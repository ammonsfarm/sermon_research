import {
  assertFrozenVectorizeMetadata,
  createCompleteIndexingManifest,
  createIntelligenceManifest,
  createTranscriptManifest,
  materializeSpeechChunks,
  partitionEmbeddingBatches,
  type CompleteIndexingManifest,
  type Float32EmbeddingRecord,
  type IndexingChunk,
} from "@aic/ai";
import {
  canonicalProcessingSnapshot,
  createProcessingRevisionHash,
  ProcessingStateError,
  type JsonValue,
} from "@aic/contracts";
import type { D1Database, D1PreparedStatement, D1Result } from "@aic/db";
import {
  parseItunesDurationToMs,
  type AudioObjectDescriptor,
  type MistralTranscriptionReceipt,
  type NormalizedTranscriptionArtifact,
  type TranscriptionAttemptContext,
} from "./audio-transport.ts";
import {
  storeEpisodeAudio,
  type OpenAudioSource,
  type R2AudioWriteBucket,
} from "./audio-storage.ts";
import type {
  EpisodeIntelligenceArtifact,
  EpisodeIntelligenceInput,
} from "./intelligence.ts";
import type {
  CompactVectorMutationReceipt,
  EpisodeIngestRepository,
  EpisodeManifestDescriptor,
  EpisodeVectorFamily,
  EpisodeVectorProofRecord,
  EpisodeWorkflowEvent,
  EpisodeWorkflowRequest,
  IntelligenceArtifactReceipt,
  PreparedEpisodeEmbeddingBatch,
} from "./workflow.ts";

interface RequestRow extends Record<string, unknown> {
  readonly request_id: string;
  readonly entity_id: string;
  readonly revision_id: string;
  readonly revision_hash: `sha256:${string}`;
  readonly idempotency_key: string;
  readonly input_snapshot_json: string;
  readonly generation: number;
  readonly desired_publication: EpisodeWorkflowRequest["desiredPublication"];
  readonly correlation_id: string;
  readonly head_request_id: string;
  readonly head_generation: number;
  readonly superseded_by_request_id: string | null;
  readonly cancel_requested_at: string | null;
}

interface EpisodeSnapshot {
  readonly episodeId: string;
  readonly title: string;
  readonly publishDate: string;
  readonly enclosureUrl: string;
  readonly enclosureLength: number | null;
  readonly durationMs: number | null;
  readonly category: string;
  readonly detail: string;
  readonly summary: string;
  readonly soundcloudUrl: string;
}

const HASH = /^[0-9a-f]{64}$/u;

function invalid(message: string): never {
  throw new ProcessingStateError("invalid_input", message);
}

function record(value: unknown, name: string): Readonly<Record<string, JsonValue>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object.`);
  return value as Readonly<Record<string, JsonValue>>;
}

function text(value: JsonValue | undefined, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || !allowEmpty && value.length === 0 || value.trim() !== value || /[\u0000-\u001F\u007F]/u.test(value)) invalid(`${name} is invalid.`);
  return value;
}

function resultChanged(result: D1Result | undefined): boolean {
  return result?.success === true && typeof result.meta?.changes === "number" && result.meta.changes >= 1;
}

async function sha256(value: string): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publishedDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) invalid("Episode publish date is invalid.");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) invalid("Episode publish date is invalid.");
  return Number(value.replaceAll("-", ""));
}

function snapshot(request: EpisodeWorkflowRequest, developmentFixture = false): EpisodeSnapshot {
  const source = request.snapshot;
  const episodeId = text(source.episodeId, "Episode ID");
  if (episodeId !== request.episodeId || !(source.source === "soundcloud-rss" || developmentFixture && source.source === "development-fixture")) invalid("Episode snapshot identity is invalid.");
  const enclosureLength = source.enclosureLength;
  if (enclosureLength !== null && (!Number.isSafeInteger(enclosureLength) || (enclosureLength as number) < 1)) invalid("Episode enclosure length is invalid.");
  return {
    episodeId,
    title: text(source.title, "Episode title"),
    publishDate: text(source.publishDate, "Episode publish date"),
    enclosureUrl: text(source.enclosureUrl, "Episode enclosure URL"),
    enclosureLength: enclosureLength as number | null,
    durationMs: parseItunesDurationToMs(source.duration),
    category: text(source.category, "Episode category", true),
    detail: text(source.detail, "Episode detail", true),
    summary: text(source.summary, "Episode summary", true),
    soundcloudUrl: text(source.soundcloudUrl, "Episode source URL", true),
  };
}

function manifestDescriptor(family: EpisodeVectorFamily, manifest: CompleteIndexingManifest): EpisodeManifestDescriptor {
  if (manifest.chunks.length === 0) invalid(`${family} manifest cannot be empty.`);
  const embeddingBatchCount = partitionEmbeddingBatches(manifest.chunks.map((chunk) => ({
    id: chunk.id,
    text: chunk.text,
    contentHash: chunk.contentHash,
    estimatedTokens: Math.ceil(new TextEncoder().encode(chunk.text).byteLength / 4),
  }))).length;
  return { family, ids: manifest.ids, idDigest: manifest.idDigest, embeddingBatchCount };
}

function ms(value: number): number {
  return Math.max(0, Math.round(value * 1_000));
}

function intelligenceProvenance(request: EpisodeWorkflowRequest, vectorId: string): {
  readonly table: "episode_intelligence" | "episode_intelligence_items";
  readonly id: string;
  readonly field: "executive_summary" | "long_summary" | "topics_keywords" | "summary";
} {
  const customId = vectorId.replace(/^i\//u, "");
  if (customId === `${request.episodeId}:summary:executive`) return { table: "episode_intelligence", id: request.episodeId, field: "executive_summary" };
  if (customId === `${request.episodeId}:summary:long`) return { table: "episode_intelligence", id: request.episodeId, field: "long_summary" };
  if (customId === `${request.episodeId}:summary:topics`) return { table: "episode_intelligence", id: request.episodeId, field: "topics_keywords" };
  const match = new RegExp(`^${request.episodeId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:item:(\\d{4})$`, "u").exec(customId);
  if (!match) invalid("Intelligence vector provenance is invalid.");
  return {
    table: "episode_intelligence_items",
    id: `p6item:${request.episodeId}:${request.revisionHash.slice(7, 19)}:${Number(match[1])}`,
    field: "summary",
  };
}

/** Readable, unique public slug: the title plus the stable track ID (e.g. sas-chapel-genesis-50-2402426601). */
export function episodeSlug(title: string, episodeId: string): string {
  const base = title.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase()
    .replace(/&/gu, " and ").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80).replace(/-+$/u, "");
  return base ? `${base}-${episodeId}` : `episode-${episodeId}`;
}

/** Editorial and public rows use six-digit fractional seconds (the public reader rejects others). */
export function editorialTimestamp(at: string): string {
  return /\.\d{3}Z$/u.test(at) ? at.replace(/Z$/u, "000Z") : at;
}

export class D1EpisodeIngestRepository implements EpisodeIngestRepository {
  readonly #db: D1Database;
  readonly #bucket: R2AudioWriteBucket;
  readonly #openAudioSource: OpenAudioSource;
  readonly #now: () => string;
  readonly #developmentFixture: boolean;
  readonly #validateSourceUrl: ((url: string) => string) | undefined;

  constructor(options: {
    readonly db: D1Database;
    readonly bucket: R2AudioWriteBucket;
    readonly openAudioSource: OpenAudioSource;
    readonly environment?: string;
    readonly validateSourceUrl?: (url: string) => string;
    readonly now?: () => string;
  }) {
    this.#db = options.db;
    this.#bucket = options.bucket;
    this.#openAudioSource = options.openAudioSource;
    this.#developmentFixture = options.environment === "development";
    this.#validateSourceUrl = options.validateSourceUrl;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async #run(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result[]> {
    if (typeof this.#db.batch !== "function") invalid("D1 transactional batch support is required.");
    return this.#db.batch([...statements]);
  }

  #headGuard(request: EpisodeWorkflowRequest): string {
    return `EXISTS (
      SELECT 1 FROM processing_requests r
      JOIN processing_heads h ON h.aggregate_type=r.aggregate_type
       AND h.aggregate_id=r.aggregate_id AND h.head_request_id=r.request_id
       AND h.generation=r.generation
      WHERE r.request_id='${request.requestId.replaceAll("'", "''")}'
       AND r.generation=${request.generation}
       AND r.revision_hash='${request.revisionHash}'
       AND r.superseded_by_request_id IS NULL AND r.cancel_requested_at IS NULL
    )`;
  }

  async #assertBatch(statements: readonly D1PreparedStatement[], message: string): Promise<void> {
    const results = await this.#run(statements);
    if (results.length !== statements.length || results.some((result) => !resultChanged(result))) {
      const failedOrdinals = results.flatMap((result, index) => resultChanged(result) ? [] : [index]);
      throw new ProcessingStateError("stale_generation", message, { failedOrdinals });
    }
  }

  async #appendResearchMutation(
    statements: D1PreparedStatement[],
    request: EpisodeWorkflowRequest,
    sourceTable: string,
    sourceRecordId: string,
    upsert: D1PreparedStatement,
  ): Promise<void> {
    const previous = await this.#db.prepare(`SELECT rowid,title,text FROM research_sources
      WHERE source_table=? AND source_record_id=?`).bind(sourceTable, sourceRecordId)
      .first<{ readonly rowid: number; readonly title: string; readonly text: string }>();
    if (previous) {
      statements.push(this.#db.prepare(`INSERT INTO research_sources_fts(research_sources_fts,rowid,title,text)
        VALUES('delete',?,?,?)`).bind(previous.rowid, previous.title, previous.text));
    }
    statements.push(upsert);
    statements.push(this.#db.prepare(`INSERT INTO research_sources_fts(rowid,title,text)
      SELECT rowid,title,text FROM research_sources WHERE source_table=? AND source_record_id=?
       AND ${this.#headGuard(request)}`).bind(sourceTable, sourceRecordId));
  }

  async loadRequest(event: EpisodeWorkflowEvent): Promise<EpisodeWorkflowRequest> {
    const row = await this.#db.prepare(`
      SELECT r.request_id,r.entity_id,r.revision_id,r.revision_hash,
             r.idempotency_key,r.input_snapshot_json,r.generation,
             r.desired_publication,r.correlation_id,r.superseded_by_request_id,
             r.cancel_requested_at,h.head_request_id,h.generation AS head_generation
        FROM processing_requests r
        JOIN processing_heads h ON h.aggregate_type=r.aggregate_type AND h.aggregate_id=r.aggregate_id
       WHERE r.request_id=? AND r.workflow_name='episode'
         AND r.operation='episode_ingest' AND r.contract_version='p6-v1'
    `).bind(event.requestId).first<RequestRow>();
    if (!row) throw new ProcessingStateError("not_found", "Episode processing request was not found.");
    if (row.revision_hash !== event.revisionHash) throw new ProcessingStateError("identity_conflict", "Workflow revision identity does not match D1.");
    if (row.head_request_id !== row.request_id || row.head_generation !== row.generation || row.superseded_by_request_id !== null) {
      throw new ProcessingStateError("superseded", "Episode processing request was superseded.");
    }
    if (row.cancel_requested_at !== null) throw new ProcessingStateError("cancelled", "Episode processing request was cancelled.");
    let parsed: unknown;
    try { parsed = JSON.parse(row.input_snapshot_json); } catch { invalid("Stored episode snapshot is invalid."); }
    const requestSnapshot = record(parsed, "Stored episode snapshot");
    if (canonicalProcessingSnapshot(requestSnapshot) !== row.input_snapshot_json || await createProcessingRevisionHash(requestSnapshot) !== row.revision_hash) {
      throw new ProcessingStateError("identity_conflict", "Stored episode snapshot hash is invalid.");
    }
    const request = {
      requestId: row.request_id,
      episodeId: row.entity_id,
      revisionId: row.revision_id,
      revisionHash: row.revision_hash,
      generation: row.generation,
      desiredPublication: row.desired_publication,
      idempotencyKey: row.idempotency_key,
      correlationId: row.correlation_id,
      snapshot: requestSnapshot,
    } satisfies EpisodeWorkflowRequest;
    snapshot(request, this.#developmentFixture);
    return request;
  }

  async storeAudio(request: EpisodeWorkflowRequest): Promise<AudioObjectDescriptor> {
    const input = snapshot(request, this.#developmentFixture);
    return storeEpisodeAudio({
      episodeId: request.episodeId,
      revisionHash: request.revisionHash,
      sourceUrl: input.enclosureUrl,
      expectedSizeBytes: input.enclosureLength,
      durationMs: input.durationMs,
    }, { bucket: this.#bucket, openSource: this.#openAudioSource, ...(this.#validateSourceUrl ? { validateSourceUrl: this.#validateSourceUrl } : {}) });
  }

  async loadAudioDescriptor(request: EpisodeWorkflowRequest): Promise<AudioObjectDescriptor | null> {
    const row = await this.#db.prepare(`
      SELECT snapshot_json FROM editorial_revisions
       WHERE revision_id=? AND operation_key=? AND entity_type='episode' AND entity_id=?
    `).bind(request.revisionId, request.idempotencyKey, request.episodeId)
      .first<{ readonly snapshot_json: string }>();
    if (!row) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(row.snapshot_json); } catch { invalid("Stored audio receipt is invalid."); }
    const revision = record(parsed, "Stored audio receipt");
    const audio = record(revision.audio, "Stored audio descriptor");
    if (
      revision.processingRevisionHash !== request.revisionHash
      || audio.bucket !== "aic-podcast-audio"
      || audio.key !== `podcasts/${request.episodeId}.mp3`
      || audio.episodeId !== request.episodeId
      || typeof audio.sha256 !== "string"
      || !/^sha256:[0-9a-f]{64}$/u.test(audio.sha256)
      || !Number.isSafeInteger(audio.sizeBytes)
      || Number(audio.sizeBytes) < 0
      || !(audio.durationMs === null || (Number.isSafeInteger(audio.durationMs) && Number(audio.durationMs) >= 0))
    ) {
      throw new ProcessingStateError("identity_conflict", "Stored audio receipt conflicts with the processing request.");
    }
    return {
      bucket: "aic-podcast-audio",
      key: audio.key,
      sizeBytes: Number(audio.sizeBytes),
      sha256: audio.sha256 as `sha256:${string}`,
      durationMs: audio.durationMs === null ? null : Number(audio.durationMs),
      episodeId: audio.episodeId,
    };
  }

  async persistAudioDescriptor(request: EpisodeWorkflowRequest, descriptor: AudioObjectDescriptor): Promise<void> {
    const input = snapshot(request, this.#developmentFixture);
    if (descriptor.episodeId !== request.episodeId) invalid("Audio descriptor episode identity is invalid.");
    const at = this.#now();
    const documentId = `episode:${request.episodeId}`;
    const revisionSnapshot = JSON.stringify({ processingRevisionHash: request.revisionHash, audio: descriptor });
    await this.#assertBatch([
      this.#db.prepare(`
        INSERT INTO episodes (episode_id,title,publish_date,category,detail,source_file,
          canonical_audio_key,source_system,source_id,content_hash,status,created_at,updated_at)
        SELECT ?,?,?,?,?,? ,?,?,?,?,'Draft',?,? WHERE ${this.#headGuard(request)}
        ON CONFLICT(episode_id) DO UPDATE SET title=excluded.title,publish_date=excluded.publish_date,
          category=excluded.category,detail=excluded.detail,source_file=excluded.source_file,
          canonical_audio_key=excluded.canonical_audio_key,content_hash=excluded.content_hash,updated_at=excluded.updated_at
      `).bind(request.episodeId, input.title, input.publishDate, input.category, input.detail,
        descriptor.key, descriptor.key, request.snapshot.source === "development-fixture" ? "development-fixture" : "soundcloud", request.episodeId, descriptor.sha256.slice(7), editorialTimestamp(at), editorialTimestamp(at)),
      this.#db.prepare(`
        INSERT INTO media_assets (asset_id,asset_type,filename,original_filename,source_provider,source_bucket,
          source_key,destination_bucket,canonical_object_key,mime_type,size_bytes,sha256,duration_seconds,
          status,created_at,updated_at)
        SELECT ?,'audio',?,?,'r2','aic-podcast-audio',?,'aic-podcast-audio',?,'audio/mpeg',?,?,?,'verified',?,? WHERE ${this.#headGuard(request)}
        ON CONFLICT(canonical_object_key) DO UPDATE SET size_bytes=excluded.size_bytes,sha256=excluded.sha256,
          duration_seconds=excluded.duration_seconds,status='verified',updated_at=excluded.updated_at
      `).bind(`podcast-audio:${request.episodeId}`, `${request.episodeId}.mp3`, `${request.episodeId}.mp3`, descriptor.key, descriptor.key,
        descriptor.sizeBytes, descriptor.sha256.slice(7), descriptor.durationMs === null ? null : descriptor.durationMs / 1000, editorialTimestamp(at), editorialTimestamp(at)),
      this.#db.prepare(`
        INSERT INTO episode_documents (document_id,episode_id,source_type,slug,title,description,
          summary,category,status,visibility,transcript_status,intelligence_status,vector_status,
          source_url,content_hash,created_at,updated_at,current_revision_id)
        SELECT ?,?,'podcast',?,?,?,?,?,'Draft','public','Running','Queued','Queued',?,?,?, ?,?
         WHERE ${this.#headGuard(request)}
        ON CONFLICT(episode_id) DO UPDATE SET title=excluded.title,description=excluded.description,
          summary=excluded.summary,category=excluded.category,source_url=excluded.source_url,
          content_hash=excluded.content_hash,transcript_status='Running',intelligence_status='Queued',
          vector_status='Queued',current_revision_id=excluded.current_revision_id,updated_at=excluded.updated_at
      `).bind(documentId, request.episodeId, episodeSlug(input.title, request.episodeId), input.title, input.detail,
        input.summary, input.category, input.soundcloudUrl, request.revisionHash.slice(7), editorialTimestamp(at), editorialTimestamp(at), request.revisionId),
      this.#db.prepare(`
        INSERT INTO editorial_revisions (revision_id,entity_type,entity_id,revision_number,title,
          excerpt,status,created_by,created_at,snapshot_json,operation_key)
        SELECT ?,'episode',?,COALESCE((SELECT MAX(revision_number) FROM editorial_revisions
          WHERE entity_type='episode' AND entity_id=?),0)+1,?,?,'Draft','episode-workflow',?,?,?
         WHERE ${this.#headGuard(request)}
        ON CONFLICT(revision_id) DO UPDATE SET title=excluded.title,excerpt=excluded.excerpt,
          snapshot_json=excluded.snapshot_json
      `).bind(request.revisionId, request.episodeId, request.episodeId, input.title, input.summary,
        editorialTimestamp(at), revisionSnapshot, request.idempotencyKey),
    ], "Audio descriptor persistence lost its generation fence.");
  }

  async persistTranscriptArtifact(
    context: TranscriptionAttemptContext,
    descriptor: AudioObjectDescriptor,
    artifact: NormalizedTranscriptionArtifact,
  ): Promise<{ readonly artifactKey: string }> {
    const request = await this.loadRequest({ requestId: context.requestId, revisionHash: context.revisionHash });
    if (request.generation !== context.generation || descriptor.episodeId !== request.episodeId || !HASH.test(artifact.artifactDigest)) {
      throw new ProcessingStateError("identity_conflict", "Transcript artifact identity is invalid.");
    }
    if (artifact.segments.length === 0) invalid("Transcript artifact requires at least one segment.");
    const at = this.#now();
    const revisionTag = request.revisionHash.slice(7, 19);
    const segmentsDigest = await sha256(JSON.stringify(artifact.segments.map(segment => ({
      text: segment.text, start: segment.start, end: segment.end, speakerId: segment.speakerId ?? "",
    }))));
    const statements = artifact.segments.map((segment, index) => {
      const segmentId = `p6seg:${request.episodeId}:${revisionTag}:${index}`;
      const raw = JSON.stringify({
        requestId: request.requestId,
        processingRevisionHash: request.revisionHash,
        artifactDigest: artifact.artifactDigest,
        segmentCount: artifact.segments.length,
        segmentsDigest,
        model: artifact.model,
      });
      return this.#db.prepare(`
        INSERT INTO transcript_segments (segment_id,episode_id,speaker,start_time,end_time,
          segment_type,text,sequence_number,created_at,updated_at,segment_index,start_seconds,
          end_seconds,speaker_id,speaker_name,source_file,raw_segment_json,source_record_id)
        SELECT ?,?,'',?,?,'speech',?,?,?, ?,?,?,? ,?,'',?,?,?
         WHERE ${this.#headGuard(request)}
        ON CONFLICT(segment_id) DO UPDATE SET text=excluded.text,start_time=excluded.start_time,
          end_time=excluded.end_time,start_seconds=excluded.start_seconds,end_seconds=excluded.end_seconds,
          speaker_id=excluded.speaker_id,raw_segment_json=excluded.raw_segment_json,updated_at=excluded.updated_at
      `).bind(segmentId, request.episodeId, String(segment.start), String(segment.end), segment.text,
        index, at, at, index, segment.start, segment.end, segment.speakerId ?? "", descriptor.key, raw, segmentId);
    });
    await this.#assertBatch(statements, "Transcript artifact persistence lost its generation fence.");
    return { artifactKey: `d1:transcript_segments:${request.requestId}` };
  }

  async loadTranscriptReceipt(request: EpisodeWorkflowRequest, requireComplete = false): Promise<MistralTranscriptionReceipt | null> {
    if (requireComplete) {
      const stored = await this.#db.prepare(`
        SELECT text,start_seconds,end_seconds,speaker_id,sequence_number,raw_segment_json
        FROM transcript_segments WHERE episode_id=? AND json_extract(raw_segment_json,'$.requestId')=?
        ORDER BY sequence_number
      `).bind(request.episodeId, request.requestId).all<{
        text: string; start_seconds: number; end_seconds: number; speaker_id: string;
        sequence_number: number; raw_segment_json: string;
      }>();
      if (stored.results.length === 0) return null;
      const metadata = stored.results.map(row => JSON.parse(row.raw_segment_json) as Record<string, unknown>);
      const first = metadata[0]!;
      if (!metadata.every((item, index) => item.processingRevisionHash === request.revisionHash
        && item.segmentCount === stored.results.length && stored.results[index]!.sequence_number === index
        && item.artifactDigest === first.artifactDigest && item.model === first.model
        && item.segmentsDigest === first.segmentsDigest)) return null;
      const actual = await sha256(JSON.stringify(stored.results.map(row => ({
        text: row.text, start: row.start_seconds, end: row.end_seconds, speakerId: row.speaker_id,
      }))));
      if (actual !== first.segmentsDigest) return null;
    }
    const row = await this.#db.prepare(`
      SELECT json_extract(raw_segment_json,'$.artifactDigest') AS artifact_digest,
             json_extract(raw_segment_json,'$.model') AS model,
             count(*) AS segment_count,
             max(end_seconds) AS duration_seconds
        FROM transcript_segments
       WHERE episode_id=? AND json_extract(raw_segment_json,'$.requestId')=?
       GROUP BY artifact_digest, model
       ORDER BY segment_count DESC LIMIT 2
    `).bind(request.episodeId, request.requestId).all<{
      readonly artifact_digest: string;
      readonly model: string;
      readonly segment_count: number;
      readonly duration_seconds: number | null;
    }>();
    if (row.results.length === 0) return null;
    if (row.results.length !== 1 || !HASH.test(row.results[0]!.artifact_digest) || !row.results[0]!.model || row.results[0]!.segment_count < 1) {
      throw new ProcessingStateError("identity_conflict", "Persisted transcript receipt is ambiguous or invalid.");
    }
    const receipt = row.results[0]!;
    return {
      artifactKey: `d1:transcript_segments:${request.requestId}`,
      model: receipt.model,
      segmentCount: receipt.segment_count,
      artifactDigest: receipt.artifact_digest,
      durationMs: receipt.duration_seconds === null ? null : Math.round(receipt.duration_seconds * 1_000),
    };
  }

  async commitTranscript(request: EpisodeWorkflowRequest, receipt: MistralTranscriptionReceipt): Promise<void> {
    const input = snapshot(request, this.#developmentFixture);
    const result = await this.#db.prepare(`
      SELECT segment_id,text,start_seconds,end_seconds,speaker_id,sequence_number,raw_segment_json
        FROM transcript_segments WHERE episode_id=?
         AND json_extract(raw_segment_json,'$.requestId')=?
         AND json_extract(raw_segment_json,'$.artifactDigest')=? ORDER BY sequence_number
    `).bind(request.episodeId, request.requestId, receipt.artifactDigest).all<Record<string, unknown>>();
    if (result.results.length !== receipt.segmentCount || result.results.length === 0) {
      throw new ProcessingStateError("identity_conflict", "Persisted transcript artifact is incomplete.");
    }
    const at = this.#now();
    const statements: D1PreparedStatement[] = [];
    for (const row of result.results) {
      const segmentId = String(row.segment_id);
      const segmentText = String(row.text);
      const sourceRecordId = await sha256(`{"segment_id":${JSON.stringify(segmentId)}}`);
      await this.#appendResearchMutation(statements, request, "transcript_segments", sourceRecordId, this.#db.prepare(`
        INSERT INTO research_sources (source_key,source_table,source_record_id,episode_id,
          entity_type,entity_id,kind,item_type,title,publish_date,text,text_sha256,start_ms,end_ms,
          sequence_number,speakers_json,source_model,metadata_json,source_fingerprint,processing_revision_hash)
        SELECT ?,'transcript_segments',?,?, 'episode',?,'segment','speech',?,?,?,?,?,?,?,'[]',?,?,?,?
         WHERE ${this.#headGuard(request)}
        ON CONFLICT(source_table,source_record_id) DO UPDATE SET title=excluded.title,
          publish_date=excluded.publish_date,text=excluded.text,text_sha256=excluded.text_sha256,
          start_ms=excluded.start_ms,end_ms=excluded.end_ms,sequence_number=excluded.sequence_number,
          source_model=excluded.source_model,metadata_json=excluded.metadata_json,
          source_fingerprint=excluded.source_fingerprint,processing_revision_hash=excluded.processing_revision_hash
      `).bind(`transcript_segments:${segmentId}`, sourceRecordId, request.episodeId, request.episodeId,
        input.title, input.publishDate, segmentText, await sha256(segmentText), ms(Number(row.start_seconds)),
        ms(Number(row.end_seconds)), Number(row.sequence_number), receipt.model,
        JSON.stringify({ projectionVersion: 1, manifestSha256: receipt.artifactDigest, requestId: request.requestId }), receipt.artifactDigest, request.revisionHash));
    }
    statements.push(this.#db.prepare(`UPDATE episode_documents SET transcript_status='Completed',updated_at=?
      WHERE episode_id=? AND ${this.#headGuard(request)}`).bind(editorialTimestamp(at), request.episodeId));
    await this.#assertBatch(statements, "Transcript commit lost its generation fence.");
  }

  async #transcriptManifest(request: EpisodeWorkflowRequest): Promise<CompleteIndexingManifest> {
    const input = snapshot(request, this.#developmentFixture);
    const rows = await this.#db.prepare(`
      SELECT text,start_seconds,end_seconds,speaker_id,sequence_number FROM transcript_segments
       WHERE episode_id=? AND json_extract(raw_segment_json,'$.requestId')=? ORDER BY sequence_number
    `).bind(request.episodeId, request.requestId).all<Record<string, unknown>>();
    const speech = materializeSpeechChunks({
      episode: { trackId: request.episodeId, title: input.title, publishedDate: input.publishDate },
      segments: rows.results.map((row) => ({
        text: String(row.text), speakerId: String(row.speaker_id), segmentType: "speech",
        startTime: String(row.start_seconds), endTime: String(row.end_seconds),
      })),
      maxCharacters: 6_000,
    });
    return createTranscriptManifest({ episodeId: request.episodeId, contentSubtype: "speech", publishedDay: publishedDay(input.publishDate), chunks: speech });
  }

  async #intelligenceManifest(request: EpisodeWorkflowRequest): Promise<CompleteIndexingManifest> {
    const input = snapshot(request, this.#developmentFixture);
    const summary = await this.#db.prepare(`SELECT executive_summary,long_summary,main_topics_json,
      search_keywords_json,source_model,raw_json FROM episode_intelligence WHERE episode_id=? AND status='complete'
      AND json_extract(raw_json,'$.processingRevisionHash')=?`).bind(request.episodeId, request.revisionHash).first<Record<string, unknown>>();
    if (!summary) invalid("Persisted intelligence artifact is unavailable.");
    const items = await this.#db.prepare(`SELECT item_id,item_type,label,summary,value_json FROM episode_intelligence_items
      WHERE episode_id=? AND json_extract(value_json,'$.processingRevisionHash')=? ORDER BY item_id`)
      .bind(request.episodeId, request.revisionHash).all<Record<string, unknown>>();
    const values = [
      { customId: `${request.episodeId}:summary:executive`, text: String(summary.executive_summary), chunkIndex: 0 },
      { customId: `${request.episodeId}:summary:long`, text: String(summary.long_summary), chunkIndex: 1 },
      { customId: `${request.episodeId}:summary:topics`, text: `${String(summary.main_topics_json)}\n${String(summary.search_keywords_json)}`, chunkIndex: 2 },
      ...items.results.map((item, index) => ({
        customId: `${request.episodeId}:item:${index.toString().padStart(4, "0")}`,
        text: `${String(item.label)}\n${String(item.summary)}`.trim(),
        chunkIndex: index + 3,
      })),
    ];
    const chunks = await Promise.all(values.map(async (value) => ({ ...value, contentHash: await sha256(value.text) })));
    return createIntelligenceManifest({ episodeId: request.episodeId, contentSubtype: "episode_intelligence", publishedDay: publishedDay(input.publishDate), chunks });
  }

  async materializeManifest(request: EpisodeWorkflowRequest, family: EpisodeVectorFamily): Promise<EpisodeManifestDescriptor> {
    const manifest = family === "transcript" ? await this.#transcriptManifest(request) : await this.#intelligenceManifest(request);
    const input = snapshot(request, this.#developmentFixture);
    const at = this.#now();
    const statements = manifest.chunks.map((chunk) => {
      if (family === "transcript") return this.#db.prepare(`
          INSERT INTO transcript_chunks (source_custom_id,episode_id,record_id,title,publish_date,
            segment_type,text,source_field,embedding_model,embedding_dimensions,metadata_json,
            content_hash,chunk_index,created_at,updated_at)
          SELECT ?,?,?,?,?,'speech',?,'text','text-embedding-3-small',1536,?,?,?, ?,?
           WHERE ${this.#headGuard(request)}
          ON CONFLICT(source_custom_id) DO UPDATE SET text=excluded.text,content_hash=excluded.content_hash,
            metadata_json=excluded.metadata_json,embedding_dimensions=1536,updated_at=excluded.updated_at
        `).bind(chunk.id.slice(2), request.episodeId, `record:${chunk.id}`, input.title, input.publishDate,
          chunk.text, JSON.stringify({ processingRevisionHash: request.revisionHash }), chunk.contentHash,
          chunk.metadata.chunk_index, at, at);
      const provenance = intelligenceProvenance(request, chunk.id);
      return this.#db.prepare(`
          INSERT INTO episode_intelligence_vectors (custom_id,record_id,vector_type,track_id,title,
            publish_date,episode_type,label,text,source_table,source_id,source_field,source_file,
            source_model,source_updated_at,content_hash,metadata_json,embedding_dimensions,updated_at)
          SELECT ?,?,'episode_intelligence',?,?,?,?,? ,?,?,?,?,
                 '','silo',?,?,?,1536,? WHERE ${this.#headGuard(request)}
          ON CONFLICT(custom_id) DO UPDATE SET text=excluded.text,content_hash=excluded.content_hash,
            metadata_json=excluded.metadata_json,embedding_dimensions=1536,updated_at=excluded.updated_at
        `).bind(chunk.id.slice(2), `record:${chunk.id}`, request.episodeId, input.title, input.publishDate,
          "episode", "", chunk.text, provenance.table, provenance.id, provenance.field,
          at, chunk.contentHash, JSON.stringify({ processingRevisionHash: request.revisionHash }), at);
    });
    await this.#assertBatch(statements, `${family} manifest materialization lost its generation fence.`);
    return manifestDescriptor(family, manifest);
  }

  async #manifest(request: EpisodeWorkflowRequest, family: EpisodeVectorFamily): Promise<CompleteIndexingManifest> {
    return family === "transcript" ? this.#transcriptManifest(request) : this.#intelligenceManifest(request);
  }

  async loadEmbeddingBatch(request: EpisodeWorkflowRequest, family: EpisodeVectorFamily, ordinal: number): Promise<PreparedEpisodeEmbeddingBatch> {
    const manifest = await this.#manifest(request, family);
    const partition = partitionEmbeddingBatches(manifest.chunks.map((chunk) => ({
      id: chunk.id, text: chunk.text, contentHash: chunk.contentHash,
      estimatedTokens: Math.ceil(new TextEncoder().encode(chunk.text).byteLength / 4),
    })));
    const batch = partition[ordinal];
    if (!batch) invalid("Embedding batch ordinal is outside the complete manifest.");
    const ids = new Set(batch.inputs.map((item) => item.id));
    return { batch, chunks: manifest.chunks.filter((chunk) => ids.has(chunk.id)) };
  }

  async recordPreparedVectors(request: EpisodeWorkflowRequest, manifest: EpisodeManifestDescriptor, chunks: readonly IndexingChunk[], records: readonly Float32EmbeddingRecord[]): Promise<void> {
    const input = snapshot(request, this.#developmentFixture);
    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const at = this.#now();
    const statements: D1PreparedStatement[] = [];
    for (const vector of records) {
      const chunk = chunksById.get(vector.id);
      if (!chunk) invalid("Embedding output does not belong to the target manifest.");
      const transcript = manifest.family === "transcript";
      const sourceTable = transcript ? "transcript_chunks" : "episode_intelligence_vectors";
      const provenance = transcript ? null : intelligenceProvenance(request, vector.id);
      const customId = vector.id.slice(2);
      const marker = {
        version: 1,
        manifestSha256: manifest.idDigest,
        sourceFingerprint: await sha256(`${vector.id}\0${chunk.contentHash}\0${request.revisionHash}`),
        sourceRecordId: `record:${vector.id}`,
        sourceTable,
        sourceField: transcript ? "text" : provenance!.field,
        sourceUpdatedAt: at,
        textSha256: await sha256(chunk.text),
        title: input.title,
        publishDate: input.publishDate,
        contentSubtype: chunk.metadata.content_subtype,
        vectorizeMetadata: chunk.metadata,
        entityType: "episode",
        entityId: request.episodeId,
        accessScope: "authenticated-corpus",
        processingRevisionHash: request.revisionHash,
        ...(transcript ? {} : { provenanceTable: provenance!.table, provenanceId: provenance!.id }),
      };
      statements.push(this.#db.prepare(`
        INSERT INTO vector_documents (vector_id,source_table,source_custom_id,source_type,source_id,
          content_subtype,content_hash,chunk_index,published_day,embedding_model,dimensions,vector_digest,
          metadata_digest,status,updated_at,record_id,source_field,authoritative_text,metadata_json,
          processing_revision_hash,processing_visibility_state)
        SELECT ?,?,?,?,?,?,?,?,?,'text-embedding-3-small',1536,?,?,'verified',?,?,?,?,?,?,'prepared'
         WHERE ${this.#headGuard(request)}
        ON CONFLICT(vector_id) DO UPDATE SET source_table=excluded.source_table,
          source_custom_id=excluded.source_custom_id,source_type=excluded.source_type,
          source_id=excluded.source_id,content_subtype=excluded.content_subtype,
          content_hash=excluded.content_hash,chunk_index=excluded.chunk_index,published_day=excluded.published_day,
          vector_digest=excluded.vector_digest,metadata_digest=excluded.metadata_digest,status='verified',
          updated_at=excluded.updated_at,record_id=excluded.record_id,source_field=excluded.source_field,
          authoritative_text=excluded.authoritative_text,metadata_json=excluded.metadata_json,
          processing_revision_hash=excluded.processing_revision_hash,processing_visibility_state='prepared'
      `).bind(vector.id, sourceTable, customId, chunk.metadata.source_type, request.episodeId,
        chunk.metadata.content_subtype, chunk.contentHash, chunk.metadata.chunk_index,
        chunk.metadata.published_day, vector.vectorDigest, await sha256(JSON.stringify(chunk.metadata)), at,
        `record:${vector.id}`, transcript ? "text" : provenance!.field, chunk.text,
        JSON.stringify({ p5Hydration: marker }), request.revisionHash));
    }
    await this.#assertBatch(statements, "Prepared vector ledger write lost its generation fence.");
  }

  async loadVectorProofRecords(request: EpisodeWorkflowRequest, ids: readonly string[]): Promise<readonly EpisodeVectorProofRecord[]> {
    if (ids.length === 0) invalid("Vector visibility proof batch cannot be empty.");
    const rows = await this.#db.prepare(`SELECT vector_id,vector_digest,metadata_json FROM vector_documents
      WHERE vector_id IN (${ids.map(() => "?").join(",")}) AND processing_revision_hash=? AND status='verified'
      ORDER BY vector_id`).bind(...ids, request.revisionHash)
      .all<{ readonly vector_id: string; readonly vector_digest: string; readonly metadata_json: string }>();
    if (rows.results.length !== ids.length) throw new ProcessingStateError("visibility_pending", "Prepared vector proof ledger is incomplete.");
    return rows.results.map((row) => {
      let parsed: unknown;
      try { parsed = JSON.parse(row.metadata_json); } catch { invalid("Prepared vector metadata is invalid."); }
      const metadata = record(record(parsed, "Prepared vector metadata").p5Hydration, "Prepared vector marker").vectorizeMetadata;
      assertFrozenVectorizeMetadata(metadata);
      if (!HASH.test(row.vector_digest)) invalid("Prepared vector digest is invalid.");
      return { id: row.vector_id, vectorDigest: row.vector_digest, metadata };
    });
  }

  async loadAcceptedMutation(request: EpisodeWorkflowRequest, batchOrdinal: number, operation: "upsert" | "delete", ids: readonly string[]): Promise<CompactVectorMutationReceipt | null> {
    const row = await this.#db.prepare(`SELECT provider_mutation_id,expected_ids_digest,visibility_state
      FROM processing_vector_batches WHERE request_id=? AND batch_ordinal=? AND operation=?`)
      .bind(request.requestId, batchOrdinal, operation).first<Record<string, unknown>>();
    if (!row) return null;
    const digest = await sha256([...ids].sort().join("\0"));
    if (row.expected_ids_digest !== `sha256:${digest}`) throw new ProcessingStateError("identity_conflict", "Stored vector acceptance IDs conflict with replay.");
    return {
      mutationId: String(row.provider_mutation_id),
      state: operation === "upsert" ? "accepted" : "delete_accepted",
      ids: [...ids].sort(),
      idDigest: digest,
    };
  }

  async markVectorsAccepted(request: EpisodeWorkflowRequest, ids: readonly string[], mutationId: string): Promise<void> {
    // A resumed request replays acceptance for batches whose vectors already became visible;
    // those stay visible (never downgraded) and still count toward the fence.
    const result = await this.#db.prepare(`UPDATE vector_documents SET processing_visibility_state=CASE
        WHEN processing_visibility_state='visible' THEN 'visible' ELSE 'accepted' END,
      last_mutation_id=?,updated_at=? WHERE vector_id IN (${ids.map(() => "?").join(",")})
      AND processing_revision_hash=? AND processing_visibility_state IN ('prepared','accepted','visible')
      AND ${this.#headGuard(request)}`).bind(mutationId, this.#now(), ...ids, request.revisionHash).run();
    if (result.meta?.changes !== ids.length) throw new ProcessingStateError("stale_generation", "Vector acceptance ledger lost its generation fence.");
  }

  async markVectorsVisible(request: EpisodeWorkflowRequest, ids: readonly string[], mutationId: string): Promise<void> {
    const result = await this.#db.prepare(`UPDATE vector_documents SET processing_visibility_state='visible',
      last_mutation_id=?,verified_at=?,updated_at=? WHERE vector_id IN (${ids.map(() => "?").join(",")})
      AND processing_revision_hash=? AND processing_visibility_state IN ('prepared','accepted','visible')
      AND ${this.#headGuard(request)}`).bind(mutationId, this.#now(), this.#now(), ...ids, request.revisionHash).run();
    if (result.meta?.changes !== ids.length) throw new ProcessingStateError("stale_generation", "Vector visibility ledger lost its generation fence.");
  }

  async listStaleVectorIds(request: EpisodeWorkflowRequest, family: EpisodeVectorFamily, targetIds: readonly string[]): Promise<readonly string[]> {
    const rows = await this.#db.prepare(`SELECT vector_id FROM vector_documents WHERE source_type=? AND source_id=?
      AND (processing_revision_hash IS NULL OR processing_revision_hash!=?) ORDER BY vector_id`)
      .bind(family === "transcript" ? "episode_transcript" : "episode_intelligence", request.episodeId, request.revisionHash)
      .all<{ readonly vector_id: string }>();
    const target = new Set(targetIds);
    return rows.results.map((row) => row.vector_id).filter((id) => !target.has(id));
  }

  async markVectorsDeleted(request: EpisodeWorkflowRequest, ids: readonly string[], mutationId: string): Promise<void> {
    if (ids.length === 0) return;
    const result = await this.#db.prepare(`UPDATE vector_documents SET status='tombstoned',
      processing_visibility_state=CASE WHEN processing_revision_hash IS NULL THEN NULL ELSE 'deleted' END,
      last_mutation_id=?,updated_at=? WHERE vector_id IN (${ids.map(() => "?").join(",")})
      AND (processing_revision_hash IS NULL OR processing_revision_hash!=?) AND ${this.#headGuard(request)}`)
      .bind(mutationId, this.#now(), ...ids, request.revisionHash).run();
    if (result.meta?.changes !== ids.length) throw new ProcessingStateError("stale_generation", "Stale vector ledger lost its generation fence.");
  }

  async loadIntelligenceInput(request: EpisodeWorkflowRequest): Promise<EpisodeIntelligenceInput> {
    const input = snapshot(request, this.#developmentFixture);
    const rows = await this.#db.prepare(`SELECT text FROM transcript_segments WHERE episode_id=?
      AND json_extract(raw_segment_json,'$.requestId')=? ORDER BY sequence_number`)
      .bind(request.episodeId, request.requestId).all<{ readonly text: string }>();
    let transcript = "";
    let transcriptTruncated = false;
    for (const row of rows.results) {
      const candidate = `${transcript}${transcript ? "\n" : ""}${row.text}`;
      if (new TextEncoder().encode(candidate).byteLength > 240_000) { transcriptTruncated = true; break; }
      transcript = candidate;
    }
    if (!transcript) invalid("Intelligence generation requires a persisted transcript.");
    return { episodeId: request.episodeId, title: input.title, publishDate: input.publishDate, transcript, transcriptTruncated };
  }

  async loadIntelligenceReceipt(request: EpisodeWorkflowRequest): Promise<IntelligenceArtifactReceipt | null> {
    const row = await this.#db.prepare(`
      SELECT content_hash, source_model,
             json_extract(raw_json,'$.requestId') AS request_id
        FROM episode_intelligence WHERE episode_id=? AND status='complete'
    `).bind(request.episodeId).first<{
      readonly content_hash: string;
      readonly source_model: string;
      readonly request_id: string | null;
    }>();
    if (!row || row.request_id !== request.requestId) return null;
    if (!HASH.test(row.content_hash) || !row.source_model) {
      throw new ProcessingStateError("identity_conflict", "Persisted intelligence receipt is invalid.");
    }
    const prefix = `p6item:${request.episodeId}:${request.revisionHash.slice(7, 19)}:`;
    const count = await this.#db.prepare("SELECT count(*) AS count FROM episode_intelligence_items WHERE item_id GLOB ?")
      .bind(`${prefix}*`).first<{ readonly count: number }>();
    return {
      artifactKey: `d1:episode_intelligence:${request.requestId}`,
      artifactDigest: row.content_hash,
      itemCount: count?.count ?? 0,
      model: row.source_model,
    };
  }

  async persistIntelligenceArtifact(request: EpisodeWorkflowRequest, artifact: EpisodeIntelligenceArtifact): Promise<IntelligenceArtifactReceipt> {
    const input = snapshot(request, this.#developmentFixture);
    const canonical = JSON.stringify(artifact);
    const artifactDigest = await sha256(canonical);
    const at = this.#now();
    const raw = JSON.stringify({ processingRevisionHash: request.revisionHash, requestId: request.requestId, artifact });
    const statements: D1PreparedStatement[] = [this.#db.prepare(`
      INSERT INTO episode_intelligence (episode_id,title,publish_date,episode_type,executive_summary,
        long_summary,main_topics_json,search_keywords_json,raw_json,source_file,source_model,input_chars,
        transcript_truncated,status,content_hash,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,? ,?,?,?,'complete',?,?,? WHERE ${this.#headGuard(request)}
      ON CONFLICT(episode_id) DO UPDATE SET title=excluded.title,publish_date=excluded.publish_date,
        episode_type=excluded.episode_type,executive_summary=excluded.executive_summary,
        long_summary=excluded.long_summary,main_topics_json=excluded.main_topics_json,
        search_keywords_json=excluded.search_keywords_json,raw_json=excluded.raw_json,
        source_model=excluded.source_model,status='complete',content_hash=excluded.content_hash,updated_at=excluded.updated_at
    `).bind(request.episodeId, input.title, input.publishDate, artifact.episodeType,
      artifact.executiveSummary, artifact.longSummary, JSON.stringify(artifact.mainTopics),
      JSON.stringify(artifact.searchKeywords), raw, `podcasts/${request.episodeId}.mp3`, artifact.model,
      new TextEncoder().encode(canonical).byteLength, 0, artifactDigest, at, at)];
    const summarySourceRecordId = await sha256(`{"track_id":${JSON.stringify(request.episodeId)}}`);
    await this.#appendResearchMutation(statements, request, "episode_intelligence", summarySourceRecordId, this.#db.prepare(`
      INSERT INTO research_sources (source_key,source_table,source_record_id,episode_id,entity_type,
        entity_id,kind,item_type,title,publish_date,text,text_sha256,speakers_json,source_model,
        metadata_json,source_fingerprint,processing_revision_hash)
      SELECT ?,'episode_intelligence',?,?,'episode',?,'summary','episode_summary',?,?,?,?,
             '[]',?,?,?,? WHERE ${this.#headGuard(request)}
      ON CONFLICT(source_table,source_record_id) DO UPDATE SET title=excluded.title,
        publish_date=excluded.publish_date,text=excluded.text,text_sha256=excluded.text_sha256,
        source_model=excluded.source_model,metadata_json=excluded.metadata_json,
        source_fingerprint=excluded.source_fingerprint,processing_revision_hash=excluded.processing_revision_hash
    `).bind(`episode_intelligence:${request.episodeId}`, summarySourceRecordId, request.episodeId,
      request.episodeId, input.title, input.publishDate, artifact.longSummary,
      await sha256(artifact.longSummary), artifact.model, JSON.stringify({ projectionVersion: 1, manifestSha256: artifactDigest, requestId: request.requestId }),
      artifactDigest, request.revisionHash));
    for (const [index, item] of artifact.items.entries()) {
      const itemId = `p6item:${request.episodeId}:${request.revisionHash.slice(7, 19)}:${index}`;
      statements.push(this.#db.prepare(`
        INSERT INTO episode_intelligence_items (item_id,episode_id,item_type,label,summary,
          source_times_json,speakers_json,confidence,value_json,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${this.#headGuard(request)}
        ON CONFLICT(item_id) DO UPDATE SET label=excluded.label,summary=excluded.summary,
          source_times_json=excluded.source_times_json,speakers_json=excluded.speakers_json,
          confidence=excluded.confidence,value_json=excluded.value_json,updated_at=excluded.updated_at
      `).bind(itemId, request.episodeId, item.itemType, item.label, item.summary,
        JSON.stringify(item.sourceTimes), JSON.stringify(item.speakers), item.confidence,
        JSON.stringify({ ...item.value, processingRevisionHash: request.revisionHash }), at, at));
      const itemSourceRecordId = await sha256(JSON.stringify({ item_id: itemId }));
      await this.#appendResearchMutation(statements, request, "episode_intelligence_items", itemSourceRecordId, this.#db.prepare(`
        INSERT INTO research_sources (source_key,source_table,source_record_id,episode_id,entity_type,
          entity_id,kind,item_type,title,publish_date,text,text_sha256,speakers_json,source_model,
          metadata_json,source_fingerprint,processing_revision_hash)
        SELECT ?,'episode_intelligence_items',?,?,'episode',?,'item',?,?,?,?,?,?,?, ?,?,?
         WHERE ${this.#headGuard(request)}
        ON CONFLICT(source_table,source_record_id) DO UPDATE SET item_type=excluded.item_type,
          title=excluded.title,publish_date=excluded.publish_date,text=excluded.text,
          text_sha256=excluded.text_sha256,speakers_json=excluded.speakers_json,
          source_model=excluded.source_model,metadata_json=excluded.metadata_json,
          source_fingerprint=excluded.source_fingerprint,processing_revision_hash=excluded.processing_revision_hash
      `).bind(`episode_intelligence_items:${itemId}`, itemSourceRecordId, request.episodeId, request.episodeId,
        item.itemType, input.title, input.publishDate, item.summary, await sha256(item.summary),
        JSON.stringify(item.speakers), artifact.model, JSON.stringify({ projectionVersion: 1, manifestSha256: artifactDigest, requestId: request.requestId }),
        await sha256(JSON.stringify(item)), request.revisionHash));
    }
    statements.push(this.#db.prepare(`UPDATE episode_documents SET intelligence_status='Completed',updated_at=?
      WHERE episode_id=? AND ${this.#headGuard(request)}`).bind(editorialTimestamp(at), request.episodeId));
    await this.#assertBatch(statements, "Intelligence artifact persistence lost its generation fence.");
    return { artifactKey: `d1:episode_intelligence:${request.requestId}`, artifactDigest, itemCount: artifact.items.length, model: artifact.model };
  }

  async finalizeEpisode(request: EpisodeWorkflowRequest, expectedVectorBatchCount: number): Promise<void> {
    const at = this.#now();
    const evidence = await this.#db.prepare(`
      SELECT
        EXISTS(SELECT 1 FROM episodes e WHERE e.episode_id=? AND e.canonical_audio_key='podcasts/'||e.episode_id||'.mp3' AND e.content_hash IS NOT NULL) AS audio_ok,
        EXISTS(SELECT 1 FROM transcript_segments s JOIN research_sources r ON r.source_table='transcript_segments' AND r.source_key='transcript_segments:'||s.segment_id
          WHERE s.episode_id=? AND json_extract(s.raw_segment_json,'$.requestId')=? AND r.processing_revision_hash=?) AS transcript_ok,
        EXISTS(SELECT 1 FROM episode_intelligence i JOIN research_sources r ON r.source_table='episode_intelligence' AND r.source_key='episode_intelligence:'||i.episode_id
          WHERE i.episode_id=? AND i.status='complete' AND json_extract(i.raw_json,'$.processingRevisionHash')=? AND r.processing_revision_hash=?) AS intelligence_ok,
        (SELECT count(*) FROM vector_documents v WHERE v.source_id=? AND v.processing_revision_hash=? AND v.source_type='episode_transcript' AND v.processing_visibility_state='visible' AND v.status='verified') AS transcript_vectors,
        (SELECT count(*) FROM vector_documents v WHERE v.source_id=? AND v.processing_revision_hash=? AND v.source_type='episode_intelligence' AND v.processing_visibility_state='visible' AND v.status='verified') AS intelligence_vectors,
        (SELECT count(*) FROM processing_vector_batches b WHERE b.request_id=?) AS vector_batches,
        (SELECT count(*) FROM processing_vector_batches b WHERE b.request_id=? AND b.visibility_state NOT IN ('visible','deleted')) AS pending_batches
    `).bind(request.episodeId, request.episodeId, request.requestId, request.revisionHash, request.episodeId, request.revisionHash, request.revisionHash,
      request.episodeId, request.revisionHash, request.episodeId, request.revisionHash,
      request.requestId, request.requestId).first<Record<string, unknown>>();
    if (!evidence || evidence.audio_ok !== 1 || evidence.transcript_ok !== 1 || evidence.intelligence_ok !== 1
      || Number(evidence.transcript_vectors) < 1 || Number(evidence.intelligence_vectors) < 1
      || evidence.vector_batches !== expectedVectorBatchCount || evidence.pending_batches !== 0) {
      throw new ProcessingStateError("publication_conflict", "Episode publication requires complete audio, transcript, intelligence, and visible vector evidence.");
    }
    await this.#assertBatch([
      this.#db.prepare(`UPDATE editorial_revisions SET status='Published' WHERE revision_id=?
        AND entity_type='episode' AND entity_id=? AND ${this.#headGuard(request)}`).bind(request.revisionId, request.episodeId),
      this.#db.prepare(`UPDATE episodes SET status='Published',published_at=?,updated_at=?
        WHERE episode_id=? AND ${this.#headGuard(request)}`).bind(editorialTimestamp(at), editorialTimestamp(at), request.episodeId),
      this.#db.prepare(`UPDATE episode_documents SET status='Published',transcript_status='Completed',
        intelligence_status='Completed',vector_status='Completed',current_revision_id=?,published_revision_id=?,
        published_at=?,updated_at=? WHERE episode_id=? AND ${this.#headGuard(request)}`)
        .bind(request.revisionId, request.revisionId, editorialTimestamp(at), editorialTimestamp(at), request.episodeId),
      this.#db.prepare(`INSERT OR REPLACE INTO search_publications (vector_id,published_revision_id,text_sha256)
        SELECT vector_id,?,json_extract(metadata_json,'$.p5Hydration.textSha256') FROM vector_documents
         WHERE source_id=? AND processing_revision_hash=? AND processing_visibility_state='visible'
           AND status='verified' AND ${this.#headGuard(request)}`).bind(request.revisionId, request.episodeId, request.revisionHash),
      this.#db.prepare(`UPDATE processing_heads SET published_request_id=?,published_revision_hash=?,
        authenticated_corpus_request_id=?,authenticated_corpus_revision_hash=?,public_visibility='visible',
        authenticated_corpus_visibility='visible',desired_publication='published',updated_at=?
        WHERE head_request_id=? AND generation=? AND ${this.#headGuard(request)}`)
        .bind(request.requestId, request.revisionHash, request.requestId, request.revisionHash, at,
          request.requestId, request.generation),
    ], "Episode publication compare-and-set failed.");
  }
}

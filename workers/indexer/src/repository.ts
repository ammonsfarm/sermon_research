import {
  assertFrozenVectorizeMetadata,
  createCompleteIndexingManifest,
  createArticleManifest,
  createTranscriptManifest,
  materializeSpeechChunks,
  partitionEmbeddingBatches,
  type CompleteIndexingManifest,
  type Float32EmbeddingRecord,
} from "@aic/ai";
import {
  canonicalProcessingSnapshot,
  createProcessingRevisionHash,
  ProcessingStateError,
  type JsonValue,
  type ProcessingState,
} from "@aic/contracts";
import type { D1Database, D1PreparedStatement, D1Result } from "@aic/db";
import type {
  ContentIndexRepository,
  ContentManifestDescriptor,
  ContentWorkflowEvent,
  ContentWorkflowRequest,
  PreparedEmbeddingBatch,
  VectorProofRecord,
} from "./workflow.ts";

interface RequestRow extends Record<string, unknown> {
  readonly request_id: string;
  readonly entity_id: string;
  readonly revision_id: string;
  readonly revision_hash: `sha256:${string}`;
  readonly operation: ContentWorkflowRequest["operation"];
  readonly idempotency_key: string;
  readonly input_snapshot_json: string;
  readonly generation: number;
  readonly desired_publication: ContentWorkflowRequest["desiredPublication"];
  readonly correlation_id: string;
  readonly state: ProcessingState;
  readonly head_request_id: string;
  readonly head_generation: number;
  readonly superseded_by_request_id: string | null;
  readonly cancel_requested_at: string | null;
}

const CONTENT_OPERATIONS = new Set<ContentWorkflowRequest["operation"]>([
  "article_replace",
  "transcript_replace",
  "public_unpublish",
  "public_archive",
  "corpus_erase",
]);

function invalid(message: string): never {
  throw new ProcessingStateError("invalid_input", message);
}

function record(value: unknown, name: string): Readonly<Record<string, JsonValue>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object.`);
  return value as Readonly<Record<string, JsonValue>>;
}

function text(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\u0000-\u001F\u007F]/u.test(value)) invalid(`${name} is invalid.`);
  return value;
}

function optionalText(value: JsonValue | undefined, name: string): string {
  if (value === undefined || value === null || value === "") return "";
  return text(value, name);
}

function isoDate(value: string, name: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/u.exec(value);
  if (!match) invalid(`${name} is invalid.`);
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) invalid(`${name} is invalid.`);
  return date;
}

function publishedDay(value: string): number {
  return Number(isoDate(value, "Published timestamp").replaceAll("-", ""));
}

function pastorwoodSourceType(contentType: string): string {
  if (/^pastorwood_[a-z0-9_]+$/u.test(contentType)) return contentType;
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(contentType)) invalid("Article content type is invalid.");
  return `pastorwood_${contentType.replaceAll("-", "_")}`;
}

async function sha256(value: string): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function articleSnapshot(request: ContentWorkflowRequest) {
  const snapshot = request.snapshot;
  const articleId = text(snapshot.articleId, "Article ID");
  const revisionId = text(snapshot.revisionId, "Article revision ID");
  if (articleId !== request.entityId || revisionId !== request.revisionId) invalid("Article snapshot identity does not match its immutable request.");
  if (!/^pastorwood:[1-9]\d*$/u.test(articleId)) {
    invalid("CMS article semantic publication is disabled until the existing hydration reader accepts CMS vector identities.");
  }
  const contentType = text(snapshot.contentType, "Article content type");
  const title = text(snapshot.title, "Article title");
  const body = text(snapshot.body, "Article body");
  const canonicalUrl = text(snapshot.canonicalUrl, "Article canonical URL");
  const publishedAt = text(snapshot.publishedAt, "Article published timestamp");
  if (snapshot.publicationIntent !== request.desiredPublication) invalid("Article publication intent does not match its immutable request.");
  let url: URL;
  try { url = new URL(canonicalUrl); } catch { invalid("Article canonical URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) invalid("Article canonical URL is invalid.");
  return { articleId, revisionId, contentType, title, body, canonicalUrl, publishedAt, publishDate: isoDate(publishedAt, "Article published timestamp") };
}

function transcriptSnapshot(request: ContentWorkflowRequest) {
  const snapshot = request.snapshot;
  const episodeId = text(snapshot.episodeId, "Transcript episode ID");
  const revisionId = text(snapshot.revisionId, "Transcript revision ID");
  if (episodeId !== request.entityId || revisionId !== request.revisionId) invalid("Transcript snapshot identity does not match its immutable request.");
  if (snapshot.publicationIntent !== request.desiredPublication) invalid("Transcript publication intent does not match its immutable request.");
  const title = text(snapshot.title, "Transcript episode title");
  const publishedAt = text(snapshot.publishedAt, "Transcript published timestamp");
  if (!Array.isArray(snapshot.segments) || snapshot.segments.length === 0) invalid("Transcript snapshot requires the complete segment list.");
  const segments = snapshot.segments.map((item, index) => {
    const segment = record(item, `Transcript segment ${index}`);
    return {
      speakerName: optionalText(segment.speakerName, "Transcript speaker"),
      speakerId: optionalText(segment.speakerId, "Transcript speaker ID"),
      text: text(segment.text, "Transcript segment text"),
      segmentType: optionalText(segment.segmentType, "Transcript segment type") || "speech",
      startTime: optionalText(segment.startTime, "Transcript start time"),
      endTime: optionalText(segment.endTime, "Transcript end time"),
    };
  });
  return { episodeId, revisionId, title, publishedAt, publishDate: isoDate(publishedAt, "Transcript published timestamp"), segments };
}

function sourceIdentity(request: ContentWorkflowRequest): { readonly sourceType: "article" | "episode_transcript"; readonly sourceId: string } {
  return request.operation === "transcript_replace"
    ? { sourceType: "episode_transcript", sourceId: request.entityId }
    : { sourceType: "article", sourceId: request.entityId };
}

function resultChanged(result: D1Result | undefined): boolean {
  return result?.success === true && typeof result.meta?.changes === "number" && result.meta.changes >= 1;
}

function descriptor(manifest: CompleteIndexingManifest): ContentManifestDescriptor {
  if (manifest.chunks.length === 0) invalid("Content replacement requires at least one semantic chunk.");
  const batches = partitionEmbeddingBatches(manifest.chunks.map((chunk) => ({
    id: chunk.id,
    text: chunk.text,
    contentHash: chunk.contentHash,
    estimatedTokens: Math.ceil(new TextEncoder().encode(chunk.text).byteLength / 4),
  })));
  return { ids: manifest.ids, idDigest: manifest.idDigest, embeddingBatchCount: batches.length };
}

export class D1ContentIndexRepository implements ContentIndexRepository {
  readonly #db: D1Database;
  readonly #now: () => string;

  constructor(options: { readonly db: D1Database; readonly now?: () => string }) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async #run(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result[]> {
    if (typeof this.#db.batch !== "function") invalid("D1 transactional batch support is required.");
    return this.#db.batch([...statements]);
  }

  #headGuard(request: ContentWorkflowRequest): string {
    return `EXISTS (
      SELECT 1 FROM processing_requests r
      JOIN processing_heads h ON h.aggregate_type = r.aggregate_type
       AND h.aggregate_id = r.aggregate_id AND h.head_request_id = r.request_id
       AND h.generation = r.generation
      WHERE r.request_id = '${request.requestId.replaceAll("'", "''")}'
       AND r.generation = ${request.generation}
       AND r.superseded_by_request_id IS NULL AND r.cancel_requested_at IS NULL
    )`;
  }

  async loadRequest(event: ContentWorkflowEvent): Promise<ContentWorkflowRequest> {
    const row = await this.#db.prepare(`
      SELECT r.request_id, r.entity_id, r.revision_id, r.revision_hash,
             r.operation, r.idempotency_key, r.input_snapshot_json, r.state,
             r.generation, r.desired_publication, r.correlation_id,
             r.superseded_by_request_id, r.cancel_requested_at,
             h.head_request_id, h.generation AS head_generation
        FROM processing_requests r
        JOIN processing_heads h ON h.aggregate_type = r.aggregate_type
         AND h.aggregate_id = r.aggregate_id
       WHERE r.request_id = ? AND r.workflow_name = 'content'
         AND r.contract_version = 'p6-v1'
    `).bind(event.requestId).first<RequestRow>();
    if (!row) throw new ProcessingStateError("not_found", "Content processing request was not found.");
    if (row.revision_hash !== event.revisionHash) throw new ProcessingStateError("identity_conflict", "Workflow revision identity does not match D1.");
    if (row.head_request_id !== row.request_id || row.head_generation !== row.generation || row.superseded_by_request_id !== null) {
      throw new ProcessingStateError("superseded", "Content processing request was superseded.");
    }
    if (row.cancel_requested_at !== null) throw new ProcessingStateError("cancelled", "Content processing request was cancelled.");
    if (!CONTENT_OPERATIONS.has(row.operation)) invalid("Content processing operation is invalid.");
    let parsed: unknown;
    try { parsed = JSON.parse(row.input_snapshot_json); } catch { invalid("Stored content processing snapshot is invalid."); }
    const snapshot = record(parsed, "Stored content processing snapshot");
    if (canonicalProcessingSnapshot(snapshot) !== row.input_snapshot_json || await createProcessingRevisionHash(snapshot) !== row.revision_hash) {
      throw new ProcessingStateError("identity_conflict", "Stored content processing snapshot hash is invalid.");
    }
    const request = {
      requestId: row.request_id,
      entityId: row.entity_id,
      revisionId: row.revision_id,
      revisionHash: row.revision_hash,
      generation: row.generation,
      operation: row.operation,
      desiredPublication: row.desired_publication,
      idempotencyKey: row.idempotency_key,
      correlationId: row.correlation_id,
      state: row.state,
      snapshot,
    } satisfies ContentWorkflowRequest;
    if (request.operation === "article_replace") articleSnapshot(request);
    if (request.operation === "transcript_replace") transcriptSnapshot(request);
    return request;
  }

  async invalidateObsoleteHydration(request: ContentWorkflowRequest): Promise<void> {
    const source = sourceIdentity(request);
    await this.#db.prepare(`
      UPDATE vector_documents
         SET status = CASE WHEN processing_revision_hash IS NULL THEN 'tombstoned' ELSE status END,
             processing_visibility_state = CASE WHEN processing_revision_hash IS NULL THEN NULL ELSE 'superseded' END,
             updated_at = ?
       WHERE source_type = ? AND source_id = ?
         AND (processing_revision_hash IS NULL OR processing_revision_hash != ?)
         AND ${this.#headGuard(request)}
    `).bind(this.#now(), source.sourceType, source.sourceId, request.revisionHash).run();
  }

  async materializeManifest(request: ContentWorkflowRequest): Promise<ContentManifestDescriptor> {
    if (request.operation === "article_replace") {
      const input = articleSnapshot(request);
      const postId = Number(input.articleId.slice("pastorwood:".length));
      const sourceType = pastorwoodSourceType(input.contentType);
      const manifest = await createArticleManifest({
        sourceType,
        postId,
        contentSubtype: sourceType,
        publishedDay: publishedDay(input.publishedAt),
        text: input.body,
        maxCharacters: 6_000,
      });
      const at = this.#now();
      const statements = manifest.chunks.map((chunk) => {
        const customId = chunk.id.slice(2);
        const metadata = JSON.stringify({ processingRevisionHash: request.revisionHash });
        return this.#db.prepare(`
          INSERT INTO pastorwood_post_chunks (
            custom_id, record_id, post_id, article_id, source_type, title,
            publish_date, source_url, source_location, chunk_index, source_field,
            text, content_hash, metadata_json, embedding_model,
            embedding_dimensions, prompt_tokens, created_at, updated_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 'text', ?, ?, ?,
                   'text-embedding-3-small', 1536, 0, ?, ?
             WHERE ${this.#headGuard(request)}
          ON CONFLICT(custom_id) DO UPDATE SET
            article_id=excluded.article_id, source_type=excluded.source_type,
            title=excluded.title, publish_date=excluded.publish_date,
            source_url=excluded.source_url, chunk_index=excluded.chunk_index,
            text=excluded.text, content_hash=excluded.content_hash,
            metadata_json=excluded.metadata_json, embedding_dimensions=1536,
            updated_at=excluded.updated_at
        `).bind(customId, `record:${chunk.id}`, String(postId), input.articleId, sourceType, input.title, input.publishDate, input.canonicalUrl, chunk.metadata.chunk_index, chunk.text, chunk.contentHash, metadata, at, at);
      });
      const results = await this.#run(statements);
      if (results.length !== statements.length || results.some((result) => !resultChanged(result))) throw new ProcessingStateError("stale_generation", "Article manifest materialization lost its generation fence.");
      return descriptor(manifest);
    }

    const input = transcriptSnapshot(request);
    const chunks = materializeSpeechChunks({
      episode: { trackId: input.episodeId, title: input.title, publishedDate: input.publishDate },
      segments: input.segments,
      maxCharacters: 6_000,
    });
    const manifest = await createTranscriptManifest({
      episodeId: input.episodeId,
      contentSubtype: "speech",
      publishedDay: publishedDay(input.publishedAt),
      chunks,
    });
    const at = this.#now();
    const statements = manifest.chunks.map((chunk) => {
      const customId = chunk.id.slice(2);
      return this.#db.prepare(`
        INSERT INTO transcript_chunks (
          source_custom_id, episode_id, record_id, title, publish_date,
          segment_type, text, source_field, embedding_model,
          embedding_dimensions, metadata_json, content_hash, chunk_index,
          created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, 'speech', ?, 'text',
                 'text-embedding-3-small', 1536, ?, ?, ?, ?, ?
           WHERE ${this.#headGuard(request)}
        ON CONFLICT(source_custom_id) DO UPDATE SET
          title=excluded.title, publish_date=excluded.publish_date,
          text=excluded.text, embedding_model='text-embedding-3-small',
          embedding_dimensions=1536, metadata_json=excluded.metadata_json,
          content_hash=excluded.content_hash, chunk_index=excluded.chunk_index,
          updated_at=excluded.updated_at
      `).bind(customId, input.episodeId, `record:${chunk.id}`, input.title, input.publishDate, chunk.text, JSON.stringify({ processingRevisionHash: request.revisionHash }), chunk.contentHash, chunk.metadata.chunk_index, at, at);
    });
    const results = await this.#run(statements);
    if (results.length !== statements.length || results.some((result) => !resultChanged(result))) throw new ProcessingStateError("stale_generation", "Transcript manifest materialization lost its generation fence.");
    return descriptor(manifest);
  }

  async loadEmbeddingBatch(request: ContentWorkflowRequest, ordinal: number): Promise<PreparedEmbeddingBatch> {
    let rows: readonly Record<string, unknown>[];
    if (request.operation === "article_replace") {
      const result = await this.#db.prepare(`
        SELECT custom_id, source_type, publish_date, chunk_index, text, content_hash
          FROM pastorwood_post_chunks
         WHERE article_id=? AND json_extract(metadata_json,'$.processingRevisionHash')=?
         ORDER BY custom_id
      `).bind(request.entityId, request.revisionHash).all<Record<string, unknown>>();
      rows = result.results;
    } else {
      const result = await this.#db.prepare(`
        SELECT source_custom_id AS custom_id, segment_type AS source_type,
               publish_date, chunk_index, text, content_hash
          FROM transcript_chunks
         WHERE episode_id=? AND json_extract(metadata_json,'$.processingRevisionHash')=?
         ORDER BY source_custom_id
      `).bind(request.entityId, request.revisionHash).all<Record<string, unknown>>();
      rows = result.results;
    }
    const chunks = rows.map((row) => {
      if (typeof row.custom_id !== "string" || typeof row.source_type !== "string" || typeof row.publish_date !== "string" || typeof row.chunk_index !== "number" || typeof row.text !== "string" || typeof row.content_hash !== "string") {
        invalid("Stored content manifest row is invalid.");
      }
      const sourceType = request.operation === "article_replace" ? "article" : "episode_transcript";
      return {
        id: `${sourceType === "article" ? "a/" : "t/"}${row.custom_id}`,
        text: row.text,
        contentHash: row.content_hash,
        metadata: {
          source_type: sourceType,
          source_id: request.entityId,
          content_subtype: row.source_type,
          published_day: publishedDay(row.publish_date),
          content_hash: row.content_hash,
          chunk_index: row.chunk_index,
        },
      } as const;
    });
    const manifest = await createCompleteIndexingManifest(chunks);
    const batches = partitionEmbeddingBatches(manifest.chunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      contentHash: chunk.contentHash,
      estimatedTokens: Math.ceil(new TextEncoder().encode(chunk.text).byteLength / 4),
    })));
    const batch = batches[ordinal];
    if (!batch) invalid("Embedding batch ordinal is outside the complete manifest.");
    const ids = new Set(batch.inputs.map((input) => input.id));
    return { batch, chunks: manifest.chunks.filter((chunk) => ids.has(chunk.id)) };
  }

  async loadVectorProofRecords(request: ContentWorkflowRequest, ids: readonly string[]): Promise<readonly VectorProofRecord[]> {
    if (ids.length === 0) invalid("Vector visibility proof batch cannot be empty.");
    const placeholders = ids.map(() => "?").join(",");
    const result = await this.#db.prepare(`
      SELECT vector_id, vector_digest, metadata_json FROM vector_documents
       WHERE vector_id IN (${placeholders}) AND processing_revision_hash=?
         AND status='verified'
       ORDER BY vector_id
    `).bind(...ids, request.revisionHash).all<{ readonly vector_id: string; readonly vector_digest: string; readonly metadata_json: string }>();
    if (result.results.length !== ids.length) throw new ProcessingStateError("visibility_pending", "Prepared vector proof ledger is incomplete.");
    return result.results.map((row) => {
      let parsed: unknown;
      try { parsed = JSON.parse(row.metadata_json); } catch { invalid("Prepared vector metadata is invalid."); }
      const marker = record(parsed, "Prepared vector metadata").p5Hydration;
      const metadata = record(marker, "Prepared vector hydration marker").vectorizeMetadata;
      assertFrozenVectorizeMetadata(metadata);
      if (!/^[0-9a-f]{64}$/u.test(row.vector_digest)) invalid("Prepared vector digest is invalid.");
      return { id: row.vector_id, vectorDigest: row.vector_digest, metadata };
    });
  }

  async recordPreparedVectors(request: ContentWorkflowRequest, manifest: ContentManifestDescriptor, chunks: readonly import("@aic/ai").IndexingChunk[], records: readonly Float32EmbeddingRecord[]): Promise<void> {
    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const input = request.operation === "article_replace" ? articleSnapshot(request) : transcriptSnapshot(request);
    const sourceTable = request.operation === "article_replace" ? "pastorwood_post_chunks" : "transcript_chunks";
    const entityType = request.operation === "article_replace" ? "article" : "episode";
    const title = input.title;
    const publishDate = input.publishDate;
    const sourceUrl = request.operation === "article_replace" ? articleSnapshot(request).canonicalUrl : "";
    const at = this.#now();
    const statements: D1PreparedStatement[] = [];
    for (const record of records) {
      const chunk = chunksById.get(record.id);
      if (!chunk) invalid("Embedding output does not belong to the complete target manifest.");
      const customId = record.id.slice(2);
      const marker = {
        version: 1,
        manifestSha256: manifest.idDigest,
        sourceFingerprint: await sha256(`${record.id}\0${chunk.contentHash}\0${request.revisionHash}`),
        sourceRecordId: `record:${record.id}`,
        sourceTable,
        sourceField: "text",
        sourceUpdatedAt: at,
        textSha256: await sha256(chunk.text),
        title,
        publishDate,
        contentSubtype: chunk.metadata.content_subtype,
        vectorizeMetadata: chunk.metadata,
        entityType,
        entityId: chunk.metadata.source_id,
        accessScope: "authenticated-corpus",
        processingRevisionHash: request.revisionHash,
        ...(request.operation === "article_replace" ? { canonicalArticlePresent: true } : {}),
      };
      const metadataJson = JSON.stringify({ p5Hydration: marker });
      const metadataDigest = await sha256(JSON.stringify(chunk.metadata));
      statements.push(this.#db.prepare(`
        INSERT INTO vector_documents (
          vector_id, source_table, source_custom_id, source_type, source_id,
          content_subtype, content_hash, chunk_index, published_day,
          embedding_model, dimensions, vector_digest, metadata_digest, status,
          updated_at, record_id, source_field, source_url, source_location,
          authoritative_text, metadata_json, processing_revision_hash,
          processing_visibility_state
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'text-embedding-3-small', 1536,
                 ?, ?, 'verified', ?, ?, 'text', ?, '', ?, ?, ?, 'prepared'
           WHERE ${this.#headGuard(request)}
        ON CONFLICT(vector_id) DO UPDATE SET
          source_table=excluded.source_table, source_custom_id=excluded.source_custom_id,
          source_type=excluded.source_type, source_id=excluded.source_id,
          content_subtype=excluded.content_subtype, content_hash=excluded.content_hash,
          chunk_index=excluded.chunk_index, published_day=excluded.published_day,
          vector_digest=excluded.vector_digest, metadata_digest=excluded.metadata_digest,
          status='verified', updated_at=excluded.updated_at,
          record_id=excluded.record_id, source_field='text', source_url=excluded.source_url,
          source_location='', authoritative_text=excluded.authoritative_text,
          metadata_json=excluded.metadata_json,
          processing_revision_hash=excluded.processing_revision_hash,
          processing_visibility_state='prepared'
      `).bind(record.id, sourceTable, customId, chunk.metadata.source_type, chunk.metadata.source_id, chunk.metadata.content_subtype, chunk.contentHash, chunk.metadata.chunk_index, chunk.metadata.published_day, record.vectorDigest, metadataDigest, at, `record:${record.id}`, sourceUrl, chunk.text, metadataJson, request.revisionHash));
    }
    const results = await this.#run(statements);
    if (results.length !== statements.length || results.some((result) => !resultChanged(result))) throw new ProcessingStateError("stale_generation", "Prepared vector ledger write lost its generation fence.");
  }

  async loadAcceptedMutation(request: ContentWorkflowRequest, batchOrdinal: number, operation: "upsert" | "delete", ids: readonly string[]) {
    const row = await this.#db.prepare(`
      SELECT provider_mutation_id, expected_ids_digest
        FROM processing_vector_batches
       WHERE request_id=? AND batch_ordinal=? AND operation=?
         AND visibility_state IN ('accepted','visible','delete_accepted','deleted')
    `).bind(request.requestId, batchOrdinal, operation).first<{ readonly provider_mutation_id: string; readonly expected_ids_digest: string }>();
    if (!row) return null;
    const sorted = [...ids].sort((left, right) => left.localeCompare(right));
    const idDigest = await sha256(sorted.join("\0"));
    if (row.expected_ids_digest !== `sha256:${idDigest}`) {
      throw new ProcessingStateError("identity_conflict", "Stored vector acceptance IDs conflict with replay.");
    }
    return {
      mutationId: row.provider_mutation_id,
      state: operation === "upsert" ? "accepted" as const : "delete_accepted" as const,
      ids: sorted,
      idDigest,
    };
  }

  async markVectorsVisible(request: ContentWorkflowRequest, ids: readonly string[], mutationId: string): Promise<void> {
    if (ids.length === 0) invalid("Visible vector batch cannot be empty.");
    const placeholders = ids.map(() => "?").join(",");
    const result = await this.#db.prepare(`
      UPDATE vector_documents SET processing_visibility_state='visible',
             last_mutation_id=?, verified_at=?, updated_at=?
       WHERE vector_id IN (${placeholders}) AND processing_revision_hash=?
         AND processing_visibility_state IN ('prepared','accepted','visible')
         AND ${this.#headGuard(request)}
    `).bind(mutationId, this.#now(), this.#now(), ...ids, request.revisionHash).run();
    if (result.meta?.changes !== ids.length) throw new ProcessingStateError("stale_generation", "Vector visibility ledger update lost its generation fence.");
  }

  async listStaleVectorIds(request: ContentWorkflowRequest, targetIds: readonly string[]): Promise<readonly string[]> {
    const source = sourceIdentity(request);
    const result = await this.#db.prepare(`
      SELECT vector_id FROM vector_documents
       WHERE source_type=? AND source_id=?
         AND (processing_revision_hash IS NULL OR processing_revision_hash != ?)
       ORDER BY vector_id
    `).bind(source.sourceType, source.sourceId, request.revisionHash).all<{ readonly vector_id: string }>();
    const target = new Set(targetIds);
    return result.results.map((row) => row.vector_id).filter((id) => !target.has(id));
  }

  async markVectorsDeleted(request: ContentWorkflowRequest, ids: readonly string[], mutationId: string): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    const result = await this.#db.prepare(`
      UPDATE vector_documents SET status='tombstoned',
             processing_visibility_state=CASE WHEN processing_revision_hash IS NULL THEN NULL ELSE 'deleted' END,
             last_mutation_id=?, updated_at=?
       WHERE vector_id IN (${placeholders})
         AND (processing_revision_hash IS NULL OR processing_revision_hash != ?)
         AND ${this.#headGuard(request)}
    `).bind(mutationId, this.#now(), ...ids, request.revisionHash).run();
    if (result.meta?.changes !== ids.length) throw new ProcessingStateError("stale_generation", "Stale vector ledger update lost its generation fence.");
  }

  async finalizeReplacement(request: ContentWorkflowRequest, expectedVectorBatchCount: number): Promise<void> {
    const at = this.#now();
    const publication = request.operation === "article_replace"
      ? this.#db.prepare(`
          INSERT OR REPLACE INTO search_publications (vector_id, published_revision_id, text_sha256)
          SELECT v.vector_id, ?, json_extract(v.metadata_json, '$.p5Hydration.textSha256')
            FROM vector_documents v
           WHERE v.processing_revision_hash=? AND v.processing_visibility_state='visible'
             AND v.status='verified' AND ${this.#headGuard(request)}
        `).bind(request.revisionId, request.revisionHash)
      : this.#db.prepare(`
          INSERT OR REPLACE INTO search_publications (vector_id, published_revision_id, text_sha256)
          SELECT v.vector_id, d.published_revision_id,
                 json_extract(v.metadata_json, '$.p5Hydration.textSha256')
            FROM vector_documents v
            JOIN episode_documents d ON d.episode_id=v.source_id
           WHERE v.processing_revision_hash=? AND v.processing_visibility_state='visible'
             AND v.status='verified' AND d.published_revision_id IS NOT NULL
             AND ${this.#headGuard(request)}
        `).bind(request.revisionHash);
    const statements: D1PreparedStatement[] = [publication];
    if (request.operation === "article_replace") {
      const input = articleSnapshot(request);
      const bodyHash = await sha256(input.body);
      statements.push(
        this.#db.prepare("UPDATE editorial_revisions SET status='Published' WHERE revision_id=? AND entity_type='article' AND entity_id=?").bind(request.revisionId, request.entityId),
        this.#db.prepare(`
          UPDATE articles SET title=?, plain_text=?, body_html=?, canonical_url=?,
                 content_hash=?, status='Published', visibility='public',
                 current_revision_id=?, published_revision_id=?, published_at=?,
                 scheduled_for=NULL, archived_at=NULL, updated_at=?
           WHERE article_id=? AND current_revision_id=?
        `).bind(input.title, input.body, input.body, input.canonicalUrl, bodyHash, request.revisionId, request.revisionId, input.publishedAt, at, request.entityId, request.revisionId),
      );
    }
    statements.push(this.#db.prepare(`
      UPDATE processing_heads
         SET published_request_id=?, published_revision_hash=?,
             authenticated_corpus_request_id=?, authenticated_corpus_revision_hash=?,
             public_visibility='visible', authenticated_corpus_visibility='visible',
             desired_publication='published', updated_at=?
       WHERE head_request_id=? AND generation=?
         AND (SELECT count(*) FROM processing_vector_batches b
               WHERE b.request_id=processing_heads.head_request_id)=?
         AND NOT EXISTS (
           SELECT 1 FROM processing_vector_batches b
            WHERE b.request_id=processing_heads.head_request_id
              AND b.visibility_state NOT IN ('visible','deleted')
         )
         AND EXISTS (
           SELECT 1 FROM processing_requests r
            WHERE r.request_id=processing_heads.head_request_id
              AND r.generation=processing_heads.generation
              AND r.state='publish_ready' AND r.desired_publication='published'
              AND r.cancel_requested_at IS NULL AND r.superseded_by_request_id IS NULL
         )
    `).bind(request.requestId, request.revisionHash, request.requestId, request.revisionHash, at, request.requestId, request.generation, expectedVectorBatchCount));
    const results = await this.#run(statements);
    const head = results.at(-1);
    if (!resultChanged(head) || request.operation === "article_replace" && (!resultChanged(results[1]) || !resultChanged(results[2]))) {
      throw new ProcessingStateError("publication_conflict", "Replacement publication compare-and-set failed.");
    }
  }
}

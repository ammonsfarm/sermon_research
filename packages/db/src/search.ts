import {
  ServiceError,
  type ArticleId,
  type ContentHash,
  type EpisodeId,
  type OperationContext,
  type SearchDocument,
  type SearchDocumentRepository,
  type VectorId,
} from "@aic/contracts";
import type { D1Database } from "./index.ts";
import {
  assertSearchAccess,
  searchVisibilityPredicate,
  type SearchCorpusAccess,
} from "./search-visibility.ts";

export type { SearchCorpusAccess } from "./search-visibility.ts";

export interface D1SearchRepositoryOptions {
  readonly db: D1Database;
  readonly canonicalOrigin: string;
  readonly access: SearchCorpusAccess;
}

const MAX_IDS = 100;
const IDS_PER_QUERY = 40;
const READ_TIMEOUT_MS = 5_000;
const MAX_TEXT_BYTES = 80_000;
const MAX_METADATA_BYTES = 16_384;
const HASH = /^[0-9a-f]{64}$/u;
const PROCESSING_HASH = /^sha256:[0-9a-f]{64}$/u;
const VECTOR_PREFIX = {
  transcript_chunks: "t/",
  episode_intelligence_vectors: "i/",
  pastorwood_post_chunks: "a/",
} as const;
const SOURCE_TYPE = {
  transcript_chunks: "episode_transcript",
  episode_intelligence_vectors: "episode_intelligence",
  pastorwood_post_chunks: "article",
} as const;
const INTELLIGENCE_PROVENANCE = new Map([
  ["episode_intelligence", new Set(["executive_summary", "long_summary", "topics_keywords"])],
  ["episode_intelligence_items", new Set(["summary"])],
]);

type Row = Record<string, unknown>;

function invalid(message: string): never {
  throw new ServiceError({ code: "invalid_argument", message });
}

/** Fail-closed integrity rejections log the failing check's call site (no row data) for operators. */
function logRejection(event: string): void {
  const frames = (new Error().stack ?? "").split("\n").slice(2, 6).map((line) => line.trim().replace(/\(.*[\\/]/u, "(")).join(" <- ");
  console.warn(JSON.stringify({ event, at: frames }));
}

function unavailable(): ServiceError {
  logRejection("search.hydration_rejected");
  return new ServiceError({
    code: "dependency_unavailable",
    message: "Search content is temporarily unavailable.",
    retryable: true,
  });
}

function cancelled(): ServiceError {
  return new ServiceError({ code: "cancelled", message: "The search content request was cancelled." });
}

function timedOut(): ServiceError {
  return new ServiceError({ code: "timeout", message: "Search content hydration timed out.", retryable: true });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(row: Row, key: string, allowEmpty = false): string {
  const value = row[key];
  if (typeof value !== "string" || !allowEmpty && value.length === 0 || value.includes("\0")) throw unavailable();
  return value;
}

function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw unavailable();
  return value;
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw unavailable();
  return value as number;
}

function utcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value);
  const parsed = Date.parse(value);
  if (match === null || !Number.isFinite(parsed)) return false;
  const date = new Date(parsed);
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]) && date.getUTCHours() === Number(match[4])
    && date.getUTCMinutes() === Number(match[5]) && date.getUTCSeconds() === Number(match[6]);
}

function canonicalTimestamp(value: unknown): value is string {
  return utcTimestamp(value) && /\.\d{3,6}Z$/u.test(value);
}

function canonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^(\d{4})-(\d{2})-(\d{2})$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== value) invalid("canonicalOrigin must be an HTTPS origin.");
    return url.origin;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    invalid("canonicalOrigin must be an HTTPS origin.");
  }
}

function validateVectorIds(value: readonly VectorId[]): string[] {
  if (!Array.isArray(value)) invalid("vectorIds must be an array.");
  if (value.length > MAX_IDS) invalid("vectorIds may contain at most 100 entries.");
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "string"
      || candidate.length <= 2
      || utf8Bytes(candidate) > 64
      || !/^[tia]\//u.test(candidate)
      || /[\u0000-\u001F\u007F]/u.test(candidate)
    ) invalid("vectorIds contains an invalid vector ID.");
    if (!seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

function stageDeadline(context: OperationContext): number {
  const local = Date.now() + READ_TIMEOUT_MS;
  if (context.deadline === undefined) return local;
  if (!utcTimestamp(context.deadline)) invalid("Operation deadline is invalid.");
  const incoming = Date.parse(context.deadline);
  return Math.min(local, incoming);
}

async function readRows(db: D1Database, sql: string, values: readonly unknown[], context: OperationContext, deadline: number): Promise<readonly Row[]> {
  if (context.signal.aborted) throw cancelled();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timedOut();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => settle(() => reject(cancelled()));
    const timer = setTimeout(() => settle(() => reject(timedOut())), remaining);
    context.signal.addEventListener("abort", onAbort, { once: true });
    queueMicrotask(() => {
      if (settled) return;
      if (context.signal.aborted) return onAbort();
      try {
        db.prepare(sql).bind(...values).all<Row>().then(
          (result) => settle(() => {
            if (!result || result.success !== undefined && result.success !== true || !Array.isArray(result.results)) return reject(unavailable());
            if (result.results.some((row) => !isRecord(row))) return reject(unavailable());
            resolve(result.results);
          }),
          () => settle(() => reject(unavailable())),
        );
      } catch {
        settle(() => reject(unavailable()));
      }
    });
  });
}

function hydrationSql(idCount: number): string {
  // Unary + keeps the status predicate while preventing SQLite from choosing
  // its low-selectivity status index instead of the bounded vector-ID lookup.
  return `
    SELECT v.vector_id, v.source_table, v.source_custom_id, v.source_type,
           v.source_id, v.content_subtype, v.content_hash, v.chunk_index,
           v.published_day, v.embedding_model, v.dimensions, v.status,
           v.record_id, v.source_field, v.source_url, v.source_location,
           v.authoritative_text, v.metadata_json,
           v.processing_revision_hash, v.processing_visibility_state,
           e.episode_id AS canonical_episode_id,
           e.status AS episode_status, e.published_at AS episode_published_at,
           d.document_id AS episode_document_id, d.title AS episode_document_title, d.slug AS episode_slug,
           d.status AS episode_document_status, d.visibility AS episode_visibility,
           d.content_hash AS episode_content_hash,
           d.published_at AS episode_document_published_at,
           d.published_revision_id AS episode_published_revision_id,
           er.revision_id AS episode_revision_id,
           er.entity_type AS episode_revision_entity_type,
           er.entity_id AS episode_revision_entity_id,
           er.status AS episode_revision_status,
           er.snapshot_json AS episode_revision_snapshot,
           a.article_id AS canonical_article_id, a.title AS article_title,
           a.source_type AS canonical_article_source_type,
           a.cms_document_id AS article_cms_document_id,
           a.slug AS article_slug, a.canonical_url AS article_canonical_url,
           a.status AS article_status, a.visibility AS article_visibility,
           a.content_hash AS article_content_hash,
           a.published_at AS article_published_at,
           a.published_revision_id AS article_published_revision_id,
           ar.revision_id AS article_revision_id,
           ar.entity_type AS article_revision_entity_type,
           ar.entity_id AS article_revision_entity_id,
           ar.status AS article_revision_status,
           ar.snapshot_json AS article_revision_snapshot,
           (SELECT count(*) FROM search_publications sp
             WHERE sp.vector_id = v.vector_id
               AND sp.published_revision_id = CASE
                 WHEN v.source_type = 'article' THEN a.published_revision_id
                 ELSE d.published_revision_id END
               AND sp.text_sha256 = json_extract(v.metadata_json, '$.p5Hydration.textSha256')) AS publication_association_count
      FROM vector_documents v
      LEFT JOIN episodes e
        ON v.source_type <> 'article' AND e.episode_id = v.source_id
      LEFT JOIN episode_documents d
        ON v.source_type <> 'article' AND d.episode_id = v.source_id
      LEFT JOIN editorial_revisions er
        ON er.revision_id = d.published_revision_id
       AND er.entity_type = 'episode'
       AND (er.entity_id = d.document_id OR (
         er.entity_id = e.episode_id AND v.processing_revision_hash IS NOT NULL
         AND CASE WHEN json_valid(er.snapshot_json) THEN
           json_extract(er.snapshot_json, '$.processingRevisionHash') = v.processing_revision_hash
           AND json_extract(er.snapshot_json, '$.audio.episodeId') = e.episode_id
         ELSE 0 END
       ))
      LEFT JOIN articles a
        ON v.source_type = 'article'
       AND (a.article_id = v.source_id OR a.cms_document_id = v.source_id)
      LEFT JOIN editorial_revisions ar
        ON ar.revision_id = a.published_revision_id
       AND ar.entity_type = 'article'
       AND ar.entity_id = CASE WHEN a.source_type = 'cms' THEN a.cms_document_id ELSE a.article_id END
     WHERE v.vector_id IN (${Array(idCount).fill("?").join(",")})
       -- Unhydrated vectors (catch-up imports awaiting reprocessing, approved omissions)
       -- cannot be proven, so they are omitted rather than failing the whole request.
       AND json_type(v.metadata_json, '$.p5Hydration') = 'object'
       AND +v.status = 'verified'
       AND ${searchVisibilityPredicate("vector")}`;
}

function validateSnapshot(value: unknown, kind: "article" | "episode", documentId: string): Row {
  if (typeof value !== "string") throw unavailable();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw unavailable(); }
  if (!isRecord(parsed)) throw unavailable();
  if ("kind" in parsed || "documentId" in parsed) {
    if (parsed.kind !== kind || parsed.documentId !== documentId) throw unavailable();
  }
  return parsed;
}

function publicCanonical(row: Row, origin: string): { readonly url: string; readonly title: string } | null {
  if (row.source_type === "article") {
    if (row.canonical_article_id === null || row.canonical_article_id === undefined) return null;
    const articleId = stringValue(row, "canonical_article_id");
    const sourceType = stringValue(row, "canonical_article_source_type");
    const cmsId = row.article_cms_document_id;
    if (
      sourceType !== "pastorwood" && sourceType !== "cms"
      || sourceType === "pastorwood" && articleId !== row.source_id
      || sourceType === "cms" && cmsId !== row.source_id
    ) throw unavailable();
    if (row.article_status !== "Published" || row.article_visibility !== "public") return null;
    const slug = stringValue(row, "article_slug");
    if (slug.trim() !== slug || /[\/\\\u0000-\u001F\u007F]/u.test(slug)) throw unavailable();
    if (!canonicalTimestamp(row.article_published_at) || !HASH.test(stringValue(row, "article_content_hash"))) throw unavailable();
    const pointer = nullableString(row, "article_published_revision_id");
    if (pointer !== null) {
      const documentId = sourceType === "cms" ? stringValue(row, "article_cms_document_id") : articleId;
      if (row.article_revision_id !== pointer || row.article_revision_entity_type !== "article" || row.article_revision_entity_id !== documentId || row.article_revision_status !== "Published") throw unavailable();
      validateSnapshot(row.article_revision_snapshot, "article", documentId);
    }
    const stored = stringValue(row, "article_canonical_url", true);
    const title = stringValue(row, "article_title", true);
    if (!stored) return { url: `${origin}/writings/${encodeURIComponent(slug)}/`, title };
    try {
      const url = new URL(stored, origin);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port || ![origin, "https://pastorwood.org", "https://www.pastorwood.org"].includes(url.origin)) throw unavailable();
      return { url: url.href, title };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw unavailable();
    }
  }

  if (row.canonical_episode_id === null || row.canonical_episode_id === undefined) return null;
  const sourceId = stringValue(row, "source_id");
  if (row.canonical_episode_id !== sourceId) throw unavailable();
  if (row.episode_status !== "Published" || row.episode_document_status !== "Published" || row.episode_visibility !== "public") return null;
  const documentId = stringValue(row, "episode_document_id");
  const slug = stringValue(row, "episode_slug");
  if (slug.trim() !== slug || /[\/\\\u0000-\u001F\u007F]/u.test(slug)) throw unavailable();
  if (!canonicalTimestamp(row.episode_published_at) || !canonicalTimestamp(row.episode_document_published_at) || !HASH.test(stringValue(row, "episode_content_hash"))) throw unavailable();
  const pointer = nullableString(row, "episode_published_revision_id");
  if (pointer !== null) {
    const snapshot = validateSnapshot(row.episode_revision_snapshot, "episode", documentId);
    // P6 editorial revisions use the canonical episode ID; legacy revisions use the document ID.
    const p6Identity = row.episode_revision_entity_id === sourceId
      && typeof row.processing_revision_hash === "string" && PROCESSING_HASH.test(row.processing_revision_hash)
      && snapshot.processingRevisionHash === row.processing_revision_hash
      && isRecord(snapshot.audio) && snapshot.audio.episodeId === sourceId;
    if (row.episode_revision_id !== pointer || row.episode_revision_entity_type !== "episode"
      || row.episode_revision_entity_id !== documentId && !p6Identity
      || row.episode_revision_status !== "Published") throw unavailable();
  }
  return { url: `${origin}/radio/${encodeURIComponent(slug)}/`, title: stringValue(row, "episode_document_title", true) };
}

function fallbackUrl(row: Row, origin: string): string {
  const sourceId = stringValue(row, "source_id");
  if (row.source_type !== "article") return `${origin}/podcast/episodes?trackId=${encodeURIComponent(sourceId)}`;
  const stored = stringValue(row, "source_url", true);
  if (stored) {
    try {
      const url = new URL(stored);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port || !["https://pastorwood.org", "https://www.pastorwood.org"].includes(url.origin)) throw unavailable();
      return url.href;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw unavailable();
    }
  }
  return `${origin}/api/rag/sources/${encodeURIComponent(stringValue(row, "vector_id"))}`;
}

function parseMarker(row: Row): Row {
  const raw = stringValue(row, "metadata_json");
  if (utf8Bytes(raw) > MAX_METADATA_BYTES + 256) throw unavailable();
  let metadata: unknown;
  try { metadata = JSON.parse(raw); } catch { throw unavailable(); }
  if (!isRecord(metadata) || !isRecord(metadata.p5Hydration)) throw unavailable();
  const marker = metadata.p5Hydration;
  if (utf8Bytes(JSON.stringify(marker)) > MAX_METADATA_BYTES) throw unavailable();
  return marker;
}

async function validateHydrationEvidence(row: Row): Promise<Omit<SearchDocument, "canonicalUrl">> {
  const table = stringValue(row, "source_table") as keyof typeof VECTOR_PREFIX;
  if (!(table in VECTOR_PREFIX)) throw unavailable();
  const vectorId = stringValue(row, "vector_id");
  const customId = stringValue(row, "source_custom_id");
  if (vectorId !== `${VECTOR_PREFIX[table]}${customId}` || row.source_type !== SOURCE_TYPE[table]) throw unavailable();
  const sourceType = SOURCE_TYPE[table];
  const sourceId = stringValue(row, "source_id");
  if (sourceType === "article" ? !/^pastorwood:[1-9]\d*$/u.test(sourceId) : !/^(?:\d+|sa_\d+|wp-sermon:\d+|cms_[A-Za-z0-9_-]+)$/u.test(sourceId)) throw unavailable();
  const chunkIndex = safeInteger(row.chunk_index);
  const contentHash = stringValue(row, "content_hash").replace(/^sha256:/u, "").toLowerCase();
  if (!HASH.test(contentHash) || row.embedding_model !== "text-embedding-3-small" || row.dimensions !== 1536 || row.status !== "verified") throw unavailable();
  const marker = parseMarker(row);
  const markerSourceTable = stringValue(marker, "sourceTable");
  const markerSourceField = stringValue(marker, "sourceField");
  const recordId = stringValue(row, "record_id");
  if (
    marker.version !== 1
    || markerSourceTable !== table
    || markerSourceField !== row.source_field
    || marker.sourceRecordId !== recordId
    || !HASH.test(stringValue(marker, "manifestSha256"))
    || !HASH.test(stringValue(marker, "sourceFingerprint"))
    || marker.entityType !== (sourceType === "article" ? "article" : "episode")
    || marker.entityId !== sourceId
    || marker.accessScope !== "authenticated-corpus"
    || marker.contentSubtype !== row.content_subtype
  ) throw unavailable();
  const processingRevision = row.processing_revision_hash;
  if (processingRevision === null) {
    if (!("processingRevisionHash" in marker) || marker.processingRevisionHash !== null || row.processing_visibility_state !== null) throw unavailable();
  } else if (typeof processingRevision !== "string" || !PROCESSING_HASH.test(processingRevision) || marker.processingRevisionHash !== processingRevision || row.processing_visibility_state !== "visible") {
    throw unavailable();
  }
  if (table !== "episode_intelligence_vectors" && markerSourceField !== "text") throw unavailable();
  if (table === "episode_intelligence_vectors") {
    const provenanceTable = stringValue(marker, "provenanceTable");
    const provenanceId = stringValue(marker, "provenanceId");
    if (!INTELLIGENCE_PROVENANCE.get(provenanceTable)?.has(markerSourceField) || !provenanceId) throw unavailable();
  }
  // Historical source timestamps retain their real precision. The P5 exporter
  // accepts UTC RFC3339 at whole-second or fractional precision; canonical D1
  // publication timestamps have a separate, stricter representation above.
  if ("sourceUpdatedAt" in marker && !utcTimestamp(marker.sourceUpdatedAt)) throw unavailable();
  if ("publishDate" in marker && !canonicalDate(marker.publishDate)) throw unavailable();
  if ((marker.sourceLocation ?? "") !== row.source_location) throw unavailable();
  if ("speakers" in marker && (!Array.isArray(marker.speakers) || marker.speakers.some((value) => typeof value !== "string" || value.includes("\0")))) throw unavailable();
  const vectorMetadata = marker.vectorizeMetadata;
  if (!isRecord(vectorMetadata) || Object.keys(vectorMetadata).sort().join(",") !== "chunk_index,content_hash,content_subtype,published_day,source_id,source_type") throw unavailable();
  if (
    vectorMetadata.source_type !== sourceType
    || vectorMetadata.source_id !== sourceId
    || vectorMetadata.content_subtype !== row.content_subtype
    || vectorMetadata.content_hash !== contentHash
    || vectorMetadata.chunk_index !== chunkIndex
    || vectorMetadata.published_day !== row.published_day
  ) throw unavailable();
  if (row.published_day !== null) {
    const day = String(safeInteger(row.published_day));
    if (day.length !== 8 || !canonicalDate(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`)) throw unavailable();
  }
  const text = stringValue(row, "authoritative_text");
  if (utf8Bytes(text) > MAX_TEXT_BYTES) throw unavailable();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const textHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (marker.textSha256 !== textHash) throw unavailable();
  let sourceLocation: SearchDocument["sourceLocation"] | undefined;
  if (sourceType === "episode_transcript") {
    const start = marker.startMs;
    const end = marker.endMs;
    if ((start === undefined) !== (end === undefined)) throw unavailable();
    if (start !== undefined) {
      const startMs = safeInteger(start);
      const endMs = safeInteger(end);
      if (endMs < startMs) throw unavailable();
      sourceLocation = { startMs, endMs };
    }
  } else if (sourceType === "episode_intelligence") {
    const label = marker.label ?? marker.sourceLocation;
    if (label !== undefined && (typeof label !== "string" || label.includes("\0"))) throw unavailable();
    if (label) sourceLocation = { label };
  } else {
    sourceLocation = { label: `Chunk ${chunkIndex + 1}` };
  }
  const title = "title" in marker ? marker.title : "";
  if (typeof title !== "string" || title.includes("\0")) throw unavailable();
  return {
    vectorId: vectorId as VectorId,
    sourceType,
    sourceId: sourceId as ArticleId | EpisodeId,
    title,
    text,
    contentHash: contentHash as ContentHash,
    chunkIndex,
    ...(sourceLocation === undefined ? {} : { sourceLocation }),
  };
}

/** Validate one already-selected Vectorize hydration witness without URL or access presentation. */
export async function validateSearchHydrationEvidence(row: Record<string, unknown>): Promise<void> {
  await validateHydrationEvidence(row);
}

async function validateHydration(row: Row, origin: string, access: SearchCorpusAccess): Promise<SearchDocument | null> {
  const evidence = await validateHydrationEvidence(row);
  const publication = publicCanonical(row, origin);
  if (access.kind === "public-published" && (publication === null || row.publication_association_count !== 1)) return null;
  return access.kind === "public-published"
    ? { ...evidence, title: publication!.title, canonicalUrl: publication!.url }
    : { ...evidence, canonicalUrl: publication?.url ?? fallbackUrl(row, origin) };
}

class D1SearchDocumentRepository implements SearchDocumentRepository {
  readonly #db: D1Database;
  readonly #origin: string;
  readonly #access: SearchCorpusAccess;

  constructor(options: D1SearchRepositoryOptions) {
    this.#db = options.db;
    this.#origin = validateOrigin(options.canonicalOrigin);
    assertSearchAccess(options.access);
    this.#access = options.access;
  }

  async getByVectorIds(context: OperationContext, vectorIds: readonly VectorId[]): Promise<readonly SearchDocument[]> {
    const requested = validateVectorIds(vectorIds);
    if (requested.length === 0) return [];
    const deadline = stageDeadline(context);
    const rows: Row[] = [];
    for (let offset = 0; offset < requested.length; offset += IDS_PER_QUERY) {
      const ids = requested.slice(offset, offset + IDS_PER_QUERY);
      rows.push(...await readRows(this.#db, hydrationSql(ids.length), ids, context, deadline));
    }
    const hydrated = new Map<string, SearchDocument>();
    const seenRows = new Set<string>();
    for (const row of rows) {
      if (context.signal.aborted) throw cancelled();
      if (Date.now() >= deadline) throw timedOut();
      const id = stringValue(row, "vector_id");
      if (seenRows.has(id)) throw unavailable();
      seenRows.add(id);
      const document = await validateHydration(row, this.#origin, this.#access);
      if (document) hydrated.set(id, document);
    }
    return requested.flatMap((id) => {
      const document = hydrated.get(id);
      return document ? [document] : [];
    });
  }
}

export function createD1SearchRepositories(options: D1SearchRepositoryOptions): { readonly searchDocuments: SearchDocumentRepository } {
  return { searchDocuments: new D1SearchDocumentRepository(options) };
}

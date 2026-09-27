import {
  ServiceError,
  type ContentHash,
  type EpisodeId,
  type EpisodeSearchHit,
  type EpisodeSearchInput,
  type OperationContext,
  type ResearchScope,
  type ResearchSort,
  type ResearchSource,
  type ResearchSourceRepository,
} from "@aic/contracts";
import type { D1Database } from "./index.ts";
import { validateSearchHydrationEvidence } from "./search.ts";
import {
  assertSearchAccess,
  canonicalEpisodeVisibilityPredicate,
  searchVisibilityPredicate,
  type SearchCorpusAccess,
} from "./search-visibility.ts";

export interface D1ResearchSourceRepositoryOptions {
  readonly db: D1Database;
  readonly access: SearchCorpusAccess;
}

type Row = Record<string, unknown>;

const HASH = /^[0-9a-f]{64}$/u;
const PROCESSING_HASH = /^sha256:[0-9a-f]{64}$/u;
const EPISODE_ID = /^(?:\d+|sa_\d+|wp-sermon:\d+|cms_[A-Za-z0-9._-]+)$/u;
const SCOPES = new Set<ResearchScope>(["all", "title", "passage", "guest", "interview", "theme"]);
const SORTS = new Set<ResearchSort>(["relevance", "date_desc", "date_asc", "title_asc"]);
const READ_TIMEOUT_MS = 5_000;
const MAX_TEXT_BYTES = 80_000;
const MAX_METADATA_BYTES = 16_384;

function invalid(message: string): never {
  throw new ServiceError({ code: "invalid_argument", message });
}

/** Fail-closed integrity rejections log the failing check's call site (no row data) for operators. */
function logRejection(event: string): void {
  const frames = (new Error().stack ?? "").split("\n").slice(2, 6).map((line) => line.trim().replace(/\(.*[\\/]/u, "(")).join(" <- ");
  console.warn(JSON.stringify({ event, at: frames }));
}

/**
 * Only vectors carrying a P5 hydration marker can be proven as evidence. Unhydrated vectors
 * (catch-up imports awaiting reprocessing, or the approved fail-closed omissions) are simply
 * not claimed, instead of failing every request that touches their episode.
 */
const HYDRATED_VECTOR = "json_type(v.metadata_json,'$.p5Hydration')='object'";

function unavailable(): ServiceError {
  logRejection("research.source_rejected");
  return new ServiceError({ code: "dependency_unavailable", message: "Research content is temporarily unavailable.", retryable: true });
}

function cancelled(): ServiceError {
  return new ServiceError({ code: "cancelled", message: "The research request was cancelled." });
}

function timedOut(): ServiceError {
  return new ServiceError({ code: "timeout", message: "Research content lookup timed out.", retryable: true });
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(row: Row, key: string, allowEmpty = false): string {
  const value = row[key];
  if (typeof value !== "string" || !allowEmpty && value.length === 0 || value.includes("\0")) throw unavailable();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw unavailable();
  return value as number;
}

function booleanFlag(row: Row, key: string): boolean {
  if (row[key] !== 0 && row[key] !== 1) throw unavailable();
  return row[key] === 1;
}

function limit(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid(`${label} must be an integer from 0 to ${maximum}.`);
  return value;
}

function canonicalDate(value: string): boolean {
  if (!/^(\d{4})-(\d{2})-(\d{2})$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateFilter(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!canonicalDate(value)) invalid(`${label} must be a real YYYY-MM-DD date.`);
  return value;
}

function episodeId(value: unknown): string {
  if (typeof value !== "string" || !EPISODE_ID.test(value)) invalid("Episode ID is invalid.");
  return value;
}

function episodeIds(value: readonly EpisodeId[], maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(`Episode IDs may contain at most ${maximum} entries.`);
  return [...new Set(value.map(episodeId))];
}

function inputFields(input: Omit<EpisodeSearchInput, "query">): { limit: number; scope: ResearchScope; sort: ResearchSort; episode?: string; from?: string; to?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Episode search input is invalid.");
  if (!SCOPES.has(input.scope)) invalid("Research scope is invalid.");
  if (!SORTS.has(input.sort)) invalid("Research sort is invalid.");
  const from = dateFilter(input.publishedFrom, "publishedFrom");
  const to = dateFilter(input.publishedTo, "publishedTo");
  if (from !== undefined && to !== undefined && from > to) invalid("publishedFrom must not be after publishedTo.");
  return {
    limit: limit(input.limit, 80, "limit"),
    scope: input.scope,
    sort: input.sort,
    ...(input.episodeId === undefined ? {} : { episode: episodeId(input.episodeId) }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

function ftsQuery(value: string): { raw: string; match: string } {
  if (typeof value !== "string" || value.length > 8_000 || value.includes("\0")) invalid("query must be a string of at most 8000 characters.");
  const raw = value.trim();
  if (!raw) return { raw, match: "" };
  const terms: string[] = [];
  let term = "";
  let quoted = false;
  for (const character of raw) {
    if (character === '"') { quoted = !quoted; continue; }
    if (/\s/u.test(character) && !quoted) {
      if (term) { terms.push(term); term = ""; }
    } else term += character;
  }
  if (quoted) term += '"';
  if (term) terms.push(term);
  if (terms.length > 32) invalid("query may contain at most 32 terms or phrases.");
  if (terms.some((value) => value.length === 0)) invalid("query contains an empty phrase.");
  return { raw, match: terms.map((value) => `"${value.replaceAll('"', '""')}"`).join(" ") };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function utcTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value);
  const parsed = Date.parse(value);
  if (match === null || !Number.isFinite(parsed)) return false;
  const date = new Date(parsed);
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]) && date.getUTCHours() === Number(match[4])
    && date.getUTCMinutes() === Number(match[5]) && date.getUTCSeconds() === Number(match[6]);
}

function stageDeadline(context: OperationContext): number {
  const local = Date.now() + READ_TIMEOUT_MS;
  if (context.deadline === undefined) return local;
  if (!utcTimestamp(context.deadline)) invalid("Operation deadline is invalid.");
  const incoming = Date.parse(context.deadline);
  return Math.min(local, incoming);
}

function ensureActive(context: OperationContext, deadline: number): void {
  if (context.signal.aborted) throw cancelled();
  if (Date.now() >= deadline) throw timedOut();
}

async function readRows(db: D1Database, sql: string, values: readonly unknown[], context: OperationContext, expires: number): Promise<readonly Row[]> {
  if (context.signal.aborted) throw cancelled();
  const remaining = expires - Date.now();
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
            if (!result || result.success !== undefined && result.success !== true || !Array.isArray(result.results) || result.results.some((row) => !isRow(row))) return reject(unavailable());
            resolve(result.results);
          }),
          () => settle(() => reject(unavailable())),
        );
      } catch { settle(() => reject(unavailable())); }
    });
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalPrimaryKey(field: string, value: string): string {
  return `{"${field}":${JSON.stringify(value)}}`;
}

async function mapSource(row: Row): Promise<ResearchSource> {
  const key = stringValue(row, "source_key");
  const table = stringValue(row, "source_table");
  const recordId = stringValue(row, "source_record_id");
  const fingerprint = stringValue(row, "source_fingerprint");
  const episode = stringValue(row, "episode_id");
  const kind = stringValue(row, "kind");
  const itemType = stringValue(row, "item_type");
  const text = stringValue(row, "text");
  const textHash = stringValue(row, "text_sha256");
  const processingRevision = row.processing_revision_hash;
  if (!HASH.test(recordId) || !HASH.test(fingerprint) || !HASH.test(textHash) || row.entity_type !== "episode" || row.entity_id !== episode || row.article_id !== null) throw unavailable();
  if (processingRevision !== null && (typeof processingRevision !== "string" || !PROCESSING_HASH.test(processingRevision))) throw unavailable();
  const expected = table === "episode_intelligence" ? ["summary", "episode_summary"]
    : table === "episode_intelligence_items" ? ["item", itemType]
      : table === "transcript_segments" ? ["segment", itemType] : null;
  const prefix = `${table}:`;
  if (!expected || kind !== expected[0] || itemType !== expected[1] || !key.startsWith(prefix) || key.length === prefix.length) throw unavailable();
  const suffix = key.slice(prefix.length);
  if (table === "episode_intelligence" && suffix !== episode) throw unavailable();
  const primaryKey = table === "episode_intelligence" ? "track_id" : table === "transcript_segments" ? "segment_id" : null;
  if (primaryKey !== null && await sha256(canonicalPrimaryKey(primaryKey, suffix)) !== recordId) throw unavailable();
  let metadata: unknown;
  let speakers: unknown;
  const metadataJson = stringValue(row, "metadata_json");
  const speakersJson = stringValue(row, "speakers_json");
  if (utf8Bytes(text) > MAX_TEXT_BYTES || utf8Bytes(metadataJson) > MAX_METADATA_BYTES || utf8Bytes(speakersJson) > MAX_METADATA_BYTES) throw unavailable();
  try { metadata = JSON.parse(metadataJson); speakers = JSON.parse(speakersJson); } catch { throw unavailable(); }
  if (!isRow(metadata) || metadata.projectionVersion !== 1 || !HASH.test(stringValue(metadata, "manifestSha256")) || !Array.isArray(speakers) || speakers.some((speaker) => typeof speaker !== "string" || speaker.includes("\0"))) throw unavailable();
  if (await sha256(text) !== textHash) throw unavailable();
  const title = stringValue(row, "canonical_title", true);
  const publishDate = stringValue(row, "canonical_publish_date", true);
  if (publishDate && !canonicalDate(publishDate) || !stringValue(row, "document_id")) throw unavailable();
  const start = row.start_ms;
  const end = row.end_ms;
  let sourceLocation: ResearchSource["sourceLocation"] | undefined;
  if ((start === null) !== (end === null)) throw unavailable();
  if (start !== null) {
    const startMs = integer(row, "start_ms");
    const endMs = integer(row, "end_ms");
    if (endMs < startMs) throw unavailable();
    sourceLocation = { startMs, endMs };
  }
  const score = Number(row.score);
  if (!Number.isFinite(score)) throw unavailable();
  return {
    key,
    episodeId: episode as EpisodeId,
    sourceType: kind === "summary" ? "structured.summary" : kind === "item" ? `structured.${itemType}` : "detail.transcript",
    title,
    publishDate,
    text,
    contentHash: textHash as ContentHash,
    canonicalUrl: `/podcast/episodes?trackId=${encodeURIComponent(episode)}`,
    ...(sourceLocation === undefined ? {} : { sourceLocation }),
    speakers,
    score,
  };
}

const SOURCE_COLUMNS = `r.source_key,r.source_table,r.source_record_id,r.episode_id,r.article_id,r.entity_type,r.entity_id,r.kind,r.item_type,r.text,r.text_sha256,r.start_ms,r.end_ms,r.sequence_number,r.speakers_json,r.metadata_json,r.source_fingerprint,r.processing_revision_hash,e.title AS canonical_title,e.publish_date AS canonical_publish_date,d.document_id`;

function sourceBase(where: string, order: string): string {
  return `SELECT ${SOURCE_COLUMNS},-bm25(research_sources_fts) AS score
    FROM research_sources_fts JOIN research_sources r ON r.rowid=research_sources_fts.rowid
    JOIN episodes e ON e.episode_id=r.episode_id LEFT JOIN episode_documents d ON d.episode_id=e.episode_id
   WHERE research_sources_fts MATCH ? AND ${searchVisibilityPredicate("research")} AND ${where}
   ORDER BY ${order} LIMIT ?`;
}

const FLAGS = `
  CASE WHEN EXISTS(SELECT 1 FROM research_sources r WHERE r.episode_id=e.episode_id AND r.source_table='transcript_segments' AND r.kind='segment' AND ${searchVisibilityPredicate("research")}) THEN 1 ELSE 0 END AS has_transcript,
  CASE WHEN EXISTS(SELECT 1 FROM research_sources r WHERE r.episode_id=e.episode_id AND ((r.source_table='episode_intelligence' AND r.kind='summary') OR (r.source_table='episode_intelligence_items' AND r.kind='item')) AND ${searchVisibilityPredicate("research")}) THEN 1 ELSE 0 END AS has_intelligence,
  CASE WHEN EXISTS(SELECT 1 FROM vector_documents v WHERE v.source_id=e.episode_id AND v.source_type IN ('episode_transcript','episode_intelligence') AND v.status='verified' AND ${HYDRATED_VECTOR} AND ${searchVisibilityPredicate("vector")}) THEN 1 ELSE 0 END AS has_vectors,
  CASE WHEN e.episode_id IN (SELECT episode_id FROM podtrac_episodes WHERE episode_id IS NOT NULL) THEN 1 ELSE 0 END AS has_podtrac`;

const EPISODE_COLUMNS = `e.episode_id,e.title,e.publish_date,e.album,e.category,e.detail,e.source_file,d.document_id,${FLAGS}`;
const VECTOR_EVIDENCE_COLUMNS = `v.vector_id,v.source_table,v.source_custom_id,v.source_type,v.source_id,v.content_subtype,v.content_hash,v.chunk_index,v.published_day,v.embedding_model,v.dimensions,v.status,v.record_id,v.source_field,v.source_location,v.authoritative_text,v.metadata_json,v.processing_revision_hash,v.processing_visibility_state`;

function filters(parts: string[], values: unknown[], input: ReturnType<typeof inputFields>): void {
  if (input.episode !== undefined) { parts.push("e.episode_id=?"); values.push(input.episode); }
  if (input.from !== undefined) { parts.push("e.publish_date>=?"); values.push(input.from); }
  if (input.to !== undefined) { parts.push("e.publish_date<=?"); values.push(input.to); }
}

function sortSql(sort: ResearchSort): string {
  if (sort === "date_desc") return "CASE WHEN e.publish_date='' THEN 1 ELSE 0 END,e.publish_date DESC,e.episode_id ASC";
  if (sort === "date_asc") return "CASE WHEN e.publish_date='' THEN 1 ELSE 0 END,e.publish_date ASC,e.episode_id ASC";
  if (sort === "title_asc") return "lower(e.title) ASC,e.title ASC,e.episode_id ASC";
  return "score DESC,CASE WHEN e.publish_date='' THEN 1 ELSE 0 END,e.publish_date DESC,e.title ASC,e.episode_id ASC";
}

const encoder = new TextEncoder();

function binaryCompare(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

function compareEpisodes(left: EpisodeSearchHit, right: EpisodeSearchHit, sort: ResearchSort): number {
  const emptyDate = Number(!left.publishDate) - Number(!right.publishDate);
  if (sort === "date_asc") return emptyDate || binaryCompare(left.publishDate, right.publishDate) || binaryCompare(left.trackId, right.trackId);
  if (sort === "date_desc") return emptyDate || binaryCompare(right.publishDate, left.publishDate) || binaryCompare(left.trackId, right.trackId);
  if (sort === "title_asc") return binaryCompare(asciiLower(left.title), asciiLower(right.title)) || binaryCompare(left.title, right.title) || binaryCompare(left.trackId, right.trackId);
  return right.score - left.score || emptyDate || binaryCompare(right.publishDate, left.publishDate) || binaryCompare(left.title, right.title) || binaryCompare(left.trackId, right.trackId);
}

function mapEpisode(row: Row, hitTypes: readonly string[], snippet: string, score: number): EpisodeSearchHit {
  const trackId = stringValue(row, "episode_id");
  if (!EPISODE_ID.test(trackId) || !stringValue(row, "document_id")) throw unavailable();
  const publishDate = stringValue(row, "publish_date", true);
  if (publishDate && !canonicalDate(publishDate)) throw unavailable();
  return {
    trackId: trackId as EpisodeId,
    title: stringValue(row, "title", true),
    publishDate,
    album: stringValue(row, "album", true),
    category: stringValue(row, "category", true),
    detail: stringValue(row, "detail", true),
    sourceFile: stringValue(row, "source_file", true),
    hasTranscript: booleanFlag(row, "has_transcript"),
    hasIntelligence: booleanFlag(row, "has_intelligence"),
    hasVectors: booleanFlag(row, "has_vectors"),
    hasPodtrac: booleanFlag(row, "has_podtrac"),
    hitTypes,
    snippet,
    score,
  };
}

function scopePredicate(scope: ResearchScope): string {
  if (scope === "passage") return "(r.kind='summary' OR r.kind='segment' OR (r.kind='item' AND r.item_type='scripture_references'))";
  if (scope === "guest") return "(r.kind='summary' OR r.kind='segment' OR (r.kind='item' AND r.item_type IN ('people_mentioned','interviews')))";
  if (scope === "interview") return "(r.kind='summary' OR r.kind='segment' OR (r.kind='item' AND r.item_type='interviews'))";
  if (scope === "theme") return "(r.kind='summary' OR r.kind='segment' OR (r.kind='item' AND r.item_type IN ('sermon_illustrations','stories','notable_quotes')))";
  return "r.kind IN ('summary','item','segment')";
}

class D1ResearchSourceRepository implements ResearchSourceRepository {
  readonly #db: D1Database;
  readonly #access: SearchCorpusAccess;

  constructor(options: D1ResearchSourceRepositoryOptions) {
    assertSearchAccess(options.access);
    this.#db = options.db;
    this.#access = options.access;
  }

  #public(): boolean { return this.#access.kind === "public-published"; }

  async #ready(context: OperationContext, deadline: number): Promise<void> {
    const rows = await readRows(this.#db, "SELECT COUNT(*) AS total FROM research_sources", [], context, deadline);
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0]?.total) || (rows[0]?.total as number) < 1) throw unavailable();
  }

  async #sources(context: OperationContext, deadline: number, sql: string, values: readonly unknown[]): Promise<readonly ResearchSource[]> {
    const rows = await readRows(this.#db, sql, values, context, deadline);
    const sources: ResearchSource[] = [];
    for (const row of rows) {
      ensureActive(context, deadline);
      sources.push(await mapSource(row));
      ensureActive(context, deadline);
    }
    return sources;
  }

  async #validateEvidence(context: OperationContext, deadline: number, rows: readonly Row[]): Promise<void> {
    const expected = new Map<string, Set<string>>();
    const vectors = new Set<string>();
    for (const row of rows) {
      const id = stringValue(row, "episode_id");
      const kinds = expected.get(id) ?? new Set<string>();
      if (booleanFlag(row, "has_transcript")) kinds.add("segment");
      if (booleanFlag(row, "has_intelligence")) kinds.add("intelligence");
      if (kinds.size > 0) expected.set(id, kinds);
      if (booleanFlag(row, "has_vectors")) vectors.add(id);
    }
    const ids = [...expected.keys()];
    if (ids.length > 0) {
      const sql = `WITH witnesses AS (
      SELECT r.episode_id,CASE WHEN r.kind='segment' THEN 'segment' ELSE 'intelligence' END AS evidence_kind,MIN(r.source_key) AS source_key
        FROM research_sources r
       WHERE r.episode_id IN (${ids.map(() => "?").join(",")})
         AND (r.kind='segment' OR r.kind='summary' OR (r.kind='item' AND r.source_table='episode_intelligence_items'))
         AND ${searchVisibilityPredicate("research")}
       GROUP BY r.episode_id,evidence_kind)
      SELECT ${SOURCE_COLUMNS},0 AS score,w.evidence_kind FROM witnesses w JOIN research_sources r ON r.source_key=w.source_key JOIN episodes e ON e.episode_id=r.episode_id LEFT JOIN episode_documents d ON d.episode_id=e.episode_id`;
      const evidence = await readRows(this.#db, sql, ids, context, deadline);
      for (const row of evidence) {
        ensureActive(context, deadline);
        await mapSource(row);
        ensureActive(context, deadline);
        expected.get(stringValue(row, "episode_id"))?.delete(stringValue(row, "evidence_kind"));
      }
      if ([...expected.values()].some((kinds) => kinds.size > 0)) throw unavailable();
    }
    if (vectors.size === 0) return;
    const vectorIds = [...vectors];
    const sql = `WITH witnesses AS (
      SELECT v.source_id,MIN(v.vector_id) AS vector_id FROM vector_documents v
       WHERE v.source_id IN (${vectorIds.map(() => "?").join(",")})
         AND v.source_type IN ('episode_transcript','episode_intelligence') AND v.status='verified'
         AND ${HYDRATED_VECTOR} AND ${searchVisibilityPredicate("vector")} GROUP BY v.source_id)
      SELECT ${VECTOR_EVIDENCE_COLUMNS} FROM witnesses w JOIN vector_documents v ON v.vector_id=w.vector_id`;
    const evidence = await readRows(this.#db, sql, vectorIds, context, deadline);
    for (const row of evidence) {
      ensureActive(context, deadline);
      await validateSearchHydrationEvidence(row);
      ensureActive(context, deadline);
      vectors.delete(stringValue(row, "source_id"));
    }
    if (vectors.size > 0) throw unavailable();
  }

  async searchStructured(context: OperationContext, query: string, requestedLimit: number): Promise<readonly ResearchSource[]> {
    const q = ftsQuery(query);
    const bounded = limit(requestedLimit, 60, "limit");
    if (this.#public() || bounded === 0 || !q.raw) return [];
    const deadline = stageDeadline(context);
    await this.#ready(context, deadline);
    return this.#sources(context, deadline, sourceBase("r.kind IN ('summary','item')", "score DESC,r.publish_date DESC,r.source_key ASC"), [q.match, bounded]);
  }

  async listInterviewInventory(context: OperationContext, requestedLimit: number): Promise<readonly ResearchSource[]> {
    const bounded = limit(requestedLimit, 120, "limit");
    if (this.#public() || bounded === 0) return [];
    const deadline = stageDeadline(context);
    await this.#ready(context, deadline);
    const sql = `SELECT ${SOURCE_COLUMNS},0.72 AS score FROM research_sources r JOIN episodes e ON e.episode_id=r.episode_id LEFT JOIN episode_documents d ON d.episode_id=e.episode_id WHERE r.kind='item' AND r.item_type='interviews' AND ${searchVisibilityPredicate("research")} ORDER BY e.publish_date DESC,e.title ASC,r.source_key ASC LIMIT ?`;
    return this.#sources(context, deadline, sql, [bounded]);
  }

  async getSummaries(context: OperationContext, ids: readonly EpisodeId[]): Promise<readonly ResearchSource[]> {
    const selected = episodeIds(ids, 12);
    if (this.#public() || selected.length === 0) return [];
    const deadline = stageDeadline(context);
    await this.#ready(context, deadline);
    const sql = `SELECT ${SOURCE_COLUMNS},0.7 AS score FROM research_sources r JOIN episodes e ON e.episode_id=r.episode_id LEFT JOIN episode_documents d ON d.episode_id=e.episode_id WHERE r.kind='summary' AND r.episode_id IN (${selected.map(() => "?").join(",")}) AND ${searchVisibilityPredicate("research")} ORDER BY CASE r.episode_id ${selected.map((_, index) => `WHEN ? THEN ${index}`).join(" ")} END,r.source_key ASC LIMIT ?`;
    return this.#sources(context, deadline, sql, [...selected, ...selected, selected.length]);
  }

  async getTranscriptDetails(context: OperationContext, query: string, ids: readonly EpisodeId[], requestedLimit: number): Promise<readonly ResearchSource[]> {
    const selected = episodeIds(ids, 20);
    const bounded = limit(requestedLimit, 60, "limit");
    const q = ftsQuery(query);
    if (this.#public() || selected.length === 0 || bounded === 0 || !q.raw) return [];
    const deadline = stageDeadline(context);
    await this.#ready(context, deadline);
    const placeholders = selected.map(() => "?").join(",");
    const sql = `WITH hits AS (
      SELECT r.episode_id,r.sequence_number,-bm25(research_sources_fts) AS score
        FROM research_sources_fts JOIN research_sources r ON r.rowid=research_sources_fts.rowid
       WHERE research_sources_fts MATCH ? AND r.kind='segment' AND r.episode_id IN (${placeholders}) AND ${searchVisibilityPredicate("research")}
       ORDER BY score DESC,r.episode_id,r.sequence_number LIMIT 20)
      SELECT ${SOURCE_COLUMNS},MAX(h.score) AS score FROM hits h JOIN research_sources r ON r.episode_id=h.episode_id AND r.kind='segment' AND r.sequence_number BETWEEN h.sequence_number-1 AND h.sequence_number+1
      JOIN episodes e ON e.episode_id=r.episode_id LEFT JOIN episode_documents d ON d.episode_id=e.episode_id
      WHERE ${searchVisibilityPredicate("research")} GROUP BY r.source_key ORDER BY score DESC,r.episode_id,r.sequence_number,r.source_key LIMIT ?`;
    return this.#sources(context, deadline, sql, [q.match, ...selected, bounded]);
  }

  async searchEpisodes(context: OperationContext, input: EpisodeSearchInput): Promise<readonly EpisodeSearchHit[]> {
    const normalized = inputFields(input);
    const q = ftsQuery(input.query);
    if (!q.raw) return this.listEpisodes(context, input);
    if (this.#public() || normalized.limit === 0) return [];
    const deadline = stageDeadline(context);
    await this.#ready(context, deadline);
    const merged = new Map<string, EpisodeSearchHit>();
    const canonicalWhere = [canonicalEpisodeVisibilityPredicate(), "(INSTR(lower(e.title),lower(?))>0 OR INSTR(lower(e.detail),lower(?))>0)"];
    const canonicalValues: unknown[] = [q.raw, q.raw];
    filters(canonicalWhere, canonicalValues, normalized);
    const canonicalRows = await readRows(this.#db, `SELECT ${EPISODE_COLUMNS},0.25 AS score FROM episodes e LEFT JOIN episode_documents d ON d.episode_id=e.episode_id WHERE ${canonicalWhere.join(" AND ")} ORDER BY ${sortSql(normalized.sort)} LIMIT ?`, [...canonicalValues, normalized.limit], context, deadline);
    await this.#validateEvidence(context, deadline, canonicalRows);
    for (const row of canonicalRows) {
      const hit = mapEpisode(row, ["episode.title_or_detail"], stringValue(row, "title", true), 0.25);
      merged.set(hit.trackId, hit);
    }
    if (normalized.scope !== "title") {
      const sourceWhere = [canonicalEpisodeVisibilityPredicate(), scopePredicate(normalized.scope)];
      const sourceValues: unknown[] = [q.match];
      filters(sourceWhere, sourceValues, normalized);
      const hitType = "CASE WHEN r.kind='summary' THEN 'intelligence.summary' WHEN r.kind='item' THEN 'intelligence.item.'||r.item_type ELSE 'transcript.match' END";
      const sql = `WITH matches AS MATERIALIZED (
        SELECT r.source_key,r.episode_id,${hitType} AS hit_type,-bm25(research_sources_fts) AS score
          FROM research_sources_fts JOIN research_sources r ON r.rowid=research_sources_fts.rowid JOIN episodes e ON e.episode_id=r.episode_id
         WHERE research_sources_fts MATCH ? AND ${searchVisibilityPredicate("research")} AND ${sourceWhere.join(" AND ")}),
      episode_matches AS (
        SELECT episode_id,MAX(score) AS score,GROUP_CONCAT(DISTINCT hit_type) AS hit_types FROM matches GROUP BY episode_id),
      candidates AS MATERIALIZED (
        SELECT m.episode_id,m.score,m.hit_types FROM episode_matches m JOIN episodes e ON e.episode_id=m.episode_id
         ORDER BY ${sortSql(normalized.sort)} LIMIT ?),
      witnesses AS (
        SELECT c.episode_id,c.score,c.hit_types,MIN(m.source_key) AS source_key FROM candidates c JOIN matches m ON m.episode_id=c.episode_id AND m.score=c.score
         GROUP BY c.episode_id,c.score,c.hit_types)
      SELECT ${SOURCE_COLUMNS},e.title,e.publish_date,e.album,e.category,e.detail,e.source_file,${FLAGS},w.score,w.hit_types
        FROM witnesses w JOIN research_sources r ON r.source_key=w.source_key JOIN episodes e ON e.episode_id=w.episode_id LEFT JOIN episode_documents d ON d.episode_id=e.episode_id
       ORDER BY ${sortSql(normalized.sort)}`;
      const rows = await readRows(this.#db, sql, [...sourceValues, normalized.limit], context, deadline);
      await this.#validateEvidence(context, deadline, rows);
      for (const row of rows) {
        ensureActive(context, deadline);
        const source = await mapSource(row);
        ensureActive(context, deadline);
        const hitTypes = stringValue(row, "hit_types").split(",").sort();
        if (hitTypes.length === 0 || new Set(hitTypes).size !== hitTypes.length || hitTypes.some((value) => value !== "intelligence.summary" && value !== "transcript.match" && !value.startsWith("intelligence.item."))) throw unavailable();
        const candidate = mapEpisode(row, hitTypes, source.text, source.score);
        const existing = merged.get(candidate.trackId);
        if (!existing) merged.set(candidate.trackId, candidate);
        else {
          const mergedTypes = [...new Set([...existing.hitTypes, ...candidate.hitTypes])];
          merged.set(candidate.trackId, { ...existing, hitTypes: mergedTypes, snippet: existing.snippet || candidate.snippet, score: Math.max(existing.score, candidate.score) });
        }
      }
    }
    const rows = [...merged.values()];
    rows.sort((left, right) => compareEpisodes(left, right, normalized.sort));
    return rows.slice(0, normalized.limit);
  }

  async listEpisodes(context: OperationContext, input: Omit<EpisodeSearchInput, "query">): Promise<readonly EpisodeSearchHit[]> {
    const normalized = inputFields(input);
    if (this.#public() || normalized.limit === 0) return [];
    const deadline = stageDeadline(context);
    await this.#ready(context, deadline);
    const where = [canonicalEpisodeVisibilityPredicate()];
    const values: unknown[] = [];
    filters(where, values, normalized);
    const rows = await readRows(this.#db, `SELECT ${EPISODE_COLUMNS},0 AS score FROM episodes e LEFT JOIN episode_documents d ON d.episode_id=e.episode_id WHERE ${where.join(" AND ")} ORDER BY ${sortSql(normalized.sort)} LIMIT ?`, [...values, normalized.limit], context, deadline);
    await this.#validateEvidence(context, deadline, rows);
    return rows.map((row) => mapEpisode(row, [], "", 0));
  }
}

export function createD1ResearchSourceRepository(options: D1ResearchSourceRepositoryOptions): ResearchSourceRepository {
  return new D1ResearchSourceRepository(options);
}

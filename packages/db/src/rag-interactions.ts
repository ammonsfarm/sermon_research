import {
  assertRepositoryPageRequest,
  ServiceError,
  type ArticleId,
  type EpisodeId,
  type IsoDateTime,
  type OpaqueCursor,
  type OperationContext,
  type PageResult,
  type RagHistoryPageRequest,
  type RagInteractionRecord,
  type RagInteractionRepository,
  type RagInteractionScope,
  type ResearchCitation,
  type RetrievalCitation,
  type UserId,
  type VectorId,
} from "@aic/contracts";
import type { D1Database, D1Result } from "./index.ts";

export interface D1RagInteractionRepositoryOptions {
  readonly db: D1Database;
  /** Stable Clerk subject, intentionally not users.user_id. */
  readonly userId: UserId;
}

const HISTORY_TIMEOUT_MS = 2_000;
const MAX_ROW_BYTES = 96 * 1024;
const MAX_SOURCES = 120;
const MAX_QUESTION_CHARS = 8_000;
const MAX_ANSWER_BYTES = 16_384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SCOPES = new Set<RagInteractionScope>(["research", "archive", "episode", "writing"]);
const STATUSES = new Set(["completed", "failed"]);
const TOKEN = /^[A-Za-z0-9_-]+$/u;
const CREATED_AT_UTC6 = "substr(created_at,1,length(created_at)-1) || substr('000000',1,27-length(created_at)) || 'Z'";

type Row = Record<string, unknown>;
type Cursor = {
  readonly v: 1;
  readonly userId: string;
  readonly filterDigest: string;
  readonly createdAt: string;
  readonly id: string;
};

function invalid(message: string): never {
  throw new ServiceError({ code: "invalid_argument", message });
}

function unavailable(): ServiceError {
  return new ServiceError({
    code: "dependency_unavailable",
    message: "RAG history is temporarily unavailable.",
    retryable: true,
  });
}

function cancelled(): ServiceError {
  return new ServiceError({ code: "cancelled", message: "The RAG history request was cancelled." });
}

function timedOut(): ServiceError {
  return new ServiceError({ code: "timeout", message: "RAG history timed out.", retryable: true });
}

function forbidden(): never {
  throw new ServiceError({ code: "forbidden", message: "RAG history is restricted to the authenticated user." });
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeText(value: unknown, label: string, maxBytes: number, allowEmpty = true): string {
  if (typeof value !== "string" || value.includes("\0") || !allowEmpty && value.length === 0 || utf8Bytes(value) > maxBytes) invalid(`${label} is invalid.`);
  return value;
}

function persistedText(row: Row, key: string, maxBytes: number, allowEmpty = true): string {
  const value = row[key];
  if (typeof value !== "string" || value.includes("\0") || !allowEmpty && value.length === 0 || utf8Bytes(value) > maxBytes) throw unavailable();
  return value;
}

function stableUserId(value: unknown): string {
  return safeText(value, "userId", 512, false);
}

function stableEpisodeId(value: unknown, input: boolean): string {
  const candidate = typeof value === "string" ? value : "";
  if (!/^(?:\d+|sa_\d+|wp-sermon:\d+|cms_[A-Za-z0-9_-]+)$/u.test(candidate)) {
    if (input) invalid("trackId is invalid.");
    throw unavailable();
  }
  return candidate;
}

function stableArticleId(value: unknown, input: boolean): string {
  const candidate = typeof value === "string" ? value : "";
  if (!/^(?:pastorwood:[1-9]\d*|cms:[A-Za-z0-9._-]+)$/u.test(candidate)) {
    if (input) invalid("articleId is invalid.");
    throw unavailable();
  }
  return candidate;
}

function utcTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value);
  const parsed = Date.parse(value);
  const date = Number.isFinite(parsed) ? new Date(parsed) : null;
  return match !== null && date !== null && date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]) && date.getUTCHours() === Number(match[4])
    && date.getUTCMinutes() === Number(match[5]) && date.getUTCSeconds() === Number(match[6]);
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !utcTimestamp(value)) return null;
  const fraction = /\.(\d{3,6})Z$/u.exec(value);
  if (fraction === null) return null;
  return `${value.slice(0, 20)}${fraction[1]!.padEnd(6, "0")}Z`;
}

function timestamp(value: unknown, input: boolean): string {
  const canonical = canonicalTimestamp(value);
  if (canonical === null) {
    if (input) invalid("createdAt must be a UTC timestamp.");
    throw unavailable();
  }
  return canonical;
}

function safeInteger(value: unknown, label: string, input: boolean): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    if (input) invalid(`${label} must be a nonnegative integer.`);
    throw unavailable();
  }
  return value as number;
}

function safeUrl(value: unknown, input: boolean): string {
  const fail = () => {
    if (input) invalid("citation canonicalUrl is invalid.");
    throw unavailable();
  };
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > 2_048 || /[\u0000-\u001F\u007F]/u.test(value)) return fail();
  if (value.startsWith("/")) {
    if (value.startsWith("//") || value.includes("\\")) return fail();
    return value;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return fail();
    return url.href;
  } catch {
    return fail();
  }
}

function citation(value: unknown, input: boolean): RetrievalCitation {
  const fail = () => {
    if (input) invalid("citation is invalid.");
    throw unavailable();
  };
  if (!isRecord(value)) return fail();
  const vectorId = value.vectorId;
  const sourceId = value.sourceId;
  if (typeof vectorId !== "string" || !/^[tia]\/.+/u.test(vectorId) || utf8Bytes(vectorId) > 64 || typeof sourceId !== "string" || sourceId.length === 0 || utf8Bytes(sourceId) > 512) return fail();
  return { vectorId: vectorId as VectorId, sourceId: sourceId as ArticleId | EpisodeId, canonicalUrl: safeUrl(value.canonicalUrl, input) };
}

function researchCitation(value: unknown, input: boolean): ResearchCitation {
  const fail = () => {
    if (input) invalid("research citation is invalid.");
    throw unavailable();
  };
  if (!isRecord(value)) return fail();
  if (value.kind === "vector") return { kind: "vector", citation: citation(value.citation, input) };
  if (value.kind === "record" && typeof value.key === "string" && value.key.length > 0 && utf8Bytes(value.key) <= 512 && typeof value.sourceId === "string" && value.sourceId.length > 0 && utf8Bytes(value.sourceId) <= 512) {
    return { kind: "record", key: value.key, sourceId: value.sourceId as ArticleId | EpisodeId, canonicalUrl: safeUrl(value.canonicalUrl, input) };
  }
  return fail();
}

function boundedArray<T>(value: unknown, label: string, convert: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCES) invalid(`${label} must contain at most 120 entries.`);
  return value.map(convert);
}

function jsonArray(row: Row, key: string): unknown[] {
  const raw = persistedText(row, key, MAX_ROW_BYTES);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw unavailable(); }
  if (!Array.isArray(value) || value.length > MAX_SOURCES) throw unavailable();
  return value;
}

function stageDeadline(context: OperationContext): number {
  const local = Date.now() + HISTORY_TIMEOUT_MS;
  if (context.deadline === undefined) return local;
  if (!utcTimestamp(context.deadline)) invalid("Operation deadline is invalid.");
  const incoming = Date.parse(context.deadline);
  return Math.min(local, incoming);
}

async function d1Call<T>(operation: () => Promise<T>, context: OperationContext, deadline: number): Promise<T> {
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
        operation().then(
          (result) => settle(() => resolve(result)),
          () => settle(() => reject(unavailable())),
        );
      } catch {
        settle(() => reject(unavailable()));
      }
    });
  });
}

function toBase64Url(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): string {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(`${standard}${"=".repeat((4 - standard.length % 4) % 4)}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function encodeCursor(input: Omit<Cursor, "v">): OpaqueCursor {
  return toBase64Url(JSON.stringify({ v: 1, ...input })) as OpaqueCursor;
}

function decodeCursor(value: OpaqueCursor | undefined, userId: string, filterDigest: string): { readonly createdAt: string; readonly id: string } | null {
  if (value === undefined) return null;
  const token = String(value);
  if (!token || token.length > 4_096 || !TOKEN.test(token)) invalid("RAG history cursor is malformed.");
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(token));
    if (!isRecord(parsed) || Object.keys(parsed).join(",") !== "v,userId,filterDigest,createdAt,id" || parsed.v !== 1 || typeof parsed.userId !== "string" || typeof parsed.filterDigest !== "string" || typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") invalid("RAG history cursor is malformed.");
    if (parsed.userId !== userId) forbidden();
    if (parsed.filterDigest !== filterDigest) invalid("RAG history cursor does not match the current filters.");
    const createdAt = timestamp(parsed.createdAt, true);
    safeText(parsed.id, "cursor id", 512, false);
    if (encodeCursor({ userId, filterDigest, createdAt: parsed.createdAt, id: parsed.id }) !== token) invalid("RAG history cursor is malformed.");
    return { createdAt, id: parsed.id };
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    invalid("RAG history cursor is malformed.");
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeFilters(page: RagHistoryPageRequest): { readonly scope: RagInteractionScope | null; readonly trackId: string | null; readonly articleId: string | null } {
  const scope = page.scope;
  if (scope !== undefined && !SCOPES.has(scope)) invalid("RAG history scope is invalid.");
  const trackId = page.trackId === undefined ? null : stableEpisodeId(page.trackId, true);
  const articleId = page.articleId === undefined ? null : stableArticleId(page.articleId, true);
  if (trackId !== null && articleId !== null) invalid("RAG history filters may select only one target.");
  return { scope: scope ?? null, trackId, articleId };
}

function parseHistoryRow(row: Row, expectedUser: string): RagInteractionRecord {
  if (persistedText(row, "clerk_user_id", 512, false) !== expectedUser) throw unavailable();
  const id = persistedText(row, "id", 512, false);
  const scope = persistedText(row, "scope", 32, false);
  const status = persistedText(row, "status", 32, false);
  if (!SCOPES.has(scope as RagInteractionScope) || !STATUSES.has(status)) throw unavailable();
  const trackId = row.track_id === null ? null : stableEpisodeId(persistedText(row, "track_id", 512, false), false);
  const articleId = row.article_id === null ? null : stableArticleId(persistedText(row, "article_id", 512, false), false);
  if (trackId !== null && articleId !== null) throw unavailable();
  const storedSources = jsonArray(row, "sources_json");
  const isResearch = storedSources.every((item) => isRecord(item) && (item.kind === "vector" || item.kind === "record"));
  const research = isResearch ? storedSources.map((item) => researchCitation(item, false)) : undefined;
  const citations = isResearch
    ? research!.flatMap((item) => item.kind === "vector" ? [item.citation] : [])
    : storedSources.map((item) => citation(item, false));
  const lanes = jsonArray(row, "retrieval_lanes_json");
  if (lanes.some((item) => typeof item !== "string" || item.includes("\0") || utf8Bytes(item) > 256)) throw unavailable();
  const episodeIds = jsonArray(row, "top_episode_ids_json");
  if (episodeIds.some((item) => typeof item !== "string" || item.length === 0 || item.includes("\0") || utf8Bytes(item) > 512)) throw unavailable();
  const question = persistedText(row, "question", 64_000, false);
  if ([...question].length > MAX_QUESTION_CHARS) throw unavailable();
  return {
    userId: expectedUser as UserId,
    question,
    answer: persistedText(row, "answer", MAX_ANSWER_BYTES),
    citations,
    createdAt: timestamp(row.created_at, false) as IsoDateTime,
    id,
    scope: scope as RagInteractionScope,
    ...(trackId === null ? {} : { trackId: trackId as EpisodeId }),
    ...(articleId === null ? {} : { articleId: articleId as ArticleId }),
    provider: persistedText(row, "provider", 256),
    model: persistedText(row, "model", 256),
    topK: safeInteger(row.top_k, "topK", false),
    status: status as "completed" | "failed",
    error: persistedText(row, "error", 16_384),
    durationMs: safeInteger(row.duration_ms, "durationMs", false),
    sources: citations,
    ...(research === undefined ? {} : { researchCitations: research }),
    retrievalLanes: lanes as string[],
    topEpisodeIds: episodeIds as EpisodeId[],
    coverageNote: persistedText(row, "coverage_note", 16_384),
    totalTokens: safeInteger(row.total_tokens, "totalTokens", false),
    inputTokens: safeInteger(row.input_tokens, "inputTokens", false),
    outputTokens: safeInteger(row.output_tokens, "outputTokens", false),
  };
}

class D1RagInteractionRepository implements RagInteractionRepository {
  readonly #db: D1Database;
  readonly #userId: string;

  constructor(options: D1RagInteractionRepositoryOptions) {
    this.#db = options.db;
    this.#userId = stableUserId(options.userId);
  }

  async append(context: OperationContext, interaction: RagInteractionRecord): Promise<void> {
    if (!isRecord(interaction) || stableUserId(interaction.userId) !== this.#userId) forbidden();
    const id = interaction.id === undefined ? crypto.randomUUID() : safeText(interaction.id, "interaction id", 64, false);
    if (!UUID.test(id)) invalid("interaction id must be a UUID.");
    const question = safeText(interaction.question, "question", 64_000, false);
    if ([...question].length > MAX_QUESTION_CHARS) invalid("question is too long.");
    const answer = safeText(interaction.answer, "answer", MAX_ANSWER_BYTES);
    const citations = boundedArray(interaction.citations, "citations", (item) => citation(item, true));
    const sources = interaction.sources === undefined ? citations : boundedArray(interaction.sources, "sources", (item) => citation(item, true));
    const research = interaction.researchCitations === undefined ? undefined : boundedArray(interaction.researchCitations, "researchCitations", (item) => researchCitation(item, true));
    if (JSON.stringify(sources) !== JSON.stringify(citations)) invalid("sources must preserve the interaction citations.");
    if (research !== undefined && JSON.stringify(research.flatMap((item) => item.kind === "vector" ? [item.citation] : [])) !== JSON.stringify(citations)) invalid("researchCitations must preserve the interaction citations.");
    const storedSources = research ?? sources;
    const scope = interaction.scope ?? "archive";
    const status = interaction.status ?? "completed";
    if (!SCOPES.has(scope)) invalid("scope is invalid.");
    if (!STATUSES.has(status)) invalid("status is invalid.");
    const trackId = interaction.trackId === undefined ? null : stableEpisodeId(interaction.trackId, true);
    const articleId = interaction.articleId === undefined ? null : stableArticleId(interaction.articleId, true);
    if (trackId !== null && articleId !== null) invalid("an interaction may target only one source.");
    if (scope === "episode" && trackId === null || scope === "writing" && articleId === null || scope !== "episode" && trackId !== null || scope !== "writing" && articleId !== null) invalid("scope and target do not match.");
    const provider = safeText(interaction.provider ?? "", "provider", 256);
    const model = safeText(interaction.model ?? "", "model", 256);
    const topK = safeInteger(interaction.topK ?? 0, "topK", true);
    if (topK > 100) invalid("topK must not exceed 100.");
    const error = safeText(interaction.error ?? "", "error", 16_384);
    const durationMs = safeInteger(interaction.durationMs ?? 0, "durationMs", true);
    const totalTokens = safeInteger(interaction.totalTokens ?? 0, "totalTokens", true);
    const inputTokens = safeInteger(interaction.inputTokens ?? 0, "inputTokens", true);
    const outputTokens = safeInteger(interaction.outputTokens ?? 0, "outputTokens", true);
    const retrievalLanes = boundedArray(interaction.retrievalLanes ?? [], "retrievalLanes", (item) => safeText(item, "retrieval lane", 256, false));
    const topEpisodeIds = boundedArray(interaction.topEpisodeIds ?? [], "topEpisodeIds", (item) => safeText(item, "top episode ID", 512, false));
    const coverageNote = safeText(interaction.coverageNote ?? "", "coverageNote", 16_384);
    const createdAt = timestamp(interaction.createdAt, true);
    const sourcesJson = JSON.stringify(storedSources);
    const lanesJson = JSON.stringify(retrievalLanes);
    const episodeIdsJson = JSON.stringify(topEpisodeIds);
    if (utf8Bytes(JSON.stringify({ id, userId: this.#userId, scope, trackId, articleId, question, answer, provider, model, topK, lanesJson, sourcesJson, episodeIdsJson, coverageNote, status, error, durationMs, totalTokens, inputTokens, outputTokens, createdAt })) > MAX_ROW_BYTES) invalid("interaction exceeds the 96 KiB storage limit.");
    const deadline = stageDeadline(context);
    let statement;
    try {
      statement = this.#db.prepare(`
        INSERT INTO rag_interactions (
          id, clerk_user_id, scope, track_id, article_id, question, answer,
          provider, model, top_k, retrieval_lanes_json, sources_json,
          top_episode_ids_json, coverage_note, status, error, duration_ms,
          total_tokens, input_tokens, output_tokens, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        id, this.#userId, scope, trackId, articleId, question, answer,
        provider, model, topK, lanesJson, sourcesJson, episodeIdsJson,
        coverageNote, status, error, durationMs, totalTokens, inputTokens,
        outputTokens, createdAt,
      );
    } catch {
      throw unavailable();
    }
    const result = await d1Call<D1Result>(() => statement.run(), context, deadline);
    if (!result || result.success !== true || result.meta?.changes !== 1) throw unavailable();
  }

  async listForUser(context: OperationContext, userId: UserId, page: RagHistoryPageRequest): Promise<PageResult<RagInteractionRecord>> {
    if (stableUserId(userId) !== this.#userId) forbidden();
    assertRepositoryPageRequest(page);
    const filters = normalizeFilters(page);
    const filterDigest = await sha256(JSON.stringify(filters));
    const cursor = decodeCursor(page.cursor, this.#userId, filterDigest);
    const clauses = ["clerk_user_id = ?"];
    const values: unknown[] = [this.#userId];
    if (filters.scope !== null) { clauses.push("scope = ?"); values.push(filters.scope); }
    if (filters.trackId !== null) { clauses.push("track_id = ?"); values.push(filters.trackId); }
    if (filters.articleId !== null) { clauses.push("article_id = ?"); values.push(filters.articleId); }
    if (cursor !== null) {
      clauses.push(`(${CREATED_AT_UTC6} < ? OR (${CREATED_AT_UTC6} = ? AND id > ?))`);
      values.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    values.push(page.limit + 1);
    const deadline = stageDeadline(context);
    let statement;
    try {
      statement = this.#db.prepare(`
        SELECT id, clerk_user_id, scope, track_id, article_id, question, answer,
               provider, model, top_k, retrieval_lanes_json, sources_json,
               top_episode_ids_json, coverage_note, status, error, duration_ms,
               total_tokens, input_tokens, output_tokens, created_at
          FROM rag_interactions
         WHERE ${clauses.join(" AND ")}
         ORDER BY ${CREATED_AT_UTC6} DESC, id ASC
         LIMIT ?`).bind(...values);
    } catch {
      throw unavailable();
    }
    const result = await d1Call(() => statement.all<Row>(), context, deadline);
    if (!result || result.success !== undefined && result.success !== true || !Array.isArray(result.results) || result.results.some((row) => !isRecord(row))) throw unavailable();
    const rows = result.results;
    const seen = new Set<string>();
    for (const row of rows) {
      const id = persistedText(row, "id", 512, false);
      if (seen.has(id)) throw unavailable();
      seen.add(id);
    }
    const items = rows.slice(0, page.limit).map((row) => parseHistoryRow(row, this.#userId));
    const last = rows[page.limit - 1];
    return rows.length > page.limit && last
      ? { items, nextCursor: encodeCursor({ userId: this.#userId, filterDigest, createdAt: timestamp(last.created_at, false), id: persistedText(last, "id", 512, false) }) }
      : { items };
  }
}

export function createD1RagInteractionRepository(options: D1RagInteractionRepositoryOptions): RagInteractionRepository {
  return new D1RagInteractionRepository(options);
}

import {
  ServiceError,
  httpStatusForError,
  isServiceError,
  toErrorEnvelope,
  type AuthorizationService,
  type Capability,
  type CorrelationId,
  type PageResult,
  type RagHistoryPageRequest,
  type RagInteractionRecord,
  type RagInteractionScope,
  type RequestOperationContext,
  type SessionPrincipal,
  type SessionReader,
} from "../../../packages/contracts/src/index.ts";
import type { EpisodeHybridSearchInput, RagAnswerInput, RagAnswerResult } from "./service.ts";
import { createCorrelationContext } from "@aic/observability";

const MAX_BODY_BYTES = 16_000;
const REQUEST_TIMEOUT_MS = 55_000;
const SPOOFABLE_AUTH_HEADERS = [
  "x-aic-auth-principal", "x-aic-auth-signature", "x-clerk-auth-message",
  "x-clerk-auth-reason", "x-clerk-auth-signature", "x-clerk-auth-status",
  "x-clerk-auth-token", "x-clerk-request-data",
] as const;

class HttpServiceError extends ServiceError {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, options: ConstructorParameters<typeof ServiceError>[0], headers: Readonly<Record<string, string>> = {}) {
    super(options);
    this.status = status;
    this.headers = headers;
  }
}

export interface RagWorkerServices {
  answer(context: RequestOperationContext, input: RagAnswerInput): Promise<RagAnswerResult>;
  history(context: RequestOperationContext, userId: string, page: RagHistoryPageRequest): Promise<PageResult<RagInteractionRecord>>;
  searchEpisodes(context: RequestOperationContext, userId: string, input: EpisodeHybridSearchInput): Promise<unknown>;
  source(context: RequestOperationContext, userId: string, vectorId: string): Promise<RagSourceDetail | null>;
  models(context: RequestOperationContext, userId: string): Promise<RagModelCatalog>;
}

export interface RagModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly isDefault: boolean;
}

/** `registry` when admin-managed models apply to the user; `environment` when the deployment default is used. */
export interface RagModelCatalog {
  readonly source: "registry" | "environment";
  readonly models: readonly RagModelOption[];
}

export interface RagSourceDetail {
  readonly vectorId: string;
  readonly sourceType: string;
  readonly trackId: string;
  readonly title: string;
  readonly text: string;
  readonly sourceUrl: string;
  readonly sourceLocation?: {
    readonly startMs?: number;
    readonly endMs?: number;
    readonly label?: string;
  };
}

export interface RagQuota {
  consume(context: RequestOperationContext, userId: string): Promise<{ readonly allowed: boolean; readonly retryAfterSeconds: number }>;
}

export interface RagWorkerDependencies {
  readonly sessions: SessionReader;
  readonly authorize: AuthorizationService;
  readonly services: RagWorkerServices;
  readonly quota: RagQuota;
  readonly now?: () => number;
  readonly correlationId?: () => string;
}

type RequestScope = { readonly context: RequestOperationContext; readonly close: () => void };

export function sanitizedRagHeaders(headers: Headers): Headers {
  const safe = new Headers(headers);
  for (const name of SPOOFABLE_AUTH_HEADERS) safe.delete(name);
  return safe;
}

function propagatedDeadline(headers: Headers, now: number): number {
  const value = headers.get("x-aic-deadline");
  if (!value) return now + REQUEST_TIMEOUT_MS;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.min(parsed, now + REQUEST_TIMEOUT_MS) : now + REQUEST_TIMEOUT_MS;
}

function requestScope(request: Request, correlationId: string, now: () => number): RequestScope {
  const url = new URL(request.url);
  const startedAt = now();
  const deadlineMs = propagatedDeadline(request.headers, startedAt);
  const controller = new AbortController();
  const cancelled = new ServiceError({ code: "cancelled", message: "The request was cancelled." });
  const timedOut = new ServiceError({ code: "timeout", message: "The request timed out.", retryable: true });
  const onAbort = () => controller.abort(cancelled);
  if (request.signal.aborted) onAbort();
  else request.signal.addEventListener("abort", onAbort, { once: true });
  const remaining = deadlineMs - startedAt;
  const timer = remaining <= 0 ? (controller.abort(timedOut), undefined) : setTimeout(() => controller.abort(timedOut), remaining);
  return {
    context: {
      boundary: "request",
      correlation: { correlationId: correlationId as CorrelationId },
      signal: controller.signal,
      deadline: new Date(deadlineMs).toISOString(),
      request: { method: request.method, path: url.pathname },
    },
    close() {
      if (timer !== undefined) clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    },
  };
}

function responseHeaders(context: RequestOperationContext): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Correlation-Id": context.correlation.correlationId,
  });
}

function jsonResponse(value: unknown, context: RequestOperationContext, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: responseHeaders(context) });
}

/** Error names, codes, and bounded messages along the cause chain; never request bodies or headers. */
export function errorCauseChain(error: unknown, depth = 6): readonly { readonly name: string; readonly code?: string; readonly message: string }[] {
  const chain: { name: string; code?: string; message: string }[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < depth) {
    const item = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    chain.push({
      name: typeof item.name === "string" ? item.name : typeof current,
      ...(typeof item.code === "string" ? { code: item.code } : {}),
      message: typeof item.message === "string" ? item.message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").slice(0, 240) : "",
    });
    current = item.cause;
  }
  return chain;
}

function errorResponse(error: unknown, context: RequestOperationContext): Response {
  const normalized = !isServiceError(error) && context.signal.aborted && isServiceError(context.signal.reason) ? context.signal.reason : error;
  if (!isServiceError(normalized) || normalized.code === "dependency_unavailable" || normalized.code === "internal") {
    console.error(JSON.stringify({ event: "rag.request_failed", correlationId: context.correlation.correlationId, causes: errorCauseChain(normalized) }));
  }
  const headers = responseHeaders(context);
  if (normalized instanceof HttpServiceError) {
    for (const [name, value] of Object.entries(normalized.headers)) headers.set(name, value);
  }
  return new Response(JSON.stringify(toErrorEnvelope(normalized, context.correlation.correlationId)), {
    status: normalized instanceof HttpServiceError ? normalized.status : httpStatusForError(normalized),
    headers,
  });
}

function ensureActive(context: RequestOperationContext): void {
  if (!context.signal.aborted) return;
  throw isServiceError(context.signal.reason) ? context.signal.reason : new ServiceError({ code: "cancelled", message: "The request was cancelled." });
}

function requestOperation<T>(context: RequestOperationContext, operation: () => Promise<T>): Promise<T> {
  ensureActive(context);
  return new Promise((resolve, rejectPromise) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      context.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => settle(() => rejectPromise(isServiceError(context.signal.reason)
      ? context.signal.reason
      : new ServiceError({ code: "cancelled", message: "The request was cancelled." })));
    context.signal.addEventListener("abort", onAbort, { once: true });
    queueMicrotask(() => {
      if (settled) return;
      if (context.signal.aborted) return onAbort();
      try {
        operation().then(
          (value) => settle(() => resolve(value)),
          (error) => settle(() => rejectPromise(error)),
        );
      } catch (error) {
        settle(() => rejectPromise(error));
      }
    });
  });
}

function reject(code: "invalid_argument" | "forbidden" | "not_found", message: string): never {
  throw new ServiceError({ code, message });
}

function methodNotAllowed(allow: string): never {
  throw new HttpServiceError(405, { code: "invalid_argument", message: "Method not allowed." }, { Allow: allow });
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  context: RequestOperationContext,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  ensureActive(context);
  return new Promise((resolve, rejectPromise) => {
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      rejectPromise(isServiceError(context.signal.reason)
        ? context.signal.reason
        : new ServiceError({ code: "cancelled", message: "The request was cancelled." }));
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, rejectPromise).finally(() => {
      context.signal.removeEventListener("abort", onAbort);
    });
  });
}

async function readJsonBody(request: Request, context: RequestOperationContext): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get("content-type") ?? "")) reject("invalid_argument", "Content-Type must be application/json.");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpServiceError(413, { code: "invalid_argument", message: "Request body is too large." });
  if (!request.body) reject("invalid_argument", "A JSON request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      ensureActive(context);
      const { done, value } = await readChunk(reader, context);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpServiceError(413, { code: "invalid_argument", message: "Request body is too large." });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } catch {
    reject("invalid_argument", "Request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("invalid_argument", "Request body must be a JSON object.");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const names = new Set(allowed);
  if (Object.keys(value).some((key) => !names.has(key))) reject("invalid_argument", "Request body contains an unsupported field.");
}

function question(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0")) reject("invalid_argument", "question is required.");
  return value;
}

function optionalInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) reject("invalid_argument", `${name} is invalid.`);
  return value as number;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\0") || value.length > 512) reject("invalid_argument", `${name} is invalid.`);
  return value;
}

function provider(value: unknown): "silo" | "openai" | undefined {
  if (value === undefined) return undefined;
  if (value !== "silo" && value !== "openai") reject("invalid_argument", "provider is invalid.");
  return value;
}

async function requireCapability(dependencies: RagWorkerDependencies, context: RequestOperationContext, principal: SessionPrincipal, capability: Capability): Promise<void> {
  const decision = await requestOperation(context, () => dependencies.authorize.decide(context, principal, { capability }));
  if (decision.kind === "deny") {
    throw new ServiceError({
      code: decision.reason === "unauthenticated" ? "unauthenticated" : "forbidden",
      message: decision.reason === "unauthenticated" ? "Authentication required." : "This role cannot access the requested RAG operation.",
    });
  }
}

async function consumeQuota(dependencies: RagWorkerDependencies, context: RequestOperationContext, userId: string): Promise<void> {
  let result;
  try {
    result = await requestOperation(context, () => dependencies.quota.consume(context, userId));
  } catch (error) {
    if (isServiceError(error) && (error.code === "cancelled" || error.code === "timeout")) throw error;
    if (context.signal.aborted) ensureActive(context);
    throw new ServiceError({ code: "dependency_unavailable", message: "Generation admission is temporarily unavailable.", retryable: true, cause: error });
  }
  if (!result.allowed) {
    throw new HttpServiceError(429, { code: "rate_limited", message: "Too many generation requests. Try again shortly.", retryable: true }, {
      "Retry-After": String(Math.max(1, Math.ceil(result.retryAfterSeconds))),
    });
  }
}

function decodePathPart(value: string, name: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { reject("invalid_argument", `${name} is invalid.`); }
  if (!decoded || decoded.includes("\0") || decoded.length > 512) reject("invalid_argument", `${name} is invalid.`);
  return decoded;
}

function generationPath(pathname: string): { readonly scope: RagAnswerInput["scope"]; readonly target?: string } | null {
  if (pathname === "/api/rag/chat") return { scope: "archive" };
  if (pathname === "/api/research/chat") return { scope: "research" };
  const episode = pathname.match(/^\/api\/episodes\/([^/]+)\/chat$/u)?.[1];
  if (episode) return { scope: "episode", target: decodePathPart(episode, "episode ID") };
  const writing = pathname.match(/^\/api\/writings\/([^/]+)\/chat$/u)?.[1];
  if (writing) return { scope: "writing", target: decodePathPart(writing, "article ID") };
  return null;
}

async function generationResponse(request: Request, context: RequestOperationContext, principal: SessionPrincipal, dependencies: RagWorkerDependencies, route: NonNullable<ReturnType<typeof generationPath>>): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed("POST");
  await requireCapability(dependencies, context, principal, "research:generate");
  const body = await readJsonBody(request, context);
  exactKeys(body, route.scope === "archive" ? ["question", "topK", "trackId", "provider", "model"] : ["question", "topK", "provider", "model"]);
  const topK = optionalInteger(body.topK, "topK", 1, 100);
  const requestedModel = optionalString(body.model, "model");
  const requestedProvider = requestedModel === undefined ? provider(body.provider) : undefined;
  const input: RagAnswerInput = {
    userId: principal.userId,
    scope: route.scope,
    question: question(body.question),
    ...(topK === undefined ? {} : { topK }),
    ...(requestedProvider === undefined ? {} : { provider: requestedProvider }),
    ...(requestedModel === undefined ? {} : { modelId: requestedModel }),
  };
  if (route.scope === "archive") {
    const episodeId = optionalString(body.trackId, "trackId");
    if (episodeId !== undefined) Object.assign(input, { episodeId });
  } else if (route.scope === "episode") Object.assign(input, { episodeId: route.target });
  else if (route.scope === "writing") {
    const target = route.target!;
    if (!/^[1-9]\d*$/u.test(target)) reject("invalid_argument", "article ID is invalid.");
    Object.assign(input, { articleId: `pastorwood:${target}` });
  }
  await consumeQuota(dependencies, context, principal.userId);
  ensureActive(context);
  return jsonResponse(await requestOperation(context, () => dependencies.services.answer(context, input)), context);
}

function strictQuery(url: URL, allowed: readonly string[]): void {
  const names = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!names.has(key) || url.searchParams.getAll(key).length !== 1) reject("invalid_argument", "Query contains an unsupported parameter.");
  }
}

function integerQuery(value: string | null, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === null) return fallback;
  if (!/^\d+$/u.test(value)) reject("invalid_argument", `${name} is invalid.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) reject("invalid_argument", `${name} is invalid.`);
  return parsed;
}

function enumQuery<T extends string>(value: string | null, values: readonly T[], fallback: T, name: string): T {
  if (value === null) return fallback;
  if (!values.includes(value as T)) reject("invalid_argument", `${name} is invalid.`);
  return value as T;
}

async function historyResponse(request: Request, context: RequestOperationContext, principal: SessionPrincipal, dependencies: RagWorkerDependencies): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed("GET");
  const url = new URL(request.url);
  strictQuery(url, ["scope", "trackId", "articleId", "limit", "cursor"]);
  const scope = url.searchParams.get("scope");
  if (scope !== null && !["research", "archive", "episode", "writing"].includes(scope)) reject("invalid_argument", "scope is invalid.");
  const page: RagHistoryPageRequest = {
    limit: integerQuery(url.searchParams.get("limit"), 10, 1, 50, "limit"),
    ...(scope === null ? {} : { scope: scope as RagInteractionScope }),
    ...(url.searchParams.get("trackId") === null ? {} : { trackId: optionalString(url.searchParams.get("trackId"), "trackId") as never }),
    ...(url.searchParams.get("articleId") === null ? {} : { articleId: optionalString(url.searchParams.get("articleId"), "articleId") as never }),
    ...(url.searchParams.get("cursor") === null ? {} : { cursor: optionalString(url.searchParams.get("cursor"), "cursor") as never }),
  };
  const result = await requestOperation(context, () => dependencies.services.history(context, principal.userId, page));
  const history = result.items.map((record) => ({
    id: record.id ?? "",
    scope: record.scope ?? "archive",
    trackId: record.trackId ?? "",
    articleId: record.articleId ?? "",
    question: record.question,
    answer: record.answer,
    provider: record.provider ?? "",
    model: record.model ?? "",
    topK: record.topK ?? 0,
    retrievalLanes: record.retrievalLanes ?? [],
    sources: record.researchCitations ?? record.sources ?? record.citations,
    topEpisodeIds: record.topEpisodeIds ?? [],
    coverageNote: record.coverageNote ?? "",
    usage: {
      total_tokens: record.totalTokens ?? 0,
      input_tokens: record.inputTokens ?? 0,
      output_tokens: record.outputTokens ?? 0,
    },
    status: record.status ?? "completed",
    error: record.error ?? "",
    createdAt: record.createdAt,
  }));
  return jsonResponse({ history, ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) }, context);
}

async function searchResponse(request: Request, context: RequestOperationContext, principal: SessionPrincipal, dependencies: RagWorkerDependencies): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed("GET");
  await requireCapability(dependencies, context, principal, "internal:read");
  const url = new URL(request.url);
  strictQuery(url, ["q", "mode", "text_only", "track_id", "scope", "date_start", "date_end", "sort", "top_k"]);
  const query = url.searchParams.get("q") ?? "";
  if (query.includes("\0") || query.length > 8_000) reject("invalid_argument", "q is invalid.");
  const mode = enumQuery(url.searchParams.get("mode"), ["text", "hybrid"] as const, "hybrid", "mode");
  const textOnly = enumQuery(url.searchParams.get("text_only"), ["0", "1", "false", "true"] as const, "false", "text_only");
  const scope = enumQuery(url.searchParams.get("scope"), ["all", "title", "passage", "guest", "interview", "theme"] as const, "all", "scope");
  const sort = enumQuery(url.searchParams.get("sort"), ["relevance", "date_desc", "date_asc", "title_asc"] as const, "relevance", "sort");
  const date = (name: string) => {
    const value = url.searchParams.get(name);
    if (value !== null && !/^\d{4}-\d{2}-\d{2}$/u.test(value)) reject("invalid_argument", `${name} is invalid.`);
    return value ?? undefined;
  };
  const publishedFrom = date("date_start");
  const publishedTo = date("date_end");
  const episodeId = url.searchParams.get("track_id") ?? undefined;
  const input: EpisodeHybridSearchInput = {
    query,
    limit: integerQuery(url.searchParams.get("top_k"), 40, 1, 80, "top_k"),
    scope,
    sort,
    mode,
    textOnly: textOnly === "1" || textOnly === "true",
    ...(episodeId === undefined ? {} : { episodeId: episodeId as never }),
    ...(publishedFrom === undefined ? {} : { publishedFrom: publishedFrom as never }),
    ...(publishedTo === undefined ? {} : { publishedTo: publishedTo as never }),
  };
  return jsonResponse(await requestOperation(context, () => dependencies.services.searchEpisodes(context, principal.userId, input)), context);
}

async function sourceResponse(request: Request, context: RequestOperationContext, principal: SessionPrincipal, dependencies: RagWorkerDependencies, encodedId: string): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed("GET");
  await requireCapability(dependencies, context, principal, "internal:read");
  strictQuery(new URL(request.url), []);
  const vectorId = decodePathPart(encodedId, "vector ID");
  if (!/^[tia]\/[A-Za-z0-9._:/-]+$/u.test(vectorId)) reject("invalid_argument", "vector ID is invalid.");
  const source = await requestOperation(context, () => dependencies.services.source(context, principal.userId, vectorId));
  if (source === null) reject("not_found", "RAG source not found.");
  return jsonResponse({ source }, context);
}

async function dispatch(request: Request, context: RequestOperationContext, principal: SessionPrincipal, dependencies: RagWorkerDependencies): Promise<Response> {
  ensureActive(context);
  const url = new URL(request.url);
  const generation = generationPath(url.pathname);
  if (generation) return generationResponse(request, context, principal, dependencies, generation);
  if (url.pathname === "/api/rag/history") return historyResponse(request, context, principal, dependencies);
  if (url.pathname === "/api/rag/models") {
    if (request.method !== "GET") methodNotAllowed("GET");
    await requireCapability(dependencies, context, principal, "research:generate");
    return jsonResponse(await requestOperation(context, () => dependencies.services.models(context, principal.userId)), context);
  }
  if (url.pathname === "/api/episodes/search") return searchResponse(request, context, principal, dependencies);
  const source = url.pathname.match(/^\/api\/rag\/sources\/([^/]+)$/u)?.[1];
  if (source) return sourceResponse(request, context, principal, dependencies, source);
  reject("not_found", "RAG endpoint not found.");
}

export function createRagWorker(dependencies: RagWorkerDependencies) {
  return {
    async fetch(request: Request): Promise<Response> {
      const incomingCorrelationId = dependencies.correlationId?.() ?? request.headers.get("x-correlation-id");
      const correlation = createCorrelationContext(incomingCorrelationId ? { incomingCorrelationId } : {});
      const scope = requestScope(request, correlation.correlationId, dependencies.now ?? Date.now);
      try {
        ensureActive(scope.context);
        const session = await requestOperation(scope.context, () => dependencies.sessions.resolve(scope.context, { headers: sanitizedRagHeaders(request.headers) }));
        if (session.kind !== "authenticated") throw new ServiceError({ code: "unauthenticated", message: "Authentication required." });
        return await dispatch(request, scope.context, session.principal, dependencies);
      } catch (error) {
        return errorResponse(error, scope.context);
      } finally {
        scope.close();
      }
    },
  };
}

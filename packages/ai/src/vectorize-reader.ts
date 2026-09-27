import { ServiceError } from "../../contracts/src/errors.ts";
import type { OperationContext } from "../../contracts/src/execution.ts";
import type {
  SemanticSearchMatch,
  SemanticSearchQuery,
  SemanticSearchReader,
} from "../../contracts/src/search.ts";
import {
  ARTICLE_SEARCH_CONTENT_SUBTYPES,
  INTELLIGENCE_SEARCH_CONTENT_SUBTYPES,
} from "../../contracts/src/search.ts";

export interface VectorizeQueryBinding {
  query(values: number[], options: {
    topK: number;
    returnMetadata: "indexed";
    returnValues: false;
    filter?: Record<string, unknown>;
  }): Promise<{ matches: ReadonlyArray<{
    id: string;
    score: number;
    metadata?: Record<string, unknown>;
  }> }>;
}

const DIMENSIONS = 1536;
const MODEL = "text-embedding-3-small";
const MAX_TOP_K = 100;
const MAX_ID_BYTES = 64;
const MAX_FILTER_BYTES = 2048;
const VECTORIZE_TIMEOUT_MS = 5_000;
const SCORE_THRESHOLD = 0.2;
const SOURCE_TYPES = new Set(["episode_transcript", "episode_intelligence", "article"]);
const FILTER_KEYS = new Set(["sourceTypes", "contentSubtypes", "episodeId", "articleId", "publishedFrom", "publishedTo", "contentHash"]);
const ARTICLE_CONTENT_SUBTYPES = new Set<string>(ARTICLE_SEARCH_CONTENT_SUBTYPES);
const INTELLIGENCE_CONTENT_SUBTYPES = new Set<string>(INTELLIGENCE_SEARCH_CONTENT_SUBTYPES);
const HASH_PATTERN = /^[0-9a-fA-F]{64}$/u;
const NORMALIZED_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const EPISODE_ID_PATTERN = /^(?:\d+|sa_\d+|wp-sermon:\d+|cms_[A-Za-z0-9_-]+)$/u;
const ARTICLE_ID_PATTERN = /^(?:pastorwood:[1-9]\d*|cms:[A-Za-z0-9._-]+)$/u;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

type VectorizeMetadata = {
  readonly source_type: "episode_transcript" | "episode_intelligence" | "article";
  readonly source_id: string;
  readonly content_hash: string;
  readonly chunk_index: number;
};

function invalid(message: string): never {
  throw new ServiceError({ code: "invalid_argument", message });
}

function unavailable(cause?: unknown): ServiceError {
  return new ServiceError({
    code: "dependency_unavailable",
    message: "Semantic search is temporarily unavailable.",
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

function cancelled(cause?: unknown): ServiceError {
  return new ServiceError({
    code: "cancelled",
    message: "The semantic search request was cancelled.",
    ...(cause === undefined ? {} : { cause }),
  });
}

function timedOut(): ServiceError {
  return new ServiceError({
    code: "timeout",
    message: "Semantic search timed out.",
    retryable: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertBoundedId(value: unknown, label: string, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || utf8Bytes(value) > MAX_ID_BYTES || !pattern.test(value)) {
    invalid(`${label} is invalid.`);
  }
}

function assertCalendarDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") invalid(`${label} must be an ISO calendar date.`);
  const parts = ISO_DATE_PATTERN.exec(value);
  if (!parts) invalid(`${label} must be an ISO calendar date.`);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) invalid(`${label} must be an ISO calendar date.`);
  const date = new Date(Date.UTC(0, month - 1, day));
  date.setUTCFullYear(year);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    invalid(`${label} must be an ISO calendar date.`);
  }
}

function normalizeHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) invalid(`${label} must be a 64-character SHA-256 hash.`);
  return value.toLowerCase();
}

function validateQuery(query: SemanticSearchQuery): void {
  if (!isRecord(query) || !isRecord(query.embedding)) invalid("Semantic search query is invalid.");
  const { embedding } = query;
  if (
    !Array.isArray(embedding.values)
    || embedding.values.length !== DIMENSIONS
    || embedding.dimensions !== DIMENSIONS
    || embedding.model !== MODEL
    || embedding.values.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    invalid("Embedding must be a finite text-embedding-3-small vector with 1536 dimensions.");
  }
  let sumOfSquares = 0;
  for (const value of embedding.values) sumOfSquares += value * value;
  if (!Number.isFinite(sumOfSquares) || sumOfSquares === 0) invalid("Embedding must have a nonzero finite norm.");
  if (!Number.isSafeInteger(query.topK) || query.topK < 1 || query.topK > MAX_TOP_K) {
    invalid("topK must be an integer from 1 through 100.");
  }
}

function buildFilter(query: SemanticSearchQuery): Record<string, unknown> | undefined {
  const input = query.filter;
  if (input === undefined) return undefined;
  if (!isRecord(input)) invalid("Semantic search filter is invalid.");
  if (Object.keys(input).some((key) => !FILTER_KEYS.has(key))) invalid("Semantic search filter contains an unsupported field.");

  const filter: Record<string, unknown> = {};
  let sourceTypes: string[] | undefined;
  if (input.sourceTypes !== undefined) {
    if (!Array.isArray(input.sourceTypes) || input.sourceTypes.length < 1 || input.sourceTypes.length > 3) {
      invalid("sourceTypes must contain one through three values.");
    }
    sourceTypes = [...new Set(input.sourceTypes)];
    if (sourceTypes.some((value) => typeof value !== "string" || !SOURCE_TYPES.has(value))) {
      invalid("sourceTypes contains an unsupported source type.");
    }
    filter.source_type = { $in: sourceTypes };
  }

  if (input.contentSubtypes !== undefined) {
    if (!Array.isArray(input.contentSubtypes) || input.contentSubtypes.length < 1 || input.contentSubtypes.length > 11) {
      invalid("contentSubtypes must contain one through eleven values.");
    }
    const contentSubtypes = [...new Set(input.contentSubtypes)];
    if (contentSubtypes.some((value) => typeof value !== "string" || !ARTICLE_CONTENT_SUBTYPES.has(value) && !INTELLIGENCE_CONTENT_SUBTYPES.has(value))) {
      invalid("contentSubtypes contains an unsupported content subtype.");
    }
    const hasArticleSubtype = contentSubtypes.some((value) => ARTICLE_CONTENT_SUBTYPES.has(value));
    const hasIntelligenceSubtype = contentSubtypes.some((value) => INTELLIGENCE_CONTENT_SUBTYPES.has(value));
    if (hasArticleSubtype && hasIntelligenceSubtype) invalid("contentSubtypes cannot combine article and intelligence families.");
    if (hasArticleSubtype && sourceTypes?.some((value) => value !== "article")) {
      invalid("Article contentSubtypes require article sourceTypes.");
    }
    if (hasIntelligenceSubtype && sourceTypes?.some((value) => value !== "episode_intelligence")) {
      invalid("Intelligence contentSubtypes require episode_intelligence sourceTypes.");
    }
    if (hasArticleSubtype && input.episodeId !== undefined) invalid("Article contentSubtypes cannot be combined with episodeId.");
    if (hasIntelligenceSubtype && input.articleId !== undefined) invalid("Intelligence contentSubtypes cannot be combined with articleId.");
    filter.content_subtype = { $in: contentSubtypes };
  }

  if (input.episodeId !== undefined && input.articleId !== undefined) invalid("episodeId and articleId cannot be combined.");
  if (input.episodeId !== undefined) {
    assertBoundedId(input.episodeId, "episodeId", EPISODE_ID_PATTERN);
    if (sourceTypes?.includes("article")) invalid("episodeId cannot be combined with article sourceTypes.");
    filter.source_id = { $eq: input.episodeId };
  }
  if (input.articleId !== undefined) {
    assertBoundedId(input.articleId, "articleId", ARTICLE_ID_PATTERN);
    if (sourceTypes && sourceTypes.some((value) => value !== "article")) invalid("articleId requires article sourceTypes.");
    filter.source_id = { $eq: input.articleId };
  }

  if (input.publishedFrom !== undefined) assertCalendarDate(input.publishedFrom, "publishedFrom");
  if (input.publishedTo !== undefined) assertCalendarDate(input.publishedTo, "publishedTo");
  if (input.publishedFrom !== undefined && input.publishedTo !== undefined && input.publishedFrom > input.publishedTo) {
    invalid("publishedFrom must not be after publishedTo.");
  }
  if (input.publishedFrom !== undefined || input.publishedTo !== undefined) {
    filter.published_day = {
      ...(input.publishedFrom === undefined ? {} : { $gte: Number(input.publishedFrom.replaceAll("-", "")) }),
      ...(input.publishedTo === undefined ? {} : { $lte: Number(input.publishedTo.replaceAll("-", "")) }),
    };
  }
  if (input.contentHash !== undefined) filter.content_hash = { $eq: normalizeHash(input.contentHash, "contentHash") };

  if (Object.keys(filter).length === 0) return undefined;
  if (utf8Bytes(JSON.stringify(filter)) >= MAX_FILTER_BYTES) invalid("Semantic search filter is too large.");
  return filter;
}

function requestTimeout(context: OperationContext): number {
  let timeout = VECTORIZE_TIMEOUT_MS;
  if (context.deadline === undefined) return timeout;
  const deadline = Date.parse(context.deadline);
  if (!Number.isFinite(deadline)) invalid("Operation deadline is invalid.");
  timeout = Math.min(timeout, deadline - Date.now());
  return timeout;
}

async function queryBinding(
  index: VectorizeQueryBinding,
  context: OperationContext,
  values: number[],
  options: Parameters<VectorizeQueryBinding["query"]>[1],
): Promise<Awaited<ReturnType<VectorizeQueryBinding["query"]>>> {
  if (context.signal.aborted) throw cancelled(context.signal.reason);
  const timeout = requestTimeout(context);
  if (timeout <= 0) throw timedOut();

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => settle(() => reject(cancelled(context.signal.reason)));
    const timer = setTimeout(() => settle(() => reject(timedOut())), timeout);
    context.signal.addEventListener("abort", onAbort, { once: true });
    queueMicrotask(() => {
      if (settled) return;
      if (context.signal.aborted) {
        settle(() => reject(cancelled(context.signal.reason)));
        return;
      }
      try {
        index.query(values, options).then(
          (result) => settle(() => resolve(result)),
          (cause: unknown) => settle(() => reject(unavailable(cause))),
        );
      } catch (cause) {
        settle(() => reject(unavailable(cause)));
      }
    });
  });
}

function validateMatch(value: unknown): SemanticSearchMatch {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || utf8Bytes(value.id) > MAX_ID_BYTES) {
    throw unavailable();
  }
  const prefix = value.id.slice(0, 2);
  if (prefix !== "t/" && prefix !== "i/" && prefix !== "a/" || value.id.length === 2) throw unavailable();
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < -1 || value.score > 1) throw unavailable();
  if (!isRecord(value.metadata)) throw unavailable();
  const metadata = value.metadata as VectorizeMetadata;
  if (!SOURCE_TYPES.has(metadata.source_type) || typeof metadata.source_id !== "string" || !NORMALIZED_HASH_PATTERN.test(metadata.content_hash) || !Number.isSafeInteger(metadata.chunk_index) || metadata.chunk_index < 0) {
    throw unavailable();
  }
  if (
    (prefix === "t/" && metadata.source_type !== "episode_transcript")
    || (prefix === "i/" && metadata.source_type !== "episode_intelligence")
    || (prefix === "a/" && metadata.source_type !== "article")
  ) throw unavailable();
  if (prefix === "a/") assertUpstreamId(metadata.source_id, ARTICLE_ID_PATTERN);
  else assertUpstreamId(metadata.source_id, EPISODE_ID_PATTERN);
  return {
    vectorId: value.id as SemanticSearchMatch["vectorId"],
    score: value.score,
    sourceType: metadata.source_type,
    sourceId: metadata.source_id as SemanticSearchMatch["sourceId"],
    contentHash: metadata.content_hash as SemanticSearchMatch["contentHash"],
    chunkIndex: metadata.chunk_index,
  };
}

function assertUpstreamId(value: string, pattern: RegExp): void {
  if (value.length === 0 || value.trim() !== value || utf8Bytes(value) > MAX_ID_BYTES || !pattern.test(value)) throw unavailable();
}

function validateResult(result: unknown, topK: number): readonly SemanticSearchMatch[] {
  if (!isRecord(result) || !Array.isArray(result.matches) || result.matches.length > topK) throw unavailable();
  const ids = new Set<string>();
  const matches = result.matches.map((value) => {
    const match = validateMatch(value);
    if (ids.has(match.vectorId)) throw unavailable();
    ids.add(match.vectorId);
    return match;
  });
  return matches
    .filter((match) => match.score > SCORE_THRESHOLD)
    .sort((left, right) => right.score - left.score || left.vectorId.localeCompare(right.vectorId));
}

export function createVectorizeReader(index: VectorizeQueryBinding): SemanticSearchReader {
  return {
    async query(context, query) {
      validateQuery(query);
      const filter = buildFilter(query);
      const result = await queryBinding(index, context, Array.from(query.embedding.values), {
        topK: query.topK,
        returnMetadata: "indexed",
        returnValues: false,
        ...(filter === undefined ? {} : { filter }),
      });
      return validateResult(result, query.topK);
    },
  };
}

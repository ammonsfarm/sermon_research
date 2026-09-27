import type {
  BackgroundOperationContext,
  RequestOperationContext,
} from "./execution.ts";
import type {
  ArticleId,
  ContentHash,
  EpisodeId,
  IsoDate,
  VectorId,
} from "./ids.ts";
import type { SearchDocumentSourceType } from "./repositories.ts";

export const CURRENT_EMBEDDING_DIMENSIONS = 1536 as const;

export const ARTICLE_SEARCH_CONTENT_SUBTYPES = [
  "pastorwood_devotional",
  "pastorwood_resource",
] as const;

export const INTELLIGENCE_SEARCH_CONTENT_SUBTYPES = [
  "scripture_references",
  "people_mentioned",
  "interviews",
  "episode_topics_keywords",
  "episode_executive_summary",
  "episode_long_summary",
  "sermon_illustrations",
  "stories",
  "notable_quotes",
] as const;

export type ArticleSearchContentSubtype =
  (typeof ARTICLE_SEARCH_CONTENT_SUBTYPES)[number];
export type IntelligenceSearchContentSubtype =
  (typeof INTELLIGENCE_SEARCH_CONTENT_SUBTYPES)[number];
export type SearchContentSubtype =
  | ArticleSearchContentSubtype
  | IntelligenceSearchContentSubtype;

export type SearchSourceType = SearchDocumentSourceType;

export interface EmbeddingVector {
  readonly values: readonly number[];
  readonly dimensions: number;
  readonly model: string;
}

export interface SemanticSearchFilter {
  readonly sourceTypes?: readonly SearchSourceType[];
  readonly contentSubtypes?: readonly SearchContentSubtype[];
  readonly episodeId?: EpisodeId;
  readonly articleId?: ArticleId;
  readonly publishedFrom?: IsoDate;
  readonly publishedTo?: IsoDate;
  readonly contentHash?: ContentHash;
}

export interface SemanticSearchQuery {
  readonly embedding: EmbeddingVector;
  readonly topK: number;
  readonly filter?: SemanticSearchFilter;
}

export interface SemanticSearchMatch {
  readonly vectorId: VectorId;
  readonly score: number;
  readonly sourceType: SearchSourceType;
  readonly sourceId: EpisodeId | ArticleId;
  readonly contentHash: ContentHash;
  readonly chunkIndex: number;
}

/** Returns identity/routing metadata only; authoritative text is hydrated from repositories. */
export interface SemanticSearchReader {
  query(
    context: RequestOperationContext | BackgroundOperationContext,
    query: SemanticSearchQuery,
  ): Promise<readonly SemanticSearchMatch[]>;
}

export interface SemanticIndexRecord {
  readonly id: VectorId;
  readonly embedding: EmbeddingVector;
  readonly sourceType: SearchSourceType;
  readonly sourceId: EpisodeId | ArticleId;
  readonly contentHash: ContentHash;
  readonly chunkIndex: number;
}

export interface SemanticIndexMutationReceipt {
  readonly accepted: readonly VectorId[];
  /** Both pgvector and Vectorize adapters expose completion explicitly. */
  readonly visibility: "immediate" | "eventual";
}

/** Bulk indexing and replacement are background-only and must be idempotent. */
export interface SemanticIndexWriter {
  upsert(
    context: BackgroundOperationContext,
    records: readonly SemanticIndexRecord[],
  ): Promise<SemanticIndexMutationReceipt>;
  delete(
    context: BackgroundOperationContext,
    ids: readonly VectorId[],
  ): Promise<SemanticIndexMutationReceipt>;
}

export interface SemanticSearch {
  readonly reader: SemanticSearchReader;
  readonly writer: SemanticIndexWriter;
}

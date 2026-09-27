import type { OperationContext } from "./execution.ts";
import type { ArticleId, ContentHash, EpisodeId, IsoDate } from "./ids.ts";
import type {
  RetrievalCitation,
  SearchDocument,
} from "./repositories.ts";

export const RAG_REPOSITORY_CONTRACT_VERSION = "p5-rag-v1" as const;

export type ResearchScope =
  | "all"
  | "title"
  | "passage"
  | "guest"
  | "interview"
  | "theme";

export type ResearchSort =
  | "relevance"
  | "date_desc"
  | "date_asc"
  | "title_asc";

export interface ResearchSource {
  /** Table-qualified exact source primary key, never a fabricated vector ID. */
  readonly key: string;
  readonly episodeId?: EpisodeId;
  readonly articleId?: ArticleId;
  readonly sourceType: string;
  readonly title: string;
  readonly publishDate: string;
  readonly text: string;
  readonly contentHash: ContentHash;
  readonly canonicalUrl: string;
  readonly sourceLocation?: SearchDocument["sourceLocation"];
  readonly speakers: readonly string[];
  readonly score: number;
}

export interface EpisodeSearchInput {
  readonly query: string;
  readonly limit: number;
  readonly episodeId?: EpisodeId;
  readonly scope: ResearchScope;
  readonly publishedFrom?: IsoDate;
  readonly publishedTo?: IsoDate;
  readonly sort: ResearchSort;
}

export interface EpisodeSearchHit {
  readonly trackId: EpisodeId;
  readonly title: string;
  readonly publishDate: string;
  readonly album: string;
  readonly category: string;
  readonly detail: string;
  readonly sourceFile: string;
  readonly hasTranscript: boolean;
  readonly hasIntelligence: boolean;
  readonly hasVectors: boolean;
  readonly hasPodtrac: boolean;
  readonly hitTypes: readonly string[];
  readonly snippet: string;
  readonly score: number;
}

export interface ResearchSourceRepository {
  searchStructured(
    context: OperationContext,
    query: string,
    limit: number,
  ): Promise<readonly ResearchSource[]>;
  listInterviewInventory(
    context: OperationContext,
    limit: number,
  ): Promise<readonly ResearchSource[]>;
  getSummaries(
    context: OperationContext,
    ids: readonly EpisodeId[],
  ): Promise<readonly ResearchSource[]>;
  getTranscriptDetails(
    context: OperationContext,
    query: string,
    ids: readonly EpisodeId[],
    limit: number,
  ): Promise<readonly ResearchSource[]>;
  searchEpisodes(
    context: OperationContext,
    input: EpisodeSearchInput,
  ): Promise<readonly EpisodeSearchHit[]>;
  listEpisodes(
    context: OperationContext,
    input: Omit<EpisodeSearchInput, "query">,
  ): Promise<readonly EpisodeSearchHit[]>;
}

export type ResearchCitation =
  | { readonly kind: "vector"; readonly citation: RetrievalCitation }
  | {
      readonly kind: "record";
      readonly key: string;
      readonly sourceId: EpisodeId | ArticleId;
      readonly canonicalUrl: string;
    };

import type { RoleName } from "./auth.ts";
import { ServiceError } from "./errors.ts";
import type { OperationContext } from "./execution.ts";
import type { ResearchCitation } from "./rag.ts";
import type {
  ArticleId,
  ContentHash,
  EditorialDocumentId,
  EpisodeId,
  IdempotencyKey,
  IsoDate,
  IsoDateTime,
  OpaqueCursor,
  OperationKey,
  RevisionToken,
  StableExternalReference,
  UserId,
  VectorId,
} from "./ids.ts";

export const RUNTIME_REPOSITORY_CONTRACT_VERSION = "p4-v2" as const;
/** Focused D1 editorial mutation contract layered on top of the public-read contract. */
export const D1_EDITORIAL_WRITE_CONTRACT_VERSION = "p4-d1-write-v1" as const;
export const MAX_REPOSITORY_PAGE_LIMIT = 100 as const;

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: OpaqueCursor;
}

/** Shared fail-closed bound used by every relational repository adapter. */
export function assertRepositoryPageRequest(page: PageRequest): void {
  if (
    !page
    || !Number.isSafeInteger(page.limit)
    || page.limit < 1
    || page.limit > MAX_REPOSITORY_PAGE_LIMIT
  ) {
    throw new ServiceError({
      code: "invalid_argument",
      message: `Repository page limit must be an integer from 1 through ${MAX_REPOSITORY_PAGE_LIMIT}.`,
    });
  }
  if (page.cursor !== undefined && String(page.cursor).trim().length === 0) {
    throw new ServiceError({
      code: "invalid_argument",
      message: "Repository cursor must not be empty.",
    });
  }
}

export interface PageResult<Item> {
  readonly items: readonly Item[];
  readonly nextCursor?: OpaqueCursor;
}

export type PublicationState =
  | "draft"
  | "scheduled"
  | "published"
  | "unpublished"
  | "archived";

export interface ArticleSummary {
  readonly id: ArticleId;
  readonly source: StableExternalReference;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  /** Authoritative CMS content classification preserved by the D1 projection. */
  readonly contentType: ArticleContentType;
  readonly publishedAt: IsoDateTime | null;
  readonly canonicalUrl: string;
  readonly contentHash: ContentHash;
}

/** Existing CMS enum values; no adapter may silently collapse these values. */
export type ArticleContentType =
  | "devotional"
  | "bible-study"
  | "article"
  | "written-resource"
  | "newsletter-archive";

export interface Article extends ArticleSummary {
  readonly body: string;
  readonly revision: RevisionToken;
}

/** Full replacement payload accepted by the Phase 4 D1 article writer. */
export interface ArticleDraftPayload {
  readonly title: string;
  readonly slug: string;
  readonly summary: string | null;
  readonly body: string;
  readonly visibility: "public" | "private" | "unlisted";
  readonly canonicalUrl: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
}

export interface EpisodeSummary {
  /** Existing track ID, preserved byte-for-byte across every adapter. */
  readonly id: EpisodeId;
  readonly source: StableExternalReference;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly programDate: IsoDate | null;
  readonly publishedAt: IsoDateTime | null;
  readonly canonicalUrl: string;
  readonly hasAudio: boolean;
  readonly contentHash: ContentHash;
}

export interface Episode extends EpisodeSummary {
  readonly body: string | null;
  readonly transcriptAvailable: boolean;
  readonly revision: RevisionToken;
}

export const MAX_EPISODE_FILTER_QUERY_LENGTH = 80 as const;

/** Bounded, provider-neutral filters for the public episode archive. */
export interface EpisodeListFilter {
  readonly query?: string;
  readonly year?: number;
}

/** A filtered page includes the exact matching total for page-count rendering. */
export interface CountedPageResult<Item> extends PageResult<Item> {
  readonly total: number;
}

/** Full replacement payload accepted by the Phase 4 D1 episode writer. */
export interface EpisodeDraftPayload {
  readonly title: string;
  readonly slug: string;
  readonly summary: string | null;
  readonly body: string | null;
  readonly visibility: "public" | "private" | "unlisted";
  readonly programDate: IsoDate | null;
}

export interface PublicPage {
  readonly documentId: EditorialDocumentId;
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly canonicalUrl: string;
  readonly contentHash: ContentHash;
  readonly revision: RevisionToken;
}

/** Full replacement payload accepted by the Phase 4 D1 page writer. */
export interface PageDraftPayload {
  readonly title: string;
  readonly slug: string;
  readonly body: string;
}

export type EditorialDraftPayload =
  | ArticleDraftPayload
  | EpisodeDraftPayload
  | PageDraftPayload;

export interface EditorialDocumentForEditBase {
  readonly documentId: EditorialDocumentId;
  readonly publicationState: PublicationState;
  readonly currentRevision: RevisionToken;
  readonly publishedRevision: RevisionToken | null;
  readonly updatedAt: IsoDateTime;
}

export interface ArticleForEdit extends EditorialDocumentForEditBase {
  readonly entity: { readonly kind: "article"; readonly id: ArticleId };
  /** Immutable classification sourced from the authoritative D1 projection. */
  readonly contentType: ArticleContentType;
  readonly payload: ArticleDraftPayload;
}

export interface EpisodeForEdit extends EditorialDocumentForEditBase {
  readonly entity: { readonly kind: "episode"; readonly id: EpisodeId };
  readonly payload: EpisodeDraftPayload;
}

export interface PageForEdit extends EditorialDocumentForEditBase {
  readonly entity: { readonly kind: "page"; readonly id: EditorialDocumentId };
  readonly payload: PageDraftPayload;
}

export type EditorialDocumentForEdit = ArticleForEdit | EpisodeForEdit | PageForEdit;

export type EditorialDocumentSummary =
  | {
      readonly documentId: EditorialDocumentId;
      readonly entity: { readonly kind: "article"; readonly id: ArticleId };
      readonly title: string;
      readonly slug: string;
      readonly publicationState: PublicationState;
      readonly currentRevision: RevisionToken;
      readonly publishedRevision: RevisionToken | null;
      readonly updatedAt: IsoDateTime;
      readonly contentType: ArticleContentType;
    }
  | {
      readonly documentId: EditorialDocumentId;
      readonly entity: { readonly kind: "episode"; readonly id: EpisodeId };
      readonly title: string;
      readonly slug: string;
      readonly publicationState: PublicationState;
      readonly currentRevision: RevisionToken;
      readonly publishedRevision: RevisionToken | null;
      readonly updatedAt: IsoDateTime;
    }
  | {
      readonly documentId: EditorialDocumentId;
      readonly entity: { readonly kind: "page"; readonly id: EditorialDocumentId };
      readonly title: string;
      readonly slug: string;
      readonly publicationState: PublicationState;
      readonly currentRevision: RevisionToken;
      readonly publishedRevision: RevisionToken | null;
      readonly updatedAt: IsoDateTime;
    };

export interface EditorialListForEditFilter {
  readonly kind: EditorialEntityReference["kind"];
  readonly query?: string;
}

export const MAX_EDITORIAL_FILTER_QUERY_LENGTH = 160 as const;

/** Bounded, body-bearing item for the public RSS renderer. */
export interface ArticleFeedItem extends ArticleSummary {
  readonly body: string;
}

export interface SiteSettings {
  readonly documentId: EditorialDocumentId;
  readonly title: string;
  readonly canonicalOrigin: string;
  readonly allowIndexing: boolean;
  readonly revision: RevisionToken;
}

export interface RedirectRecord {
  readonly sourcePath: string;
  readonly destination: string;
  readonly status: 301 | 302 | 307 | 308;
}

export interface PublicContentRepository {
  getArticleById(context: OperationContext, id: ArticleId): Promise<Article | null>;
  getPublishedArticleBySlug(
    context: OperationContext,
    slug: string,
  ): Promise<Article | null>;
  listPublishedArticles(
    context: OperationContext,
    page: PageRequest,
  ): Promise<PageResult<ArticleSummary>>;
  /** Uses one bounded query for RSS and other body-bearing feeds; never N+1s. */
  readonly listPublishedArticleFeed?: (
    context: OperationContext,
    page: PageRequest,
  ) => Promise<PageResult<ArticleFeedItem>>;
  /** Applies the authoritative article classification before cursor paging. */
  readonly listPublishedArticleFeedFiltered?: (
    context: OperationContext,
    page: PageRequest,
    filter: { readonly contentType?: ArticleContentType },
  ) => Promise<CountedPageResult<ArticleFeedItem>>;
  getEpisodeById(context: OperationContext, id: EpisodeId): Promise<Episode | null>;
  getPublishedEpisodeBySlug(
    context: OperationContext,
    slug: string,
  ): Promise<Episode | null>;
  listPublishedEpisodes(
    context: OperationContext,
    page: PageRequest,
  ): Promise<PageResult<EpisodeSummary>>;
  /**
   * Pushes bounded query/year filters into the provider query before cursor
   * pagination and returns the exact matching total. Transitional adapters may
   * omit this additive method while callers retain the unfiltered method.
   */
  readonly listPublishedEpisodesFiltered?: (
    context: OperationContext,
    page: PageRequest,
    filter: EpisodeListFilter,
  ) => Promise<CountedPageResult<EpisodeSummary>>;
  getDynamicPageBySlug(
    context: OperationContext,
    slug: string,
  ): Promise<PublicPage | null>;
  getSiteSettings(context: OperationContext): Promise<SiteSettings>;
  resolveRedirect(
    context: OperationContext,
    path: string,
  ): Promise<RedirectRecord | null>;
}

export interface EditorialMutation<Payload> {
  readonly documentId: EditorialDocumentId;
  /** Additive Phase 4 discriminator; the D1 adapter requires it at runtime. */
  readonly entity?: EditorialEntityReference;
  readonly expectedRevision: RevisionToken;
  readonly actorId: UserId;
  /** Optional for source compatibility; required by the Phase 4 D1 adapter. */
  readonly idempotencyKey?: IdempotencyKey;
  readonly payload: Payload;
}

export type EditorialEntityReference =
  | { readonly kind: "article"; readonly id: ArticleId }
  | { readonly kind: "episode"; readonly id: EpisodeId }
  | { readonly kind: "page"; readonly id: EditorialDocumentId };

export interface EditorialWriteResult {
  readonly documentId: EditorialDocumentId;
  readonly revision: RevisionToken;
  readonly publicationState: PublicationState;
  /** Present for Phase 4 D1 writes; optional for transitional adapters. */
  readonly operationKey?: OperationKey;
}

/**
 * Provider-neutral editorial boundary. The current adapter talks to Strapi and
 * PostgreSQL projection state; the target adapter persists D1/R2 state.
 */
export interface EditorialRepository {
  /**
   * Resolves a provider-neutral document identity before an edit or mutation.
   * Transitional adapters may omit this additive method; D1-backed callers
   * use it to map CMS document IDs to canonical relational entity IDs.
   */
  readonly resolveEntity?: (
    context: OperationContext,
    input: {
      readonly kind: EditorialEntityReference["kind"];
      readonly documentId: EditorialDocumentId;
    },
  ) => Promise<EditorialEntityReference | null>;
  /** Lists a bounded, authoritative edit inventory; transitional adapters may omit it. */
  readonly listForEdit?: (
    context: OperationContext,
    page: PageRequest,
    filter: EditorialListForEditFilter,
  ) => Promise<CountedPageResult<EditorialDocumentSummary>>;
  saveDraft(
    context: OperationContext,
    mutation: EditorialMutation<EditorialDraftPayload>,
  ): Promise<EditorialWriteResult>;
  getForEdit(
    context: OperationContext,
    input: {
      readonly documentId: EditorialDocumentId;
      readonly entity?: EditorialEntityReference;
    },
  ): Promise<EditorialDocumentForEdit | null>;
  transition(
    context: OperationContext,
    input: {
      readonly documentId: EditorialDocumentId;
      /** Additive Phase 4 discriminator; the D1 adapter requires it at runtime. */
      readonly entity?: EditorialEntityReference;
      readonly expectedRevision: RevisionToken;
      readonly actorId: UserId;
      /** Optional for source compatibility; required by the Phase 4 D1 adapter. */
      readonly idempotencyKey?: IdempotencyKey;
      readonly to: PublicationState;
      readonly note?: string;
    },
  ): Promise<EditorialWriteResult>;
}

export interface UserAccessRecord {
  readonly userId: UserId;
  readonly roles: readonly RoleName[];
  readonly disabled: boolean;
  readonly revision: RevisionToken;
}

export interface UserAccessRepository {
  getByUserId(
    context: OperationContext,
    userId: UserId,
  ): Promise<UserAccessRecord | null>;
}

export type SearchDocumentSourceType =
  | "episode_transcript"
  | "episode_intelligence"
  | "article";

export interface SearchDocument {
  readonly vectorId: VectorId;
  readonly sourceType: SearchDocumentSourceType;
  readonly sourceId: ArticleId | EpisodeId;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly text: string;
  readonly contentHash: ContentHash;
  readonly chunkIndex: number;
  readonly sourceLocation?: {
    readonly startMs?: number;
    readonly endMs?: number;
    readonly label?: string;
  };
}

/** Hydrates authoritative text after semantic search returns stable vector IDs. */
export interface SearchDocumentRepository {
  getByVectorIds(
    context: OperationContext,
    vectorIds: readonly VectorId[],
  ): Promise<readonly SearchDocument[]>;
}

export interface RetrievalCitation {
  readonly vectorId: VectorId;
  readonly sourceId: ArticleId | EpisodeId;
  readonly canonicalUrl: string;
}

export interface RagInteractionRecord {
  readonly userId: UserId;
  readonly question: string;
  readonly answer: string;
  readonly citations: readonly RetrievalCitation[];
  readonly createdAt: IsoDateTime;
  readonly id?: string;
  readonly scope?: RagInteractionScope;
  readonly trackId?: EpisodeId;
  readonly articleId?: ArticleId;
  readonly provider?: string;
  readonly model?: string;
  readonly topK?: number;
  readonly status?: RagInteractionStatus;
  /** Safe, presentation-ready error only; raw provider errors are forbidden. */
  readonly error?: string;
  readonly durationMs?: number;
  readonly sources?: readonly RetrievalCitation[];
  readonly researchCitations?: readonly ResearchCitation[];
  readonly retrievalLanes?: readonly string[];
  readonly topEpisodeIds?: readonly EpisodeId[];
  readonly coverageNote?: string;
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export type RagInteractionScope = "research" | "archive" | "episode" | "writing";
export type RagInteractionStatus = "completed" | "failed";

export interface RagHistoryPageRequest extends PageRequest {
  readonly scope?: RagInteractionScope;
  readonly trackId?: EpisodeId;
  readonly articleId?: ArticleId;
}

export interface RagInteractionRepository {
  append(context: OperationContext, interaction: RagInteractionRecord): Promise<void>;
  listForUser(
    context: OperationContext,
    userId: UserId,
    page: RagHistoryPageRequest,
  ): Promise<PageResult<RagInteractionRecord>>;
}

export interface RelationalRepositories {
  readonly publicContent: PublicContentRepository;
  readonly editorial: EditorialRepository;
  readonly userAccess: UserAccessRepository;
  readonly searchDocuments: SearchDocumentRepository;
  readonly ragInteractions: RagInteractionRepository;
}

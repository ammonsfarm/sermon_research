import {
  assertRepositoryPageRequest,
  decodeRepositoryRevision,
  encodeRepositoryRevision,
  MAX_REPOSITORY_PAGE_LIMIT,
  ServiceError,
  type Article,
  type ArticleContentType,
  type ArticleId,
  type ArticleSummary,
  type ArticleDraftPayload,
  type ArticleFeedItem,
  type ContentHash,
  type EditorialDocumentForEdit,
  type EditorialDocumentId,
  type EditorialEntityReference,
  type EditorialDocumentSummary,
  type EditorialListForEditFilter,
  type EditorialMutation,
  type EditorialDraftPayload,
  type EditorialRepository,
  type EditorialWriteResult,
  type PageDraftPayload,
  type Episode,
  type EpisodeDraftPayload,
  type EpisodeId,
  type EpisodeSummary,
  type EpisodeListFilter,
  type CountedPageResult,
  MAX_EPISODE_FILTER_QUERY_LENGTH,
  MAX_EDITORIAL_FILTER_QUERY_LENGTH,
  type IsoDate,
  type IsoDateTime,
  type OpaqueCursor,
  type OperationContext,
  type PageRequest,
  type PageResult,
  type PublicContentRepository,
  type PublicPage,
  type RedirectRecord,
  type RevisionToken,
  type PublicationState,
  type RoleName,
  type SiteSettings,
  type StableExternalReference,
  type UserAccessRecord,
  type UserAccessRepository,
  type UserId,
  type IdempotencyKey,
  type OperationKey,
} from "@aic/contracts";

/** Minimal structural surface used from the Worker-provided D1 binding. */
export interface D1PreparedStatement {
  bind(...values: readonly unknown[]): D1PreparedStatement;
  first<Row extends Record<string, unknown>>(): Promise<Row | null>;
  all<Row extends Record<string, unknown>>(): Promise<{ readonly results: readonly Row[]; readonly success?: boolean }>;
  run(): Promise<D1Result>;
}

export interface D1Result {
  readonly success?: boolean;
  readonly meta?: { readonly changes?: number; readonly last_row_id?: number };
}

/** Minimal structural surface used from the Worker-provided D1 binding. */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<readonly D1Result[]>;
}

export interface D1ReadRepositoryOptions {
  readonly db: D1Database;
}

const ARTICLE_SOURCE_SQL = `
  SELECT article_id, source_type, cms_document_id, source_post_id, slug, title,
         excerpt, body_html, canonical_url, content_hash, published_at,
         updated_at, status, visibility, content_type
    FROM articles
   WHERE article_id = ?
     AND status = 'Published'
     AND visibility = 'public'`;
const ARTICLE_SLUG_SQL = `
  SELECT article_id, source_type, cms_document_id, source_post_id, slug, title,
         excerpt, body_html, canonical_url, content_hash, published_at,
         updated_at, status, visibility, content_type
    FROM articles
   WHERE slug = ?
     AND status = 'Published'
     AND visibility = 'public'`;
const ARTICLE_LIST_SQL = `
  SELECT article_id, source_type, cms_document_id, source_post_id, slug, title,
         excerpt, canonical_url, content_hash, published_at, updated_at,
         status, visibility, content_type
    FROM articles
   WHERE status = 'Published'
     AND visibility = 'public'
     AND published_at IS NOT NULL
     AND (published_at < ? OR (published_at = ? AND article_id > ?))
   ORDER BY published_at DESC, article_id ASC
   LIMIT ?`;
const ARTICLE_FEED_SQL = `
  SELECT article_id, source_type, cms_document_id, source_post_id, slug, title,
         excerpt, body_html, canonical_url, content_hash, published_at,
         updated_at, status, visibility, content_type
    FROM articles
   WHERE status = 'Published'
     AND visibility = 'public'
     AND published_at IS NOT NULL
     AND (published_at < ? OR (published_at = ? AND article_id > ?))
   ORDER BY published_at DESC, article_id ASC
   LIMIT ?`;
const ARTICLE_FEED_FILTER_CLAUSE = `
     AND (? IS NULL OR content_type = ?)`;
const ARTICLE_FEED_FILTERED_SQL = `
  SELECT article_id, source_type, cms_document_id, source_post_id, slug, title,
         excerpt, body_html, canonical_url, content_hash, published_at,
         updated_at, status, visibility, content_type
    FROM articles
   WHERE status = 'Published'
     AND visibility = 'public'
     AND published_at IS NOT NULL` + ARTICLE_FEED_FILTER_CLAUSE + `
     AND (published_at < ? OR (published_at = ? AND article_id > ?))
   ORDER BY published_at DESC, article_id ASC
   LIMIT ?`;
const ARTICLE_FEED_FILTERED_COUNT_SQL = `
  SELECT COUNT(*) AS total
    FROM articles
   WHERE status = 'Published'
     AND visibility = 'public'
     AND published_at IS NOT NULL` + ARTICLE_FEED_FILTER_CLAUSE;
const EPISODE_SOURCE_SQL = `
  SELECT e.episode_id, e.source_system, e.source_id, e.canonical_audio_key,
         e.publish_date, e.updated_at AS episode_updated_at,
         d.document_id, d.slug, d.title, d.summary, d.description,
         d.status, d.visibility, d.transcript_status, d.content_hash,
         d.published_at, d.updated_at AS document_updated_at,
         CASE WHEN m.asset_id IS NULL THEN 0 ELSE 1 END AS has_audio
    FROM episodes e
    JOIN episode_documents d ON d.episode_id = e.episode_id
    LEFT JOIN media_assets m
      ON m.canonical_object_key = e.canonical_audio_key
     AND m.destination_bucket = 'aic-podcast-audio'
     AND m.mime_type = 'audio/mpeg'
     AND m.status IN ('verified', 'published')
   WHERE e.episode_id = ?
     AND e.status = 'Published'
     AND d.status = 'Published'
     AND d.visibility = 'public'`;
const EPISODE_SLUG_SQL = `
  SELECT e.episode_id, e.source_system, e.source_id, e.canonical_audio_key,
         e.publish_date, e.updated_at AS episode_updated_at,
         d.document_id, d.slug, d.title, d.summary, d.description,
         d.status, d.visibility, d.transcript_status, d.content_hash,
         d.published_at, d.updated_at AS document_updated_at,
         CASE WHEN m.asset_id IS NULL THEN 0 ELSE 1 END AS has_audio
    FROM episodes e
    JOIN episode_documents d ON d.episode_id = e.episode_id
    LEFT JOIN media_assets m
      ON m.canonical_object_key = e.canonical_audio_key
     AND m.destination_bucket = 'aic-podcast-audio'
     AND m.mime_type = 'audio/mpeg'
     AND m.status IN ('verified', 'published')
   WHERE d.slug = ?
     AND e.status = 'Published'
     AND d.status = 'Published'
     AND d.visibility = 'public'`;
const EPISODE_LIST_SQL = `
  SELECT e.episode_id, e.source_system, e.source_id, e.canonical_audio_key,
         e.publish_date, e.updated_at AS episode_updated_at,
         d.document_id, d.slug, d.title, d.summary, d.description,
         d.status, d.visibility, d.transcript_status, d.content_hash,
         d.published_at, d.updated_at AS document_updated_at,
         CASE WHEN m.asset_id IS NULL THEN 0 ELSE 1 END AS has_audio
    FROM episodes e
    JOIN episode_documents d ON d.episode_id = e.episode_id
    LEFT JOIN media_assets m
      ON m.canonical_object_key = e.canonical_audio_key
     AND m.destination_bucket = 'aic-podcast-audio'
     AND m.mime_type = 'audio/mpeg'
     AND m.status IN ('verified', 'published')
   WHERE e.status = 'Published'
     AND d.status = 'Published'
     AND d.visibility = 'public'
     AND d.published_at IS NOT NULL
     AND (d.published_at < ? OR (d.published_at = ? AND e.episode_id > ?))
   ORDER BY d.published_at DESC, e.episode_id ASC
   LIMIT ?`;
const EPISODE_FILTER_CLAUSE = `
     AND (
       ? = ''
       OR lower(d.title) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(d.summary) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(d.description) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(d.slug) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(e.episode_id) LIKE '%' || lower(?) || '%' ESCAPE '!'
     )
     AND (
       ? IS NULL
       OR (e.publish_date >= ? AND e.publish_date < ?)
     )`;
const EPISODE_FILTER_LIST_SQL = `
  SELECT e.episode_id, e.source_system, e.source_id, e.canonical_audio_key,
         e.publish_date, e.updated_at AS episode_updated_at,
         d.document_id, d.slug, d.title, d.summary, d.description,
         d.status, d.visibility, d.transcript_status, d.content_hash,
         d.published_at, d.updated_at AS document_updated_at,
         CASE WHEN m.asset_id IS NULL THEN 0 ELSE 1 END AS has_audio
    FROM episodes e
    JOIN episode_documents d ON d.episode_id = e.episode_id
    LEFT JOIN media_assets m
      ON m.canonical_object_key = e.canonical_audio_key
     AND m.destination_bucket = 'aic-podcast-audio'
     AND m.mime_type = 'audio/mpeg'
     AND m.status IN ('verified', 'published')
   WHERE e.status = 'Published'
     AND d.status = 'Published'
     AND d.visibility = 'public'
     AND d.published_at IS NOT NULL` + EPISODE_FILTER_CLAUSE + `
     AND (d.published_at < ? OR (d.published_at = ? AND e.episode_id > ?))
   ORDER BY d.published_at DESC, e.episode_id ASC
   LIMIT ?`;
const EPISODE_FILTER_COUNT_SQL = `
  SELECT COUNT(*) AS total
    FROM episodes e
    JOIN episode_documents d ON d.episode_id = e.episode_id
   WHERE e.status = 'Published'
     AND d.status = 'Published'
     AND d.visibility = 'public'
     AND d.published_at IS NOT NULL` + EPISODE_FILTER_CLAUSE;
const RESOLVE_ARTICLE_SQL = `
  SELECT article_id, source_type, cms_document_id, source_post_id
    FROM articles
   WHERE article_id = ? OR cms_document_id = ?`;
const RESOLVE_EPISODE_SQL = `
  SELECT episode_id, document_id
    FROM episode_documents
   WHERE document_id = ?`;
const RESOLVE_PAGE_SQL = `
  SELECT document_id
    FROM pages
   WHERE document_id = ?`;
const EDIT_CURSOR_DEFAULT = "9999-12-31T23:59:59.999999Z";
const EDITORIAL_ARTICLE_LIST_SQL = `
  SELECT a.article_id, a.source_type, a.cms_document_id, a.content_type,
         a.title, a.slug, a.status, a.updated_at, a.current_revision_id,
         cr.revision_id AS current_revision_joined_id,
         a.published_revision_id, pr.created_at AS published_revision_at
    FROM articles a
    LEFT JOIN editorial_revisions cr
      ON cr.revision_id = a.current_revision_id
     AND cr.entity_type = 'article'
     AND cr.entity_id = CASE WHEN a.source_type = 'cms' THEN a.cms_document_id ELSE a.article_id END
    LEFT JOIN editorial_revisions pr
      ON pr.revision_id = a.published_revision_id
     AND pr.entity_type = 'article'
     AND pr.entity_id = CASE WHEN a.source_type = 'cms' THEN a.cms_document_id ELSE a.article_id END
   WHERE (
       ? = ''
       OR lower(a.title) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(a.slug) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(CASE WHEN a.source_type = 'cms' THEN a.cms_document_id ELSE a.article_id END) LIKE '%' || lower(?) || '%' ESCAPE '!'
     )
     AND (a.updated_at < ? OR (a.updated_at = ? AND (CASE WHEN a.source_type = 'cms' THEN a.cms_document_id ELSE a.article_id END) > ?))
   ORDER BY a.updated_at DESC, (CASE WHEN a.source_type = 'cms' THEN a.cms_document_id ELSE a.article_id END) ASC
   LIMIT ?`;
const EDITORIAL_ARTICLE_COUNT_SQL = `
  SELECT COUNT(*) AS total
    FROM articles a
   WHERE (
       ? = ''
       OR lower(a.title) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(a.slug) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(CASE WHEN a.source_type = 'cms' THEN a.cms_document_id ELSE a.article_id END) LIKE '%' || lower(?) || '%' ESCAPE '!'
     )`;
const EDITORIAL_EPISODE_LIST_SQL = `
  SELECT d.document_id, d.episode_id, d.title, d.slug, d.status, d.updated_at,
         d.current_revision_id, cr.revision_id AS current_revision_joined_id,
         d.published_revision_id,
         pr.created_at AS published_revision_at
    FROM episode_documents d
    LEFT JOIN editorial_revisions cr
      ON cr.revision_id = d.current_revision_id
     AND cr.entity_type = 'episode'
     AND cr.entity_id = d.document_id
    LEFT JOIN editorial_revisions pr
      ON pr.revision_id = d.published_revision_id
     AND pr.entity_type = 'episode'
     AND pr.entity_id = d.document_id
   WHERE (
       ? = ''
       OR lower(d.title) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(d.slug) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(d.document_id) LIKE '%' || lower(?) || '%' ESCAPE '!'
     )
     AND (d.updated_at < ? OR (d.updated_at = ? AND d.document_id > ?))
   ORDER BY d.updated_at DESC, d.document_id ASC
   LIMIT ?`;
const EDITORIAL_EPISODE_COUNT_SQL = `
  SELECT COUNT(*) AS total
    FROM episode_documents d
   WHERE (
       ? = ''
       OR lower(d.title) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(d.slug) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(d.document_id) LIKE '%' || lower(?) || '%' ESCAPE '!'
     )`;
const EDITORIAL_PAGE_LIST_SQL = `
  SELECT p.document_id, p.title, p.slug, p.status, p.updated_at,
         p.current_revision_id, cr.revision_id AS current_revision_joined_id,
         p.published_revision_id,
         pr.created_at AS published_revision_at
    FROM pages p
    LEFT JOIN editorial_revisions cr
      ON cr.revision_id = p.current_revision_id
     AND cr.entity_type = 'page'
     AND cr.entity_id = p.document_id
    LEFT JOIN editorial_revisions pr
      ON pr.revision_id = p.published_revision_id
     AND pr.entity_type = 'page'
     AND pr.entity_id = p.document_id
   WHERE (
       ? = ''
       OR lower(p.title) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(p.slug) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(p.document_id) LIKE '%' || lower(?) || '%' ESCAPE '!'
     )
     AND (p.updated_at < ? OR (p.updated_at = ? AND p.document_id > ?))
   ORDER BY p.updated_at DESC, p.document_id ASC
   LIMIT ?`;
const EDITORIAL_PAGE_COUNT_SQL = `
  SELECT COUNT(*) AS total
    FROM pages p
   WHERE (
       ? = ''
       OR lower(p.title) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(p.slug) LIKE '%' || lower(?) || '%' ESCAPE '!'
       OR lower(p.document_id) LIKE '%' || lower(?) || '%' ESCAPE '!'
     )`;
const PAGE_SQL = `
  SELECT p.document_id, p.slug, p.title, p.status, p.published_revision_id,
         p.updated_at, r.entity_type AS revision_entity_type,
         r.entity_id AS revision_entity_id, r.status AS revision_status,
         r.body_html
    FROM pages p
    LEFT JOIN editorial_revisions r
      ON r.revision_id = p.published_revision_id
     AND r.entity_type = 'page'
     AND r.entity_id = p.document_id
   WHERE p.slug = ?
     AND p.status = 'Published'`;
const SETTINGS_SQL = `
  SELECT setting_key, value_json, value_type, is_public, updated_at
    FROM site_settings
   WHERE setting_key IN ('site.title', 'site.canonicalOrigin', 'site.allowIndexing')`;
const REDIRECT_SQL = `
  SELECT source_path, target_path, status_code
    FROM redirects
   WHERE source_path = ?
     AND active = 1`;
const USER_SQL = `
  SELECT u.user_id, u.clerk_user_id, u.status, u.updated_at,
         r.role, r.revoked_at
    FROM users u
    LEFT JOIN user_roles r ON r.user_id = u.user_id AND r.revoked_at IS NULL
   WHERE u.clerk_user_id = ?`;

const SITE_SETTING_KEYS = ["site.title", "site.canonicalOrigin", "site.allowIndexing"] as const;
const KNOWN_ROLES = new Set<string>(["User", "Admin", "Content Manager", "Research User", "Read Only"]);
const EPISODE_SOURCES = new Set(["postgresql", "strapi", "soundcloud", "sermonaudio", "migration"]);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/u;
const HEX_HASH = /^(?:sha256:)?[0-9a-fA-F]{64}$/u;

function fail(message: string, cause?: unknown): never {
  throw new ServiceError({ code: "dependency_unavailable", message, retryable: true, ...(cause === undefined ? {} : { cause }) });
}

function invalid(message: string): never {
  throw new ServiceError({ code: "invalid_argument", message });
}

function checkCancelled(context: OperationContext): void {
  if (context.signal.aborted) {
    throw new ServiceError({ code: "cancelled", message: "The operation was cancelled." });
  }
}

function normalizePathSegment(value: string, label: string): string {
  if (typeof value !== "string") invalid(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized !== value || normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\") || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    invalid(`${label} is not a valid path segment.`);
  }
  return normalized;
}

function normalizeSlug(value: string, label = "slug"): string {
  if (value === "/" && label === "page slug") return value;
  return normalizePathSegment(value, label);
}

function canonicalSegmentUrl(prefix: string, slug: string): string {
  return `${prefix}${encodeURIComponent(slug)}/`;
}

function requiredText(row: Record<string, unknown>, key: string, label = key): string {
  const value = row[key];
  if (typeof value !== "string") fail(`D1 ${label} integrity check failed.`);
  return value;
}

function requiredString(row: Record<string, unknown>, key: string, label = key): string {
  const value = requiredText(row, key, label);
  if (value.length === 0 || value.trim() !== value) fail(`D1 ${label} integrity check failed.`);
  return value;
}

function providerId(row: Record<string, unknown>, key: string, label = key): string {
  const value = requiredString(row, key, label);
  return stableProviderValue(value, label);
}

function stableProviderValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || new TextEncoder().encode(value).byteLength > 512 || /[\u0000-\u001F\u007F]/u.test(value)) fail(`D1 ${label} integrity check failed.`);
  return value;
}

function escapeLikeQuery(value: string): string {
  return value.replace(/[!%_]/gu, (character) => `!${character}`);
}

function isCanonicalTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

function timestamp(row: Record<string, unknown>, key: string): IsoDateTime {
  const value = requiredString(row, key);
  if (!isCanonicalTimestamp(value)) fail("D1 timestamp integrity check failed.");
  return value as IsoDateTime;
}

function isoDate(row: Record<string, unknown>, key: string): IsoDate | null {
  const raw = row[key];
  if (raw === null || raw === undefined) fail("D1 date integrity check failed.");
  if (typeof raw !== "string") fail("D1 date integrity check failed.");
  const value = raw;
  if (!value) return null;
  const match = ISO_DATE.exec(value);
  if (!match) fail("D1 date integrity check failed.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)) fail("D1 date integrity check failed.");
  return value as IsoDate;
}

function contentHash(row: Record<string, unknown>, key = "content_hash"): ContentHash {
  const value = requiredString(row, key);
  if (!HEX_HASH.test(value)) fail("D1 content hash integrity check failed.");
  return value as ContentHash;
}

const ARTICLE_CONTENT_TYPES = new Set<ArticleContentType>([
  "devotional",
  "bible-study",
  "article",
  "written-resource",
  "newsletter-archive",
]);

function articleContentType(row: Record<string, unknown>): ArticleContentType {
  const value = requiredString(row, "content_type");
  if (!ARTICLE_CONTENT_TYPES.has(value as ArticleContentType)) fail("D1 article content type integrity check failed.");
  return value as ArticleContentType;
}

function requiredCount(row: Record<string, unknown>): number {
  const value = row.total;
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("D1 count integrity check failed.");
  return value as number;
}

function normalizeEpisodeFilter(filter: EpisodeListFilter): { readonly query: string; readonly year: number | null } {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) invalid("Episode filter is invalid.");
  const rawQuery = filter.query;
  if (rawQuery !== undefined && typeof rawQuery !== "string") invalid("Episode query is invalid.");
  const query = rawQuery === undefined ? "" : rawQuery.normalize("NFKC").replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  if (new TextEncoder().encode(query).byteLength > MAX_EPISODE_FILTER_QUERY_LENGTH) invalid("Episode query is too long.");
  const rawYear = filter.year;
  if (rawYear !== undefined && rawYear !== null && (!Number.isSafeInteger(rawYear) || rawYear < 1900 || rawYear > 2100)) invalid("Episode year is invalid.");
  return { query: escapeLikeQuery(query), year: rawYear === undefined || rawYear === null ? null : rawYear };
}

function normalizeArticleFeedFilter(filter: { readonly contentType?: ArticleContentType }): ArticleContentType | null {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) invalid("Article feed filter is invalid.");
  const value = filter.contentType;
  if (value === undefined) return null;
  if (typeof value !== "string" || !ARTICLE_CONTENT_TYPES.has(value as ArticleContentType)) invalid("Article content type filter is invalid.");
  return value as ArticleContentType;
}

function normalizeEditorialListFilter(filter: EditorialListForEditFilter): { readonly kind: "article" | "episode" | "page"; readonly query: string } {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) invalid("Editorial list filter is invalid.");
  if (filter.kind !== "article" && filter.kind !== "episode" && filter.kind !== "page") invalid("Editorial list kind is invalid.");
  if (filter.query !== undefined && typeof filter.query !== "string") invalid("Editorial list query is invalid.");
  const query = filter.query === undefined ? "" : filter.query.normalize("NFKC").replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  if (new TextEncoder().encode(query).byteLength > MAX_EDITORIAL_FILTER_QUERY_LENGTH) invalid("Editorial list query is too long.");
  return { kind: filter.kind, query: escapeLikeQuery(query) };
}

function editorialPublishedRevision(kind: EditorialKind, documentId: string, row: EditorialRow): RevisionToken | null {
  const pointer = row.published_revision_id;
  const createdAt = row.published_revision_at;
  if (pointer === null || pointer === undefined) {
    if (createdAt !== null && createdAt !== undefined) fail("D1 published editorial revision integrity check failed.");
    return null;
  }
  if (createdAt === null || createdAt === undefined) fail("D1 published editorial revision integrity check failed.");
  stableProviderValue(pointer, "published revision ID");
  const publishedAt = timestamp({ published_at: createdAt }, "published_at");
  return revision(kind, documentId, publishedAt);
}

function editorialSummaryFromRow(kind: EditorialKind, row: EditorialRow): EditorialDocumentSummary {
  const updatedAt = timestamp(row, "updated_at");
  const status = publicationState(row.status);
  const title = requiredText(row, "title");
  const rawSlug = requiredString(row, "slug");
  const currentRevision = revision(kind, kind === "article" ? documentIdForArticle(row) : providerId(row, "document_id"), updatedAt);
  if (row.current_revision_id !== null && row.current_revision_id !== undefined) {
    const currentId = stableProviderValue(row.current_revision_id, "current revision ID");
    if (row.current_revision_joined_id !== currentId) fail("D1 current editorial revision integrity check failed.");
  }
  const documentId = kind === "article" ? documentIdForArticle(row) : providerId(row, "document_id");
  const publishedRevision = editorialPublishedRevision(kind, documentId, row);
  if (kind === "article") {
    const articleId = providerId(row, "article_id", "article ID");
    return {
      documentId: documentId as EditorialDocumentId,
      entity: { kind, id: articleId as ArticleId },
      title,
      slug: normalizeSlug(rawSlug),
      publicationState: status,
      currentRevision,
      publishedRevision,
      updatedAt,
      contentType: articleContentType(row),
    };
  }
  if (kind === "episode") {
    return {
      documentId: documentId as EditorialDocumentId,
      entity: { kind, id: providerId(row, "episode_id", "episode ID") as EpisodeId },
      title,
      slug: normalizeSlug(rawSlug),
      publicationState: status,
      currentRevision,
      publishedRevision,
      updatedAt,
    };
  }
  return {
    documentId: documentId as EditorialDocumentId,
    entity: { kind, id: documentId as EditorialDocumentId },
    title,
    slug: normalizeSlug(rawSlug, "page slug"),
    publicationState: status,
    currentRevision,
    publishedRevision,
    updatedAt,
  };
}

function requireId(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || new TextEncoder().encode(value).byteLength > 512 || /[\u0000-\u001F\u007F]/u.test(value)) invalid(`${label} must be a non-empty stable ID.`);
  return value;
}

function encodePathSegment(value: string): string { return encodeURIComponent(value); }

function revision(kind: "article" | "episode" | "page" | "site-settings" | "user-access", documentId: string, updatedAt: IsoDateTime): RevisionToken {
  try {
    return encodeRepositoryRevision({ kind, documentId, updatedAt });
  } catch (error) {
    fail("D1 revision integrity check failed.", error);
  }
}

interface CursorData { readonly v: 1; readonly kind: "article" | "episode"; readonly publishedAt: string; readonly id: string; }

function cursorEncode(data: Omit<CursorData, "v">): OpaqueCursor {
  const value = JSON.stringify({ v: 1, ...data });
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  if (encoded.length > 2048) invalid("Repository cursor is too long.");
  return encoded as OpaqueCursor;
}

function cursorDecode(value: OpaqueCursor | undefined, kind: CursorData["kind"]): CursorData {
  if (!value) return { v: 1, kind, publishedAt: "9999-12-31T23:59:59.999999Z", id: "" };
  if (typeof value !== "string") invalid("Repository cursor is malformed.");
  const raw = value;
  if (!/^[A-Za-z0-9_-]+$/u.test(raw) || raw.length > 2048) invalid("Repository cursor is malformed.");
  try {
    const padded = `${raw}${"=".repeat((4 - (raw.length % 4)) % 4)}`;
    const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("Repository cursor is malformed.");
    const candidate = parsed as Record<string, unknown>;
    if (Object.keys(candidate).join(",") !== "v,kind,publishedAt,id" || candidate.v !== 1 || candidate.kind !== kind || typeof candidate.publishedAt !== "string" || typeof candidate.id !== "string" || !isCanonicalTimestamp(candidate.publishedAt) || cursorEncode({ kind, publishedAt: candidate.publishedAt, id: candidate.id }) !== raw) invalid("Repository cursor is malformed.");
    requireId(candidate.id, "cursor id");
    return { v: 1, kind, publishedAt: candidate.publishedAt, id: candidate.id };
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    invalid("Repository cursor is malformed.");
  }
}

interface EditorialCursorData {
  readonly v: 1;
  readonly kind: "article" | "episode" | "page";
  readonly updatedAt: string;
  readonly id: string;
}

function editorialCursorEncode(data: Omit<EditorialCursorData, "v">): OpaqueCursor {
  const value = JSON.stringify({ v: 1, ...data });
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  if (encoded.length > 2048) invalid("Repository cursor is too long.");
  return encoded as OpaqueCursor;
}

function editorialCursorDecode(value: OpaqueCursor | undefined, kind: EditorialCursorData["kind"]): EditorialCursorData {
  if (!value) return { v: 1, kind, updatedAt: EDIT_CURSOR_DEFAULT, id: "" };
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 2048) invalid("Repository cursor is malformed.");
  try {
    const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
    const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("Repository cursor is malformed.");
    const candidate = parsed as Record<string, unknown>;
    if (Object.keys(candidate).join(",") !== "v,kind,updatedAt,id" || candidate.v !== 1 || candidate.kind !== kind || typeof candidate.updatedAt !== "string" || typeof candidate.id !== "string" || !isCanonicalTimestamp(candidate.updatedAt) || editorialCursorEncode({ kind, updatedAt: candidate.updatedAt, id: candidate.id }) !== value) invalid("Repository cursor is malformed.");
    requireId(candidate.id, "editorial cursor id");
    return { v: 1, kind, updatedAt: candidate.updatedAt, id: candidate.id };
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    invalid("Repository cursor is malformed.");
  }
}

async function first<Row extends Record<string, unknown>>(db: D1Database, sql: string, values: readonly unknown[], context: OperationContext): Promise<Row | null> {
  checkCancelled(context);
  try {
    const statement = db.prepare(sql).bind(...values);
    const result = await statement.first<Row>();
    checkCancelled(context);
    if (result === null) return null;
    if (typeof result !== "object" || Array.isArray(result)) fail("D1 read returned an invalid row.");
    return result;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    fail("D1 read is temporarily unavailable.", error);
  }
}

async function all<Row extends Record<string, unknown>>(db: D1Database, sql: string, values: readonly unknown[], context: OperationContext): Promise<readonly Row[]> {
  checkCancelled(context);
  try {
    const result = await db.prepare(sql).bind(...values).all<Row>();
    if (!result || result.success !== undefined && result.success !== true || !Array.isArray(result.results)) fail("D1 read returned an invalid result.");
    for (const row of result.results) {
      if (!row || typeof row !== "object" || Array.isArray(row)) fail("D1 read returned an invalid row.");
    }
    checkCancelled(context);
    return result.results;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    fail("D1 read is temporarily unavailable.", error);
  }
}

function articleFromRow(row: Record<string, unknown>, includeBody: boolean): Article | ArticleSummary {
  if (row.status !== "Published" || row.visibility !== "public") fail("D1 article publication integrity check failed.");
  const id = requiredString(row, "article_id") as ArticleId;
  const sourceType = requiredString(row, "source_type");
  let source: StableExternalReference;
  let documentId: string;
  if (sourceType === "cms") {
    documentId = requiredString(row, "cms_document_id");
    source = { source: "strapi", value: documentId };
  } else if (sourceType === "pastorwood") {
    documentId = id;
    source = { source: "postgresql", value: requiredString(row, "source_post_id") };
  } else fail("D1 article source integrity check failed.");
  const slug = normalizeSlug(requiredString(row, "slug"));
  const publishedAt = timestamp(row, "published_at");
  const updatedAt = timestamp(row, "updated_at");
  const hash = contentHash(row);
  const canonical = requiredText(row, "canonical_url") || `/writings/${encodePathSegment(slug)}/`;
  if (canonical.length > 0 && (canonical.trim() !== canonical || /[\u0000-\u001F\u007F]/u.test(canonical))) fail("D1 article URL integrity check failed.");
  const summary: ArticleSummary = {
    id,
    source,
    slug,
    title: requiredText(row, "title"),
    summary: requiredText(row, "excerpt") || null,
    contentType: articleContentType(row),
    publishedAt,
    canonicalUrl: canonical,
    contentHash: hash,
  };
  if (!includeBody) return summary;
  return { ...summary, body: requiredText(row, "body_html"), revision: revision("article", documentId, updatedAt) };
}

function episodeFromRow(row: Record<string, unknown>, includeBody: boolean): Episode | EpisodeSummary {
  const id = requiredString(row, "episode_id") as EpisodeId;
  const sourceSystem = requiredString(row, "source_system");
  if (!EPISODE_SOURCES.has(sourceSystem)) fail("D1 episode source integrity check failed.");
  const sourceId = requiredString(row, "source_id");
  const slug = normalizeSlug(requiredString(row, "slug"));
  const documentId = requiredString(row, "document_id");
  const publishedAt = timestamp(row, "published_at");
  const updatedAt = timestamp(row, "document_updated_at");
  const hash = contentHash(row);
  const canonicalKey = requiredString(row, "canonical_audio_key");
  if (canonicalKey !== `podcasts/${id}.mp3`) fail("D1 episode audio-key integrity check failed.");
  if (row.status !== "Published" || row.visibility !== "public") fail("D1 episode publication integrity check failed.");
  const result: EpisodeSummary = {
    id,
    source: { source: sourceSystem as StableExternalReference["source"], value: sourceId },
    slug,
    title: requiredText(row, "title"),
    summary: requiredText(row, "summary") || null,
    programDate: isoDate(row, "publish_date"),
    publishedAt,
    canonicalUrl: `/radio/${encodePathSegment(slug)}/`,
    hasAudio: row.has_audio === 1 || row.has_audio === true,
    contentHash: hash,
  };
  if (!includeBody) return result;
  return {
    ...result,
    body: requiredText(row, "description") || null,
    transcriptAvailable: row.transcript_status === "Completed",
    revision: revision("episode", documentId, updatedAt),
  };
}

async function pageFromRow(row: Record<string, unknown>, context: OperationContext): Promise<PublicPage> {
  const documentId = requiredString(row, "document_id") as EditorialDocumentId;
  const storedSlug = requiredString(row, "slug");
  const slug = storedSlug === "/" ? storedSlug : normalizeSlug(storedSlug, "page slug");
  if (row.status !== "Published") fail("D1 page publication integrity check failed.");
  const revisionId = requiredString(row, "published_revision_id");
  if (!revisionId || row.revision_entity_type !== "page" || row.revision_entity_id !== documentId || row.revision_status !== "Published") fail("D1 page revision integrity check failed.");
  const body = requiredText(row, "body_html");
  checkCancelled(context);
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  } catch (error) {
    fail("D1 page content hashing is temporarily unavailable.", error);
  }
  checkCancelled(context);
  const contentHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") as ContentHash;
  const updatedAt = timestamp(row, "updated_at");
  return {
    documentId,
    slug,
    title: requiredText(row, "title"),
    body,
    canonicalUrl: slug === "/" ? "/" : canonicalSegmentUrl("/", slug),
    contentHash,
    revision: revision("page", documentId, updatedAt),
  };
}

function normalizedRedirectPath(value: string): string {
  if (typeof value !== "string" || value.trim() !== value || !value.startsWith("/") || /[\u0000-\u001F\u007F\\]/u.test(value)) invalid("Redirect path is invalid.");
  return value;
}

export class D1PublicContentRepository implements PublicContentRepository {
  readonly #db: D1Database;
  constructor(options: D1ReadRepositoryOptions) { this.#db = options.db; }

  async getArticleById(context: OperationContext, id: ArticleId): Promise<Article | null> {
    const normalized = requireId(id, "articleId");
    const row = await first(this.#db, ARTICLE_SOURCE_SQL, [normalized], context);
    return row ? articleFromRow(row, true) as Article : null;
  }
  async getPublishedArticleBySlug(context: OperationContext, slug: string): Promise<Article | null> {
    const normalized = normalizeSlug(slug);
    const row = await first(this.#db, ARTICLE_SLUG_SQL, [normalized], context);
    return row ? articleFromRow(row, true) as Article : null;
  }
  async listPublishedArticles(context: OperationContext, page: PageRequest): Promise<PageResult<ArticleSummary>> {
    assertRepositoryPageRequest(page);
    const cursor = cursorDecode(page.cursor, "article");
    const rows = await all(this.#db, ARTICLE_LIST_SQL, [cursor.publishedAt, cursor.publishedAt, cursor.id, page.limit + 1], context);
    const items = rows.slice(0, page.limit).map((row) => articleFromRow(row, false) as ArticleSummary);
    const last = rows[page.limit - 1];
    return rows.length > page.limit && last ? { items, nextCursor: cursorEncode({ kind: "article", publishedAt: requiredString(last, "published_at"), id: requiredString(last, "article_id") }) } : { items };
  }
  async listPublishedArticleFeed(context: OperationContext, page: PageRequest): Promise<PageResult<ArticleFeedItem>> {
    assertRepositoryPageRequest(page);
    const cursor = cursorDecode(page.cursor, "article");
    const rows = await all(this.#db, ARTICLE_FEED_SQL, [cursor.publishedAt, cursor.publishedAt, cursor.id, page.limit + 1], context);
    const items = rows.slice(0, page.limit).map((row) => articleFromRow(row, true) as ArticleFeedItem);
    const last = rows[page.limit - 1];
    return rows.length > page.limit && last ? { items, nextCursor: cursorEncode({ kind: "article", publishedAt: requiredString(last, "published_at"), id: requiredString(last, "article_id") }) } : { items };
  }
  async listPublishedArticleFeedFiltered(context: OperationContext, page: PageRequest, filter: { readonly contentType?: ArticleContentType }): Promise<CountedPageResult<ArticleFeedItem>> {
    assertRepositoryPageRequest(page);
    const contentType = normalizeArticleFeedFilter(filter);
    const cursor = cursorDecode(page.cursor, "article");
    const countRow = await first(this.#db, ARTICLE_FEED_FILTERED_COUNT_SQL, [contentType, contentType], context);
    if (!countRow) fail("D1 article feed count is missing.");
    const total = requiredCount(countRow);
    const rows = await all(this.#db, ARTICLE_FEED_FILTERED_SQL, [contentType, contentType, cursor.publishedAt, cursor.publishedAt, cursor.id, page.limit + 1], context);
    const items = rows.slice(0, page.limit).map((row) => articleFromRow(row, true) as ArticleFeedItem);
    const last = rows[page.limit - 1];
    return {
      total,
      items,
      ...(rows.length > page.limit && last ? { nextCursor: cursorEncode({ kind: "article", publishedAt: requiredString(last, "published_at"), id: requiredString(last, "article_id") }) } : {}),
    };
  }
  async getEpisodeById(context: OperationContext, id: EpisodeId): Promise<Episode | null> {
    const normalized = requireId(id, "episodeId");
    const row = await first(this.#db, EPISODE_SOURCE_SQL, [normalized], context);
    return row ? episodeFromRow(row, true) as Episode : null;
  }
  async getPublishedEpisodeBySlug(context: OperationContext, slug: string): Promise<Episode | null> {
    const normalized = normalizeSlug(slug);
    const row = await first(this.#db, EPISODE_SLUG_SQL, [normalized], context);
    return row ? episodeFromRow(row, true) as Episode : null;
  }
  async listPublishedEpisodes(context: OperationContext, page: PageRequest): Promise<PageResult<EpisodeSummary>> {
    assertRepositoryPageRequest(page);
    const cursor = cursorDecode(page.cursor, "episode");
    const rows = await all(this.#db, EPISODE_LIST_SQL, [cursor.publishedAt, cursor.publishedAt, cursor.id, page.limit + 1], context);
    const items = rows.slice(0, page.limit).map((row) => episodeFromRow(row, false) as EpisodeSummary);
    const last = rows[page.limit - 1];
    return rows.length > page.limit && last ? { items, nextCursor: cursorEncode({ kind: "episode", publishedAt: requiredString(last, "published_at"), id: requiredString(last, "episode_id") }) } : { items };
  }
  async listPublishedEpisodesFiltered(context: OperationContext, page: PageRequest, filter: EpisodeListFilter): Promise<CountedPageResult<EpisodeSummary>> {
    assertRepositoryPageRequest(page);
    const normalizedFilter = normalizeEpisodeFilter(filter);
    const cursor = cursorDecode(page.cursor, "episode");
    const yearStart = normalizedFilter.year === null ? null : `${normalizedFilter.year}-01-01`;
    const yearEnd = normalizedFilter.year === null ? null : `${normalizedFilter.year + 1}-01-01`;
    const filterValues = [
      normalizedFilter.query,
      normalizedFilter.query,
      normalizedFilter.query,
      normalizedFilter.query,
      normalizedFilter.query,
      normalizedFilter.query,
      yearStart,
      yearStart,
      yearEnd,
    ];
    const countRow = await first(this.#db, EPISODE_FILTER_COUNT_SQL, filterValues, context);
    if (!countRow) fail("D1 episode count is missing.");
    const total = requiredCount(countRow);
    const rows = await all(this.#db, EPISODE_FILTER_LIST_SQL, [
      ...filterValues,
      cursor.publishedAt,
      cursor.publishedAt,
      cursor.id,
      page.limit + 1,
    ], context);
    const items = rows.slice(0, page.limit).map((row) => episodeFromRow(row, false) as EpisodeSummary);
    const last = rows[page.limit - 1];
    return {
      total,
      items,
      ...(rows.length > page.limit && last ? { nextCursor: cursorEncode({ kind: "episode", publishedAt: requiredString(last, "published_at"), id: requiredString(last, "episode_id") }) } : {}),
    };
  }
  async getDynamicPageBySlug(context: OperationContext, slug: string): Promise<PublicPage | null> {
    const normalized = slug === "/" ? slug : normalizeSlug(slug, "page slug");
    const row = await first(this.#db, PAGE_SQL, [normalized], context);
    return row ? pageFromRow(row, context) : null;
  }
  async getSiteSettings(context: OperationContext): Promise<SiteSettings> {
    const rows = await all(this.#db, SETTINGS_SQL, [], context);
    if (rows.length !== SITE_SETTING_KEYS.length) fail("D1 site settings integrity check failed.");
    const values = new Map<string, { value: unknown; updatedAt: IsoDateTime }>();
    for (const row of rows) {
      const key = requiredString(row, "setting_key");
      if (!SITE_SETTING_KEYS.includes(key as typeof SITE_SETTING_KEYS[number]) || values.has(key)) fail("D1 site settings integrity check failed.");
      if (row.value_type !== "json" || row.is_public !== 1) fail("D1 site settings integrity check failed.");
      const raw = requiredString(row, "value_json");
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch (error) { fail("D1 site settings integrity check failed.", error); }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !("value" in parsed)) fail("D1 site settings integrity check failed.");
      values.set(key, { value: (parsed as { value: unknown }).value, updatedAt: timestamp(row, "updated_at") });
    }
    const title = values.get("site.title")!;
    const origin = values.get("site.canonicalOrigin")!;
    const indexing = values.get("site.allowIndexing")!;
    if (title.value === undefined || typeof title.value !== "string" || !title.value.trim()) fail("D1 site settings integrity check failed.");
    if (origin.value === undefined || typeof origin.value !== "string") fail("D1 site settings integrity check failed.");
    let parsedOrigin: URL;
    try { parsedOrigin = new URL(origin.value); } catch (error) { fail("D1 site settings integrity check failed.", error); }
    if (parsedOrigin.protocol !== "https:" || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash || origin.value !== parsedOrigin.origin) fail("D1 site settings integrity check failed.");
    if (typeof indexing.value !== "boolean") fail("D1 site settings integrity check failed.");
    if (new Set([title.updatedAt, origin.updatedAt, indexing.updatedAt]).size !== 1) fail("D1 site settings integrity check failed.");
    return { documentId: "site_settings:global" as EditorialDocumentId, title: title.value, canonicalOrigin: origin.value, allowIndexing: indexing.value, revision: revision("site-settings", "site_settings:global", title.updatedAt) };
  }
  async resolveRedirect(context: OperationContext, path: string): Promise<RedirectRecord | null> {
    const normalized = normalizedRedirectPath(path);
    const row = await first(this.#db, REDIRECT_SQL, [normalized], context);
    if (!row) return null;
    const status = row.status_code;
    if (status !== 301 && status !== 302 && status !== 307 && status !== 308) fail("D1 redirect integrity check failed.");
    const sourcePath = requiredString(row, "source_path");
    if (sourcePath !== normalized) fail("D1 redirect integrity check failed.");
    const destination = requiredString(row, "target_path");
    if (/[\u0000-\u001F\u007F]/u.test(destination)) fail("D1 redirect integrity check failed.");
    return { sourcePath, destination, status: status as 301 | 302 | 307 | 308 };
  }
}

export class D1UserAccessRepository implements UserAccessRepository {
  readonly #db: D1Database;
  constructor(options: D1ReadRepositoryOptions) { this.#db = options.db; }
  async getByUserId(context: OperationContext, userId: UserId): Promise<UserAccessRecord | null> {
    const normalizedUserId = requireId(userId, "userId");
    const rows = await all(this.#db, USER_SQL, [normalizedUserId], context);
    if (!rows.length) return null;
    const firstRow = rows[0]!;
    const stableUserId = requiredString(firstRow, "clerk_user_id");
    if (stableUserId !== normalizedUserId) fail("D1 user access integrity check failed.");
    const internalId = requiredString(firstRow, "user_id");
    const status = requiredString(firstRow, "status");
    const updatedAt = timestamp(firstRow, "updated_at");
    const roles = new Set<RoleName>();
    for (const row of rows) {
      if (requiredString(row, "user_id") !== internalId || requiredString(row, "clerk_user_id") !== stableUserId || requiredString(row, "status") !== status || timestamp(row, "updated_at") !== updatedAt) fail("D1 user access integrity check failed.");
      if (row.role === null || row.role === undefined) continue;
      if (typeof row.role !== "string" || !KNOWN_ROLES.has(row.role)) fail("D1 user role integrity check failed.");
      roles.add(row.role as RoleName);
    }
    return { userId, roles: ["User", "Admin", "Content Manager", "Research User", "Read Only"].filter((role) => roles.has(role as RoleName)) as RoleName[], disabled: status !== "active", revision: revision("user-access", stableUserId, updatedAt) };
  }
}

/* -------------------------------------------------------------------------- */
/* Phase 4 editorial writes                                                   */
/* -------------------------------------------------------------------------- */

const EDIT_ARTICLE_SQL = `
  SELECT a.article_id, a.source_type, a.cms_document_id, a.source_post_id,
         a.slug, a.title, a.excerpt, a.body_html, a.canonical_url,
         a.seo_title, a.seo_description, a.content_hash, a.content_type,
         a.status, a.visibility,
         a.updated_at, a.current_revision_id, a.published_revision_id,
         r.status AS current_revision_status, r.snapshot_json AS current_snapshot,
         pr.created_at AS published_revision_at, pr.snapshot_json AS published_snapshot
    FROM articles a
    LEFT JOIN editorial_revisions r
      ON r.revision_id = a.current_revision_id
     AND r.entity_type = 'article' AND r.entity_id = CASE WHEN a.source_type = 'cms' THEN a.cms_document_id ELSE a.article_id END
    LEFT JOIN editorial_revisions pr
      ON pr.revision_id = a.published_revision_id
     AND pr.entity_type = 'article' AND pr.entity_id = CASE WHEN a.source_type = 'cms' THEN a.cms_document_id ELSE a.article_id END
   WHERE (a.article_id = ? OR a.cms_document_id = ?)`;
const EDIT_EPISODE_SQL = `
  SELECT d.document_id, d.episode_id, d.slug, d.title, d.summary, d.description,
         d.status, d.visibility, d.updated_at, d.current_revision_id,
         d.published_revision_id, d.content_hash, e.publish_date,
         e.canonical_audio_key, e.status AS episode_status,
         r.status AS current_revision_status, r.snapshot_json AS current_snapshot,
         pr.created_at AS published_revision_at, pr.snapshot_json AS published_snapshot,
         CASE WHEN m.asset_id IS NULL THEN 0 ELSE 1 END AS has_audio,
         m.size_bytes AS audio_size_bytes, m.sha256 AS audio_sha256
    FROM episode_documents d
    JOIN episodes e ON e.episode_id = d.episode_id
    LEFT JOIN editorial_revisions r
      ON r.revision_id = d.current_revision_id
     AND r.entity_type = 'episode' AND r.entity_id = d.document_id
    LEFT JOIN editorial_revisions pr
      ON pr.revision_id = d.published_revision_id
     AND pr.entity_type = 'episode' AND pr.entity_id = d.document_id
    LEFT JOIN media_assets m
      ON m.canonical_object_key = e.canonical_audio_key
     AND m.destination_bucket = 'aic-podcast-audio'
     AND m.mime_type = 'audio/mpeg'
     AND m.status IN ('verified', 'published')
   WHERE d.document_id = ? OR d.episode_id = ?`;
const EDIT_PAGE_SQL = `
  SELECT p.document_id, p.slug, p.title, p.status, p.updated_at,
         p.current_revision_id, p.published_revision_id,
         r.status AS current_revision_status, r.snapshot_json AS current_snapshot,
         pr.created_at AS published_revision_at,
         pr.snapshot_json AS published_snapshot, pr.body_html AS published_body_html
    FROM pages p
    LEFT JOIN editorial_revisions r
      ON r.revision_id = p.current_revision_id
     AND r.entity_type = 'page' AND r.entity_id = p.document_id
    LEFT JOIN editorial_revisions pr
      ON pr.revision_id = p.published_revision_id
     AND pr.entity_type = 'page' AND pr.entity_id = p.document_id
   WHERE p.document_id = ?`;
const OPERATION_SQL = `
  SELECT revision_id, operation_key, entity_type, entity_id, snapshot_json, status, created_at
    FROM editorial_revisions
   WHERE operation_key = ?`;

const EDITORIAL_MAX_TITLE = 1_000;
const EDITORIAL_MAX_SUMMARY = 20_000;
const EDITORIAL_MAX_BODY_BYTES = 256 * 1024;
const EDITORIAL_MAX_CANONICAL = 2_000;
const EDITORIAL_MAX_SEO_TITLE = 500;
const EDITORIAL_MAX_SEO_DESCRIPTION = 2_000;
const EDITORIAL_MAX_NOTE = 2_000;
const EDITORIAL_MAX_SNAPSHOT = 300 * 1024;

type EditorialKind = "article" | "episode" | "page";
type EditorialRow = Record<string, unknown>;

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort().join(",");
  const expected = [...keys].sort().join(",");
  if (actual !== expected) invalid(`${label} has an invalid shape.`);
}

function boundedString(value: unknown, label: string, maxBytes: number, nonEmpty = false): string {
  if (typeof value !== "string" || /[\u0000]/u.test(value)) invalid(`${label} must be valid text.`);
  if (nonEmpty && value.length === 0) invalid(`${label} must not be empty.`);
  if (new TextEncoder().encode(value).byteLength > maxBytes) invalid(`${label} is too long.`);
  return value;
}

function canonicalUrlValue(value: unknown): string | null {
  if (value === null) return null;
  const result = boundedString(value, "article canonical URL", EDITORIAL_MAX_CANONICAL, true);
  if (result.trim() !== result || /[\u0000-\u001F\u007F]/u.test(result)) invalid("article canonical URL must be a normalized URL.");
  return result;
}

function optionalBoundedString(value: unknown, label: string, maxBytes: number): string | null {
  if (value === null) return null;
  return boundedString(value, label, maxBytes);
}

function validDateValue(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !ISO_DATE.test(value)) invalid(`${label} must be a canonical date.`);
  const match = ISO_DATE.exec(value);
  if (!match) invalid(`${label} must be a canonical date.`);
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > (days[month - 1] ?? 0)) invalid(`${label} must be a canonical date.`);
  return value;
}

function persistedDateValue(value: unknown, label: string): string | null {
  if (value === null || value === undefined) fail(`D1 ${label} integrity check failed.`);
  try {
    return value === "" ? null : validDateValue(value, label);
  } catch (error) {
    if (error instanceof ServiceError && error.code === "invalid_argument") fail(`D1 ${label} integrity check failed.`, error);
    throw error;
  }
}

function editorialSlug(value: unknown, label: string, allowRoot = false): string {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > 255 || value.trim() !== value || /[\u0000-\u001F\u007F\\]/u.test(value)) invalid(`${label} is invalid.`);
  if (allowRoot && value === "/") return value;
  if (value.includes("/") || value === "." || value === "..") invalid(`${label} is invalid.`);
  return value;
}

function validateArticlePayload(value: unknown): ArticleDraftPayload {
  const p = assertObject(value, "article payload");
  exactKeys(p, ["title", "slug", "summary", "body", "visibility", "canonicalUrl", "seoTitle", "seoDescription"], "article payload");
  const visibility = p.visibility;
  if (visibility !== "public" && visibility !== "private" && visibility !== "unlisted") invalid("article visibility is invalid.");
  return {
    title: boundedString(p.title, "article title", EDITORIAL_MAX_TITLE, true),
    slug: editorialSlug(p.slug, "article slug"),
    summary: optionalBoundedString(p.summary, "article summary", EDITORIAL_MAX_SUMMARY),
    body: boundedString(p.body, "article body", EDITORIAL_MAX_BODY_BYTES, true),
    visibility,
    canonicalUrl: canonicalUrlValue(p.canonicalUrl),
    seoTitle: optionalBoundedString(p.seoTitle, "article SEO title", EDITORIAL_MAX_SEO_TITLE),
    seoDescription: optionalBoundedString(p.seoDescription, "article SEO description", EDITORIAL_MAX_SEO_DESCRIPTION),
  };
}

function validateEpisodePayload(value: unknown): EpisodeDraftPayload {
  const p = assertObject(value, "episode payload");
  exactKeys(p, ["title", "slug", "summary", "body", "visibility", "programDate"], "episode payload");
  const visibility = p.visibility;
  if (visibility !== "public" && visibility !== "private" && visibility !== "unlisted") invalid("episode visibility is invalid.");
  return {
    title: boundedString(p.title, "episode title", EDITORIAL_MAX_TITLE, true),
    slug: editorialSlug(p.slug, "episode slug"),
    summary: optionalBoundedString(p.summary, "episode summary", EDITORIAL_MAX_SUMMARY),
    body: optionalBoundedString(p.body, "episode body", EDITORIAL_MAX_BODY_BYTES),
    visibility,
    programDate: validDateValue(p.programDate, "episode program date") as EpisodeDraftPayload["programDate"],
  };
}

function validatePagePayload(value: unknown): PageDraftPayload {
  const p = assertObject(value, "page payload");
  exactKeys(p, ["title", "slug", "body"], "page payload");
  return {
    title: boundedString(p.title, "page title", EDITORIAL_MAX_TITLE, true),
    slug: editorialSlug(p.slug, "page slug", true),
    body: boundedString(p.body, "page body", EDITORIAL_MAX_BODY_BYTES),
  };
}

function validateIdempotency(value: unknown): IdempotencyKey {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > 256 || value.trim() !== value || /[\u0000-\u001F\u007F]/u.test(value)) invalid("idempotencyKey is invalid.");
  return value as IdempotencyKey;
}

function entityKind(entity: EditorialEntityReference | undefined, documentId: string): EditorialKind {
  if (!entity) invalid("Editorial entity is required.");
  if (entity.kind !== "article" && entity.kind !== "episode" && entity.kind !== "page") invalid("Editorial entity kind is invalid.");
  return entity.kind;
}

function validateEntity(entity: EditorialEntityReference | undefined, kind: EditorialKind, documentId: string): void {
  if (!entity || entity.kind !== kind || typeof entity.id !== "string" || entity.id.length === 0) invalid("Editorial entity is invalid.");
  requireId(entity.id, "Editorial entity ID");
  if (kind === "page" && entity.id !== documentId) throw new ServiceError({ code: "conflict", message: "Editorial entity does not match the document." });
}

function parseSnapshot(value: unknown): { readonly kind?: string; readonly documentId?: string; readonly payload?: unknown; readonly fingerprint?: string; readonly result?: EditorialWriteResult } | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as { readonly kind?: string; readonly documentId?: string; readonly payload?: unknown; readonly fingerprint?: string; readonly result?: EditorialWriteResult };
  } catch { return null; }
}

function isoNowAfter(previous: string): IsoDateTime {
  const match = ISO_TIMESTAMP.exec(previous);
  if (!match) fail("D1 editorial timestamp integrity check failed.");
  const previousMicros = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])) * 1_000
    + Number(match[7]);
  let micros = Math.max(Date.now() * 1_000, previousMicros + 1);
  const milliseconds = Math.floor(micros / 1_000);
  const remainder = micros % 1_000_000;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) fail("D1 editorial timestamp integrity check failed.");
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}.${String(remainder).padStart(6, "0")}Z` as IsoDateTime;
}

async function sha256Text(value: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (error) { fail("D1 editorial hashing is temporarily unavailable.", error); }
}

async function executeWriteBatch(db: D1Database, statements: readonly D1PreparedStatement[], context: OperationContext): Promise<void> {
  if (typeof db.batch !== "function") fail("D1 write transactions are unavailable.");
  checkCancelled(context);
  let results: readonly D1Result[];
  try { results = await db.batch([...statements]); } catch (error) { fail("D1 write is temporarily unavailable.", error); }
  // Once D1 has accepted the batch, cancellation cannot turn an unknown or
  // committed write into a client-visible cancellation; callers can replay by
  // idempotency key to resolve an ambiguous provider response.
  if (!Array.isArray(results) || results.length !== statements.length || results.some((result) => result?.success !== true || result?.meta?.changes !== 1)) fail("D1 write returned an invalid result.");
}

function publicationState(value: unknown): PublicationState {
  if (value === "Draft" || value === "Scheduled" || value === "Published" || value === "Archived") return value.toLowerCase() as PublicationState;
  fail("D1 editorial state integrity check failed.");
}

function documentIdForArticle(row: EditorialRow): string {
  const sourceType = requiredString(row, "source_type");
  if (sourceType === "cms") return providerId(row, "cms_document_id", "CMS document ID");
  if (sourceType === "pastorwood") return providerId(row, "article_id", "article ID");
  fail("D1 article source integrity check failed.");
}

function persistedPayload(kind: EditorialKind, snapshot: { readonly kind?: string; readonly documentId?: string; readonly payload?: unknown }, documentId: string): EditorialDraftPayload {
  if (snapshot.kind !== kind || snapshot.documentId !== documentId || snapshot.payload === undefined) fail("D1 editorial snapshot integrity check failed.");
  try {
    if (kind === "article") return validateArticlePayload(snapshot.payload);
    if (kind === "episode") return validateEpisodePayload(snapshot.payload);
    return validatePagePayload(snapshot.payload);
  } catch (error) {
    if (error instanceof ServiceError && error.code === "invalid_argument") fail("D1 editorial snapshot integrity check failed.", error);
    throw error;
  }
}

function persistedCanonicalPayload(build: () => EditorialDraftPayload): EditorialDraftPayload {
  try {
    return build();
  } catch (error) {
    if (error instanceof ServiceError && error.code === "invalid_argument") fail("D1 editorial canonical row integrity check failed.", error);
    throw error;
  }
}

function payloadFromRow(kind: EditorialKind, row: EditorialRow, documentId: string): EditorialDraftPayload {
  const snapshot = parseSnapshot(row.current_snapshot);
  if (snapshot?.payload !== undefined) {
    return persistedPayload(kind, snapshot, documentId);
  }
  if (kind === "article") return persistedCanonicalPayload(() => validateArticlePayload({
    title: requiredText(row, "title"), slug: requiredText(row, "slug"),
    summary: requiredText(row, "excerpt"), body: requiredText(row, "body_html"),
    visibility: requiredString(row, "visibility"), canonicalUrl: requiredText(row, "canonical_url") || null,
    seoTitle: requiredText(row, "seo_title") || null, seoDescription: requiredText(row, "seo_description") || null,
  }));
  if (kind === "episode") return persistedCanonicalPayload(() => validateEpisodePayload({
    title: requiredText(row, "title"), slug: requiredText(row, "slug"), summary: requiredText(row, "summary"),
    body: requiredText(row, "description"), visibility: requiredString(row, "visibility"), programDate: persistedDateValue(row.publish_date, "episode program date"),
  }));
  const publishedSnapshot = parseSnapshot(row.published_snapshot);
  if (publishedSnapshot?.payload !== undefined) return persistedPayload(kind, publishedSnapshot, documentId);
  return persistedCanonicalPayload(() => validatePagePayload({ title: requiredText(row, "title"), slug: requiredText(row, "slug"), body: requiredText(row, "published_body_html") }));
}

function validateJoinedSnapshot(value: unknown, kind: EditorialKind, documentId: string, label: string): void {
  if (typeof value !== "string") fail(`D1 ${label} snapshot integrity check failed.`);
  const snapshot = parseSnapshot(value);
  if (!snapshot) fail(`D1 ${label} snapshot integrity check failed.`);
  const hasKind = Object.prototype.hasOwnProperty.call(snapshot, "kind");
  const hasDocumentId = Object.prototype.hasOwnProperty.call(snapshot, "documentId");
  if (hasKind || hasDocumentId) {
    if (typeof snapshot.kind !== "string" || typeof snapshot.documentId !== "string") fail(`D1 ${label} snapshot integrity check failed.`);
    stableProviderValue(snapshot.documentId, `${label} snapshot document ID`);
    if (snapshot.kind !== kind || snapshot.documentId !== documentId) fail(`D1 ${label} snapshot integrity check failed.`);
  }
  if (snapshot.payload !== undefined) persistedPayload(kind, snapshot, documentId);
}

function resultFromRow(kind: EditorialKind, row: EditorialRow, documentId: string, updatedAt: IsoDateTime, operationKey?: string): EditorialWriteResult {
  return {
    documentId: documentId as EditorialDocumentId,
    revision: revision(kind, documentId, updatedAt),
    publicationState: publicationState(row.status),
    ...(operationKey === undefined ? {} : { operationKey: operationKey as OperationKey }),
  };
}

function commandSnapshot(payload: unknown, fingerprint: string, result: EditorialWriteResult, kind: EditorialKind, documentId: string): string {
  const encoded = JSON.stringify({ kind, documentId, payload, fingerprint, result });
  if (new TextEncoder().encode(encoded).byteLength > EDITORIAL_MAX_SNAPSHOT) invalid("Editorial snapshot is too large.");
  return encoded;
}

export interface D1EditorialRepositoryOptions {
  readonly db: D1Database;
}

export class D1EditorialRepository implements EditorialRepository {
  readonly #db: D1Database;
  constructor(options: D1EditorialRepositoryOptions) { this.#db = options.db; }

  async resolveEntity(
    context: OperationContext,
    input: {
      readonly kind: EditorialEntityReference["kind"];
      readonly documentId: EditorialDocumentId;
    },
  ): Promise<EditorialEntityReference | null> {
    if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Editorial entity lookup is invalid.");
    const documentId = requireId(input.documentId, "documentId");
    if (input.kind !== "article" && input.kind !== "episode" && input.kind !== "page") invalid("Editorial entity kind is invalid.");
    if (input.kind === "article") {
      const rows = await all(this.#db, RESOLVE_ARTICLE_SQL, [documentId, documentId], context);
      if (rows.length === 0) return null;
      if (rows.length !== 1) fail("D1 article identity is ambiguous.");
      const row = rows[0]!;
      const articleId = providerId(row, "article_id", "article ID");
      const sourceType = requiredString(row, "source_type", "article source type");
      if (sourceType === "cms") {
        if (providerId(row, "cms_document_id", "CMS document ID") !== documentId) fail("D1 article identity integrity check failed.");
        return { kind: "article", id: articleId as ArticleId };
      }
      if (sourceType === "pastorwood") {
        if (articleId !== documentId || (row.cms_document_id !== null && row.cms_document_id !== undefined)) fail("D1 article identity integrity check failed.");
        providerId(row, "source_post_id", "source post ID");
        return { kind: "article", id: articleId as ArticleId };
      }
      fail("D1 article source integrity check failed.");
    }
    if (input.kind === "episode") {
      const rows = await all(this.#db, RESOLVE_EPISODE_SQL, [documentId], context);
      if (rows.length === 0) return null;
      if (rows.length !== 1) fail("D1 episode identity is ambiguous.");
      const row = rows[0]!;
      const rowDocumentId = providerId(row, "document_id", "episode document ID");
      const episodeId = providerId(row, "episode_id", "episode ID");
      if (rowDocumentId !== documentId) fail("D1 episode identity integrity check failed.");
      return { kind: "episode", id: episodeId as EpisodeId };
    }
    const rows = await all(this.#db, RESOLVE_PAGE_SQL, [documentId], context);
    if (rows.length === 0) return null;
    if (rows.length !== 1) fail("D1 page identity is ambiguous.");
    const row = rows[0]!;
    if (providerId(row, "document_id", "page document ID") !== documentId) fail("D1 page identity integrity check failed.");
    return { kind: "page", id: documentId as EditorialDocumentId };
  }

  async listForEdit(context: OperationContext, page: PageRequest, filter: EditorialListForEditFilter): Promise<CountedPageResult<EditorialDocumentSummary>> {
    assertRepositoryPageRequest(page);
    const normalized = normalizeEditorialListFilter(filter);
    const cursor = editorialCursorDecode(page.cursor, normalized.kind);
    const queryValues = [normalized.query, normalized.query, normalized.query, normalized.query];
    const countSql = normalized.kind === "article" ? EDITORIAL_ARTICLE_COUNT_SQL : normalized.kind === "episode" ? EDITORIAL_EPISODE_COUNT_SQL : EDITORIAL_PAGE_COUNT_SQL;
    const listSql = normalized.kind === "article" ? EDITORIAL_ARTICLE_LIST_SQL : normalized.kind === "episode" ? EDITORIAL_EPISODE_LIST_SQL : EDITORIAL_PAGE_LIST_SQL;
    const countRow = await first(this.#db, countSql, queryValues, context);
    if (!countRow) fail("D1 editorial inventory count is missing.");
    const total = requiredCount(countRow);
    const rows = await all(this.#db, listSql, [
      ...queryValues,
      cursor.updatedAt,
      cursor.updatedAt,
      cursor.id,
      page.limit + 1,
    ], context);
    const items = rows.slice(0, page.limit).map((row) => editorialSummaryFromRow(normalized.kind, row));
    const last = rows[page.limit - 1];
    return {
      total,
      items,
      ...(rows.length > page.limit && last ? {
        nextCursor: editorialCursorEncode({
          kind: normalized.kind,
          updatedAt: timestamp(last, "updated_at"),
          id: normalized.kind === "article" ? documentIdForArticle(last) : providerId(last, "document_id"),
        }),
      } : {}),
    };
  }

  async #load(context: OperationContext, documentId: string, entity?: EditorialEntityReference): Promise<{ readonly kind: EditorialKind; readonly row: EditorialRow } | null> {
    const normalized = requireId(documentId, "documentId");
    const kind = entityKind(entity, normalized);
    validateEntity(entity, kind, normalized);
    const sql = kind === "article" ? EDIT_ARTICLE_SQL : kind === "episode" ? EDIT_EPISODE_SQL : EDIT_PAGE_SQL;
    const values = kind === "article" || kind === "episode" ? [normalized, normalized] : [normalized];
    let row: EditorialRow | null;
    if (kind === "article") {
      const rows = await all<EditorialRow>(this.#db, sql, values, context);
      if (rows.length > 1) throw new ServiceError({ code: "conflict", message: "Editorial article identity is ambiguous." });
      row = rows[0] ?? null;
    } else {
      row = await first(this.#db, sql, values, context);
    }
    if (!row) {
      const alternatives: readonly [string, readonly unknown[]][] = kind === "article"
        ? [[EDIT_EPISODE_SQL, [normalized, normalized]], [EDIT_PAGE_SQL, [normalized]]]
        : kind === "episode"
          ? [[EDIT_ARTICLE_SQL, [normalized, normalized]], [EDIT_PAGE_SQL, [normalized]]]
          : [[EDIT_ARTICLE_SQL, [normalized, normalized]], [EDIT_EPISODE_SQL, [normalized, normalized]]];
      for (const [alternativeSql, alternativeValues] of alternatives) {
        if (await first(this.#db, alternativeSql, alternativeValues, context)) throw new ServiceError({ code: "conflict", message: "Editorial document identity does not match the requested entity." });
      }
      return null;
    }
    if (kind === "article") {
      const articleId = providerId(row, "article_id", "article ID");
      const cmsDocumentId = row.cms_document_id === null || row.cms_document_id === undefined ? null : providerId(row, "cms_document_id", "CMS document ID");
      const matchCount = (articleId === normalized ? 1 : 0) + (cmsDocumentId === normalized ? 1 : 0);
      if (matchCount !== 1) throw new ServiceError({ code: "conflict", message: "Editorial article identity is ambiguous." });
    }
    const resolved = kind === "article" ? documentIdForArticle(row) : providerId(row, "document_id", "document ID");
    if (resolved !== normalized) throw new ServiceError({ code: "conflict", message: "Editorial document identity does not match the request." });
    if (entity && entity.id !== (kind === "page" ? resolved : providerId(row, kind === "article" ? "article_id" : "episode_id", kind === "article" ? "article ID" : "episode ID"))) throw new ServiceError({ code: "conflict", message: "Editorial entity does not match the document." });
    if (kind === "episode" && row.status !== row.episode_status) fail("D1 episode status integrity check failed.");
    if (row.current_revision_id !== null && row.current_revision_id !== undefined) {
      if (row.current_snapshot === null || row.current_snapshot === undefined) fail("D1 current editorial revision integrity check failed.");
      validateJoinedSnapshot(row.current_snapshot, kind, resolved, "current editorial");
    }
    if (row.published_revision_id !== null && row.published_revision_id !== undefined) {
      if (row.published_revision_at === null || row.published_revision_at === undefined || row.published_snapshot === null || row.published_snapshot === undefined) fail("D1 published editorial revision integrity check failed.");
      validateJoinedSnapshot(row.published_snapshot, kind, resolved, "published editorial");
    }
    requiredString(row, "updated_at");
    timestamp(row, "updated_at");
    return { kind, row };
  }

  async getForEdit(context: OperationContext, input: { readonly documentId: EditorialDocumentId; readonly entity?: EditorialEntityReference }): Promise<EditorialDocumentForEdit | null> {
    if (!input || typeof input !== "object" || Array.isArray(input) || !input.entity) invalid("Editorial entity is required.");
    const loaded = await this.#load(context, input.documentId, input.entity);
    if (!loaded) return null;
    const { kind, row } = loaded;
    const documentId = kind === "article" ? documentIdForArticle(row) : requiredString(row, "document_id");
    const updatedAt = timestamp(row, "updated_at");
    const payload = payloadFromRow(kind, row, documentId);
    const publishedAt = row.published_revision_at === null || row.published_revision_at === undefined ? null : timestamp({ at: row.published_revision_at }, "at");
    const base = {
      documentId: documentId as EditorialDocumentId,
      publicationState: publicationState(row.status),
      currentRevision: revision(kind, documentId, updatedAt),
      publishedRevision: publishedAt === null ? null : revision(kind, documentId, publishedAt),
      updatedAt,
    };
    if (kind === "article") return { ...base, entity: { kind: "article", id: requiredString(row, "article_id") as ArticleId }, contentType: articleContentType(row), payload: payload as ArticleDraftPayload };
    if (kind === "episode") return { ...base, entity: { kind: "episode", id: requiredString(row, "episode_id") as EpisodeId }, payload: payload as EpisodeDraftPayload };
    return { ...base, entity: { kind: "page", id: documentId as EditorialDocumentId }, payload: payload as PageDraftPayload };
  }

  async #existingOperation(context: OperationContext, operationKey: string, fingerprint: string, kind: EditorialKind, documentId: string, expectedPublicationState: PublicationState): Promise<EditorialWriteResult | null> {
    const row = await first(this.#db, OPERATION_SQL, [operationKey], context);
    if (!row) return null;
    const parsed = parseSnapshot(row.snapshot_json);
    if (!parsed || Object.keys(parsed).sort().join(",") !== "documentId,fingerprint,kind,payload,result" || typeof parsed.kind !== "string" || typeof parsed.documentId !== "string" || typeof parsed.fingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(parsed.fingerprint)) {
      fail("D1 idempotency receipt integrity check failed.");
    }
    stableProviderValue(parsed.documentId, "idempotency document ID");
    if (parsed.kind !== kind || parsed.documentId !== documentId) fail("D1 idempotency snapshot integrity check failed.");
    if (row.operation_key !== operationKey || row.revision_id !== `p4r_${operationKey}` || row.entity_type !== kind || row.entity_id !== documentId) fail("D1 idempotency receipt integrity check failed.");
    persistedPayload(kind, parsed, documentId);
    if (!parsed.result || typeof parsed.result !== "object" || Array.isArray(parsed.result)) fail("D1 idempotency receipt integrity check failed.");
    const result = parsed.result as unknown as Record<string, unknown>;
    if (Object.keys(result).sort().join(",") !== "documentId,operationKey,publicationState,revision" || result.documentId !== documentId || result.operationKey !== operationKey || typeof result.revision !== "string" || typeof result.publicationState !== "string" || !["draft", "scheduled", "published", "unpublished", "archived"].includes(result.publicationState)) fail("D1 idempotency receipt integrity check failed.");
    let decoded: ReturnType<typeof decodeRepositoryRevision>;
    try {
      decoded = decodeRepositoryRevision(result.revision as RevisionToken);
    } catch (error) {
      fail("D1 idempotency receipt integrity check failed.", error);
    }
    if (decoded.kind !== kind || decoded.documentId !== documentId) fail("D1 idempotency receipt integrity check failed.");
    if (timestamp(row, "created_at") !== decoded.updatedAt) fail("D1 idempotency receipt integrity check failed.");
    if (parsed.fingerprint !== fingerprint) throw new ServiceError({ code: "conflict", message: "The idempotency key was already used for a different command." });
    if (result.publicationState !== expectedPublicationState) fail("D1 idempotency receipt integrity check failed.");
    return parsed.result;
  }

  async saveDraft(context: OperationContext, mutation: EditorialMutation<EditorialDraftPayload>): Promise<EditorialWriteResult> {
    if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) invalid("Editorial mutation is invalid.");
    const documentId = requireId(mutation.documentId, "documentId");
    const actorId = requireId(mutation.actorId, "actorId");
    const idempotencyKey = validateIdempotency(mutation.idempotencyKey);
    const kind = entityKind(mutation.entity, documentId);
    validateEntity(mutation.entity, kind, documentId);
    const payload = kind === "article" ? validateArticlePayload(mutation.payload) : kind === "episode" ? validateEpisodePayload(mutation.payload) : validatePagePayload(mutation.payload);
    const expected = typeof mutation.expectedRevision === "string" ? decodeRepositoryRevision(mutation.expectedRevision) : invalid("expectedRevision is invalid.");
    if (expected.kind !== kind || expected.documentId !== documentId) invalid("expectedRevision does not match the document.");
    const operationKey = await sha256Text(JSON.stringify({ kind, documentId, idempotencyKey }));
    const fingerprint = await sha256Text(JSON.stringify({ command: "saveDraft", kind, documentId, expectedRevision: mutation.expectedRevision, actorId, payload }));
    const replay = await this.#existingOperation(context, operationKey, fingerprint, kind, documentId, "draft");
    if (replay) return replay;
    const loaded = await this.#load(context, documentId, mutation.entity);
    if (!loaded) throw new ServiceError({ code: "not_found", message: "Editorial document was not found." });
    const row = loaded.row;
    const previous = timestamp(row, "updated_at");
    if (previous !== expected.updatedAt) throw new ServiceError({ code: "precondition_failed", message: "Editorial document has changed." });
    const next = isoNowAfter(previous);
    const revisionId = `p4r_${operationKey}`;
    const eventId = `p4e_${operationKey}`;
    const snapshot = commandSnapshot(payload, fingerprint, { documentId: documentId as EditorialDocumentId, revision: revision(kind, documentId, next), publicationState: "draft", operationKey: operationKey as OperationKey }, kind, documentId);
    const revisionSql = `INSERT INTO editorial_revisions (revision_id, entity_type, entity_id, revision_number, title, excerpt, body_html, status, created_by, created_at, snapshot_json, operation_key) SELECT ?, ?, ?, COALESCE((SELECT MAX(revision_number) FROM editorial_revisions WHERE entity_type = ? AND entity_id = ?), 0) + 1, ?, ?, ?, 'Draft', ?, ?, ?, ? FROM (SELECT 1) WHERE EXISTS (SELECT 1 FROM ${kind === "article" ? "articles" : kind === "episode" ? "episode_documents" : "pages"} WHERE ${kind === "article" ? "(article_id = ? OR cms_document_id = ?)" : "document_id = ?"} AND updated_at = ?)`;
    const statements: D1PreparedStatement[] = [this.#db.prepare(revisionSql).bind(revisionId, kind, documentId, kind, documentId, payload.title, "summary" in payload && payload.summary !== null ? payload.summary : "", payload.body ?? "", actorId, next, snapshot, operationKey, ...(kind === "article" ? [documentId, documentId] : [documentId]), previous)];
    const saveTable = kind === "article" ? "articles" : kind === "episode" ? "episode_documents" : "pages";
    const saveIdWhere = kind === "article" ? "(article_id = ? OR cms_document_id = ?)" : "document_id = ?";
    const saveIdValues = kind === "article" ? [documentId, documentId] : [documentId];
    if (kind === "article") {
      statements.push(this.#db.prepare(`UPDATE articles SET current_revision_id = ?, updated_at = ?, updated_by = ? WHERE (article_id = ? OR cms_document_id = ?) AND updated_at = ? AND (current_revision_id IS NULL OR current_revision_id <> ?)` ).bind(revisionId, next, actorId, documentId, documentId, previous, revisionId));
    } else if (kind === "episode") {
      statements.push(this.#db.prepare(`UPDATE episode_documents SET current_revision_id = ?, updated_at = ? WHERE document_id = ? AND updated_at = ? AND (current_revision_id IS NULL OR current_revision_id <> ?)` ).bind(revisionId, next, documentId, previous, revisionId));
    } else {
      statements.push(this.#db.prepare(`UPDATE pages SET current_revision_id = ?, updated_at = ?, updated_by = ? WHERE document_id = ? AND updated_at = ? AND (current_revision_id IS NULL OR current_revision_id <> ?)` ).bind(revisionId, next, actorId, documentId, previous, revisionId));
    }
    const saveGuard = `EXISTS (SELECT 1 FROM editorial_revisions WHERE revision_id = ? AND operation_key = ?) AND EXISTS (SELECT 1 FROM ${saveTable} WHERE ${saveIdWhere} AND current_revision_id = ? AND updated_at = ?)`;
    statements.push(this.#db.prepare(`INSERT INTO editorial_events (event_id, entity_type, entity_id, event_type, from_status, to_status, revision_id, actor_id, note, payload_json, event_at) SELECT ?, ?, ?, 'draft_saved', status, status, ?, ?, '', CASE WHEN ${saveGuard} THEN ? ELSE '{' END, ? FROM ${saveTable} WHERE ${saveIdWhere}` ).bind(eventId, kind, documentId, revisionId, actorId, revisionId, operationKey, ...saveIdValues, revisionId, next, JSON.stringify(payload), next, ...saveIdValues));
    await executeWriteBatch(this.#db, statements, context);
    return { documentId: documentId as EditorialDocumentId, revision: revision(kind, documentId, next), publicationState: "draft", operationKey: operationKey as OperationKey };
  }

  async transition(context: OperationContext, input: { readonly documentId: EditorialDocumentId; readonly entity?: EditorialEntityReference; readonly expectedRevision: RevisionToken; readonly actorId: UserId; readonly idempotencyKey?: IdempotencyKey; readonly to: PublicationState; readonly note?: string }): Promise<EditorialWriteResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Editorial transition is invalid.");
    const documentId = requireId(input.documentId, "documentId");
    const actorId = requireId(input.actorId, "actorId");
    const idempotencyKey = validateIdempotency(input.idempotencyKey);
    const kind = entityKind(input.entity, documentId);
    validateEntity(input.entity, kind, documentId);
    const expected = typeof input.expectedRevision === "string" ? decodeRepositoryRevision(input.expectedRevision) : invalid("expectedRevision is invalid.");
    if (expected.kind !== kind || expected.documentId !== documentId) invalid("expectedRevision does not match the document.");
    if (input.to !== "draft" && input.to !== "scheduled" && input.to !== "published" && input.to !== "unpublished" && input.to !== "archived") invalid("Editorial transition state is invalid.");
    if (input.to === "scheduled") throw new ServiceError({ code: "invalid_argument", message: "Scheduled transitions require a schedule command." });
    const note = input.note === undefined ? "" : boundedString(input.note, "transition note", EDITORIAL_MAX_NOTE);
    const operationKey = await sha256Text(JSON.stringify({ kind, documentId, idempotencyKey }));
    const fingerprint = await sha256Text(JSON.stringify({ command: "transition", kind, documentId, expectedRevision: input.expectedRevision, actorId, to: input.to, note }));
    const replay = await this.#existingOperation(context, operationKey, fingerprint, kind, documentId, input.to);
    if (replay) return replay;
    const loaded = await this.#load(context, documentId, input.entity);
    if (!loaded) throw new ServiceError({ code: "not_found", message: "Editorial document was not found." });
    const row = loaded.row;
    const previous = timestamp(row, "updated_at");
    if (previous !== expected.updatedAt) throw new ServiceError({ code: "precondition_failed", message: "Editorial document has changed." });
    const current = publicationState(row.status);
    if (current === input.to && !(input.to === "published" && row.current_revision_id !== row.published_revision_id)) throw new ServiceError({ code: "conflict", message: "Editorial document is already in that state." });
    if (input.to === "draft" && current !== "archived") throw new ServiceError({ code: "conflict", message: "Only archived editorial documents can be restored to draft." });
    if (input.to === "unpublished" && current !== "published" && current !== "scheduled") throw new ServiceError({ code: "conflict", message: "Only published or scheduled documents can be unpublished." });
    if (input.to === "archived" && current !== "draft" && current !== "scheduled" && current !== "published") throw new ServiceError({ code: "conflict", message: "Editorial document cannot be archived from its current state." });
    if (input.to === "published" && current === "archived") throw new ServiceError({ code: "conflict", message: "Archived editorial documents cannot be published directly." });
    if (input.to === "published" && kind === "episode") {
      if (row.has_audio !== 1 && row.has_audio !== true) throw new ServiceError({ code: "precondition_failed", message: "Episode audio must be verified before publication." });
      if (!Number.isSafeInteger(row.audio_size_bytes) || (row.audio_size_bytes as number) <= 0 || typeof row.audio_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(row.audio_sha256)) throw new ServiceError({ code: "precondition_failed", message: "Episode audio must have verified size and checksum evidence." });
    }
    const next = isoNowAfter(previous);
    const payload = payloadFromRow(kind, row, documentId);
    const operationResult: EditorialWriteResult = { documentId: documentId as EditorialDocumentId, revision: revision(kind, documentId, next), publicationState: input.to, operationKey: operationKey as OperationKey };
    const snapshot = commandSnapshot(payload, fingerprint, operationResult, kind, documentId);
    const revisionId = `p4r_${operationKey}`;
    const eventId = `p4e_${operationKey}`;
    const revisionSql = `INSERT INTO editorial_revisions (revision_id, entity_type, entity_id, revision_number, title, excerpt, body_html, status, created_by, created_at, change_note, snapshot_json, operation_key) SELECT ?, ?, ?, COALESCE((SELECT MAX(revision_number) FROM editorial_revisions WHERE entity_type = ? AND entity_id = ?), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM (SELECT 1) WHERE EXISTS (SELECT 1 FROM ${kind === "article" ? "articles" : kind === "episode" ? "episode_documents" : "pages"} WHERE ${kind === "article" ? "(article_id = ? OR cms_document_id = ?)" : "document_id = ?"} AND updated_at = ?)`;
    const summary = "summary" in payload && payload.summary !== null ? payload.summary : "";
    const body = payload.body ?? "";
    const statements: D1PreparedStatement[] = [this.#db.prepare(revisionSql).bind(revisionId, kind, documentId, kind, documentId, payload.title, summary, body, input.to === "unpublished" ? "Draft" : input.to === "draft" ? "Draft" : input.to === "published" ? "Published" : "Archived", actorId, next, note, snapshot, operationKey, ...(kind === "article" ? [documentId, documentId] : [documentId]), previous)];
    const table = kind === "article" ? "articles" : kind === "episode" ? "episode_documents" : "pages";
    const idWhere = kind === "article" ? "(article_id = ? OR cms_document_id = ?)" : "document_id = ?";
    const idValues = kind === "article" ? [documentId, documentId] : [documentId];
    let transitionGuard = "EXISTS (SELECT 1 FROM editorial_revisions WHERE revision_id = ? AND operation_key = ?)";
    let transitionGuardValues: readonly unknown[] = [revisionId, operationKey];
    if (input.to === "published" && kind === "article") {
      const articlePayload = payload as ArticleDraftPayload;
      const hash = await sha256Text(articlePayload.body);
      statements.push(this.#db.prepare(`UPDATE articles SET slug = ?, title = ?, excerpt = ?, body_html = ?, canonical_url = COALESCE(?, ''), seo_title = COALESCE(?, ''), seo_description = COALESCE(?, ''), content_hash = ?, visibility = ?, status = 'Published', published_at = ?, scheduled_for = NULL, archived_at = NULL, current_revision_id = ?, published_revision_id = ?, updated_at = ?, updated_by = ? WHERE ${idWhere} AND updated_at = ? AND current_revision_id IS NOT NULL AND (published_revision_id IS NULL OR current_revision_id <> published_revision_id)`).bind(articlePayload.slug, articlePayload.title, articlePayload.summary ?? "", articlePayload.body, articlePayload.canonicalUrl, articlePayload.seoTitle, articlePayload.seoDescription, hash, articlePayload.visibility, next, revisionId, revisionId, next, actorId, ...idValues, previous));
      transitionGuard += ` AND EXISTS (SELECT 1 FROM articles WHERE ${idWhere} AND status = 'Published' AND current_revision_id = ? AND published_revision_id = ? AND updated_at = ?)`;
      transitionGuardValues = [...transitionGuardValues, ...idValues, revisionId, revisionId, next];
    } else if (input.to === "published" && kind === "episode") {
      const episodePayload = payload as EpisodeDraftPayload;
      const hash = await sha256Text(episodePayload.body ?? "");
      statements.push(this.#db.prepare(`UPDATE episode_documents SET slug = ?, title = ?, summary = ?, description = COALESCE(?, ''), content_hash = ?, visibility = ?, status = 'Published', published_at = ?, scheduled_for = NULL, archived_at = NULL, current_revision_id = ?, published_revision_id = ?, updated_at = ? WHERE document_id = ? AND updated_at = ? AND current_revision_id IS NOT NULL AND (published_revision_id IS NULL OR current_revision_id <> published_revision_id) AND EXISTS (SELECT 1 FROM episodes e JOIN media_assets m ON m.canonical_object_key = e.canonical_audio_key AND m.destination_bucket = 'aic-podcast-audio' AND m.mime_type = 'audio/mpeg' AND m.status IN ('verified', 'published') WHERE e.episode_id = episode_documents.episode_id AND m.size_bytes IS NOT NULL AND m.size_bytes > 0 AND m.sha256 IS NOT NULL AND length(m.sha256) = 64 AND m.sha256 NOT GLOB '*[^0-9a-f]*')`).bind(episodePayload.slug, episodePayload.title, episodePayload.summary ?? "", episodePayload.body, hash, episodePayload.visibility, next, revisionId, revisionId, next, documentId, previous));
      const publishDate = episodePayload.programDate ?? "";
      statements.push(this.#db.prepare(`UPDATE episodes SET status = 'Published', publish_date = ?, published_at = ?, updated_at = ? WHERE episode_id = (SELECT episode_id FROM episode_documents WHERE document_id = ?) AND updated_at <= ?`).bind(publishDate, next, next, documentId, previous));
      transitionGuard += ` AND EXISTS (SELECT 1 FROM episode_documents WHERE document_id = ? AND status = 'Published' AND current_revision_id = ? AND published_revision_id = ? AND updated_at = ?) AND EXISTS (SELECT 1 FROM episodes e JOIN episode_documents d ON d.episode_id = e.episode_id JOIN media_assets m ON m.canonical_object_key = e.canonical_audio_key AND m.destination_bucket = 'aic-podcast-audio' AND m.status IN ('verified', 'published') WHERE d.document_id = ? AND e.status = 'Published' AND e.publish_date = ? AND e.published_at = ? AND e.updated_at = ? AND m.size_bytes IS NOT NULL AND m.size_bytes > 0 AND m.sha256 IS NOT NULL AND length(m.sha256) = 64 AND m.sha256 NOT GLOB '*[^0-9a-f]*')`;
      transitionGuardValues = [...transitionGuardValues, documentId, revisionId, revisionId, next, documentId, publishDate, next, next];
    } else if (input.to === "published" && kind === "page") {
      const pagePayload = payload as PageDraftPayload;
      statements.push(this.#db.prepare(`UPDATE pages SET slug = ?, title = ?, status = 'Published', published_revision_id = ?, current_revision_id = ?, published_at = ?, scheduled_for = NULL, archived_at = NULL, updated_at = ?, updated_by = ? WHERE document_id = ? AND updated_at = ? AND current_revision_id IS NOT NULL AND (published_revision_id IS NULL OR current_revision_id <> published_revision_id)`).bind(pagePayload.slug, pagePayload.title, revisionId, revisionId, next, next, actorId, documentId, previous));
      transitionGuard += " AND EXISTS (SELECT 1 FROM pages WHERE document_id = ? AND status = 'Published' AND current_revision_id = ? AND published_revision_id = ? AND updated_at = ?)";
      transitionGuardValues = [...transitionGuardValues, documentId, revisionId, revisionId, next];
    } else {
      const status = input.to === "unpublished" ? "Draft" : input.to === "draft" ? "Draft" : "Archived";
      statements.push(this.#db.prepare(`UPDATE ${table} SET status = ?, current_revision_id = ?, updated_at = ?${kind === "article" ? ", updated_by = ?" : kind === "page" ? ", updated_by = ?" : ""}${input.to === "unpublished" || input.to === "archived" ? ", published_at = NULL, scheduled_for = NULL" : ""}${input.to === "archived" ? ", archived_at = ?" : ""}${input.to === "draft" ? ", archived_at = NULL" : ""} WHERE ${idWhere} AND updated_at = ? AND (current_revision_id IS NULL OR current_revision_id <> ?)` ).bind(status, revisionId, next, ...(kind === "article" || kind === "page" ? [actorId] : []), ...(input.to === "archived" ? [next] : []), ...idValues, previous, revisionId));
      if (kind === "episode") statements.push(this.#db.prepare(`UPDATE episodes SET status = ?, published_at = CASE WHEN ? IN ('Draft', 'Archived') THEN NULL ELSE published_at END, updated_at = ? WHERE episode_id = (SELECT episode_id FROM episode_documents WHERE document_id = ?) AND updated_at <= ?`).bind(status, status, next, documentId, previous));
      const statePostcondition = input.to === "unpublished" ? " AND published_at IS NULL AND scheduled_for IS NULL" : input.to === "archived" ? " AND published_at IS NULL AND scheduled_for IS NULL AND archived_at = ?" : input.to === "draft" ? " AND archived_at IS NULL" : "";
      transitionGuard += ` AND EXISTS (SELECT 1 FROM ${table} WHERE ${idWhere} AND status = ? AND current_revision_id = ? AND updated_at = ?${statePostcondition})`;
      transitionGuardValues = [...transitionGuardValues, ...idValues, status, revisionId, next];
      if (input.to === "archived") transitionGuardValues = [...transitionGuardValues, next];
      if (kind === "episode") {
        transitionGuard += " AND EXISTS (SELECT 1 FROM episodes e JOIN episode_documents d ON d.episode_id = e.episode_id WHERE d.document_id = ? AND e.status = ? AND e.published_at IS ? AND e.updated_at = ?)";
        transitionGuardValues = [...transitionGuardValues, documentId, status, status === "Draft" || status === "Archived" ? null : row.published_at ?? null, next];
      }
    }
    statements.push(this.#db.prepare(`INSERT INTO editorial_events (event_id, entity_type, entity_id, event_type, from_status, to_status, revision_id, actor_id, note, payload_json, event_at) SELECT ?, ?, ?, 'state_transition', ?, ?, ?, ?, ?, CASE WHEN ${transitionGuard} THEN ? ELSE '{' END, ? FROM ${table} WHERE ${idWhere}` ).bind(eventId, kind, documentId, current, input.to, revisionId, actorId, note, ...transitionGuardValues, JSON.stringify({ to: input.to }), next, ...idValues));
    await executeWriteBatch(this.#db, statements, context);
    return operationResult;
  }
}

export function createD1ReadRepositories(options: D1ReadRepositoryOptions): { readonly publicContent: PublicContentRepository; readonly userAccess: UserAccessRepository } {
  return { publicContent: new D1PublicContentRepository(options), userAccess: new D1UserAccessRepository(options) };
}

export function createD1EditorialRepository(options: D1EditorialRepositoryOptions): EditorialRepository {
  return new D1EditorialRepository(options);
}

export { MAX_REPOSITORY_PAGE_LIMIT, decodeRepositoryRevision, encodeRepositoryRevision };
export * from "./processing.ts";
export * from "./processing-operator.ts";
export * from "./processing-execution.ts";

export { createD1SearchRepositories, type D1SearchRepositoryOptions, type SearchCorpusAccess } from "./search.ts";
export { createD1RagInteractionRepository, type D1RagInteractionRepositoryOptions } from "./rag-interactions.ts";
export { createD1ResearchSourceRepository, type D1ResearchSourceRepositoryOptions } from "./research.ts";

export * from "./user-administration.ts";
export * from "./llm-registry.ts";

import assert from "node:assert/strict";
import test from "node:test";

import {
  D1EditorialRepository,
  D1PublicContentRepository,
  D1UserAccessRepository,
} from "../src/index.ts";
import { ServiceError } from "@aic/contracts";

const context = (aborted = false) => ({
  boundary: "request",
  request: { method: "GET", path: "/" },
  correlation: { correlationId: "test-correlation" },
  signal: aborted ? AbortSignal.abort() : new AbortController().signal,
});

const time = "2026-08-22T00:00:00.000000Z";
const article = (id, publishedAt = time) => ({
  article_id: id,
  source_type: "pastorwood",
  cms_document_id: null,
  source_post_id: id.replace("pastorwood:", ""),
  slug: `article-${id.replaceAll(":", "-")}`,
  title: "A faithful article",
  excerpt: "",
  body_html: "<p>Body</p>",
  canonical_url: "",
  content_type: "article",
  content_hash: "a".repeat(64),
  published_at: publishedAt,
  updated_at: time,
  status: "Published",
  visibility: "public",
});

class FakeDb {
  constructor(resolver) { this.resolver = resolver; this.queries = []; }
  prepare(sql) {
    const db = this;
    return {
      bind(...values) {
        db.queries.push({ sql, values });
        return {
          async first() { return db.resolver(sql, values, "first"); },
          async all() {
            const result = await db.resolver(sql, values, "all");
            return result && typeof result === "object" && Object.hasOwn(result, "results") ? result : { results: result };
          },
        };
      },
    };
  }
}

test("article read maps source, canonical URL, summary, and canonical revision", async () => {
  const db = new FakeDb((sql) => sql.includes("FROM articles") ? article("pastorwood:42") : null);
  const repository = new D1PublicContentRepository({ db });
  const result = await repository.getArticleById(context(), "pastorwood:42");
  assert.equal(result?.source.source, "postgresql");
  assert.equal(result?.source.value, "42");
  assert.equal(result?.summary, null);
  assert.equal(result?.contentType, "article");
  assert.equal(result?.canonicalUrl, "/writings/article-pastorwood-42/");
  assert.equal(result?.revision.length > 10, true);
  assert.match(db.queries[0].sql, /status = 'Published'/u);
  assert.match(db.queries[0].sql, /visibility = 'public'/u);
  const spaced = new FakeDb((sql) => sql.includes("FROM articles") ? { ...article("pastorwood:42"), title: "  Title  ", excerpt: "  excerpt  ", canonical_url: "/canonical", body_html: "  body  " } : null);
  const spacedResult = await new D1PublicContentRepository({ db: spaced }).getArticleById(context(), "pastorwood:42");
  assert.equal(spacedResult?.title, "  Title  ");
  assert.equal(spacedResult?.summary, "  excerpt  ");
  assert.equal(spacedResult?.canonicalUrl, "/canonical");
  assert.equal(spacedResult?.body, "  body  ");
  for (const canonical_url of ["   ", " /canonical", "/canonical ", "\u0000"]) {
    const invalidCanonical = new FakeDb((sql) => sql.includes("FROM articles") ? { ...article("pastorwood:42"), canonical_url } : null);
    await assert.rejects(() => new D1PublicContentRepository({ db: invalidCanonical }).getArticleById(context(), "pastorwood:42"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  }
});

test("CMS articles preserve the source document identity without PostgreSQL fallback", async () => {
  const cms = article("cms:entry-1");
  cms.source_type = "cms";
  cms.cms_document_id = "entry-1-α";
  cms.source_post_id = null;
  const db = new FakeDb((sql) => sql.includes("FROM articles") ? cms : null);
  const result = await new D1PublicContentRepository({ db }).getArticleById(context(), "cms:entry-1");
  assert.deepEqual(result?.source, { source: "strapi", value: "entry-1-α" });
  const invalid = new FakeDb((sql) => sql.includes("FROM articles") ? { ...cms, cms_document_id: null } : null);
  await assert.rejects(() => new D1PublicContentRepository({ db: invalid }).getArticleById(context(), "cms:entry-1"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
});

test("article list is bounded and deterministic across opaque cursors", async () => {
  const rows = [article("pastorwood:1", "2026-08-22T00:00:00.000000Z"), article("pastorwood:2", "2026-08-21T00:00:00.000000Z"), article("pastorwood:3", "2026-08-20T00:00:00.000000Z")];
  const db = new FakeDb((sql, values) => {
    if (!sql.includes("ORDER BY published_at")) return null;
    const [publishedAt, , id, limit] = values;
    return rows.filter((row) => row.published_at < publishedAt || (row.published_at === publishedAt && row.article_id > id)).slice(0, limit);
  });
  const repository = new D1PublicContentRepository({ db });
  const first = await repository.listPublishedArticles(context(), { limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), ["pastorwood:1", "pastorwood:2"]);
  assert.ok(first.nextCursor);
  const second = await repository.listPublishedArticles(context(), { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.id), ["pastorwood:3"]);
  await assert.rejects(() => repository.listPublishedArticles(context(), { limit: 101 }), ServiceError);
  await assert.rejects(() => repository.listPublishedArticles(context(), { limit: 1, cursor: `${first.nextCursor}=` }), ServiceError);
});

test("filtered article feeds apply content classification before cursor pagination", async () => {
  const rows = [article("pastorwood:1"), article("pastorwood:2", "2026-08-21T00:00:00.000000Z")].map((row, index) => ({ ...row, content_type: index === 0 ? "bible-study" : "article" }));
  const db = new FakeDb((sql, values, operation) => {
    if (operation === "first" && sql.includes("COUNT(*)")) return { total: 1 };
    if (operation === "all" && sql.includes("content_type = ?")) {
      assert.ok(sql.indexOf("content_type = ?") < sql.indexOf("ORDER BY"));
      assert.deepEqual(values.slice(0, 2), ["bible-study", "bible-study"]);
      return rows.filter((row) => row.content_type === values[0]);
    }
    return null;
  });
  const result = await new D1PublicContentRepository({ db }).listPublishedArticleFeedFiltered(context(), { limit: 10 }, { contentType: "bible-study" });
  assert.equal(result.total, 1);
  assert.deepEqual(result.items.map((item) => item.contentType), ["bible-study"]);
  await assert.rejects(() => new D1PublicContentRepository({ db }).listPublishedArticleFeedFiltered(context(), { limit: 1 }, { contentType: "invalid" }), (error) => error instanceof ServiceError && error.code === "invalid_argument");
});

test("public reads treat malformed rows and provider failures as retryable dependency errors", async () => {
  const malformed = new FakeDb((sql) => sql.includes("FROM articles") ? { ...article("pastorwood:42"), source_post_id: null } : null);
  await assert.rejects(() => new D1PublicContentRepository({ db: malformed }).getArticleById(context(), "pastorwood:42"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable" && error.retryable);
  const failed = new FakeDb(() => { throw new Error("SQL secret"); });
  await assert.rejects(() => new D1PublicContentRepository({ db: failed }).getArticleById(context(), "pastorwood:42"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable" && !error.message.includes("SQL secret"));
  await assert.rejects(() => new D1PublicContentRepository({ db: failed }).getArticleById(context(true), "pastorwood:42"), (error) => error instanceof ServiceError && error.code === "cancelled");
  const invalidTimestamp = new FakeDb((sql) => sql.includes("FROM articles") ? { ...article("pastorwood:42"), updated_at: "2026-08-22T99:00:00.000000Z" } : null);
  await assert.rejects(() => new D1PublicContentRepository({ db: invalidTimestamp }).getArticleById(context(), "pastorwood:42"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  const failedResult = new FakeDb((sql) => sql.includes("ORDER BY published_at") ? { success: false, results: [] } : null);
  await assert.rejects(() => new D1PublicContentRepository({ db: failedResult }).listPublishedArticles(context(), { limit: 1 }), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  for (const field of ["excerpt", "canonical_url", "body_html", "content_type"]) {
    const invalidRow = new FakeDb((sql) => sql.includes("FROM articles") ? { ...article("pastorwood:42"), [field]: null } : null);
    await assert.rejects(() => new D1PublicContentRepository({ db: invalidRow }).getArticleById(context(), "pastorwood:42"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  }
  for (const content_type of ["unknown", "", " Devotional "]) {
    const invalidType = new FakeDb((sql) => sql.includes("FROM articles") ? { ...article("pastorwood:42"), content_type } : null);
    await assert.rejects(() => new D1PublicContentRepository({ db: invalidType }).getArticleById(context(), "pastorwood:42"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  }
  await assert.rejects(() => new D1PublicContentRepository({ db: new FakeDb(() => null) }).getArticleById(context(), null), (error) => error instanceof ServiceError && error.code === "invalid_argument");
  await assert.rejects(() => new D1PublicContentRepository({ db: new FakeDb(() => null) }).getArticleById(context(), 42), (error) => error instanceof ServiceError && error.code === "invalid_argument");
});

test("episode reads enforce the joined publication boundary and expose verified audio only", async () => {
  const episodeRow = {
    episode_id: "sa_42", source_system: "sermonaudio", source_id: "42", canonical_audio_key: "podcasts/sa_42.mp3",
    publish_date: "2026-08-21", episode_updated_at: time, document_id: "episode-doc-42", slug: "episode-42", title: "Episode",
    summary: "", description: "", status: "Published", visibility: "public", transcript_status: "Completed", content_hash: "b".repeat(64),
    published_at: time, document_updated_at: time, has_audio: 1,
  };
  const db = new FakeDb((sql) => sql.includes("FROM episodes") ? episodeRow : null);
  const result = await new D1PublicContentRepository({ db }).getEpisodeById(context(), "sa_42");
  assert.equal(result?.source.source, "sermonaudio");
  assert.equal(result?.programDate, "2026-08-21");
  assert.equal(result?.hasAudio, true);
  assert.equal(result?.transcriptAvailable, true);
  const privateDb = new FakeDb((sql) => sql.includes("FROM episodes") ? { ...episodeRow, visibility: "private" } : null);
  await assert.rejects(() => new D1PublicContentRepository({ db: privateDb }).getEpisodeById(context(), "sa_42"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  for (const field of ["summary", "description"]) {
    const invalidRow = new FakeDb((sql) => sql.includes("FROM episodes") ? { ...episodeRow, [field]: null } : null);
    await assert.rejects(() => new D1PublicContentRepository({ db: invalidRow }).getEpisodeById(context(), "sa_42"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  }
  const invalidDate = new FakeDb((sql) => sql.includes("FROM episodes") ? { ...episodeRow, publish_date: "2026-02-31" } : null);
  await assert.rejects(() => new D1PublicContentRepository({ db: invalidDate }).getEpisodeById(context(), "sa_42"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  const nullDate = new FakeDb((sql) => sql.includes("FROM episodes") ? { ...episodeRow, publish_date: null } : null);
  await assert.rejects(() => new D1PublicContentRepository({ db: nullDate }).getEpisodeById(context(), "sa_42"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
});

test("filtered episode pages apply bounded query/year predicates before cursor pagination", async () => {
  const rows = [
    {
      episode_id: "sa_1", source_system: "sermonaudio", source_id: "1", canonical_audio_key: "podcasts/sa_1.mp3",
      publish_date: "2026-08-21", episode_updated_at: time, document_id: "episode-doc-1", slug: "grace-1", title: "Grace one", summary: "Grace summary", description: "Description", status: "Published", visibility: "public", transcript_status: "Completed", content_hash: "b".repeat(64), published_at: "2026-08-21T00:00:00.000000Z", document_updated_at: time, has_audio: 1,
    },
    {
      episode_id: "sa_2", source_system: "sermonaudio", source_id: "2", canonical_audio_key: "podcasts/sa_2.mp3",
      publish_date: "2026-07-21", episode_updated_at: time, document_id: "episode-doc-2", slug: "grace-2", title: "Grace two", summary: "Grace summary", description: "Description", status: "Published", visibility: "public", transcript_status: "Completed", content_hash: "c".repeat(64), published_at: "2026-07-21T00:00:00.000000Z", document_updated_at: time, has_audio: 1,
    },
  ];
  const db = new FakeDb((sql, values, operation) => {
    if (operation === "first" && sql.includes("COUNT(*)")) return { total: 2 };
    if (operation === "all" && sql.includes("lower(d.title)")) {
      assert.ok(sql.indexOf("lower(d.title)") < sql.indexOf("ORDER BY"));
      assert.deepEqual(values.slice(0, 6), Array(6).fill(values[0]));
      assert.deepEqual(values.slice(6, 9), ["2026-01-01", "2026-01-01", "2027-01-01"]);
      const cursorId = values[11];
      return rows.filter((row) => row.episode_id > cursorId);
    }
    return null;
  });
  const repository = new D1PublicContentRepository({ db });
  const firstPage = await repository.listPublishedEpisodesFiltered(context(), { limit: 1 }, { query: "  grace ", year: 2026 });
  assert.equal(firstPage.total, 2);
  assert.deepEqual(firstPage.items.map((item) => item.id), ["sa_1"]);
  assert.ok(firstPage.nextCursor);
  const secondPage = await repository.listPublishedEpisodesFiltered(context(), { limit: 1, cursor: firstPage.nextCursor }, { query: "grace", year: 2026 });
  assert.deepEqual(secondPage.items.map((item) => item.id), ["sa_2"]);
  await repository.listPublishedEpisodesFiltered(context(), { limit: 1 }, { query: "100%_!", year: 2026 });
  const escaped = db.queries.findLast((query) => query.sql.includes("lower(d.title)"));
  assert.equal(escaped.values[0], "100!%!_!!");
  for (const filter of [
    { query: "x".repeat(81) },
    { query: 42 },
    { year: 1899 },
    { year: 2101 },
    { year: 2026.5 },
  ]) {
    await assert.rejects(() => repository.listPublishedEpisodesFiltered(context(), { limit: 1 }, filter), (error) => error instanceof ServiceError && error.code === "invalid_argument");
  }
});

test("cursor encoding handles UTF-8 IDs and rejects non-canonical calendar timestamps", async () => {
  const rows = [article("pastorwood:42", time), article("pastorwood:43", "2026-08-21T00:00:00.000000Z")];
  const db = new FakeDb((sql, values) => {
    if (!sql.includes("ORDER BY published_at")) return null;
    const [publishedAt, , id, limit] = values;
    return rows.filter((row) => row.published_at < publishedAt || (row.published_at === publishedAt && row.article_id > id)).slice(0, limit);
  });
  const result = await new D1PublicContentRepository({ db }).listPublishedArticles(context(), { limit: 1 });
  assert.ok(result.nextCursor);
  const second = await new D1PublicContentRepository({ db }).listPublishedArticles(context(), { limit: 1, cursor: result.nextCursor });
  assert.deepEqual(second.items.map((item) => item.id), ["pastorwood:43"]);
  const malformed = Buffer.from(JSON.stringify({ v: 1, kind: "article", publishedAt: "2026-02-31T00:00:00.000000Z", id: "x" })).toString("base64url");
  await assert.rejects(() => new D1PublicContentRepository({ db }).listPublishedArticles(context(), { limit: 1, cursor: malformed }), (error) => error instanceof ServiceError && error.code === "invalid_argument");
  for (const id of ["", " x", "x ", "x\u0000"]) {
    const invalidId = Buffer.from(JSON.stringify({ v: 1, kind: "article", publishedAt: time, id })).toString("base64url");
    await assert.rejects(() => new D1PublicContentRepository({ db }).listPublishedArticles(context(), { limit: 1, cursor: invalidId }), (error) => error instanceof ServiceError && error.code === "invalid_argument");
  }
});

test("D1 first() rejects undefined, primitive, and array provider results", async () => {
  for (const invalidResult of [undefined, 7, "row", []]) {
    const db = new FakeDb((sql) => sql.includes("FROM articles") ? invalidResult : null);
    await assert.rejects(() => new D1PublicContentRepository({ db }).getArticleById(context(), "pastorwood:42"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  }
});

test("editorial identity resolution maps CMS documents to canonical D1 entity IDs", async () => {
  const cmsArticle = { article_id: "cms:article-1", source_type: "cms", cms_document_id: "doc-1", source_post_id: null };
  const articleDb = new FakeDb((sql) => sql.includes("FROM articles") ? [cmsArticle] : null);
  const repository = new D1EditorialRepository({ db: articleDb });
  assert.deepEqual(await repository.resolveEntity(context(), { kind: "article", documentId: "doc-1" }), { kind: "article", id: "cms:article-1" });

  const episodeDb = new FakeDb((sql) => sql.includes("FROM episode_documents") ? [{ document_id: "episode-doc-1", episode_id: "sa_1" }] : null);
  assert.deepEqual(await new D1EditorialRepository({ db: episodeDb }).resolveEntity(context(), { kind: "episode", documentId: "episode-doc-1" }), { kind: "episode", id: "sa_1" });
  const pageDb = new FakeDb((sql) => sql.includes("FROM pages") ? [{ document_id: "page-doc-1" }] : null);
  assert.deepEqual(await new D1EditorialRepository({ db: pageDb }).resolveEntity(context(), { kind: "page", documentId: "page-doc-1" }), { kind: "page", id: "page-doc-1" });
  assert.equal(await new D1EditorialRepository({ db: new FakeDb(() => []) }).resolveEntity(context(), { kind: "article", documentId: "missing" }), null);

  for (const rows of [
    [cmsArticle, { ...cmsArticle, article_id: "cms:article-2" }],
    [{ article_id: "cms:article-1", source_type: "other", cms_document_id: "doc-1", source_post_id: null }],
    [{ article_id: null, source_type: "cms", cms_document_id: "doc-1", source_post_id: null }],
  ]) {
    await assert.rejects(() => new D1EditorialRepository({ db: new FakeDb((sql) => sql.includes("FROM articles") ? rows : null) }).resolveEntity(context(), { kind: "article", documentId: "doc-1" }), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  }
  await assert.rejects(() => new D1EditorialRepository({ db: new FakeDb(() => []) }).resolveEntity(context(), { kind: "article", documentId: null }), (error) => error instanceof ServiceError && error.code === "invalid_argument");
});

test("dynamic page computes the published body hash and normalizes root URL", async () => {
  const db = new FakeDb((sql) => sql.includes("FROM pages") ? ({ document_id: "page-home", slug: "/", title: "Home", status: "Published", published_revision_id: "rev-1", updated_at: time, revision_entity_type: "page", revision_entity_id: "page-home", revision_status: "Published", body_html: "<h1>Home</h1>" }) : null);
  const result = await new D1PublicContentRepository({ db }).getDynamicPageBySlug(context(), "/");
  assert.equal(result?.canonicalUrl, "/");
  assert.equal(result?.contentHash, "1a7133067a4ac7fe06565943dd44870f232041b1d28b4340e2b678244a3b79f6");
  for (const mismatch of [{ revision_entity_type: "article", revision_entity_id: "page-home" }, { revision_entity_type: "page", revision_entity_id: "page-other" }]) {
    const mismatched = new FakeDb((sql) => sql.includes("FROM pages") ? ({ document_id: "page-home", slug: "/", title: "Home", status: "Published", published_revision_id: "rev-1", updated_at: time, ...mismatch, revision_status: "Published", body_html: "<h1>Home</h1>" }) : null);
    await assert.rejects(() => new D1PublicContentRepository({ db: mismatched }).getDynamicPageBySlug(context(), "/"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  }
  for (const field of ["title", "body_html"]) {
    const invalidRow = new FakeDb((sql) => sql.includes("FROM pages") ? ({ document_id: "page-home", slug: "/", title: "Home", status: "Published", published_revision_id: "rev-1", updated_at: time, revision_entity_type: "page", revision_entity_id: "page-home", revision_status: "Published", body_html: "<h1>Home</h1>", [field]: null }) : null);
    await assert.rejects(() => new D1PublicContentRepository({ db: invalidRow }).getDynamicPageBySlug(context(), "/"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  }
});

test("site settings require all three exact public JSON rows", async () => {
  const rows = [
    { setting_key: "site.title", value_json: JSON.stringify({ value: "AIC" }), value_type: "json", is_public: 1, updated_at: time },
    { setting_key: "site.canonicalOrigin", value_json: JSON.stringify({ value: "https://aic.example" }), value_type: "json", is_public: 1, updated_at: time },
    { setting_key: "site.allowIndexing", value_json: JSON.stringify({ value: false }), value_type: "json", is_public: 1, updated_at: time },
  ];
  const db = new FakeDb((sql) => sql.includes("site_settings") ? rows : null);
  const result = await new D1PublicContentRepository({ db }).getSiteSettings(context());
  assert.equal(result.title, "AIC");
  assert.equal(result.canonicalOrigin, "https://aic.example");
  assert.equal(result.allowIndexing, false);
  const incomplete = new FakeDb((sql) => sql.includes("site_settings") ? rows.slice(0, 2) : null);
  await assert.rejects(() => new D1PublicContentRepository({ db: incomplete }).getSiteSettings(context()), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
});

test("redirect lookup is exact, active-only, and preserves constrained status", async () => {
  const db = new FakeDb((sql) => sql.includes("FROM redirects") ? { source_path: "/old", target_path: "/new", status_code: 308 } : null);
  const result = await new D1PublicContentRepository({ db }).resolveRedirect(context(), "/old");
  assert.deepEqual(result, { sourcePath: "/old", destination: "/new", status: 308 });
  const absent = new FakeDb(() => null);
  assert.equal(await new D1PublicContentRepository({ db: absent }).resolveRedirect(context(), "/old"), null);
  await assert.rejects(() => new D1PublicContentRepository({ db }).resolveRedirect(context(), "old"), ServiceError);
  for (const target_path of [42, "", " /new", "/new ", "\u0000"]) {
    const invalidTarget = new FakeDb((sql) => sql.includes("FROM redirects") ? { source_path: "/old", target_path, status_code: 308 } : null);
    await assert.rejects(() => new D1PublicContentRepository({ db: invalidTarget }).resolveRedirect(context(), "/old"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  }
});

test("user access uses Clerk ID, deduplicates known active roles, and fails closed for unknown roles", async () => {
  const rows = [
    { user_id: "internal-1", clerk_user_id: "user_clerk_1", status: "active", updated_at: time, role: "Admin" },
    { user_id: "internal-1", clerk_user_id: "user_clerk_1", status: "active", updated_at: time, role: "Admin" },
    { user_id: "internal-1", clerk_user_id: "user_clerk_1", status: "active", updated_at: time, role: "Read Only" },
  ];
  const db = new FakeDb((sql) => sql.includes("FROM users") ? rows : null);
  const result = await new D1UserAccessRepository({ db }).getByUserId(context(), "user_clerk_1");
  assert.deepEqual(result?.roles, ["Admin", "Read Only"]);
  assert.equal(result?.disabled, false);
  assert.equal(db.queries[0].values[0], "user_clerk_1");
  const unknown = new FakeDb((sql) => sql.includes("FROM users") ? [{ ...rows[0], role: "Root" }] : null);
  await assert.rejects(() => new D1UserAccessRepository({ db: unknown }).getByUserId(context(), "user_clerk_1"), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  const absent = new FakeDb(() => []);
  assert.equal(await new D1UserAccessRepository({ db: absent }).getByUserId(context(), "missing"), null);
});

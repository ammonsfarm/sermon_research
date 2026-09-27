import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  D1EditorialRepository,
  encodeRepositoryRevision,
} from "../src/index.ts";
import { ServiceError, idempotencyKey } from "@aic/contracts";

const at = "2026-08-22T20:00:00.000000Z";

function context(aborted = false) {
  return {
    boundary: "request",
    request: { method: "POST", path: "/admin/editorial" },
    correlation: { correlationId: "editorial-test" },
    signal: aborted ? AbortSignal.abort() : new AbortController().signal,
  };
}

function articleRevision(updatedAt = at) {
  return encodeRepositoryRevision({ kind: "article", documentId: "pastorwood:77", updatedAt });
}

function articlePayload(overrides = {}) {
  return {
    title: "Draft title",
    slug: "draft-title",
    summary: "Draft summary",
    body: "<p>Draft body</p>",
    visibility: "public",
    canonicalUrl: null,
    seoTitle: null,
    seoDescription: null,
    ...overrides,
  };
}

function articleRow(overrides = {}) {
  return {
    article_id: "pastorwood:77",
    source_type: "pastorwood",
    cms_document_id: null,
    source_post_id: "77",
    slug: "published-title",
    title: "Published title",
    excerpt: "Published summary",
    body_html: "<p>Published body</p>",
    canonical_url: "",
    content_type: "article",
    seo_title: "",
    seo_description: "",
    content_hash: "a".repeat(64),
    status: "Draft",
    visibility: "public",
    updated_at: at,
    current_revision_id: null,
    published_revision_id: null,
    current_snapshot: null,
    published_revision_at: null,
    ...overrides,
  };
}

function episodeRow(overrides = {}) {
  return {
    document_id: "episode-doc-77",
    episode_id: "sa_77",
    slug: "episode",
    title: "Episode",
    summary: "Episode summary",
    description: "Episode body",
    status: "Draft",
    episode_status: "Draft",
    visibility: "public",
    updated_at: at,
    current_revision_id: null,
    published_revision_id: null,
    current_snapshot: null,
    published_revision_at: null,
    published_snapshot: null,
    publish_date: "2026-08-22",
    has_audio: 1,
    audio_size_bytes: 77,
    audio_sha256: "a".repeat(64),
    ...overrides,
  };
}

class FakeWriteDb {
  constructor(row = articleRow(), options = {}) {
    this.row = row;
    this.options = options;
    this.queries = [];
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...values) {
        db.queries.push({ sql, values });
        return {
          async first() {
            if (sql.includes("operation_key")) return db.options.operation ?? null;
            return db.row;
          },
          async all() { return { success: true, results: sql.includes("FROM articles") ? (db.options.rows ?? [db.row]) : [] }; },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
      },
    };
  }

  async batch() {
    if (this.options.batchError) throw this.options.batchError;
    return this.options.batchResults ?? [{ success: true, meta: { changes: 1 } }];
  }
}

class FakeInventoryDb {
  constructor(rows, total = rows.length) {
    this.rows = rows;
    this.total = total;
    this.queries = [];
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...values) {
        db.queries.push({ sql, values });
        return {
          async first() { return sql.includes("COUNT(*)") ? { total: db.total } : null; },
          async all() {
            if (!sql.includes("COUNT(*)")) {
              const cursorId = values[values.length - 2];
              return { success: true, results: db.rows.filter((row) => (row.document_id ?? row.cms_document_id ?? row.article_id) > cursorId) };
            }
            return { success: true, results: [] };
          },
        };
      },
    };
  }
}

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../../../migrations/d1/", import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) database.exec(await readFile(new URL(file, directory), "utf8"));
  return database;
}

class SqliteD1Binding {
  constructor(database, options = {}) { this.database = database; this.options = options; }

  prepare(sql) {
    const database = this.database;
    return {
      bind(...values) {
        return {
          async first() { return database.prepare(sql).get(...values) ?? null; },
          async all() { return { success: true, results: database.prepare(sql).all(...values) }; },
          async run() {
            const result = database.prepare(sql).run(...values);
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (let index = 0; index < statements.length; index += 1) {
        this.options.beforeRun?.(index, this.database);
        results.push(await statements[index].run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function seedArticle(database, { published = false } = {}) {
  database.prepare(`
    INSERT INTO articles
      (article_id, source_type, source_post_id, slug, title, excerpt, body_html,
       canonical_url, seo_title, seo_description, content_hash, status, visibility,
       created_at, updated_at, updated_by, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "pastorwood:77", "pastorwood", "77", "published-title", "Published title",
    "Published summary", "<p>Published body</p>", "", "", "", "a".repeat(64),
    published ? "Published" : "Draft", "public", at, at, "system", published ? at : null,
  );
  if (published) {
    database.prepare(`
      INSERT INTO editorial_revisions
        (revision_id, entity_type, entity_id, revision_number, title, body_html,
         status, created_by, created_at)
      VALUES (?, 'article', ?, 1, ?, ?, 'Published', 'system', ?)
    `).run("article-published-77", "pastorwood:77", "Published title", "<p>Published body</p>", at);
    database.prepare(`
      UPDATE articles SET current_revision_id = ?, published_revision_id = ?
       WHERE article_id = ?
    `).run("article-published-77", "article-published-77", "pastorwood:77");
  }
}

function seedEpisode(database, { audioStatus = null, audioSize = 77, audioSha = "a".repeat(64) } = {}) {
  database.prepare(`
    INSERT INTO episodes
      (episode_id, title, publish_date, canonical_audio_key, source_system,
       source_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Draft', ?, ?)
  `).run("sa_77", "Episode", "2026-08-22", "podcasts/sa_77.mp3", "sermonaudio", "77", at, at);
  database.prepare(`
    INSERT INTO episode_documents
      (document_id, episode_id, source_type, slug, title, description, summary,
       status, visibility, created_at, updated_at)
    VALUES (?, ?, 'podcast', ?, ?, ?, ?, 'Draft', 'public', ?, ?)
  `).run("episode-doc-77", "sa_77", "episode", "Episode", "Episode body", "Episode summary", at, at);
  if (audioStatus) {
    database.prepare(`
      INSERT INTO media_assets
        (asset_id, source_provider, destination_bucket, canonical_object_key,
         mime_type, size_bytes, status, created_at, updated_at, sha256)
      VALUES (?, 'r2', 'aic-podcast-audio', ?, 'audio/mpeg', ?, ?, ?, ?, ?)
    `).run("asset-77", "podcasts/sa_77.mp3", audioSize, audioStatus, at, at, audioStatus === "verified" ? audioSha : null);
  }
}

function seedLegacyPage(database) {
  database.prepare(`
    INSERT INTO editorial_revisions
      (revision_id, entity_type, entity_id, revision_number, title, body_html,
       status, created_by, created_at)
    VALUES (?, 'page', ?, 1, ?, ?, 'Published', 'system', ?)
  `).run("page-published-77", "page-doc-77", "Legacy home", "<h1>Legacy home</h1>", at);
  database.prepare(`
    INSERT INTO pages
      (page_key, document_id, slug, title, status, published_revision_id,
       created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, 'Published', ?, ?, ?, ?)
  `).run("home", "page-doc-77", "/", "Legacy home", "page-published-77", at, at, at);
}

test("migrated SQLite preserves published projection during draft save, then publishes atomically", async () => {
  const database = await migratedDatabase();
  seedArticle(database, { published: true });
  const repository = new D1EditorialRepository({ db: new SqliteD1Binding(database) });
  const saved = await repository.saveDraft(context(), {
    documentId: "pastorwood:77",
    entity: { kind: "article", id: "pastorwood:77" },
    expectedRevision: articleRevision(),
    actorId: "editor-1",
    idempotencyKey: idempotencyKey("draft-77"),
    payload: articlePayload(),
  });
  assert.equal(saved.publicationState, "draft");
  const preserved = database.prepare("SELECT status, body_html, published_revision_id FROM articles").get();
  assert.equal(preserved.status, "Published");
  assert.equal(preserved.body_html, "<p>Published body</p>");
  assert.equal(preserved.published_revision_id, "article-published-77");
  const edit = await repository.getForEdit(context(), {
    documentId: "pastorwood:77",
    entity: { kind: "article", id: "pastorwood:77" },
  });
  assert.equal(edit.payload.body, "<p>Draft body</p>");
  assert.equal(edit.contentType, "article");
  const published = await repository.transition(context(), {
    documentId: "pastorwood:77",
    entity: { kind: "article", id: "pastorwood:77" },
    expectedRevision: saved.revision,
    actorId: "editor-1",
    idempotencyKey: idempotencyKey("publish-77"),
    to: "published",
  });
  assert.equal(published.publicationState, "published");
  const projection = database.prepare("SELECT status, slug, body_html, published_revision_id FROM articles").get();
  assert.equal(projection.status, "Published");
  assert.equal(projection.slug, "draft-title");
  assert.equal(projection.body_html, "<p>Draft body</p>");
  assert.match(projection.published_revision_id, /^p4r_/u);
});

test("writer enforces full payload shape, bounds, and null semantics before D1 access", async () => {
  const db = new FakeWriteDb();
  const repository = new D1EditorialRepository({ db });
  const base = {
    documentId: "pastorwood:77",
    entity: { kind: "article", id: "pastorwood:77" },
    expectedRevision: articleRevision(),
    actorId: "editor-1",
    idempotencyKey: idempotencyKey("shape-77"),
  };
  for (const payload of [
    { ...articlePayload(), extra: true },
    { ...articlePayload(), body: null },
    { ...articlePayload(), body: "" },
    { ...articlePayload(), title: "" },
    { ...articlePayload(), body: "x".repeat(256 * 1024 + 1) },
    { ...articlePayload(), slug: "bad/slug" },
    { ...articlePayload(), slug: "é".repeat(128) },
    { ...articlePayload(), canonicalUrl: "" },
    { ...articlePayload(), summary: "\u0000" },
  ]) {
    await assert.rejects(() => repository.saveDraft(context(), { ...base, payload }), (error) => error instanceof ServiceError && error.code === "invalid_argument");
  }
  await assert.rejects(() => repository.saveDraft(context(), { ...base, entity: undefined, payload: articlePayload() }), (error) => error instanceof ServiceError && error.code === "invalid_argument");
  await assert.rejects(() => repository.saveDraft(context(), { ...base, idempotencyKey: "é".repeat(129), payload: articlePayload() }), (error) => error instanceof ServiceError && error.code === "invalid_argument");
  await assert.rejects(() => repository.getForEdit(context(), { documentId: "pastorwood:77" }), (error) => error instanceof ServiceError && error.code === "invalid_argument");
  assert.equal(db.queries.length, 0);
});

test("episode program dates reject empty input and fail closed for malformed persisted dates", async () => {
  const repository = new D1EditorialRepository({ db: new FakeWriteDb(episodeRow()) });
  await assert.rejects(() => repository.saveDraft(context(), {
    documentId: "episode-doc-77", entity: { kind: "episode", id: "sa_77" },
    expectedRevision: encodeRepositoryRevision({ kind: "episode", documentId: "episode-doc-77", updatedAt: at }),
    actorId: "editor-1", idempotencyKey: idempotencyKey("empty-program-date"),
    payload: { title: "Episode", slug: "episode", summary: "Episode summary", body: "Episode body", visibility: "public", programDate: "" },
  }), (error) => error instanceof ServiceError && error.code === "invalid_argument");
  for (const publishDate of [null, "2026-02-31"]) {
    await assert.rejects(() => new D1EditorialRepository({ db: new FakeWriteDb(episodeRow({ publish_date: publishDate })) }).getForEdit(context(), {
      documentId: "episode-doc-77", entity: { kind: "episode", id: "sa_77" },
    }), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  }
});

test("malformed persisted canonical rows and explicit snapshot identities are dependency failures", async () => {
  for (const row of [
    articleRow({ body_html: "" }),
    articleRow({ canonical_url: "  /canonical  " }),
    articleRow({ current_revision_id: "wrong-identity", current_snapshot: JSON.stringify({ kind: "episode", documentId: "episode-doc-77" }) }),
  ]) {
    await assert.rejects(() => new D1EditorialRepository({ db: new FakeWriteDb(row) }).getForEdit(context(), {
      documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" },
    }), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  }
});

test("editorial inventory resolves non-identity CMS documents with bounded search and cursors", async () => {
  const rows = [
    {
      article_id: "cms:article-1", source_type: "cms", cms_document_id: "doc-1", content_type: "bible-study",
      title: "Grace one", slug: "grace-one", status: "Published", updated_at: "2026-08-22T20:00:00.000000Z",
      current_revision_id: null, published_revision_id: null, published_revision_at: null,
    },
    {
      article_id: "cms:article-2", source_type: "cms", cms_document_id: "doc-2", content_type: "devotional",
      title: "Grace two", slug: "grace-two", status: "Draft", updated_at: "2026-08-21T20:00:00.000000Z",
      current_revision_id: null, published_revision_id: null, published_revision_at: null,
    },
  ];
  const db = new FakeInventoryDb(rows, 2);
  const repository = new D1EditorialRepository({ db });
  const first = await repository.listForEdit(context(), { limit: 1 }, { kind: "article", query: " grace " });
  assert.equal(first.total, 2);
  assert.equal(first.items[0].documentId, "doc-1");
  assert.equal(first.items[0].entity.id, "cms:article-1");
  assert.equal(first.items[0].contentType, "bible-study");
  assert.equal(first.items[0].publicationState, "published");
  assert.ok(first.nextCursor);
  const listQuery = db.queries.find((query) => query.sql.includes("ORDER BY a.updated_at"));
  assert.ok(listQuery);
  assert.deepEqual(listQuery.values.slice(0, 4), ["grace", "grace", "grace", "grace"]);
  assert.ok(listQuery.sql.indexOf("lower(a.title)") < listQuery.sql.indexOf("ORDER BY"));
  const second = await repository.listForEdit(context(), { limit: 1, cursor: first.nextCursor }, { kind: "article", query: "grace" });
  assert.deepEqual(second.items.map((item) => item.documentId), ["doc-2"]);
  await assert.rejects(() => repository.listForEdit(context(), { limit: 1 }, { kind: "article", query: "x".repeat(161) }), (error) => error instanceof ServiceError && error.code === "invalid_argument");
});

test("direct article loads reject ambiguous article and CMS document identities", async () => {
  const first = articleRow();
  const second = articleRow({ article_id: "cms:article-77", source_type: "cms", cms_document_id: "pastorwood:77" });
  const repository = new D1EditorialRepository({ db: new FakeWriteDb(first, { rows: [first, second] }) });
  await assert.rejects(() => repository.getForEdit(context(), {
    documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" },
  }), (error) => error instanceof ServiceError && error.code === "conflict");
});

test("D1 all() rejects null, primitive, and array rows instead of treating them as absence", async () => {
  for (const invalidRow of [null, 7, [], "row"]) {
    await assert.rejects(() => new D1EditorialRepository({ db: new FakeWriteDb(articleRow(), { rows: [invalidRow] }) }).getForEdit(context(), {
      documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" },
    }), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  }
});

test("persisted Unpublished state and episode/document status drift fail closed", async () => {
  await assert.rejects(() => new D1EditorialRepository({ db: new FakeWriteDb(articleRow({ status: "Unpublished" })) }).getForEdit(context(), {
    documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" },
  }), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  await assert.rejects(() => new D1EditorialRepository({ db: new FakeWriteDb(episodeRow({ episode_status: "Published" })) }).getForEdit(context(), {
    documentId: "episode-doc-77", entity: { kind: "episode", id: "sa_77" },
  }), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
});

test("writer rejects stale tokens and supports exact idempotent replay while conflicting on changed commands", async () => {
  const database = await migratedDatabase();
  seedArticle(database);
  const repository = new D1EditorialRepository({ db: new SqliteD1Binding(database) });
  const mutation = {
    documentId: "pastorwood:77",
    entity: { kind: "article", id: "pastorwood:77" },
    expectedRevision: articleRevision(),
    actorId: "editor-1",
    idempotencyKey: idempotencyKey("replay-77"),
    payload: articlePayload(),
  };
  const first = await repository.saveDraft(context(), mutation);
  const replay = await repository.saveDraft(context(), mutation);
  assert.deepEqual(replay, first);
  await assert.rejects(() => repository.transition(context(), {
    documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" }, expectedRevision: first.revision,
    actorId: "editor-1", idempotencyKey: mutation.idempotencyKey, to: "published",
  }), (error) => error instanceof ServiceError && error.code === "conflict");
  await assert.rejects(() => repository.saveDraft(context(), {
    ...mutation,
    payload: articlePayload({ title: "Different command" }),
  }), (error) => error instanceof ServiceError && error.code === "conflict");
  await assert.rejects(() => repository.saveDraft(context(), {
    ...mutation,
    expectedRevision: articleRevision("2026-08-23T00:00:00.000000Z"),
    idempotencyKey: idempotencyKey("stale-77"),
  }), (error) => error instanceof ServiceError && error.code === "precondition_failed");
  const receipt = database.prepare("SELECT revision_id, snapshot_json FROM editorial_revisions WHERE operation_key = ?").get(first.operationKey);
  const corrupted = JSON.parse(receipt.snapshot_json);
  corrupted.result.publicationState = "published";
  database.prepare("UPDATE editorial_revisions SET snapshot_json = ? WHERE revision_id = ?").run(JSON.stringify(corrupted), receipt.revision_id);
  await assert.rejects(() => repository.saveDraft(context(), mutation), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  corrupted.result.revision = Buffer.from(JSON.stringify({
    v: 1, kind: "article", documentId: "pastorwood:77", updatedAt: "2026-02-31T00:00:00.000000Z",
  })).toString("base64url");
  database.prepare("UPDATE editorial_revisions SET snapshot_json = ? WHERE revision_id = ?").run(JSON.stringify(corrupted), receipt.revision_id);
  await assert.rejects(() => repository.saveDraft(context(), mutation), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
});

test("writer fails closed on malformed batch result shapes and honors cancellation before dispatch", async () => {
  const row = articleRow();
  const malformed = new FakeWriteDb(row, { batchResults: [{ success: true, meta: { changes: 0 } }] });
  const repository = new D1EditorialRepository({ db: malformed });
  await assert.rejects(() => repository.saveDraft(context(), {
    documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" },
    expectedRevision: articleRevision(), actorId: "editor-1", idempotencyKey: idempotencyKey("bad-batch"), payload: articlePayload(),
  }), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  const missingSuccess = new FakeWriteDb(row, { batchResults: [{ meta: { changes: 1 } }] });
  await assert.rejects(() => new D1EditorialRepository({ db: missingSuccess }).saveDraft(context(), {
    documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" },
    expectedRevision: articleRevision(), actorId: "editor-1", idempotencyKey: idempotencyKey("missing-success"), payload: articlePayload(),
  }), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  const cancelled = new FakeWriteDb(row);
  await assert.rejects(() => new D1EditorialRepository({ db: cancelled }).saveDraft(context(true), {
    documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" },
    expectedRevision: articleRevision(), actorId: "editor-1", idempotencyKey: idempotencyKey("cancelled"), payload: articlePayload(),
  }), (error) => error instanceof ServiceError && error.code === "cancelled");
});

test("editorial reads fail closed on dangling or wrong-kind revision pointers", async () => {
  for (const row of [
    articleRow({ current_revision_id: "dangling-revision", current_snapshot: null }),
    articleRow({ current_revision_id: "wrong-kind-revision", current_snapshot: null }),
    articleRow({ current_revision_id: "wrong-entity-revision", current_snapshot: JSON.stringify({ kind: "episode", documentId: "episode-doc-77", payload: articlePayload() }) }),
    articleRow({ current_revision_id: "malformed-payload-revision", current_snapshot: JSON.stringify({ kind: "article", documentId: "pastorwood:77", payload: { title: "" } }) }),
    articleRow({ published_revision_id: "dangling-published", published_revision_at: null }),
    articleRow({ published_revision_id: "wrong-published-revision", published_revision_at: at, published_snapshot: JSON.stringify({ kind: "episode", documentId: "episode-doc-77", payload: articlePayload() }) }),
  ]) {
    const repository = new D1EditorialRepository({ db: new FakeWriteDb(row) });
    await assert.rejects(() => repository.getForEdit(context(), {
      documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" },
    }), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  }
});

test("legacy pages without a current pointer hydrate the published revision body for editing", async () => {
  const database = await migratedDatabase();
  seedLegacyPage(database);
  const repository = new D1EditorialRepository({ db: new SqliteD1Binding(database) });
  const edit = await repository.getForEdit(context(), {
    documentId: "page-doc-77", entity: { kind: "page", id: "page-doc-77" },
  });
  assert.equal(edit.payload.body, "<h1>Legacy home</h1>");
  assert.equal(edit.payload.title, "Legacy home");
});

test("episode publication requires verified audio and rejects near-miss media", async () => {
  for (const media of [
    { audioStatus: null },
    { audioStatus: "pending" },
    { audioStatus: "verified", audioSize: 0 },
    { audioStatus: "verified", audioSha: "A".repeat(64) },
    { audioStatus: "verified" },
    { audioStatus: "verified", programDate: null },
  ]) {
    const database = await migratedDatabase();
    seedEpisode(database, media);
    const repository = new D1EditorialRepository({ db: new SqliteD1Binding(database) });
    const initial = encodeRepositoryRevision({ kind: "episode", documentId: "episode-doc-77", updatedAt: at });
    const saved = await repository.saveDraft(context(), {
      documentId: "episode-doc-77", entity: { kind: "episode", id: "sa_77" }, expectedRevision: initial,
      actorId: "editor-1", idempotencyKey: idempotencyKey(`episode-draft-${media.audioStatus ?? "none"}-${media.audioSize ?? "default"}-${media.audioSha ?? "default"}`),
      payload: { title: "Episode", slug: "episode", summary: "Episode summary", body: "Episode body", visibility: "public", programDate: Object.hasOwn(media, "programDate") ? media.programDate : "2026-08-22" },
    });
    const parentEpisode = database.prepare("SELECT status, updated_at, publish_date FROM episodes").get();
    assert.equal(parentEpisode.status, "Draft");
    assert.equal(parentEpisode.updated_at, at);
    assert.equal(parentEpisode.publish_date, "2026-08-22");
    if (media.audioStatus === "verified" && media.audioSize !== 0 && media.audioSha === undefined) {
      const result = await repository.transition(context(), {
        documentId: "episode-doc-77", entity: { kind: "episode", id: "sa_77" }, expectedRevision: saved.revision,
        actorId: "editor-1", idempotencyKey: idempotencyKey("episode-publish"), to: "published",
      });
      assert.equal(result.publicationState, "published");
      const parent = database.prepare("SELECT publish_date, published_at FROM episodes").get();
      assert.equal(parent.publish_date, media.programDate === null ? "" : "2026-08-22");
      assert.match(parent.published_at, /^2026-/u);
      const unpublished = await repository.transition(context(), {
        documentId: "episode-doc-77", entity: { kind: "episode", id: "sa_77" }, expectedRevision: result.revision,
        actorId: "editor-1", idempotencyKey: idempotencyKey(`episode-unpublish-${media.programDate === null ? "null" : "date"}`), to: "unpublished",
      });
      assert.equal(unpublished.publicationState, "unpublished");
      assert.equal(database.prepare("SELECT published_at FROM episodes").get().published_at, null);
    } else {
      await assert.rejects(() => repository.transition(context(), {
        documentId: "episode-doc-77", entity: { kind: "episode", id: "sa_77" }, expectedRevision: saved.revision,
        actorId: "editor-1", idempotencyKey: idempotencyKey(`episode-publish-${media.audioStatus ?? "none"}-${media.audioSize ?? "default"}-${media.audioSha ?? "default"}`), to: "published",
      }), (error) => error instanceof ServiceError && error.code === "precondition_failed");
    }
  }
});

test("migrated SQLite clears both episode publication timestamps when archiving a published episode", async () => {
  const database = await migratedDatabase();
  seedEpisode(database, { audioStatus: "verified" });
  const repository = new D1EditorialRepository({ db: new SqliteD1Binding(database) });
  const saved = await repository.saveDraft(context(), {
    documentId: "episode-doc-77", entity: { kind: "episode", id: "sa_77" },
    expectedRevision: encodeRepositoryRevision({ kind: "episode", documentId: "episode-doc-77", updatedAt: at }),
    actorId: "editor-1", idempotencyKey: idempotencyKey("archive-episode-draft"),
    payload: { title: "Episode", slug: "episode", summary: "Episode summary", body: "Episode body", visibility: "public", programDate: "2026-08-22" },
  });
  const published = await repository.transition(context(), {
    documentId: "episode-doc-77", entity: { kind: "episode", id: "sa_77" }, expectedRevision: saved.revision,
    actorId: "editor-1", idempotencyKey: idempotencyKey("archive-episode-publish"), to: "published",
  });
  const archived = await repository.transition(context(), {
    documentId: "episode-doc-77", entity: { kind: "episode", id: "sa_77" }, expectedRevision: published.revision,
    actorId: "editor-1", idempotencyKey: idempotencyKey("archive-episode-archive"), to: "archived",
  });
  assert.equal(archived.publicationState, "archived");
  const episode = database.prepare("SELECT status, published_at FROM episodes").get();
  assert.equal(episode.status, "Archived");
  assert.equal(episode.published_at, null);
  const document = database.prepare("SELECT status, published_at, scheduled_for FROM episode_documents").get();
  assert.equal(document.status, "Archived");
  assert.equal(document.published_at, null);
  assert.equal(document.scheduled_for, null);
});

test("editorial transitions enforce archive/restore and unpublish state rules", async () => {
  const database = await migratedDatabase();
  seedArticle(database);
  const repository = new D1EditorialRepository({ db: new SqliteD1Binding(database) });
  const saved = await repository.saveDraft(context(), {
    documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" }, expectedRevision: articleRevision(),
    actorId: "editor-1", idempotencyKey: idempotencyKey("transition-draft"), payload: articlePayload(),
  });
  const archived = await repository.transition(context(), {
    documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" }, expectedRevision: saved.revision,
    actorId: "editor-1", idempotencyKey: idempotencyKey("transition-archive"), to: "archived",
  });
  assert.equal(archived.publicationState, "archived");
  const restored = await repository.transition(context(), {
    documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" }, expectedRevision: archived.revision,
    actorId: "editor-1", idempotencyKey: idempotencyKey("transition-restore"), to: "draft",
  });
  assert.equal(restored.publicationState, "draft");
  const published = await repository.transition(context(), {
    documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" }, expectedRevision: restored.revision,
    actorId: "editor-1", idempotencyKey: idempotencyKey("transition-publish"), to: "published",
  });
  const unpublished = await repository.transition(context(), {
    documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" }, expectedRevision: published.revision,
    actorId: "editor-1", idempotencyKey: idempotencyKey("transition-unpublish"), to: "unpublished",
  });
  assert.equal(unpublished.publicationState, "unpublished");
  assert.equal(database.prepare("SELECT status FROM articles").get().status, "Draft");
  await assert.rejects(() => repository.transition(context(), {
    documentId: "pastorwood:77", entity: { kind: "article", id: "pastorwood:77" }, expectedRevision: unpublished.revision,
    actorId: "editor-1", idempotencyKey: idempotencyKey("transition-invalid"), to: "unpublished",
  }), (error) => error instanceof ServiceError && error.code === "conflict");
});

test("episode publication rolls back revision, event, and projection when media changes inside the batch", async () => {
  const database = await migratedDatabase();
  seedEpisode(database, { audioStatus: "verified" });
  const binding = new SqliteD1Binding(database, {
    beforeRun(index, db) {
      if (index === 1) db.prepare("DELETE FROM media_assets WHERE asset_id = ?").run("asset-77");
    },
  });
  const repository = new D1EditorialRepository({ db: new SqliteD1Binding(database) });
  const saved = await repository.saveDraft(context(), {
    documentId: "episode-doc-77", entity: { kind: "episode", id: "sa_77" },
    expectedRevision: encodeRepositoryRevision({ kind: "episode", documentId: "episode-doc-77", updatedAt: at }),
    actorId: "editor-1", idempotencyKey: idempotencyKey("atomic-draft"),
    payload: { title: "Episode", slug: "episode", summary: "Episode summary", body: "Episode body", visibility: "public", programDate: "2026-08-22" },
  });
  const mutatingRepository = new D1EditorialRepository({ db: binding });
  await assert.rejects(() => mutatingRepository.transition(context(), {
    documentId: "episode-doc-77", entity: { kind: "episode", id: "sa_77" }, expectedRevision: saved.revision,
    actorId: "editor-1", idempotencyKey: idempotencyKey("atomic-publish"), to: "published",
  }), (error) => error instanceof ServiceError && error.code === "dependency_unavailable");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM editorial_events WHERE entity_id = ? AND event_type = 'state_transition'").get("episode-doc-77").count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM editorial_revisions WHERE entity_id = ? AND status = 'Published'").get("episode-doc-77").count, 0);
  assert.equal(database.prepare("SELECT status, current_revision_id FROM episode_documents WHERE document_id = ?").get("episode-doc-77").status, "Draft");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM media_assets WHERE asset_id = ?").get("asset-77").count, 1);
});

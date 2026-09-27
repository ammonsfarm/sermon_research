import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { correlationId } from "@aic/contracts";
import { createD1ReadRepositories } from "../src/index.ts";

const migrationDirectory = new URL("../../../migrations/d1/", import.meta.url);
const at = "2026-08-22T20:00:00.000000Z";

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const files = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    database.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
  }
  return database;
}

class SqliteD1Binding {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    const statement = this.database.prepare(sql);
    return {
      bind(...values) {
        return {
          async first() {
            return statement.get(...values) ?? null;
          },
          async all() {
            return { success: true, results: statement.all(...values) };
          },
        };
      },
    };
  }
}

function context() {
  return {
    boundary: "request",
    request: { method: "GET", path: "/" },
    correlation: { correlationId: correlationId("db-sqlite-acceptance") },
    signal: new AbortController().signal,
  };
}

function seedRuntimeRows(database) {
  database.prepare(
    `INSERT INTO articles
      (article_id, source_type, source_post_id, slug, title, excerpt, body_html,
       canonical_url, content_hash, status, visibility, created_at, updated_at,
       published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "pastorwood:77",
    "pastorwood",
    "77",
    "synthetic-writing",
    "Synthetic writing",
    "Article summary",
    "<p>Article body</p>",
    "",
    "a".repeat(64),
    "Published",
    "public",
    at,
    at,
    at,
  );

  database.prepare(
    `INSERT INTO episodes
      (episode_id, title, publish_date, canonical_audio_key, source_system,
       source_id, status, created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "sa_77",
    "Synthetic episode",
    "2026-08-22",
    "podcasts/sa_77.mp3",
    "sermonaudio",
    "77",
    "Published",
    at,
    at,
    at,
  );
  database.prepare(
    `INSERT INTO episode_documents
      (document_id, episode_id, source_type, slug, title, description, summary,
       status, visibility, transcript_status, content_hash, created_at,
       updated_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "episode-doc-77",
    "sa_77",
    "podcast",
    "synthetic-episode",
    "Synthetic episode",
    "Episode body",
    "Episode summary",
    "Published",
    "public",
    "Completed",
    "b".repeat(64),
    at,
    at,
    at,
  );
  database.prepare(
    `INSERT INTO media_assets
      (asset_id, source_provider, destination_bucket, canonical_object_key,
       mime_type, size_bytes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "asset-77",
    "r2",
    "aic-podcast-audio",
    "podcasts/sa_77.mp3",
    "audio/mpeg",
    77,
    "verified",
    at,
    at,
  );

  database.prepare(
    `INSERT INTO editorial_revisions
      (revision_id, entity_type, entity_id, revision_number, title, body_html,
       status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "page-revision-77",
    "page",
    "page-doc-77",
    1,
    "Home",
    "<h1>Home</h1>",
    "Published",
    at,
  );
  database.prepare(
    `INSERT INTO pages
      (page_key, document_id, slug, title, status, published_revision_id,
       created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "home",
    "page-doc-77",
    "/",
    "Home",
    "Published",
    "page-revision-77",
    at,
    at,
    at,
  );

  const setting = database.prepare(
    `INSERT INTO site_settings
      (setting_key, value_json, value_type, is_public, created_at, updated_at)
     VALUES (?, ?, 'json', 1, ?, ?)`,
  );
  setting.run("site.title", JSON.stringify({ value: "AIC" }), at, at);
  setting.run(
    "site.canonicalOrigin",
    JSON.stringify({ value: "https://aic.example" }),
    at,
    at,
  );
  setting.run("site.allowIndexing", JSON.stringify({ value: false }), at, at);

  database.prepare(
    `INSERT INTO redirects
      (redirect_id, source_path, target_path, status_code, active, created_at,
       updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run("redirect-77", "/old", "/new", 308, at, at);

  database.prepare(
    `INSERT INTO users
      (user_id, clerk_user_id, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  ).run("internal-user-77", "user_clerk_77", at, at);
  database.prepare(
    `INSERT INTO user_roles (user_id, role, granted_at)
     VALUES (?, ?, ?)`,
  ).run("internal-user-77", "Admin", at);
}

test("runtime repositories execute against the complete migrated D1 schema", async () => {
  const database = await migratedDatabase();
  try {
    seedRuntimeRows(database);
    const repositories = createD1ReadRepositories({
      db: new SqliteD1Binding(database),
    });
    const operation = context();

    const article = await repositories.publicContent.getPublishedArticleBySlug(
      operation,
      "synthetic-writing",
    );
    assert.equal(article?.source.value, "77");
    assert.equal(article?.body, "<p>Article body</p>");
    assert.equal(
      (await repositories.publicContent.getArticleById(operation, "pastorwood:77"))?.slug,
      "synthetic-writing",
    );

    const articles = await repositories.publicContent.listPublishedArticles(
      operation,
      { limit: 10 },
    );
    assert.deepEqual(articles.items.map((item) => item.id), ["pastorwood:77"]);
    const articleFeed = await repositories.publicContent.listPublishedArticleFeedFiltered(
      operation,
      { limit: 10 },
      { contentType: "article" },
    );
    assert.equal(articleFeed.total, 1);
    assert.deepEqual(articleFeed.items.map((item) => item.contentType), ["article"]);

    const episode = await repositories.publicContent.getPublishedEpisodeBySlug(
      operation,
      "synthetic-episode",
    );
    assert.equal(episode?.hasAudio, true);
    assert.equal(episode?.transcriptAvailable, true);
    assert.equal(
      (await repositories.publicContent.getEpisodeById(operation, "sa_77"))?.slug,
      "synthetic-episode",
    );
    const episodes = await repositories.publicContent.listPublishedEpisodes(
      operation,
      { limit: 10 },
    );
    assert.deepEqual(episodes.items.map((item) => item.id), ["sa_77"]);
    database.prepare("UPDATE episode_documents SET published_at = ? WHERE document_id = ?").run("2025-12-31T00:00:00.000000Z", "episode-doc-77");
    const filteredEpisodes = await repositories.publicContent.listPublishedEpisodesFiltered(
      operation,
      { limit: 10 },
      { query: "synthetic%", year: 2026 },
    );
    assert.equal(filteredEpisodes.total, 0);
    const matchingEpisodes = await repositories.publicContent.listPublishedEpisodesFiltered(
      operation,
      { limit: 10 },
      { query: "synthetic", year: 2026 },
    );
    assert.equal(matchingEpisodes.total, 1);

    const page = await repositories.publicContent.getDynamicPageBySlug(operation, "/");
    assert.equal(page?.body, "<h1>Home</h1>");
    assert.equal(page?.canonicalUrl, "/");

    const settings = await repositories.publicContent.getSiteSettings(operation);
    assert.equal(settings.title, "AIC");
    assert.equal(settings.allowIndexing, false);

    assert.deepEqual(
      await repositories.publicContent.resolveRedirect(operation, "/old"),
      { sourcePath: "/old", destination: "/new", status: 308 },
    );

    const access = await repositories.userAccess.getByUserId(operation, "user_clerk_77");
    assert.deepEqual(access?.roles, ["Admin"]);
    assert.equal(access?.disabled, false);
  } finally {
    database.close();
  }
});

test("migrated SQLite executes all three D1 editorial inventory queries", async () => {
  const database = await migratedDatabase();
  try {
    seedRuntimeRows(database);
    const { D1EditorialRepository } = await import("../src/index.ts");
    const repository = new D1EditorialRepository({ db: new SqliteD1Binding(database) });
    const operation = context();
    const article = await repository.listForEdit(operation, { limit: 10 }, { kind: "article", query: "synthetic" });
    assert.equal(article.total, 1);
    assert.equal(article.items[0].documentId, "pastorwood:77");
    const episode = await repository.listForEdit(operation, { limit: 10 }, { kind: "episode", query: "synthetic" });
    assert.equal(episode.total, 1);
    assert.equal(episode.items[0].entity.id, "sa_77");
    const page = await repository.listForEdit(operation, { limit: 10 }, { kind: "page", query: "home" });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].documentId, "page-doc-77");
    database.prepare(`
      INSERT INTO editorial_revisions
        (revision_id, entity_type, entity_id, revision_number, status, created_at)
      VALUES ('wrong-article-pointer', 'article', 'pastorwood:other', 1, 'Published', ?)
    `).run(at);
    database.prepare("UPDATE articles SET published_revision_id = ? WHERE article_id = ?").run("wrong-article-pointer", "pastorwood:77");
    await assert.rejects(() => repository.listForEdit(operation, { limit: 10 }, { kind: "article" }), /D1 published editorial revision integrity check failed/u);
  } finally {
    database.close();
  }
});

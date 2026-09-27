import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createProcessingIdempotencyKey,
  createProcessingRevisionHash,
  ServiceError,
} from "@aic/contracts";
import { D1ProcessingStateStore } from "../src/index.ts";
import { createD1SearchRepositories, validateSearchHydrationEvidence } from "../src/search.ts";

const migrationDirectory = new URL("../../../migrations/d1/", import.meta.url);
const at = "2026-09-07T12:00:00.000000Z";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const articleHash = (subtype, id, index, text) => {
  const digest = createHash("sha256");
  for (const part of [subtype, id, String(index), text]) digest.update(part).update("\0");
  return digest.digest("hex");
};

class SqliteD1Statement {
  constructor(binding, sql, values = []) { this.binding = binding; this.sql = sql; this.values = values; }
  bind(...values) { return new SqliteD1Statement(this.binding, this.sql, values); }
  async first() { return this.binding.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() {
    this.binding.allCalls.push({ sql: this.sql, values: this.values });
    return { success: true, results: this.binding.database.prepare(this.sql).all(...this.values) };
  }
  async run() {
    const result = this.binding.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class SqliteD1Binding {
  constructor(database) { this.database = database; this.allCalls = []; }
  prepare(sql) { return new SqliteD1Statement(this, sql); }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) database.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
  return database;
}

function operation(overrides = {}) {
  return {
    boundary: "request",
    request: { method: "POST", path: "/api/rag/chat" },
    correlation: { correlationId: "synthetic-search" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function marker({ vectorId, table, sourceType, sourceId, subtype, chunkIndex, text, title, sourceField = "text", processingRevisionHash = null, extra = {} }) {
  return {
    version: 1,
    manifestSha256: "1".repeat(64),
    sourceFingerprint: hash(`source:${vectorId}`),
    sourceRecordId: `record:${vectorId}`,
    sourceTable: table,
    sourceField,
    sourceUpdatedAt: at,
    textSha256: hash(text),
    title,
    publishDate: "2026-09-07",
    contentSubtype: subtype,
    vectorizeMetadata: {
      source_type: sourceType,
      source_id: sourceId,
      content_subtype: subtype,
      published_day: 20260907,
      content_hash: extra.contentHash,
      chunk_index: chunkIndex,
    },
    entityType: sourceType === "article" ? "article" : "episode",
    entityId: sourceId,
    accessScope: "authenticated-corpus",
    processingRevisionHash,
    ...extra.marker,
  };
}

function seedCanonical(database) {
  database.prepare(`INSERT INTO episodes
    (episode_id,title,publish_date,canonical_audio_key,source_system,source_id,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("123", "Synthetic episode", "2026-09-07", "podcasts/123.mp3", "postgresql", "123", "Draft", at, at);
  database.prepare(`INSERT INTO episode_documents
    (document_id,episode_id,source_type,slug,title,status,visibility,content_hash,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("episode-doc-123", "123", "podcast", "synthetic-episode", "Synthetic episode", "Draft", "public", "e".repeat(64), at, at);
}

function seedVector(database, { vectorId, table, customId, sourceType, sourceId, subtype, chunkIndex, text, title, contentHash = hash(text), sourceField = "text", sourceUrl = "", sourceLocation = "", processingRevisionHash = null, processingVisibilityState = null, markerExtra = {} }) {
  const hydration = marker({
    vectorId, table, sourceType, sourceId, subtype, chunkIndex, text, title, sourceField,
    processingRevisionHash,
    extra: { contentHash, marker: markerExtra },
  });
  database.prepare(`INSERT INTO vector_documents
    (vector_id,source_table,source_custom_id,source_type,source_id,content_subtype,
     content_hash,chunk_index,published_day,embedding_model,dimensions,vector_digest,
     metadata_digest,status,updated_at,record_id,source_field,source_url,
     source_location,authoritative_text,metadata_json,processing_revision_hash,
     processing_visibility_state)
    VALUES (?,?,?,?,?,?,?,?,?,'text-embedding-3-small',1536,?,?,'verified',?,?,?,?,?,?,?,?,?)`).run(
    vectorId, table, customId, sourceType, sourceId, subtype, contentHash, chunkIndex,
    20260907, "2".repeat(64), "3".repeat(64), at, `record:${vectorId}`,
    sourceField, sourceUrl, sourceLocation, text, JSON.stringify({ p5Hydration: hydration }),
    processingRevisionHash, processingVisibilityState,
  );
}

async function fixture() {
  const database = await migratedDatabase();
  seedCanonical(database);
  seedVector(database, {
    vectorId: "t/123:speech:0001", table: "transcript_chunks", customId: "123:speech:0001",
    sourceType: "episode_transcript", sourceId: "123", subtype: "speech", chunkIndex: 1,
    text: "Synthetic transcript text.", title: "Synthetic episode",
    markerExtra: { startMs: 1000, endMs: 2500 },
  });
  seedVector(database, {
    vectorId: "i/123:summary", table: "episode_intelligence_vectors", customId: "123:summary",
    sourceType: "episode_intelligence", sourceId: "123", subtype: "episode_executive_summary", chunkIndex: 0,
    text: "Synthetic intelligence text.", title: "Synthetic episode", sourceField: "executive_summary",
    sourceLocation: "Executive summary",
    markerExtra: { provenanceTable: "episode_intelligence", provenanceId: "123", label: "Executive summary", sourceLocation: "Executive summary" },
  });
  const articleText = "Synthetic legacy article text.";
  seedVector(database, {
    vectorId: "a/10:devotional:0002", table: "pastorwood_post_chunks", customId: "10:devotional:0002",
    sourceType: "article", sourceId: "pastorwood:10", subtype: "pastorwood_devotional", chunkIndex: 2,
    text: articleText, title: "Synthetic writing",
    contentHash: articleHash("pastorwood_devotional", "10", 2, articleText),
    sourceUrl: "https://pastorwood.org/synthetic-writing/",
    markerExtra: { canonicalArticlePresent: false },
  });
  return database;
}

function repository(binding, access = { kind: "authenticated-corpus", userId: "user_clerk_a" }) {
  return createD1SearchRepositories({ db: binding, canonicalOrigin: "https://aic.example", access }).searchDocuments;
}

async function rejectsSanitized(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "dependency_unavailable");
    assert.equal(error.message, "Search content is temporarily unavailable.");
    assert.equal(error.cause, undefined);
    assert.equal(error.safeDetails, undefined);
    assert.equal(JSON.stringify(error).includes("synthetic SQL secret"), false);
    return true;
  });
}

test("hydrates all three exact source families while Draft remains authenticated-only", async () => {
  const database = await fixture();
  try {
    const binding = new SqliteD1Binding(database);
    const ids = ["a/10:devotional:0002", "t/123:speech:0001", "i/123:summary"];
    const authenticated = await repository(binding).getByVectorIds(operation(), ids);
    assert.deepEqual(authenticated.map((item) => item.vectorId), ids);
    // A status-index scan reads the entire 174k-row historical corpus for every
    // bounded ID batch. Keep the primary-key lookup with the status filter intact.
    const lookup = binding.allCalls.find((call) => call.sql.includes("FROM vector_documents v"));
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${lookup.sql}`).all(...lookup.values).map((row) => row.detail).join("\n");
    assert.match(plan, /SEARCH v USING INDEX .*\(vector_id=\?\)/);
    assert.doesNotMatch(plan, /idx_vector_documents_status/);
    assert.notEqual(authenticated[0].contentHash, hash(authenticated[0].text));
    assert.equal(authenticated[1].canonicalUrl, "https://aic.example/podcast/episodes?trackId=123");
    assert.deepEqual(authenticated[1].sourceLocation, { startMs: 1000, endMs: 2500 });
    assert.deepEqual(authenticated[2].sourceLocation, { label: "Executive summary" });
    assert.deepEqual(await repository(binding, { kind: "public-published" }).getByVectorIds(operation(), [ids[1]]), []);
  } finally { database.close(); }
});

test("exposes hydration evidence validation without URL or access presentation", async () => {
  const database = await fixture();
  try {
    const columns = "vector_id,source_table,source_custom_id,source_type,source_id,content_subtype,content_hash,chunk_index,published_day,embedding_model,dimensions,status,record_id,source_field,source_location,authoritative_text,metadata_json,processing_revision_hash,processing_visibility_state";
    const row = database.prepare(`SELECT ${columns} FROM vector_documents WHERE vector_id='t/123:speech:0001'`).get();
    await validateSearchHydrationEvidence(row);
    row.metadata_json = "{}";
    await assert.rejects(validateSearchHydrationEvidence(row), { code: "dependency_unavailable" });
  } finally { database.close(); }
});

test("historical source UTC timestamps preserve whole-second and fractional precision", async () => {
  const database = await fixture();
  try {
    const reader = repository(new SqliteD1Binding(database));
    const id = "i/123:summary";
    const metadata = JSON.parse(database.prepare("SELECT metadata_json FROM vector_documents WHERE vector_id=?").get(id).metadata_json);
    for (const stamp of ["2026-05-06T02:31:49Z", "2026-05-06T02:31:49.1Z", "2026-05-06T02:31:49.123456Z"]) {
      metadata.p5Hydration.sourceUpdatedAt = stamp;
      database.prepare("UPDATE vector_documents SET metadata_json=? WHERE vector_id=?").run(JSON.stringify(metadata), id);
      assert.equal((await reader.getByVectorIds(operation(), [id])).length, 1);
    }
    for (const stamp of ["2026-02-30T02:31:49Z", "2026-05-06T24:31:49Z", "2026-05-06T02:31:49-04:00", "May 6 2026"]) {
      metadata.p5Hydration.sourceUpdatedAt = stamp;
      database.prepare("UPDATE vector_documents SET metadata_json=? WHERE vector_id=?").run(JSON.stringify(metadata), id);
      await assert.rejects(reader.getByVectorIds(operation(), [id]), { code: "dependency_unavailable" });
    }
  } finally { database.close(); }
});

test("rejects malformed eligible hydration and omits absent, nonverified, or tombstoned rows", async () => {
  const database = await fixture();
  try {
    const binding = new SqliteD1Binding(database);
    const reader = repository(binding);
    database.prepare("UPDATE vector_documents SET authoritative_text='' WHERE vector_id=?").run("t/123:speech:0001");
    await assert.rejects(reader.getByVectorIds(operation(), ["t/123:speech:0001"]), { code: "dependency_unavailable" });
    // A vector with no hydration marker cannot be proven, so it is omitted rather than failing.
    database.prepare("UPDATE vector_documents SET authoritative_text='Synthetic transcript text.', metadata_json='{}' WHERE vector_id=?").run("t/123:speech:0001");
    assert.deepEqual(await reader.getByVectorIds(operation(), ["t/123:speech:0001"]), []);
    database.prepare("UPDATE vector_documents SET status='pending' WHERE vector_id=?").run("t/123:speech:0001");
    assert.deepEqual(await reader.getByVectorIds(operation(), ["t/123:speech:0001", "t/absent"]), []);
    database.prepare("UPDATE vector_documents SET status='tombstoned' WHERE vector_id=?").run("t/123:speech:0001");
    assert.deepEqual(await reader.getByVectorIds(operation(), ["t/123:speech:0001"]), []);
  } finally { database.close(); }
});

test("validates text digest, vector metadata, identity, and legacy URL provenance", async () => {
  const database = await fixture();
  try {
    const reader = repository(new SqliteD1Binding(database));
    const transcript = "t/123:speech:0001";
    const original = database.prepare("SELECT metadata_json FROM vector_documents WHERE vector_id=?").get(transcript).metadata_json;
    const changed = JSON.parse(original);
    changed.p5Hydration.textSha256 = "f".repeat(64);
    database.prepare("UPDATE vector_documents SET metadata_json=? WHERE vector_id=?").run(JSON.stringify(changed), transcript);
    await assert.rejects(reader.getByVectorIds(operation(), [transcript]), { code: "dependency_unavailable" });
    changed.p5Hydration.textSha256 = hash("Synthetic transcript text.");
    changed.p5Hydration.vectorizeMetadata.source_id = "124";
    database.prepare("UPDATE vector_documents SET metadata_json=? WHERE vector_id=?").run(JSON.stringify(changed), transcript);
    await assert.rejects(reader.getByVectorIds(operation(), [transcript]), { code: "dependency_unavailable" });
    const article = "a/10:devotional:0002";
    for (const poisoned of ["https://unapproved.example/phishing", "/admin/private", "https://aic.example/admin/private"]) {
      database.prepare("UPDATE vector_documents SET source_url=? WHERE vector_id=?").run(poisoned, article);
      await assert.rejects(reader.getByVectorIds(operation(), [article]), { code: "dependency_unavailable" });
    }
    database.prepare("UPDATE vector_documents SET source_url='https://www.pastorwood.org/legacy/' WHERE vector_id=?").run(article);
    assert.equal((await reader.getByVectorIds(operation(), [article]))[0].canonicalUrl, "https://www.pastorwood.org/legacy/");
    database.prepare("UPDATE vector_documents SET source_url='' WHERE vector_id=?").run(article);
    assert.equal((await reader.getByVectorIds(operation(), [article]))[0].canonicalUrl, "https://aic.example/api/rag/sources/a%2F10%3Adevotional%3A0002");
  } finally { database.close(); }
});

test("rejects a CMS source ID attached to the legacy pastorwood chunk family", async () => {
  const database = await fixture();
  try {
    seedVector(database, {
      vectorId: "a/cms-poison", table: "pastorwood_post_chunks", customId: "cms-poison",
      sourceType: "article", sourceId: "cms:doc-1", subtype: "pastorwood_resource", chunkIndex: 0,
      text: "Poisoned CMS identity.", title: "Poisoned", sourceUrl: "https://pastorwood.org/poisoned/",
    });
    await assert.rejects(repository(new SqliteD1Binding(database)).getByVectorIds(operation(), ["a/cms-poison"]), { code: "dependency_unavailable" });
  } finally { database.close(); }
});

test("never substitutes an unrelated current CMS draft for verified historical text", async () => {
  const database = await fixture();
  try {
    database.prepare(`INSERT INTO articles
      (article_id,source_type,source_post_id,slug,title,body_html,content_hash,status,visibility,created_at,updated_at)
      VALUES ('pastorwood:10','pastorwood','10','current-draft','Current draft','Unrelated CMS draft body',?,'Draft','private',?,?)`).run("a".repeat(64), at, at);
    const result = await repository(new SqliteD1Binding(database)).getByVectorIds(operation(), ["a/10:devotional:0002"]);
    assert.equal(result[0].text, "Synthetic legacy article text.");
    assert.equal(result[0].title, "Synthetic writing");
  } finally { database.close(); }
});

test("deduplicates in caller order, uses at most 40 IDs per query, and rejects raw length 101", async () => {
  const database = await fixture();
  try {
    const binding = new SqliteD1Binding(database);
    const reader = repository(binding);
    const ids = Array.from({ length: 100 }, (_, index) => index === 61 ? "t/123:speech:0001" : `t/missing-${index}`);
    ids[7] = "t/123:speech:0001";
    assert.deepEqual((await reader.getByVectorIds(operation(), ids)).map((item) => item.vectorId), ["t/123:speech:0001"]);
    assert.deepEqual(binding.allCalls.map((call) => call.values.length), [40, 40, 19]);
    const calls = binding.allCalls.length;
    await assert.rejects(reader.getByVectorIds(operation(), [...ids, "t/extra"]), { code: "invalid_argument" });
    assert.equal(binding.allCalls.length, calls);
  } finally { database.close(); }
});

test("public hydration requires exact canonical pointer and search association", async () => {
  const database = await fixture();
  try {
    const id = "t/123:speech:0001";
    database.prepare(`INSERT INTO editorial_revisions
      (revision_id,entity_type,entity_id,revision_number,title,status,created_at,snapshot_json)
      VALUES (?,?,?,?,?,'Published',?,?)`).run("revision-1", "episode", "episode-doc-123", 1, "Synthetic episode", at, JSON.stringify({ kind: "episode", documentId: "episode-doc-123" }));
    database.prepare("UPDATE episodes SET status='Published',published_at=? WHERE episode_id='123'").run(at);
    database.prepare("UPDATE episode_documents SET status='Published',published_at=?,published_revision_id='revision-1' WHERE episode_id='123'").run(at);
    const reader = repository(new SqliteD1Binding(database), { kind: "public-published" });
    assert.deepEqual(await reader.getByVectorIds(operation(), [id]), []);
    database.prepare("INSERT INTO search_publications(vector_id,published_revision_id,text_sha256) VALUES(?,?,?)").run(id, "revision-1", hash("Synthetic transcript text."));
    database.prepare("UPDATE episode_documents SET title='Current public episode title' WHERE episode_id='123'").run();
    const published = (await reader.getByVectorIds(operation(), [id]))[0];
    assert.equal(published.canonicalUrl, "https://aic.example/radio/synthetic-episode/");
    assert.equal(published.title, "Current public episode title");
    assert.equal((await repository(new SqliteD1Binding(database)).getByVectorIds(operation(), [id]))[0].title, "Synthetic episode");
    database.prepare(`INSERT INTO editorial_revisions
      (revision_id,entity_type,entity_id,revision_number,title,status,created_at,snapshot_json)
      VALUES (?,?,?,?,?,'Published',?,?)`).run("revision-2", "episode", "episode-doc-123", 2, "Replacement", at, JSON.stringify({ kind: "episode", documentId: "episode-doc-123" }));
    database.prepare("UPDATE episode_documents SET published_revision_id='revision-2' WHERE episode_id='123'").run();
    assert.deepEqual(await reader.getByVectorIds(operation(), [id]), []);
    database.prepare("UPDATE episode_documents SET published_revision_id='missing-revision' WHERE episode_id='123'").run();
    await assert.rejects(reader.getByVectorIds(operation(), [id]), { code: "dependency_unavailable" });
    database.prepare("UPDATE episode_documents SET status='Archived',published_revision_id='revision-1' WHERE episode_id='123'").run();
    assert.deepEqual(await reader.getByVectorIds(operation(), [id]), []);
    assert.equal((await repository(new SqliteD1Binding(database)).getByVectorIds(operation(), [id])).length, 1);
  } finally { database.close(); }
});

test("uses the current canonical article title only for public hydration", async () => {
  const database = await fixture();
  try {
    database.prepare(`INSERT INTO editorial_revisions
      (revision_id,entity_type,entity_id,revision_number,title,status,created_at,snapshot_json)
      VALUES ('article-title-revision','article','pastorwood:10',1,'Current public article title','Published',?,?)`).run(at, JSON.stringify({ kind: "article", documentId: "pastorwood:10" }));
    database.prepare(`INSERT INTO articles
      (article_id,source_type,source_post_id,slug,title,content_hash,status,visibility,created_at,updated_at,published_at,published_revision_id)
      VALUES ('pastorwood:10','pastorwood','10','synthetic-writing','Current public article title',?,'Published','public',?,?,?,'article-title-revision')`).run("a".repeat(64), at, at, at);
    database.prepare("INSERT INTO search_publications(vector_id,published_revision_id,text_sha256) VALUES(?,?,?)").run("a/10:devotional:0002", "article-title-revision", hash("Synthetic legacy article text."));
    const publicItem = (await repository(new SqliteD1Binding(database), { kind: "public-published" }).getByVectorIds(operation(), ["a/10:devotional:0002"]))[0];
    const authenticated = (await repository(new SqliteD1Binding(database)).getByVectorIds(operation(), ["a/10:devotional:0002"]))[0];
    assert.equal(publicItem.title, "Current public article title");
    assert.equal(authenticated.title, "Synthetic writing");
    assert.equal(publicItem.text, authenticated.text);
  } finally { database.close(); }
});

test("fails closed when article ID and CMS alias resolve the same source to two canonical rows", async () => {
  const database = await fixture();
  try {
    database.prepare(`INSERT INTO editorial_revisions
      (revision_id,entity_type,entity_id,revision_number,title,status,created_at,snapshot_json)
      VALUES ('article-revision-1','article','pastorwood:10',1,'Legacy','Published',?,?)`).run(at, JSON.stringify({ kind: "article", documentId: "pastorwood:10" }));
    database.prepare(`INSERT INTO editorial_revisions
      (revision_id,entity_type,entity_id,revision_number,title,status,created_at,snapshot_json)
      VALUES ('article-revision-2','article','pastorwood:10',2,'Alias','Published',?,?)`).run(at, JSON.stringify({ kind: "article", documentId: "pastorwood:10" }));
    database.prepare(`INSERT INTO articles
      (article_id,source_type,source_post_id,slug,title,content_hash,status,visibility,created_at,updated_at,published_at,published_revision_id)
      VALUES ('pastorwood:10','pastorwood','10','legacy','Legacy',?,'Published','public',?,?,?,?)`).run("a".repeat(64), at, at, at, "article-revision-1");
    database.prepare(`INSERT INTO articles
      (article_id,source_type,cms_document_id,slug,title,content_hash,status,visibility,created_at,updated_at,published_at,published_revision_id)
      VALUES ('cms:collision','cms','pastorwood:10','alias','Alias',?,'Published','public',?,?,?,?)`).run("b".repeat(64), at, at, at, "article-revision-2");
    database.prepare("INSERT INTO search_publications(vector_id,published_revision_id,text_sha256) VALUES(?,?,?)").run("a/10:devotional:0002", "article-revision-1", hash("Synthetic legacy article text."));
    await assert.rejects(repository(new SqliteD1Binding(database), { kind: "public-published" }).getByVectorIds(operation(), ["a/10:devotional:0002"]), { code: "dependency_unavailable" });
  } finally { database.close(); }
});

test("allows only the configured or approved legacy origins for canonical article links", async () => {
  const database = await fixture();
  try {
    database.prepare(`INSERT INTO editorial_revisions
      (revision_id,entity_type,entity_id,revision_number,title,status,created_at,snapshot_json)
      VALUES ('article-revision','article','pastorwood:10',1,'Legacy','Published',?,?)`).run(at, JSON.stringify({ kind: "article", documentId: "pastorwood:10" }));
    database.prepare(`INSERT INTO articles
      (article_id,source_type,source_post_id,slug,title,canonical_url,content_hash,status,visibility,created_at,updated_at,published_at,published_revision_id)
      VALUES ('pastorwood:10','pastorwood','10','legacy','Legacy','https://unapproved.example/phishing',?,'Published','public',?,?,?,'article-revision')`).run("a".repeat(64), at, at, at);
    database.prepare("INSERT INTO search_publications(vector_id,published_revision_id,text_sha256) VALUES(?,?,?)").run("a/10:devotional:0002", "article-revision", hash("Synthetic legacy article text."));
    const publicReader = repository(new SqliteD1Binding(database), { kind: "public-published" });
    const authenticated = repository(new SqliteD1Binding(database));
    for (const poisoned of ["https://unapproved.example/phishing", "https://aic.example:444/phishing", "https://attacker@aic.example/phishing"]) {
      database.prepare("UPDATE articles SET canonical_url=? WHERE article_id='pastorwood:10'").run(poisoned);
      await assert.rejects(publicReader.getByVectorIds(operation(), ["a/10:devotional:0002"]), { code: "dependency_unavailable" });
      await assert.rejects(authenticated.getByVectorIds(operation(), ["a/10:devotional:0002"]), { code: "dependency_unavailable" });
    }
    database.prepare("UPDATE articles SET canonical_url='/writings/legacy/' WHERE article_id='pastorwood:10'").run();
    assert.equal((await publicReader.getByVectorIds(operation(), ["a/10:devotional:0002"]))[0].canonicalUrl, "https://aic.example/writings/legacy/");
    database.prepare("UPDATE articles SET canonical_url='https://www.pastorwood.org/legacy/' WHERE article_id='pastorwood:10'").run();
    assert.equal((await authenticated.getByVectorIds(operation(), ["a/10:devotional:0002"]))[0].canonicalUrl, "https://www.pastorwood.org/legacy/");
  } finally { database.close(); }
});

test("versioned rows require visible ledger and exact visible head while explicit withdrawal denies historical rows", async () => {
  const database = await fixture();
  try {
    const binding = new SqliteD1Binding(database);
    const snapshot = { trackId: "123", text: "replacement" };
    const revisionHash = await createProcessingRevisionHash(snapshot);
    const idempotencyKey = await createProcessingIdempotencyKey({ operation: "transcript_replace", entityType: "transcript", entityId: "123", revisionHash });
    await new D1ProcessingStateStore({ db: binding, now: () => at }).createOrGetRequest({
      requestId: "request-visible", workflow: "content", entityType: "transcript", entityId: "123",
      revisionId: "revision-visible", revisionHash, operation: "transcript_replace", idempotencyKey,
      snapshot, desiredPublication: "published", requestedBy: "synthetic", correlationId: "synthetic",
    });
    database.prepare(`UPDATE processing_heads SET authenticated_corpus_request_id=?,
      authenticated_corpus_revision_hash=?,authenticated_corpus_visibility='visible' WHERE aggregate_type='episode' AND aggregate_id='123'`).run("request-visible", revisionHash);
    const id = "t/123:speech:0001";
    const metadata = JSON.parse(database.prepare("SELECT metadata_json FROM vector_documents WHERE vector_id=?").get(id).metadata_json);
    metadata.p5Hydration.processingRevisionHash = revisionHash;
    database.prepare("UPDATE vector_documents SET metadata_json=?,processing_revision_hash=?,processing_visibility_state='visible' WHERE vector_id=?").run(JSON.stringify(metadata), revisionHash, id);
    assert.equal((await repository(binding).getByVectorIds(operation(), [id])).length, 1);
    database.prepare("UPDATE processing_heads SET authenticated_corpus_revision_hash=? WHERE aggregate_id='123'").run(`sha256:${"9".repeat(64)}`);
    assert.deepEqual(await repository(binding).getByVectorIds(operation(), [id]), []);
    database.prepare("UPDATE vector_documents SET processing_revision_hash=NULL,processing_visibility_state=NULL WHERE vector_id=?").run(id);
    metadata.p5Hydration.processingRevisionHash = null;
    database.prepare("UPDATE vector_documents SET metadata_json=? WHERE vector_id=?").run(JSON.stringify(metadata), id);
    assert.deepEqual(await repository(binding).getByVectorIds(operation(), [id]), []);
    database.prepare("UPDATE processing_heads SET authenticated_corpus_request_id=NULL,authenticated_corpus_revision_hash=NULL,authenticated_corpus_visibility='inherited' WHERE aggregate_id='123'").run();
    assert.equal((await repository(binding).getByVectorIds(operation(), [id])).length, 1);
    database.prepare("UPDATE processing_heads SET authenticated_corpus_visibility='hidden' WHERE aggregate_id='123'").run();
    assert.deepEqual(await repository(binding).getByVectorIds(operation(), [id]), []);
  } finally { database.close(); }
});

test("bounds cancellation and deadline around D1 and redacts binding errors", async () => {
  let calls = 0;
  const pending = { prepare: () => ({ bind: () => ({ all: () => { calls += 1; return new Promise(() => {}); } }) }) };
  await assert.rejects(repository(pending).getByVectorIds(operation({ deadline: new Date(Date.now() + 20).toISOString() }), ["t/x"]), { code: "timeout" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(repository(pending).getByVectorIds(operation({ signal: controller.signal }), ["t/x"]), { code: "cancelled" });
  assert.equal(calls, 1);
  const foreign = () => new ServiceError({ code: "forbidden", message: "synthetic SQL secret", safeDetails: { raw: "synthetic SQL secret" }, cause: new Error("synthetic SQL secret") });
  const failures = [
    (error) => ({ prepare: () => { throw error; } }),
    (error) => ({ prepare: () => ({ bind: () => { throw error; } }) }),
    (error) => ({ prepare: () => ({ bind: () => ({ all: async () => { throw error; } }) }) }),
  ];
  for (const makeBinding of failures) {
    await rejectsSanitized(repository(makeBinding(new Error("synthetic SQL secret"))).getByVectorIds(operation(), ["t/x"]));
    await rejectsSanitized(repository(makeBinding(foreign())).getByVectorIds(operation(), ["t/x"]));
  }
});

test("rejects malformed search deadlines before D1", async () => {
  const reader = repository({ prepare: () => { throw new Error("D1 must not run"); } });
  for (const deadline of ["January 1, 2099", "2099-01-01T00:00:00", "2099-01-01T00:00:00-05:00", "2099-02-30T00:00:00.000Z", "2099-01-01T00:00:00.Z", "2099-01-01T24:00:00Z", "2099-02-29T00:00:00.1Z", "2099-04-31T00:00:00.123456789Z", "2099-01-01T00:00:00+00:00"]) {
    await assert.rejects(reader.getByVectorIds(operation({ deadline }), ["t/123:speech:0001"]), { code: "invalid_argument" });
  }
});

test("admits UTC search deadlines independently of fractional precision", async () => {
  const database = await fixture();
  try {
    const adapter = repository(new SqliteD1Binding(database));
    for (const fraction of ['', '.1', '.12', '.123', '.123456', '.123456789', `.${'1'.repeat(100)}`]) {
      assert.equal((await adapter.getByVectorIds(operation({ deadline: `2099-01-01T00:00:00${fraction}Z` }), ["t/123:speech:0001"])).length, 1);
    }
  } finally { database.close(); }
});

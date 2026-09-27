import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createProcessingIdempotencyKey, createProcessingRevisionHash } from "@aic/contracts";
import { D1ProcessingStateStore } from "../src/index.ts";
import { createD1ResearchSourceRepository } from "../src/research.ts";
import { createD1SearchRepositories } from "../src/search.ts";

const migrations = new URL("../../../migrations/d1/", import.meta.url);
const at = "2026-09-07T12:00:00.000000Z";
const hash = (value) => createHash("sha256").update(value).digest("hex");

class Statement {
  constructor(binding, sql, values = []) { this.binding = binding; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.binding, this.sql, values); }
  async first() { return this.binding.db.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { success: true, results: this.binding.db.prepare(this.sql).all(...this.values) }; }
  async run() { const before = this.binding.db.prepare("SELECT total_changes() n").get().n; const result = this.binding.db.prepare(this.sql).run(...this.values); const after = this.binding.db.prepare("SELECT total_changes() n").get().n; return { success: true, meta: { changes: after - before, last_row_id: Number(result.lastInsertRowid) } }; }
}
class Binding {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) { this.db.exec("BEGIN IMMEDIATE"); try { const rows = []; for (const statement of statements) rows.push(await statement.run()); this.db.exec("COMMIT"); return rows; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
}

async function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) db.exec(await readFile(new URL(file, migrations), "utf8"));
  db.prepare("INSERT INTO episodes(episode_id,title,publish_date,canonical_audio_key,source_system,source_id,status,created_at,updated_at) VALUES('7','Seven','2026-08-01','podcasts/7.mp3','postgresql','7','Draft',?,?)").run(at, at);
  db.prepare("INSERT INTO episode_documents(document_id,episode_id,source_type,slug,title,status,visibility,content_hash,created_at,updated_at) VALUES('doc-7','7','podcast','seven','Seven','Draft','private',?,?,?)").run("a".repeat(64), at, at);
  db.prepare("INSERT INTO articles(article_id,source_type,source_post_id,slug,title,content_hash,status,visibility,created_at,updated_at) VALUES('pastorwood:10','pastorwood','10','ten','Ten',?,'Published','public',?,?)").run("b".repeat(64), at, at);
  return db;
}

function seedResearch(db, { key = "transcript_segments:segment-7-10", text = "visible phrase", revision = null } = {}) {
  const segmentId = key.slice("transcript_segments:".length);
  db.prepare(`INSERT INTO research_sources(source_key,source_table,source_record_id,episode_id,entity_type,entity_id,kind,item_type,title,publish_date,text,text_sha256,start_ms,end_ms,sequence_number,speakers_json,source_model,metadata_json,source_fingerprint,processing_revision_hash)
    VALUES(?,'transcript_segments',?,'7','episode','7','segment','speech','','',?,?,?,?,10,'[]','',?,?,?)`).run(key, hash(JSON.stringify({ segment_id: segmentId })), text, hash(text), 1, 2, JSON.stringify({ projectionVersion: 1, manifestSha256: "1".repeat(64) }), hash(`fingerprint:${key}`), revision);
  db.prepare("INSERT INTO research_sources_fts(rowid,title,text) SELECT rowid,title,text FROM research_sources WHERE source_key=?").run(key);
}

function seedEpisodeVector(db) {
  const text = "visible vector";
  const marker = { version: 1, manifestSha256: "1".repeat(64), sourceFingerprint: hash("vector-source"), sourceRecordId: "record:t/7:speech:0010", sourceTable: "transcript_chunks", sourceField: "text", sourceUpdatedAt: at, textSha256: hash(text), title: "Seven", publishDate: "2026-08-01", contentSubtype: "speech", vectorizeMetadata: { source_type: "episode_transcript", source_id: "7", content_subtype: "speech", published_day: 20260801, content_hash: hash(text), chunk_index: 10 }, entityType: "episode", entityId: "7", accessScope: "authenticated-corpus", processingRevisionHash: null };
  db.prepare(`INSERT INTO vector_documents(vector_id,source_table,source_custom_id,source_type,source_id,content_subtype,content_hash,chunk_index,published_day,embedding_model,dimensions,vector_digest,metadata_digest,status,updated_at,record_id,source_field,authoritative_text,metadata_json)
    VALUES('t/7:speech:0010','transcript_chunks','7:speech:0010','episode_transcript','7','speech',?,10,20260801,'text-embedding-3-small',1536,?,?,'verified',?,'record:t/7:speech:0010','text',?,?)`).run(hash(text), "2".repeat(64), "3".repeat(64), at, text, JSON.stringify({ p5Hydration: marker }));
}

function seedArticleVector(db) {
  const text = "article text";
  const marker = { version: 1, manifestSha256: "1".repeat(64), sourceFingerprint: hash("article-source"), sourceRecordId: "record:a/10", sourceTable: "pastorwood_post_chunks", sourceField: "text", sourceUpdatedAt: at, textSha256: hash(text), title: "Ten", publishDate: "2026-08-01", contentSubtype: "pastorwood_devotional", vectorizeMetadata: { source_type: "article", source_id: "pastorwood:10", content_subtype: "pastorwood_devotional", published_day: 20260801, content_hash: hash(text), chunk_index: 0 }, entityType: "article", entityId: "pastorwood:10", accessScope: "authenticated-corpus", processingRevisionHash: null, canonicalArticlePresent: true };
  db.prepare(`INSERT INTO vector_documents(vector_id,source_table,source_custom_id,source_type,source_id,content_subtype,content_hash,chunk_index,published_day,embedding_model,dimensions,vector_digest,metadata_digest,status,updated_at,record_id,source_field,source_url,authoritative_text,metadata_json)
    VALUES('a/10:devotional:0000','pastorwood_post_chunks','10:devotional:0000','article','pastorwood:10','pastorwood_devotional',?,0,20260801,'text-embedding-3-small',1536,?,?,'verified',?,'record:a/10','text','https://pastorwood.org/ten',?,?)`).run(hash(text), "2".repeat(64), "3".repeat(64), at, text, JSON.stringify({ p5Hydration: marker }));
}

const context = () => ({ boundary: "request", request: { method: "GET", path: "/synthetic" }, correlation: { correlationId: "visibility-test" }, signal: new AbortController().signal });
const readers = (binding) => ({ research: createD1ResearchSourceRepository({ db: binding, access: { kind: "authenticated-corpus", userId: "user_test" } }), vectors: createD1SearchRepositories({ db: binding, canonicalOrigin: "https://aic.example", access: { kind: "authenticated-corpus", userId: "user_test" } }).searchDocuments });

async function input({ requestId, operation, entityType, entityId, snapshot, desiredPublication, corpusEraseApproved }) {
  const revisionHash = await createProcessingRevisionHash(snapshot);
  return { requestId, workflow: operation === "episode_ingest" ? "episode" : "content", entityType, entityId, revisionId: `revision-${requestId}`, revisionHash, operation, idempotencyKey: await createProcessingIdempotencyKey({ operation, entityType, entityId, revisionHash }), snapshot, desiredPublication, requestedBy: "synthetic", correlationId: requestId, ...(corpusEraseApproved ? { corpusEraseApproved } : {}) };
}

test("actual episode ingest and transcript replacement supersede one head and filter stale rows before limit", async () => {
  const db = await fixture();
  try {
    seedResearch(db); seedEpisodeVector(db);
    const binding = new Binding(db);
    const store = new D1ProcessingStateStore({ db: binding, now: () => at });
    const current = readers(binding);
    assert.equal((await current.research.searchEpisodes(context(), { query: "visible phrase", scope: "all", sort: "relevance", limit: 1 })).length, 1);
    db.prepare("UPDATE research_sources SET processing_revision_hash=?").run(`sha256:${"9".repeat(64)}`);
    db.prepare("UPDATE vector_documents SET processing_revision_hash=?,processing_visibility_state='visible'").run(`sha256:${"9".repeat(64)}`);
    assert.deepEqual(await current.research.searchEpisodes(context(), { query: "visible phrase", scope: "all", sort: "relevance", limit: 1 }), []);
    assert.deepEqual(await current.vectors.getByVectorIds(context(), ["t/7:speech:0010"]), []);
    db.prepare("UPDATE research_sources SET processing_revision_hash=NULL").run();
    db.prepare("UPDATE vector_documents SET processing_revision_hash=NULL,processing_visibility_state=NULL").run();
    const ingest = await store.createOrGetRequest(await input({ requestId: "episode-ingest", operation: "episode_ingest", entityType: "episode", entityId: "7", snapshot: { episodeId: "7", source: "synthetic" }, desiredPublication: "draft" }));
    assert.equal((await current.research.searchEpisodes(context(), { query: "visible phrase", scope: "all", sort: "relevance", limit: 1 })).length, 1);
    const replacement = await store.createOrGetRequest(await input({ requestId: "transcript-replace", operation: "transcript_replace", entityType: "transcript", entityId: "7", snapshot: { episodeId: "7", transcript: "replacement" }, desiredPublication: "draft" }));
    assert.equal(replacement.generation, 2);
    assert.equal(db.prepare("SELECT superseded_by_request_id FROM processing_requests WHERE request_id=?").get(ingest.requestId).superseded_by_request_id, replacement.requestId);
    db.prepare("UPDATE processing_heads SET authenticated_corpus_visibility='visible',authenticated_corpus_request_id=?,authenticated_corpus_revision_hash=? WHERE aggregate_type='episode' AND aggregate_id='7'").run(replacement.requestId, replacement.revisionHash);
    const canonical = await current.research.listEpisodes(context(), { scope: "all", sort: "date_desc", limit: 1 });
    assert.equal(canonical.length, 1);
    assert.deepEqual([canonical[0].hasTranscript, canonical[0].hasIntelligence, canonical[0].hasVectors], [false, false, false]);
    seedResearch(db, { key: "transcript_segments:segment-7-12", text: "new visible phrase", revision: replacement.revisionHash });
    db.prepare("UPDATE research_sources SET sequence_number=12 WHERE source_key LIKE '%-12'").run();
    const visible = await current.research.searchEpisodes(context(), { query: "visible phrase", scope: "all", sort: "relevance", limit: 1 });
    assert.deepEqual(visible.map((row) => row.trackId), ["7"]);
    assert.equal(visible[0].snippet, "new visible phrase");
    db.prepare("UPDATE research_sources SET processing_revision_hash=? WHERE source_key LIKE '%-12'").run(`sha256:${"8".repeat(64)}`);
    assert.deepEqual(await current.research.searchEpisodes(context(), { query: "visible phrase", scope: "all", sort: "relevance", limit: 1 }), []);
    db.prepare("UPDATE research_sources SET processing_revision_hash=? WHERE source_key LIKE '%-12'").run(replacement.revisionHash);
    assert.deepEqual(await current.vectors.getByVectorIds(context(), ["t/7:speech:0010"]), []);
  } finally { db.close(); }
});

test("synthetic hidden and erased episode heads deny canonical, research, and vector lanes before cleanup", async () => {
  const db = await fixture();
  try {
    seedResearch(db); seedEpisodeVector(db);
    const binding = new Binding(db);
    const store = new D1ProcessingStateStore({ db: binding, now: () => at });
    await store.createOrGetRequest(await input({ requestId: "episode-head", operation: "episode_ingest", entityType: "episode", entityId: "7", snapshot: { episodeId: "7" }, desiredPublication: "draft" }));
    const current = readers(binding);
    for (const state of ["hidden", "erased"]) {
      db.prepare("UPDATE processing_heads SET authenticated_corpus_visibility=?,authenticated_corpus_request_id=NULL,authenticated_corpus_revision_hash=NULL WHERE aggregate_type='episode' AND aggregate_id='7'").run(state);
      assert.deepEqual(await current.research.searchEpisodes(context(), { query: "visible phrase", scope: "all", sort: "relevance", limit: 10 }), []);
      assert.deepEqual(await current.research.listEpisodes(context(), { scope: "all", sort: "date_desc", limit: 10 }), []);
      assert.deepEqual(await current.vectors.getByVectorIds(context(), ["t/7:speech:0010"]), []);
      if (state === "hidden") db.exec("DROP TRIGGER p6_processing_corpus_erase_after_head_update");
    }
  } finally { db.close(); }
});

test("real article unpublish retains authenticated corpus and real erase hides it", async () => {
  const db = await fixture();
  try {
    seedArticleVector(db);
    const binding = new Binding(db);
    const store = new D1ProcessingStateStore({ db: binding, now: () => at });
    const vectors = readers(binding).vectors;
    const unpublish = await store.createOrGetRequest(await input({ requestId: "article-unpublish", operation: "public_unpublish", entityType: "article", entityId: "pastorwood:10", snapshot: { articleId: "pastorwood:10", intent: "unpublished" }, desiredPublication: "unpublished" }));
    await store.transition({ requestId: unpublish.requestId, workflow: "content", generation: unpublish.generation, from: "public_unpublish_requested", to: "public_hidden", stageName: "hide-public" });
    assert.equal((await vectors.getByVectorIds(context(), ["a/10:devotional:0000"])).length, 1);
    const erase = await store.createOrGetRequest(await input({ requestId: "article-erase", operation: "corpus_erase", entityType: "article", entityId: "pastorwood:10", snapshot: { articleId: "pastorwood:10", intent: "erase" }, desiredPublication: "archived", corpusEraseApproved: true }));
    await store.transition({ requestId: erase.requestId, workflow: "content", generation: erase.generation, from: "corpus_erase_requested", to: "corpus_hidden", stageName: "hide-corpus" });
    assert.deepEqual(await vectors.getByVectorIds(context(), ["a/10:devotional:0000"]), []);
  } finally { db.close(); }
});

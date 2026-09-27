import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createProcessingIdempotencyKey, createProcessingRevisionHash } from "@aic/contracts";
import { D1ProcessingStateStore } from "@aic/db";
import { D1ContentIndexRepository } from "../src/repository.ts";
import { runContentIndexWorkflow } from "../src/workflow.ts";

const migrations = new URL("../../../migrations/d1/", import.meta.url);
const at = "2026-09-21T12:00:00.000Z";
const hash = (value) => createHash("sha256").update(value).digest("hex");

class Statement {
  constructor(binding, sql, values = []) { this.binding = binding; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.binding, this.sql, values); }
  async first() { return this.binding.db.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { success: true, results: this.binding.db.prepare(this.sql).all(...this.values) }; }
  async run() {
    const before = this.binding.db.prepare("SELECT total_changes() count").get().count;
    const result = this.binding.db.prepare(this.sql).run(...this.values);
    const after = this.binding.db.prepare("SELECT total_changes() count").get().count;
    return { success: true, meta: { changes: after - before, last_row_id: Number(result.lastInsertRowid) } };
  }
}

class Binding {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

async function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(await readFile(new URL(file, migrations), "utf8"));
  }
  db.prepare(`INSERT INTO articles (
    article_id,source_type,source_post_id,slug,title,body_html,plain_text,
    publish_date,status,visibility,canonical_url,content_hash,created_at,updated_at,
    published_at,current_revision_id,published_revision_id
  ) VALUES ('pastorwood:10','pastorwood','10','ten','Old','Old','Old','2026-09-20',
    'Published','public','https://pastorwood.org/ten',?,?,?,?,?,?)`
  ).run(hash("Old"), at, at, "2026-09-20T12:00:00.000Z", "revision-new", "revision-old");
  db.prepare(`INSERT INTO editorial_revisions (
    revision_id,entity_type,entity_id,revision_number,title,plain_text,status,
    created_by,created_at,snapshot_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run("revision-old", "article", "pastorwood:10", 1, "Old", "Old", "Published", "test", at, JSON.stringify({ kind: "article", documentId: "pastorwood:10" }));
  db.prepare(`INSERT INTO editorial_revisions (
    revision_id,entity_type,entity_id,revision_number,title,plain_text,status,
    created_by,created_at,snapshot_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run("revision-new", "article", "pastorwood:10", 2, "New", "New", "Draft", "test", at, JSON.stringify({ kind: "article", documentId: "pastorwood:10" }));
  db.prepare(`INSERT INTO pastorwood_post_chunks (
    custom_id,record_id,post_id,article_id,source_type,title,publish_date,chunk_index,
    text,content_hash,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("pastorwood_devotional:10:0001", "record:old", "10", "pastorwood:10", "pastorwood_devotional", "Old", "2026-09-20", 1, "Old stale text", hash("Old stale text"), at, at);
  const oldRevision = `sha256:${"9".repeat(64)}`;
  db.prepare(`INSERT INTO vector_documents (
    vector_id,source_table,source_custom_id,source_type,source_id,content_subtype,
    content_hash,chunk_index,published_day,embedding_model,dimensions,vector_digest,
    metadata_digest,status,updated_at,record_id,source_field,authoritative_text,
    metadata_json,processing_revision_hash,processing_visibility_state
  ) VALUES (?,?,?,?,?,?,?,?,?,'text-embedding-3-small',1536,?,?,'verified',?,?,?,?,?,?,?)`
  ).run("a/pastorwood_devotional:10:0001", "pastorwood_post_chunks", "pastorwood_devotional:10:0001", "article", "pastorwood:10", "pastorwood_devotional", hash("Old stale text"), 1, 20260920, hash("vector"), hash("metadata"), at, "record:old", "text", "Old stale text", "{}", oldRevision, "visible");
  return db;
}

function vectors() {
  const visible = new Map([["a/pastorwood_devotional:10:0001", { id: "a/pastorwood_devotional:10:0001", values: new Float32Array(1536), metadata: {} }]]);
  const pending = new Map();
  const deletes = new Set();
  let ordinal = 0;
  return {
    visible,
    async upsert(records) { records.forEach((record) => pending.set(record.id, record)); return { mutationId: `upsert-${ordinal += 1}` }; },
    async deleteByIds(ids) { ids.forEach((id) => deletes.add(id)); return { mutationId: `delete-${ordinal += 1}` }; },
    async getByIds(ids) { return ids.flatMap((id) => visible.has(id) ? [visible.get(id)] : []); },
    async queryById(id) { const row = visible.get(id); return { count: row ? 1 : 0, matches: row ? [{ id, metadata: row.metadata, score: 1 }] : [] }; },
    settle() { for (const [id, row] of pending) visible.set(id, row); pending.clear(); for (const id of deletes) visible.delete(id); deletes.clear(); },
  };
}

const embeddings = {
  async embedBatch(_context, input) {
    return input.inputs.map(({ customId }) => ({ customId, values: Array(1536).fill(0.5), dimensions: 1536, model: "text-embedding-3-small" }));
  },
};

function steps(vectorize) {
  return {
    async do(_name, configOrCallback, maybeCallback) { return (maybeCallback ?? configOrCallback)(); },
    async sleep() { vectorize.settle(); },
  };
}

async function processingInput(overrides) {
  const revisionHash = await createProcessingRevisionHash(overrides.snapshot);
  return {
    requestId: overrides.requestId,
    workflow: "content",
    entityType: "article",
    entityId: "pastorwood:10",
    revisionId: overrides.revisionId,
    revisionHash,
    operation: overrides.operation,
    idempotencyKey: await createProcessingIdempotencyKey({ operation: overrides.operation, entityType: "article", entityId: "pastorwood:10", revisionHash }),
    snapshot: overrides.snapshot,
    desiredPublication: overrides.desiredPublication,
    requestedBy: "test",
    correlationId: overrides.requestId,
  };
}

test("D1 replacement atomically publishes after proof, then public unpublish retains authenticated corpus", async () => {
  const db = await fixture();
  try {
    const binding = new Binding(db);
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => at });
    const repository = new D1ContentIndexRepository({ db: binding, now: () => at });
    const vectorize = vectors();
    const snapshot = {
      articleId: "pastorwood:10",
      revisionId: "revision-new",
      contentType: "pastorwood_devotional",
      title: "New",
      body: "New authoritative article body.",
      canonicalUrl: "https://pastorwood.org/ten",
      publishedAt: at,
      publicationIntent: "published",
    };
    const replacement = await stateStore.createOrGetRequest(await processingInput({ requestId: "replace-10", revisionId: "revision-new", operation: "article_replace", desiredPublication: "published", snapshot }));
    await runContentIndexWorkflow(steps(vectorize), { requestId: replacement.requestId, revisionHash: replacement.revisionHash }, {
      repository, stateStore, embeddings, vectorize, now: () => new Date(at),
    });

    const article = db.prepare("SELECT status,published_revision_id,plain_text FROM articles WHERE article_id='pastorwood:10'").get();
    assert.deepEqual({ ...article }, { status: "Published", published_revision_id: "revision-new", plain_text: "New authoritative article body." });
    const head = db.prepare("SELECT published_revision_hash,authenticated_corpus_revision_hash,public_visibility,authenticated_corpus_visibility FROM processing_heads WHERE aggregate_type='article' AND aggregate_id='pastorwood:10'").get();
    assert.deepEqual({ ...head }, { published_revision_hash: replacement.revisionHash, authenticated_corpus_revision_hash: replacement.revisionHash, public_visibility: "visible", authenticated_corpus_visibility: "visible" });
    assert.equal(db.prepare("SELECT state FROM processing_requests WHERE request_id='replace-10'").get().state, "published");
    assert.deepEqual({ ...db.prepare("SELECT status,processing_visibility_state FROM vector_documents WHERE vector_id='a/pastorwood_devotional:10:0001'").get() }, { status: "tombstoned", processing_visibility_state: "deleted" });
    assert.equal(db.prepare("SELECT count(*) count FROM vector_documents WHERE processing_revision_hash=? AND processing_visibility_state='visible'").get(replacement.revisionHash).count, 1);
    assert.equal(db.prepare("SELECT count(*) count FROM search_publications WHERE published_revision_id='revision-new'").get().count, 1);

    const hideSnapshot = { articleId: "pastorwood:10", revisionId: "revision-hide", publicationIntent: "unpublished" };
    const hide = await stateStore.createOrGetRequest(await processingInput({ requestId: "unpublish-10", revisionId: "revision-hide", operation: "public_unpublish", desiredPublication: "unpublished", snapshot: hideSnapshot }));
    const vectorCount = vectorize.visible.size;
    await runContentIndexWorkflow(steps(vectorize), { requestId: hide.requestId, revisionHash: hide.revisionHash }, { repository, stateStore, embeddings, vectorize });

    const hiddenHead = db.prepare("SELECT public_visibility,authenticated_corpus_visibility,authenticated_corpus_revision_hash FROM processing_heads WHERE aggregate_type='article' AND aggregate_id='pastorwood:10'").get();
    assert.deepEqual({ ...hiddenHead }, { public_visibility: "hidden", authenticated_corpus_visibility: "visible", authenticated_corpus_revision_hash: replacement.revisionHash });
    assert.equal(db.prepare("SELECT status FROM articles WHERE article_id='pastorwood:10'").get().status, "Draft");
    assert.equal(db.prepare("SELECT state FROM processing_requests WHERE request_id='unpublish-10'").get().state, "unpublished");
    assert.equal(vectorize.visible.size, vectorCount, "public lifecycle must not delete authenticated-corpus vectors");
  } finally {
    db.close();
  }
});

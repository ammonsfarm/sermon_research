import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createProcessingIdempotencyKey,
  createProcessingRevisionHash,
  isAuthenticatedCorpusVisible,
} from "@aic/contracts";
import { D1ProcessingStateStore } from "../src/index.ts";

const migrationDirectory = new URL("../../../migrations/d1/", import.meta.url);
const now = "2026-09-05T12:00:00.000000Z";
const leaseExpiry = "2026-09-05T12:31:01.000000Z";

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) database.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
  return database;
}

class SqliteD1Statement {
  constructor(binding, sql, values = []) {
    this.binding = binding;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new SqliteD1Statement(this.binding, this.sql, values);
  }

  async first() {
    const row = this.binding.database.prepare(this.sql).get(...this.values) ?? null;
    await this.binding.afterFirstRead(this.sql);
    return row;
  }

  async all() {
    return { success: true, results: this.binding.database.prepare(this.sql).all(...this.values) };
  }

  async run() {
    const before = this.binding.database.prepare("SELECT total_changes() AS count").get().count;
    const result = this.binding.database.prepare(this.sql).run(...this.values);
    const after = this.binding.database.prepare("SELECT total_changes() AS count").get().count;
    return { success: true, meta: { changes: after - before, last_row_id: Number(result.lastInsertRowid) } };
  }
}

class TransactionalSqliteD1Binding {
  constructor(database) {
    this.database = database;
    this.batchCalls = 0;
    this.beforeNextBatch = null;
    this.firstReadBarrier = null;
    this.batchTail = Promise.resolve();
  }

  prepare(sql) {
    return new SqliteD1Statement(this, sql);
  }

  pauseAfterReadsContaining(fragment, count) {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    this.firstReadBarrier = { fragment, count, arrived: 0, promise, release };
  }

  async afterFirstRead(sql) {
    const barrier = this.firstReadBarrier;
    if (!barrier || !sql.includes(barrier.fragment)) return;
    barrier.arrived += 1;
    if (barrier.arrived === barrier.count) {
      this.firstReadBarrier = null;
      barrier.release();
    }
    await barrier.promise;
  }

  async batch(statements) {
    this.batchCalls += 1;
    let release;
    const previous = this.batchTail;
    this.batchTail = new Promise((resolve) => { release = resolve; });
    await previous;
    const before = this.beforeNextBatch;
    this.beforeNextBatch = null;
    try {
      if (before) before();
      this.database.exec("BEGIN IMMEDIATE");
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      release();
    }
  }
}

async function input({
  requestId,
  operation = "article_replace",
  entityType = "article",
  entityId = "pastorwood:42",
  snapshot = { articleId: entityId, title: requestId },
  desiredPublication = "published",
  idempotencyKey,
  revisionHash,
  corpusEraseApproved,
}) {
  const frozenRevisionHash = revisionHash ?? await createProcessingRevisionHash(snapshot);
  const frozenIdempotencyKey = idempotencyKey ?? await createProcessingIdempotencyKey({
    operation,
    entityType,
    entityId,
    revisionHash: frozenRevisionHash,
  });
  return {
    requestId,
    workflow: operation === "episode_ingest" ? "episode" : "content",
    entityType,
    entityId,
    revisionId: `revision-${requestId}`,
    revisionHash: frozenRevisionHash,
    operation,
    idempotencyKey: frozenIdempotencyKey,
    snapshot,
    desiredPublication,
    requestedBy: "operator-42",
    correlationId: `correlation-${requestId}`,
    ...(corpusEraseApproved === undefined ? {} : { corpusEraseApproved }),
  };
}

function createStore(database) {
  const binding = new TransactionalSqliteD1Binding(database);
  return { binding, store: new D1ProcessingStateStore({ db: binding, now: () => now }) };
}

async function expectProcessingError(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

test("same idempotency and snapshot replays one request while a changed snapshot conflicts", async () => {
  const database = await migratedDatabase();
  try {
    const { binding, store } = createStore(database);
    const firstInput = await input({ requestId: "request-duplicate" });
    const first = await store.createOrGetRequest(firstInput);
    const duplicate = await store.createOrGetRequest(firstInput);
    assert.deepEqual(first, {
      requestId: "request-duplicate",
      workflow: "content",
      aggregate: { type: "article", id: "pastorwood:42" },
      revisionHash: firstInput.revisionHash,
      generation: 1,
      state: "revision_recorded",
      duplicate: false,
    });
    assert.deepEqual(duplicate, { ...first, duplicate: true });
    await expectProcessingError(
      store.createOrGetRequest({ ...firstInput, snapshot: { articleId: "pastorwood:42", title: "changed" } }),
      "identity_conflict",
    );
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_requests WHERE contract_version = 'p6-v1'").get().count, 1);
    assert.equal(binding.batchCalls, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_heads WHERE head_request_id = ?").get(first.requestId).count, 1);

    await store.claimMutationLease({ requestId: first.requestId, generation: 1, leaseToken: "replay-lease", expiresAt: leaseExpiry });
    const replayWithLease = await store.createOrGetRequest(firstInput);
    assert.equal(replayWithLease.duplicate, true);
    assert.deepEqual(
      { ...database.prepare("SELECT mutation_owner_request_id, mutation_lease_token, mutation_lease_expires_at FROM processing_heads WHERE head_request_id = ?").get(first.requestId) },
      { mutation_owner_request_id: first.requestId, mutation_lease_token: "replay-lease", mutation_lease_expires_at: leaseExpiry },
    );
  } finally {
    database.close();
  }
});

test("same-key allocation races converge while distinct revisions retain stale-generation conflicts", async () => {
  const database = await migratedDatabase();
  try {
    const { binding, store } = createStore(database);
    const duplicateInput = await input({ requestId: "request-racing-duplicate" });
    binding.pauseAfterReadsContaining("SELECT generation FROM processing_heads", 2);
    const duplicateResults = await Promise.allSettled([
      store.createOrGetRequest(duplicateInput),
      store.createOrGetRequest(duplicateInput),
    ]);
    assert.deepEqual(duplicateResults.map(({ status }) => status), ["fulfilled", "fulfilled"]);
    assert.deepEqual(
      duplicateResults.map(({ value }) => value.generation),
      [1, 1],
    );
    assert.equal(duplicateResults.filter(({ value }) => value.duplicate).length, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_requests WHERE request_id = ?").get(duplicateInput.requestId).count, 1);

    const firstDistinct = await input({
      requestId: "request-racing-distinct-a",
      entityId: "pastorwood:84",
      snapshot: { articleId: "pastorwood:84", revision: 1 },
    });
    const secondDistinct = await input({
      requestId: "request-racing-distinct-b",
      entityId: "pastorwood:84",
      snapshot: { articleId: "pastorwood:84", revision: 2 },
    });
    binding.pauseAfterReadsContaining("SELECT generation FROM processing_heads", 2);
    const distinctResults = await Promise.allSettled([
      store.createOrGetRequest(firstDistinct),
      store.createOrGetRequest(secondDistinct),
    ]);
    assert.equal(distinctResults.filter(({ status }) => status === "fulfilled").length, 1);
    const rejection = distinctResults.find(({ status }) => status === "rejected");
    assert.equal(rejection.reason.code, "stale_generation");
  } finally {
    database.close();
  }
});

test("new episode and transcript revisions share one head and fence the running ingest", async () => {
  const database = await migratedDatabase();
  try {
    const { store } = createStore(database);
    const ingestInput = await input({
      requestId: "request-ingest",
      operation: "episode_ingest",
      entityType: "episode",
      entityId: "sa_42",
      snapshot: { episodeId: "sa_42", source: "synthetic" },
      desiredPublication: "draft",
    });
    const ingest = await store.createOrGetRequest(ingestInput);
    await store.createOrGetInitialExecution(ingest.requestId);
    const transcriptInput = await input({
      requestId: "request-transcript",
      operation: "transcript_replace",
      entityType: "transcript",
      entityId: "sa_42",
      snapshot: { episodeId: "sa_42", transcript: "replacement" },
    });
    const transcript = await store.createOrGetRequest(transcriptInput);
    assert.equal(ingest.generation, 1);
    assert.equal(transcript.generation, 2);
    assert.deepEqual(transcript.aggregate, { type: "episode", id: "sa_42" });
    const head = database.prepare("SELECT * FROM processing_heads WHERE aggregate_type = 'episode' AND aggregate_id = 'sa_42'").get();
    assert.equal(head.head_request_id, "request-transcript");
    assert.equal(head.generation, 2);
    const old = database.prepare("SELECT * FROM processing_requests WHERE request_id = 'request-ingest'").get();
    assert.equal(old.superseded_by_request_id, "request-transcript");
    assert.equal(old.cancel_requested_at, now);
    await expectProcessingError(store.assertCurrentHead("request-ingest", 1), "superseded");
    await expectProcessingError(
      store.claimMutationLease({ requestId: "request-ingest", generation: 1, leaseToken: "old-lease", expiresAt: leaseExpiry }),
      "superseded",
    );
  } finally {
    database.close();
  }
});

test("state transitions are guarded, sanitize errors, and resume retry-required work with a new identity", async () => {
  const database = await migratedDatabase();
  try {
    const { store } = createStore(database);
    const request = await store.createOrGetRequest(await input({ requestId: "request-resume" }));
    const [initial, initialReplayA] = await Promise.all([
      store.createOrGetInitialExecution(request.requestId),
      store.createOrGetInitialExecution(request.requestId),
    ]);
    assert.deepEqual(initialReplayA, initial);
    assert.equal(initial.resumeSequence, 0);
    assert.match(initial.workflowInstanceId, /^p6a-[0-9a-f]{64}-0$/u);
    await expectProcessingError(store.transition({
      requestId: request.requestId,
      workflow: "content",
      generation: 1,
      from: "revision_recorded",
      to: "published",
      stageName: "illegal",
    }), "invalid_state_transition");
    await store.transition({
      requestId: request.requestId,
      workflow: "content",
      generation: 1,
      from: "revision_recorded",
      to: "chunking",
      stageName: "chunk",
    });
    await store.transition({
      requestId: request.requestId,
      workflow: "content",
      generation: 1,
      from: "chunking",
      to: "retry_required",
      stageName: "embed",
      errorCode: "provider_timeout",
      errorClass: "transient_dependency",
      errorMessage: `safe:${"x".repeat(2_500)}`,
    });
    assert.equal(database.prepare("SELECT length(last_error_message) AS length FROM processing_requests WHERE request_id = ?").get(request.requestId).length, 2_000);
    const resumed = await store.resume(request.requestId, "operator-43", "provider repaired");
    assert.equal(resumed.requestId, request.requestId);
    assert.equal(resumed.resumeSequence, 1);
    assert.notEqual(resumed.workflowInstanceId, initial.workflowInstanceId);
    assert.match(resumed.workflowInstanceId, /^p6a-[0-9a-f]{64}-1$/u);
    const replay = await store.transition({
      requestId: request.requestId,
      workflow: "content",
      generation: 1,
      from: "revision_recorded",
      to: "chunking",
      stageName: "chunk",
    });
    assert.equal(replay.replayed, true);
    assert.equal(database.prepare("SELECT state FROM processing_requests WHERE request_id = ?").get(request.requestId).state, "chunking");
    const retried = await store.transition({
      requestId: request.requestId,
      workflow: "content",
      generation: 1,
      from: "chunking",
      to: "embedding",
      stageName: "embed",
    });
    assert.equal(retried.replayed, false);
    assert.deepEqual(
      { ...database.prepare("SELECT status, attempt_count, error_code, error_class, error_message FROM processing_stage_runs WHERE request_id = ? AND stage_name = 'embed'").get(request.requestId) },
      { status: "complete", attempt_count: 2, error_code: null, error_class: null, error_message: "" },
    );
    await store.transition({
      requestId: request.requestId,
      workflow: "content",
      generation: 1,
      from: "embedding",
      to: "indexing",
      stageName: "index",
    });
    const persisted = database.prepare("SELECT revision_hash, idempotency_key, resume_sequence, state FROM processing_requests WHERE request_id = ?").get(request.requestId);
    assert.equal(persisted.revision_hash, (await input({ requestId: "request-resume" })).revisionHash);
    assert.equal(persisted.resume_sequence, 1);
    assert.equal(persisted.state, "indexing");
  } finally {
    database.close();
  }
});

test("accepted vector batches cannot publish until visibility and publication CAS succeeds only once", async () => {
  const database = await migratedDatabase();
  try {
    const { store } = createStore(database);
    const request = await store.createOrGetRequest(await input({ requestId: "request-publish" }));
    await store.claimMutationLease({ requestId: request.requestId, generation: 1, leaseToken: "publish-lease", expiresAt: leaseExpiry });
    const digest = await createProcessingRevisionHash({ ids: ["a/chunk-42"] });
    await store.recordVectorAcceptance({
      requestId: request.requestId,
      generation: 1,
      leaseToken: "publish-lease",
      batchOrdinal: 0,
      operation: "upsert",
      expectedIdsDigest: digest,
      expectedCount: 1,
      targetRevisionHash: request.revisionHash,
      providerMutationId: "mutation-accepted",
    });
    assert.equal(database.prepare("SELECT visibility_state FROM processing_vector_batches WHERE request_id = ?").get(request.requestId).visibility_state, "accepted");
    await store.transition({ requestId: request.requestId, workflow: "content", generation: 1, from: "revision_recorded", to: "chunking", stageName: "chunk" });
    await store.transition({ requestId: request.requestId, workflow: "content", generation: 1, from: "chunking", to: "embedding", stageName: "embed" });
    await store.transition({ requestId: request.requestId, workflow: "content", generation: 1, from: "embedding", to: "indexing", stageName: "index" });
    await store.transition({ requestId: request.requestId, workflow: "content", generation: 1, from: "indexing", to: "index_visibility_pending", stageName: "wait-index" });
    await store.transition({ requestId: request.requestId, workflow: "content", generation: 1, from: "index_visibility_pending", to: "stale_vector_deleting", stageName: "stale" });
    await store.transition({ requestId: request.requestId, workflow: "content", generation: 1, from: "stale_vector_deleting", to: "delete_visibility_pending", stageName: "wait-delete" });
    await store.transition({ requestId: request.requestId, workflow: "content", generation: 1, from: "delete_visibility_pending", to: "indexed", stageName: "indexed" });
    await store.transition({ requestId: request.requestId, workflow: "content", generation: 1, from: "indexed", to: "publish_ready", stageName: "ready" });
    await expectProcessingError(store.transition({
      requestId: request.requestId,
      workflow: "content",
      generation: 1,
      from: "publish_ready",
      to: "published",
      stageName: "direct-publish-bypass",
    }), "invalid_state_transition");
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_stage_runs WHERE request_id = ? AND stage_name = 'direct-publish-bypass'").get(request.requestId).count, 0);
    await expectProcessingError(store.finalizePublication({ requestId: request.requestId, generation: 1, to: "published", expectedVectorBatchCount: 1 }), "visibility_pending");
    await store.recordVectorVisibility({
      requestId: request.requestId,
      generation: 1,
      leaseToken: "publish-lease",
      batchOrdinal: 0,
      operation: "upsert",
      processedUpToMutation: "mutation-accepted",
    });
    await store.finalizePublication({ requestId: request.requestId, generation: 1, to: "published", expectedVectorBatchCount: 1 });
    const head = database.prepare("SELECT * FROM processing_heads WHERE head_request_id = ?").get(request.requestId);
    assert.equal(head.public_visibility, "visible");
    assert.equal(head.published_revision_hash, request.revisionHash);
    assert.equal(head.authenticated_corpus_visibility, "visible");
    await expectProcessingError(store.finalizePublication({ requestId: request.requestId, generation: 1, to: "published", expectedVectorBatchCount: 1 }), "publication_conflict");
  } finally {
    database.close();
  }
});

test("draft publication intent cannot bypass guarded terminal finalization", async () => {
  const database = await migratedDatabase();
  try {
    const { store } = createStore(database);
    const request = await store.createOrGetRequest(await input({
      requestId: "request-draft-bypass",
      entityId: "pastorwood:91",
      snapshot: { articleId: "pastorwood:91", intent: "draft" },
      desiredPublication: "draft",
    }));
    for (const [from, to, stageName] of [
      ["revision_recorded", "chunking", "chunk"],
      ["chunking", "embedding", "embed"],
      ["embedding", "indexing", "index"],
      ["indexing", "index_visibility_pending", "wait-index"],
      ["index_visibility_pending", "stale_vector_deleting", "stale"],
      ["stale_vector_deleting", "delete_visibility_pending", "wait-delete"],
      ["delete_visibility_pending", "indexed", "indexed"],
      ["indexed", "publish_ready", "ready"],
    ]) await store.transition({ requestId: request.requestId, workflow: "content", generation: 1, from, to, stageName });
    await expectProcessingError(store.transition({
      requestId: request.requestId,
      workflow: "content",
      generation: 1,
      from: "publish_ready",
      to: "published",
      stageName: "direct-draft-publish",
    }), "invalid_state_transition");
    await expectProcessingError(store.finalizePublication({
      requestId: request.requestId,
      generation: 1,
      to: "published",
      expectedVectorBatchCount: 0,
    }), "publication_conflict");
    assert.deepEqual(
      { ...database.prepare("SELECT state, completed_at FROM processing_requests WHERE request_id = ?").get(request.requestId) },
      { state: "publish_ready", completed_at: null },
    );
    assert.deepEqual(
      { ...database.prepare("SELECT published_request_id, public_visibility FROM processing_heads WHERE head_request_id = ?").get(request.requestId) },
      { published_request_id: null, public_visibility: "hidden" },
    );
  } finally {
    database.close();
  }
});

test("unpublish and archive hide public content while retaining authenticated corpus state", async () => {
  const database = await migratedDatabase();
  try {
    database.prepare(
      `INSERT INTO articles
        (article_id, source_type, source_post_id, slug, title, status, visibility,
         created_at, updated_at, published_at)
       VALUES ('pastorwood:42', 'pastorwood', '42', 'visible-42', 'Visible',
               'Published', 'public', ?, ?, ?)`,
    ).run(now, now, now);
    const { store } = createStore(database);
    const unpublish = await store.createOrGetRequest(await input({
      requestId: "request-unpublish",
      operation: "public_unpublish",
      snapshot: { articleId: "pastorwood:42", intent: "unpublished" },
      desiredPublication: "unpublished",
    }));
    await store.transition({ requestId: unpublish.requestId, workflow: "content", generation: 1, from: "public_unpublish_requested", to: "public_hidden", stageName: "hide-public" });
    const hiddenArticle = database.prepare("SELECT status, published_at FROM articles WHERE article_id = 'pastorwood:42'").get();
    assert.equal(hiddenArticle.status, "Draft");
    assert.equal(hiddenArticle.published_at, null);
    const hiddenHead = database.prepare("SELECT public_visibility, authenticated_corpus_visibility FROM processing_heads WHERE head_request_id = ?").get(unpublish.requestId);
    assert.deepEqual({ ...hiddenHead }, { public_visibility: "hidden", authenticated_corpus_visibility: "inherited" });
    await store.finalizePublication({ requestId: unpublish.requestId, generation: 1, to: "unpublished", expectedVectorBatchCount: 0 });

    database.prepare("UPDATE articles SET status = 'Published', published_at = ? WHERE article_id = 'pastorwood:42'").run(now);
    const archive = await store.createOrGetRequest(await input({
      requestId: "request-archive",
      operation: "public_archive",
      snapshot: { articleId: "pastorwood:42", intent: "archived" },
      desiredPublication: "archived",
    }));
    await store.transition({ requestId: archive.requestId, workflow: "content", generation: 2, from: "public_archive_requested", to: "public_hidden", stageName: "hide-public" });
    await store.finalizePublication({ requestId: archive.requestId, generation: 2, to: "archived", expectedVectorBatchCount: 0 });
    assert.equal(database.prepare("SELECT status FROM articles WHERE article_id = 'pastorwood:42'").get().status, "Archived");
    assert.equal(database.prepare("SELECT authenticated_corpus_visibility FROM processing_heads WHERE head_request_id = ?").get(archive.requestId).authenticated_corpus_visibility, "inherited");
  } finally {
    database.close();
  }
});

test("public hiding rolls back when the canonical public row is missing", async () => {
  const database = await migratedDatabase();
  try {
    const { store } = createStore(database);
    const request = await store.createOrGetRequest(await input({
      requestId: "request-missing-unpublish",
      entityId: "pastorwood:404",
      operation: "public_unpublish",
      snapshot: { articleId: "pastorwood:404", intent: "unpublished" },
      desiredPublication: "unpublished",
    }));
    await expectProcessingError(store.transition({
      requestId: request.requestId,
      workflow: "content",
      generation: 1,
      from: "public_unpublish_requested",
      to: "public_hidden",
      stageName: "hide-missing-public-row",
    }), "invalid_state_transition");
    assert.equal(database.prepare("SELECT state FROM processing_requests WHERE request_id = ?").get(request.requestId).state, "public_unpublish_requested");
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_stage_runs WHERE request_id = ?").get(request.requestId).count, 0);
  } finally {
    database.close();
  }
});

test("publication CAS rechecks batch completeness inside the guarded mutation", async () => {
  const database = await migratedDatabase();
  try {
    const { binding, store } = createStore(database);
    const request = await store.createOrGetRequest(await input({ requestId: "request-publication-race", entityId: "pastorwood:99", snapshot: { articleId: "pastorwood:99" } }));
    database.prepare("UPDATE processing_requests SET state = 'publish_ready' WHERE request_id = ?").run(request.requestId);
    database.prepare(
      `INSERT INTO processing_vector_batches
        (request_id, batch_ordinal, operation, generation, expected_ids_digest,
         expected_count, target_revision_hash, provider_mutation_id,
         visibility_state, accepted_at, visible_at, created_at, updated_at)
       VALUES (?, 0, 'upsert', 1, ?, 1, ?, 'visible-mutation', 'visible', ?, ?, ?, ?)`,
    ).run(request.requestId, `sha256:${"1".repeat(64)}`, request.revisionHash, now, now, now, now);
    binding.beforeNextBatch = () => database.prepare(
      `INSERT INTO processing_vector_batches
        (request_id, batch_ordinal, operation, generation, expected_ids_digest,
         expected_count, target_revision_hash, provider_mutation_id,
         visibility_state, accepted_at, created_at, updated_at)
       VALUES (?, 1, 'upsert', 1, ?, 1, ?, 'late-mutation', 'accepted', ?, ?, ?)`,
    ).run(request.requestId, `sha256:${"2".repeat(64)}`, request.revisionHash, now, now, now);
    await expectProcessingError(store.finalizePublication({
      requestId: request.requestId,
      generation: 1,
      to: "published",
      expectedVectorBatchCount: 1,
    }), "publication_conflict");
    assert.equal(database.prepare("SELECT published_request_id FROM processing_heads WHERE head_request_id = ?").get(request.requestId).published_request_id, null);
    assert.equal(database.prepare("SELECT state FROM processing_requests WHERE request_id = ?").get(request.requestId).state, "publish_ready");
  } finally {
    database.close();
  }
});

test("corpus erase requires approval, hides corpus before cleanup, and finalizes through a guarded boundary", async () => {
  const database = await migratedDatabase();
  try {
    const { store } = createStore(database);
    const erase = await input({
      requestId: "request-erase",
      operation: "corpus_erase",
      snapshot: { articleId: "pastorwood:42", intent: "erase" },
      desiredPublication: "archived",
    });
    await expectProcessingError(store.createOrGetRequest(erase), "forbidden");
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_requests WHERE contract_version = 'p6-v1'").get().count, 0);

    const approved = await store.createOrGetRequest({
      ...erase,
      requestId: "request-erase-approved",
      revisionId: "revision-request-erase-approved",
      requestedBy: "privacy-operator",
      correlationId: "correlation-request-erase-approved",
      desiredPublication: "archived",
      corpusEraseApproved: true,
    });
    await store.transition({
      requestId: approved.requestId,
      workflow: "content",
      generation: 1,
      from: "corpus_erase_requested",
      to: "corpus_hidden",
      stageName: "hide-authenticated-corpus",
    });
    const hidden = database.prepare(
      "SELECT authenticated_corpus_visibility, authenticated_corpus_revision_hash FROM processing_heads WHERE head_request_id = ?",
    ).get(approved.requestId);
    assert.equal(hidden.authenticated_corpus_visibility, "hidden");
    assert.equal(isAuthenticatedCorpusVisible({ visibility: hidden.authenticated_corpus_visibility, revisionHash: hidden.authenticated_corpus_revision_hash }, approved.revisionHash), false);
    await store.claimMutationLease({
      requestId: approved.requestId,
      generation: 1,
      leaseToken: "erase-lease",
      expiresAt: leaseExpiry,
    });
    await store.recordVectorAcceptance({
      requestId: approved.requestId,
      generation: 1,
      leaseToken: "erase-lease",
      batchOrdinal: 0,
      operation: "delete",
      expectedIdsDigest: await createProcessingRevisionHash({ ids: ["a/erased"] }),
      expectedCount: 1,
      targetRevisionHash: approved.revisionHash,
      providerMutationId: "erase-mutation",
    });
    await store.transition({ requestId: approved.requestId, workflow: "content", generation: 1, from: "corpus_hidden", to: "vector_deleting", stageName: "delete-corpus-vectors" });
    await store.transition({ requestId: approved.requestId, workflow: "content", generation: 1, from: "vector_deleting", to: "delete_visibility_pending", stageName: "wait-corpus-delete" });
    await expectProcessingError(store.transition({
      requestId: approved.requestId,
      workflow: "content",
      generation: 1,
      from: "delete_visibility_pending",
      to: "corpus_erased",
      stageName: "direct-erase-bypass",
    }), "invalid_state_transition");
    await expectProcessingError(store.finalizePublication({
      requestId: approved.requestId,
      generation: 1,
      to: "corpus_erased",
      expectedVectorBatchCount: 1,
    }), "visibility_pending");
    await store.recordVectorVisibility({
      requestId: approved.requestId,
      generation: 1,
      leaseToken: "erase-lease",
      batchOrdinal: 0,
      operation: "delete",
      processedUpToMutation: "erase-mutation",
    });
    await store.finalizePublication({
      requestId: approved.requestId,
      generation: 1,
      to: "corpus_erased",
      expectedVectorBatchCount: 1,
    });
    assert.deepEqual(
      { ...database.prepare("SELECT authenticated_corpus_visibility, authenticated_corpus_request_id, authenticated_corpus_revision_hash FROM processing_heads WHERE head_request_id = ?").get(approved.requestId) },
      { authenticated_corpus_visibility: "erased", authenticated_corpus_request_id: null, authenticated_corpus_revision_hash: null },
    );
    assert.equal(database.prepare("SELECT state FROM processing_requests WHERE request_id = ?").get(approved.requestId).state, "corpus_erased");
    await expectProcessingError(store.finalizePublication({
      requestId: approved.requestId,
      generation: 1,
      to: "corpus_erased",
      expectedVectorBatchCount: 1,
    }), "publication_conflict");
  } finally {
    database.close();
  }
});

test("stale, cancelled, superseded, and zero-change CAS attempts leave no partial mutation", async () => {
  const database = await migratedDatabase();
  try {
    const { store } = createStore(database);
    const cancelled = await store.createOrGetRequest(await input({ requestId: "request-cancelled", entityId: "pastorwood:77", snapshot: { articleId: "pastorwood:77" } }));
    await expectProcessingError(
      store.claimMutationLease({ requestId: cancelled.requestId, generation: 2, leaseToken: "stale-lease", expiresAt: leaseExpiry }),
      "stale_generation",
    );
    await store.transition({ requestId: cancelled.requestId, workflow: "content", generation: 1, from: "revision_recorded", to: "cancelled", stageName: "operator-cancel" });
    await expectProcessingError(store.assertCurrentHead(cancelled.requestId, 1), "cancelled");
    await expectProcessingError(
      store.claimMutationLease({ requestId: cancelled.requestId, generation: 1, leaseToken: "cancelled-lease", expiresAt: leaseExpiry }),
      "cancelled",
    );
    const cancelledHead = database.prepare("SELECT mutation_lease_token, published_request_id FROM processing_heads WHERE head_request_id = ?").get(cancelled.requestId);
    assert.deepEqual({ ...cancelledHead }, { mutation_lease_token: null, published_request_id: null });

    const oldRequest = await store.createOrGetRequest(await input({ requestId: "request-old", entityId: "pastorwood:88", snapshot: { articleId: "pastorwood:88", revision: 1 } }));
    await store.claimMutationLease({ requestId: oldRequest.requestId, generation: 1, leaseToken: "old-live-lease", expiresAt: leaseExpiry });
    const newRequest = await store.createOrGetRequest(await input({ requestId: "request-new", entityId: "pastorwood:88", snapshot: { articleId: "pastorwood:88", revision: 2 } }));
    assert.deepEqual(
      { ...database.prepare("SELECT mutation_owner_request_id, mutation_lease_token, mutation_lease_expires_at FROM processing_heads WHERE head_request_id = ?").get(newRequest.requestId) },
      { mutation_owner_request_id: oldRequest.requestId, mutation_lease_token: "old-live-lease", mutation_lease_expires_at: leaseExpiry },
    );
    await expectProcessingError(store.assertCurrentHead(oldRequest.requestId, 1), "superseded");
    await expectProcessingError(store.claimMutationLease({ requestId: oldRequest.requestId, generation: 1, leaseToken: "old-live-lease", expiresAt: leaseExpiry }), "superseded");
    await expectProcessingError(store.claimMutationLease({ requestId: newRequest.requestId, generation: 2, leaseToken: "new-live-lease", expiresAt: leaseExpiry }), "lease_conflict");
    await expectProcessingError(store.releaseMutationLease({ requestId: oldRequest.requestId, generation: 1, leaseToken: "wrong-token" }), "lease_conflict");
    await expectProcessingError(store.releaseMutationLease({ requestId: newRequest.requestId, generation: 2, leaseToken: "old-live-lease" }), "lease_conflict");
    await expectProcessingError(store.releaseMutationLease({ requestId: oldRequest.requestId, generation: 2, leaseToken: "old-live-lease" }), "lease_conflict");
    await store.releaseMutationLease({ requestId: oldRequest.requestId, generation: 1, leaseToken: "old-live-lease" });
    assert.deepEqual({ ...database.prepare("SELECT head_request_id, generation FROM processing_heads WHERE aggregate_id='pastorwood:88'").get() }, { head_request_id: newRequest.requestId, generation: 2 });
    await store.claimMutationLease({ requestId: newRequest.requestId, generation: 2, leaseToken: "new-live-lease", expiresAt: leaseExpiry });
    await expectProcessingError(store.releaseMutationLease({ requestId: oldRequest.requestId, generation: 1, leaseToken: "old-live-lease" }), "lease_conflict");
    await expectProcessingError(store.recordVectorAcceptance({
      requestId: oldRequest.requestId,
      generation: 1,
      leaseToken: "old-live-lease",
      batchOrdinal: 0,
      operation: "upsert",
      expectedIdsDigest: await createProcessingRevisionHash({ ids: ["a/stale"] }),
      expectedCount: 1,
      targetRevisionHash: oldRequest.revisionHash,
      providerMutationId: "stale-mutation",
    }), "superseded");
    await expectProcessingError(store.finalizePublication({ requestId: oldRequest.requestId, generation: 1, leaseToken: "old-live-lease", to: "published", expectedVectorBatchCount: 0 }), "superseded");
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_vector_batches WHERE request_id = ?").get(oldRequest.requestId).count, 0);

    await expectProcessingError(store.transition({
      requestId: "request-new",
      workflow: "content",
      generation: 2,
      from: "chunking",
      to: "embedding",
      stageName: "wrong-current-state",
    }), "invalid_state_transition");
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_stage_runs WHERE request_id = 'request-new'").get().count, 0);
  } finally {
    database.close();
  }
});

test("episode publication predecessor is checked atomically and preserves unexpired leases", async () => {
  const db = await migratedDatabase();
  try {
    const { binding, store } = createStore(db);
    const draft = await input({ requestId: "publication-draft", operation: "episode_ingest", entityType: "episode", entityId: "9001", desiredPublication: "draft" });
    await store.createOrGetRequest(draft);
    const publication = { ...await input({ requestId: "publication-new", operation: "episode_ingest", entityType: "episode", entityId: "9001" }),
      expectedPredecessor: { requestId: draft.requestId, revisionHash: draft.revisionHash, generation: 1 } };
    db.prepare("UPDATE processing_requests SET state='publish_ready' WHERE request_id=?").run(draft.requestId);
    await store.claimMutationLease({ requestId: draft.requestId, generation: 1, leaseToken: "held", expiresAt: leaseExpiry });
    await expectProcessingError(store.createOrGetRequest(publication), "stale_generation");
    assert.equal(db.prepare("SELECT mutation_lease_token FROM processing_heads").get().mutation_lease_token, "held");
    await store.releaseMutationLease({ requestId: draft.requestId, generation: 1, leaseToken: "held" });
    // Change the predecessor AFTER allocator reads, immediately before its INSERT.
    binding.beforeNextBatch = () => db.prepare("UPDATE processing_requests SET state='retry_required' WHERE request_id=?").run(draft.requestId);
    await expectProcessingError(store.createOrGetRequest(publication), "stale_generation");
    assert.equal(db.prepare("SELECT count(*) AS n FROM processing_requests").get().n, 1);
    db.prepare("UPDATE processing_requests SET state='publish_ready' WHERE request_id=?").run(draft.requestId);
    await store.createOrGetRequest(await input({ requestId: "newer-draft", operation: "episode_ingest", entityType: "episode", entityId: "9001", desiredPublication: "draft" }));
    await expectProcessingError(store.createOrGetRequest(publication), "stale_generation");
    assert.equal(db.prepare("SELECT head_request_id FROM processing_heads").get().head_request_id, "newer-draft");
  } finally { db.close(); }
});

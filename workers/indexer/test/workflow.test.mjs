import assert from "node:assert/strict";
import test from "node:test";

import { ProcessingStateError } from "@aic/contracts";
import { runContentIndexWorkflow } from "../src/workflow.ts";

const HASH = "a".repeat(64);
const REVISION = `sha256:${"b".repeat(64)}`;
const now = new Date("2026-09-21T12:00:00.000Z");

function chunk(id, index, text = `text-${index}`) {
  return {
    id,
    text,
    contentHash: HASH,
    metadata: {
      source_type: "article",
      source_id: "pastorwood:10",
      content_subtype: "pastorwood_devotional",
      published_day: 20260921,
      content_hash: HASH,
      chunk_index: index,
    },
  };
}

async function manifest(ids) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ids.join("\0")));
  return {
    complete: true,
    ids,
    idDigest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    chunks: ids.map((id, index) => chunk(id, index)),
    embeddingBatchCount: 1,
  };
}

function request(overrides = {}) {
  return {
    requestId: "request-1",
    entityId: "pastorwood:10",
    revisionId: "revision-1",
    revisionHash: REVISION,
    generation: 2,
    operation: "article_replace",
    desiredPublication: "published",
    idempotencyKey: `p6:article-index:v1:${"c".repeat(64)}`,
    correlationId: "correlation-1",
    state: "revision_recorded",
    snapshot: {},
    ...overrides,
  };
}

function stateStore(initial = "revision_recorded", options = {}) {
  let state = initial;
  let current = true;
  const accepted = [];
  const visible = [];
  return {
    accepted,
    visible,
    setCurrent(value) { current = value; },
    get state() { return state; },
    async assertCurrentHead() {
      if (!current) throw new ProcessingStateError("superseded", "superseded");
    },
    async transition(command) {
      await this.assertCurrentHead();
      assert.equal(command.from, state);
      state = command.to;
      return { requestId: command.requestId, stageName: command.stageName, batchOrdinal: 0, state, status: "complete", replayed: false };
    },
    async claimMutationLease() { await this.assertCurrentHead(); },
    async releaseMutationLease() { await this.assertCurrentHead(); },
    async recordVectorAcceptance(command) {
      await this.assertCurrentHead();
      accepted.push(command);
      if (options.failAfterAcceptanceOnce && (options.failOperation === undefined || options.failOperation === command.operation)) {
        options.failAfterAcceptanceOnce = false;
        throw new Error("synthetic crash after acceptance receipt");
      }
    },
    async recordVectorVisibility(command) { await this.assertCurrentHead(); visible.push(command); },
    async finalizePublication(command) {
      await this.assertCurrentHead();
      assert.equal(state, "public_hidden");
      assert.equal(command.expectedVectorBatchCount, 0);
      state = command.to;
    },
  };
}

function vectorize({ publishOnSleep = true } = {}) {
  const visible = new Map();
  const pending = new Map();
  const pendingDeletes = new Set();
  let mutations = 0;
  return {
    get mutations() { return mutations; },
    visible,
    pending,
    pendingDeletes,
    async upsert(records) {
      mutations += 1;
      for (const record of records) pending.set(record.id, record);
      return { mutationId: `upsert-${mutations}` };
    },
    async deleteByIds(ids) {
      mutations += 1;
      ids.forEach((id) => pendingDeletes.add(id));
      return { mutationId: `delete-${mutations}` };
    },
    async getByIds(ids) { return ids.flatMap((id) => visible.has(id) ? [visible.get(id)] : []); },
    async queryById(id) {
      const value = visible.get(id);
      return { count: value ? 1 : 0, matches: value ? [{ id, metadata: value.metadata, score: 1 }] : [] };
    },
    settle() {
      if (!publishOnSleep) return;
      for (const [id, record] of pending) visible.set(id, record);
      pending.clear();
      for (const id of pendingDeletes) visible.delete(id);
      pendingDeletes.clear();
    },
  };
}

function steps(onSleep = () => {}) {
  const names = [];
  const outputs = [];
  return {
    names,
    outputs,
    async do(name, configOrCallback, maybeCallback) {
      names.push(name);
      const value = await (maybeCallback ?? configOrCallback)();
      outputs.push({ name, value });
      return value;
    },
    async sleep(name) { names.push(name); onSleep(name); },
  };
}

function embeddings(options = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async embedBatch(_context, input) {
      calls += 1;
      options.onCall?.(input);
      return input.inputs.map(({ customId }) => ({
        customId,
        values: Array(1536).fill(0.25),
        dimensions: 1536,
        model: "text-embedding-3-small",
      }));
    },
  };
}

function repository(workflowRequest, target, staleIds = [], acceptedStore = null) {
  const prepared = new Set();
  const proofs = new Map();
  const visible = new Set();
  const deleted = new Set();
  let invalidated = false;
  let finalized = false;
  return {
    get invalidated() { return invalidated; },
    get finalized() { return finalized; },
    prepared,
    visible,
    deleted,
    async loadRequest(event) { assert.deepEqual(event, { requestId: workflowRequest.requestId, revisionHash: workflowRequest.revisionHash }); return workflowRequest; },
    async invalidateObsoleteHydration() { invalidated = true; },
    async materializeManifest() { return target; },
    async loadEmbeddingBatch() {
      return {
        batch: {
          inputs: target.chunks.map((item) => ({ id: item.id, text: item.text, contentHash: item.contentHash, estimatedTokens: 2 })),
          estimatedTokens: target.chunks.length * 2,
        },
        chunks: target.chunks,
      };
    },
    async loadVectorProofRecords(_request, ids) { return ids.map((id) => proofs.get(id)); },
    async loadAcceptedMutation(_request, ordinal, operation, ids) {
      const accepted = acceptedStore?.find((item) => item.batchOrdinal === ordinal && item.operation === operation);
      return accepted === undefined ? null : {
        mutationId: accepted.providerMutationId,
        state: operation === "upsert" ? "accepted" : "delete_accepted",
        ids,
        idDigest: accepted.expectedIdsDigest.slice(7),
      };
    },
    async recordPreparedVectors(_request, _manifest, chunks, records) {
      const byId = new Map(chunks.map((item) => [item.id, item]));
      records.forEach((record) => {
        prepared.add(record.id);
        proofs.set(record.id, { id: record.id, vectorDigest: record.vectorDigest, metadata: byId.get(record.id).metadata });
      });
    },
    async markVectorsVisible(_request, ids) { ids.forEach((id) => visible.add(id)); },
    async listStaleVectorIds(_request, targetIds) { assert.deepEqual(targetIds, target.ids); return staleIds; },
    async markVectorsDeleted(_request, ids) { ids.forEach((id) => deleted.add(id)); },
    async finalizeReplacement(_request, expectedVectorBatchCount) {
      assert.equal(visible.size, target.ids.length, "publication cannot precede target visibility");
      assert.deepEqual([...deleted].sort(), [...staleIds].sort(), "publication cannot precede stale-vector absence");
      assert.equal(expectedVectorBatchCount, 1 + (staleIds.length === 0 ? 0 : 1));
      finalized = true;
    },
  };
}

test("replacement publishes only after visible upsert and reduced-manifest stale absence", async () => {
  const target = await manifest(["a/pastorwood_devotional:10:0000"]);
  const workflowRequest = request();
  const repo = repository(workflowRequest, target, ["a/pastorwood_devotional:10:0001"]);
  const vectors = vectorize();
  vectors.visible.set("a/pastorwood_devotional:10:0001", { id: "a/pastorwood_devotional:10:0001", values: new Float32Array(1536), metadata: chunk("a/pastorwood_devotional:10:0001", 1).metadata });
  const store = stateStore();
  const step = steps(() => vectors.settle());

  await runContentIndexWorkflow(step, { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
    repository: repo, stateStore: store, embeddings: embeddings(), vectorize: vectors, now: () => now,
  });

  assert.equal(repo.invalidated, true);
  assert.equal(repo.finalized, true);
  assert.equal(store.state, "publish_ready");
  assert.equal(vectors.visible.has(target.ids[0]), true);
  assert.equal(vectors.visible.has("a/pastorwood_devotional:10:0001"), false);
  assert.ok(step.names.indexOf("finalize-replacement") > step.names.findIndex((name) => name.startsWith("wait-delete-visibility-0-poll")));
  assert.equal(step.outputs.some(({ value }) => value instanceof Float32Array || JSON.stringify(value)?.includes('"values"')), false, "vectors must not enter Workflow step results");
});

test("visibility timeout never publishes or deletes the previous complete manifest", async () => {
  const target = await manifest(["a/pastorwood_devotional:10:0000"]);
  const workflowRequest = request();
  const repo = repository(workflowRequest, target, ["a/pastorwood_devotional:10:0001"]);
  const vectors = vectorize({ publishOnSleep: false });
  const store = stateStore();

  await assert.rejects(
    runContentIndexWorkflow(steps(), { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
      repository: repo, stateStore: store, embeddings: embeddings(), vectorize: vectors, now: () => now,
    }),
    (error) => error instanceof ProcessingStateError && error.code === "visibility_pending",
  );
  assert.equal(repo.finalized, false);
  assert.equal(repo.deleted.size, 0);
});

test("a transient preparation failure becomes operator-resumable", async () => {
  const target = await manifest(["a/pastorwood_devotional:10:0000"]);
  const workflowRequest = request();
  const repo = repository(workflowRequest, target);
  repo.materializeManifest = async () => { throw new Error("temporary D1 dependency failure"); };
  const store = stateStore();

  await assert.rejects(runContentIndexWorkflow(steps(), { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
    repository: repo, stateStore: store, embeddings: embeddings(), vectorize: vectorize(), now: () => now,
  }), /temporary D1 dependency failure/u);

  assert.equal(store.state, "retry_required");
});

test("a completed replay tolerates an already released mutation lease", async () => {
  const target = await manifest(["a/pastorwood_devotional:10:0000"]);
  const workflowRequest = request();
  const repo = repository(workflowRequest, target);
  const vectors = vectorize();
  const store = stateStore();
  store.releaseMutationLease = async () => {
    throw new ProcessingStateError("lease_conflict", "already released");
  };

  await runContentIndexWorkflow(steps(() => vectors.settle()), { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
    repository: repo, stateStore: store, embeddings: embeddings(), vectorize: vectors, now: () => now,
  });

  assert.equal(repo.finalized, true);
  assert.equal(store.state, "publish_ready");
});

for (const [operation, staleIds, retryName, expectedMutations] of [
  ["upsert", [], "upsert-acceptance-0", 1],
  ["delete", ["a/pastorwood_devotional:10:0001"], "delete-stale-acceptance-0", 2],
]) {
test(`a failed ${operation} acceptance ledger step replays without a duplicate Vectorize mutation`, async () => {
  const target = await manifest(["a/pastorwood_devotional:10:0000"]);
  const workflowRequest = request();
  const failure = { failAfterAcceptanceOnce: true, failOperation: operation };
  const store = stateStore("revision_recorded", failure);
  const vectors = vectorize();
  const embeddingProvider = embeddings();
  const repo = repository(workflowRequest, target, staleIds, store.accepted);
  const names = [];
  const attempts = new Map();
  const step = {
    async do(name, configOrCallback, maybeCallback) {
      names.push(name);
      const callback = maybeCallback ?? configOrCallback;
      try {
        return await callback();
      } catch (error) {
        const count = attempts.get(name) ?? 0;
        attempts.set(name, count + 1);
        if (name === retryName && count === 0) return callback();
        throw error;
      }
    },
    async sleep(name) { names.push(name); vectors.settle(); },
  };

  await runContentIndexWorkflow(step, { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
    repository: repo, stateStore: store, embeddings: embeddingProvider, vectorize: vectors, now: () => now,
  });

  assert.equal(embeddingProvider.calls, 1, "the replay must not call the embedding provider again");
  assert.equal(vectors.mutations, expectedMutations, "the replay must not submit a duplicate Vectorize mutation");
  assert.equal(repo.finalized, true);
  assert.equal(store.state, "publish_ready");
});
}

test("a late superseded mutation stays non-serving and cannot trigger stale deletion", async () => {
  const target = await manifest(["a/pastorwood_devotional:10:0000"]);
  const workflowRequest = request();
  const repo = repository(workflowRequest, target, ["a/pastorwood_devotional:10:0001"]);
  const vectors = vectorize();
  const store = stateStore();
  const step = steps((name) => {
    vectors.settle();
    if (name.startsWith("wait-upsert-visibility")) store.setCurrent(false);
  });

  await assert.rejects(
    runContentIndexWorkflow(step, { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
      repository: repo, stateStore: store, embeddings: embeddings(), vectorize: vectors, now: () => now,
    }),
    (error) => error instanceof ProcessingStateError && error.code === "superseded",
  );
  assert.equal(vectors.visible.has(target.ids[0]), true, "the provider may contain the late mutation");
  assert.equal(repo.visible.size, 0, "D1 hydration never marks the stale revision visible");
  assert.equal(repo.deleted.size, 0);
  assert.equal(repo.finalized, false);
});

for (const [operation, initial, terminal] of [
  ["public_unpublish", "public_unpublish_requested", "unpublished"],
  ["public_archive", "public_archive_requested", "archived"],
]) {
  test(`${operation} hides public hydration while retaining authenticated corpus vectors`, async () => {
    const workflowRequest = request({ operation, desiredPublication: terminal, snapshot: {} });
    let authenticatedCorpusRevision = "existing-authenticated-revision";
    const repo = { async loadRequest() { return workflowRequest; } };
    const store = stateStore(initial);
    const vectors = vectorize();
    vectors.visible.set("a/existing", { id: "a/existing", values: new Float32Array(1536), metadata: chunk("a/existing", 0).metadata });

    await runContentIndexWorkflow(steps(), { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
      repository: repo, stateStore: store, embeddings: embeddings(), vectorize: vectors,
    });

    assert.equal(store.state, terminal);
    assert.equal(vectors.visible.has("a/existing"), true);
    assert.equal(authenticatedCorpusRevision, "existing-authenticated-revision");
    assert.equal(store.accepted.length, 0);
  });
}

test("corpus erase remains disabled before any provider mutation", async () => {
  const workflowRequest = request({ operation: "corpus_erase", desiredPublication: "archived" });
  const vectors = vectorize();
  await assert.rejects(
    runContentIndexWorkflow(steps(), { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
      repository: { async loadRequest() { return workflowRequest; } },
      stateStore: stateStore("corpus_erase_requested"), embeddings: embeddings(), vectorize: vectors,
    }),
    (error) => error instanceof ProcessingStateError && error.code === "forbidden",
  );
  assert.equal(vectors.pending.size, 0);
  assert.equal(vectors.pendingDeletes.size, 0);
});

test("lease claims retain the minimum duration after a delayed step and retry", async () => {
  const target = await manifest(["a/pastorwood_devotional:10:0000"]);
  const workflowRequest = request();
  const repo = repository(workflowRequest, target);
  const vectors = vectorize();
  const store = stateStore();
  let clock = now.getTime();
  let attempts = 0;
  store.claimMutationLease = async (command) => {
    attempts += 1;
    // D1 observes the claim later than the caller's clock read.
    assert.ok(Date.parse(command.expiresAt) - (clock + 25) > 31 * 60_000);
    if (attempts === 1) throw new ProcessingStateError("lease_conflict", "retry later");
  };
  const step = steps(() => vectors.settle());
  const originalDo = step.do;
  step.do = async (name, config, callback) => {
    if (name !== "claim-vector-mutation") return originalDo(name, config, callback);
    const claim = callback ?? config;
    clock += 5 * 60_000;
    await assert.rejects(claim(), error => error.code === "lease_conflict");
    clock += 5 * 60_000;
    return claim();
  };
  await runContentIndexWorkflow(step, { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
    repository: repo, stateStore: store, embeddings: embeddings(), vectorize: vectors, now: () => new Date(clock),
  });
  assert.ok(attempts > 2, "live boundaries renew after the initial claim retry");
  assert.equal(repo.finalized, true);
});

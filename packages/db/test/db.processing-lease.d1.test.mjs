import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createProcessingIdempotencyKey, createProcessingRevisionHash } from "@aic/contracts";
import { D1ProcessingStateStore, ProcessingOperatorController } from "../src/index.ts";

// Exercise the installed Wrangler/workerd D1 runtime, including its batch and
// trigger semantics. HTTP keeps the binding inside workerd rather than mocking SQL.
async function migratedD1(t) {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    compatibilityDate: "2026-08-01",
    d1Databases: ["DB"],
    script: `export default { async fetch(request, env) {
      const { method, sql, values, statements } = await request.json();
      try {
        const result = method === "exec" ? await env.DB.exec(sql)
          : method === "batch" ? await env.DB.batch(statements.map(s => env.DB.prepare(s.sql).bind(...s.values)))
          : await env.DB.prepare(sql).bind(...values)[method]();
        return Response.json(result);
      } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
    } }`,
  }));
  t.after(() => runtime.dispose());
  const url = await runtime.ready;
  async function call(command) {
    const response = await fetch(url, { method: "POST", body: JSON.stringify(command) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }
  const db = {
    prepare(sql) {
      const statement = (values = []) => ({
        sql, values,
        bind: (...bound) => statement(bound),
        first: () => call({ method: "first", sql, values }),
        all: () => call({ method: "all", sql, values }),
        run: () => call({ method: "run", sql, values }),
      });
      return statement();
    },
    batch: (statements) => call({ method: "batch", statements }),
  };
  const directory = new URL("../../../migrations/d1/", import.meta.url);
  for (const name of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
    // D1 exec treats each line as a complete SQL program; preserve trigger bodies.
    const sql = (await readFile(new URL(name, directory), "utf8")).replace(/--[^\n]*/gu, "").replace(/\n/gu, " ");
    await call({ method: "exec", sql });
  }
  return db;
}

async function createRequest(state, requestId) {
  const snapshot = { articleId: "pastorwood:42", title: requestId };
  const revisionHash = await createProcessingRevisionHash(snapshot);
  const identity = { operation: "article_replace", entityType: "article", entityId: "pastorwood:42", revisionHash };
  return state.createOrGetRequest({ ...identity, requestId, workflow: "content", revisionId: requestId, snapshot, desiredPublication: "published", idempotencyKey: await createProcessingIdempotencyKey(identity) });
}

const conflict = (promise, code = "lease_conflict") => assert.rejects(promise, (error) => error.code === code);
const initialTime = "2026-09-22T12:00:00.000Z";
const expiry = "2026-09-22T12:31:01.000Z";
const nextExpiry = "2026-09-22T13:31:01.000Z";
const head = (db) => db.prepare("SELECT head_request_id,generation,mutation_owner_request_id,mutation_lease_token,mutation_lease_expires_at FROM processing_heads").first();
const acceptance = (request, leaseToken, providerMutationId) => ({ requestId: request.requestId, generation: request.generation, leaseToken, batchOrdinal: 0, operation: "upsert", expectedIdsDigest: `sha256:${"a".repeat(64)}`, expectedCount: 1, targetRevisionHash: request.revisionHash, providerMutationId });

test("workerd D1: supersession retains the live lease and only its exact owner can release it", { timeout: 30_000 }, async (t) => {
  const db = await migratedD1(t);
  const state = new D1ProcessingStateStore({ db, now: () => initialTime });
  const old = await createRequest(state, "native-old");
  const lease = { requestId: old.requestId, generation: 1, leaseToken: "old-token" };
  await state.claimMutationLease({ ...lease, expiresAt: expiry });
  const newer = await createRequest(state, "native-new");
  const retained = await head(db);
  assert.deepEqual(retained, { head_request_id: newer.requestId, generation: 2, mutation_owner_request_id: old.requestId, mutation_lease_token: lease.leaseToken, mutation_lease_expires_at: expiry });
  await conflict(state.assertCurrentHead(old.requestId, 1), "superseded");
  await conflict(state.claimMutationLease({ ...lease, expiresAt: expiry }), "superseded");
  const next = { requestId: newer.requestId, generation: 2, leaseToken: "new-token", expiresAt: expiry };
  await conflict(state.claimMutationLease(next));
  await conflict(state.releaseMutationLease({ ...lease, leaseToken: "wrong-token" }));
  await conflict(state.releaseMutationLease({ ...lease, requestId: newer.requestId }));
  await conflict(state.recordVectorAcceptance(acceptance(old, lease.leaseToken, "late-result")), "superseded");
  await conflict(state.finalizePublication({ ...lease, to: "published", expectedVectorBatchCount: 0 }), "superseded");
  assert.deepEqual(await head(db), retained);
  await state.releaseMutationLease(lease);
  assert.deepEqual(await head(db), { ...retained, mutation_owner_request_id: null, mutation_lease_token: null, mutation_lease_expires_at: null });
  await state.claimMutationLease(next);
  await conflict(state.releaseMutationLease(lease));
  await conflict(state.recordVectorAcceptance(acceptance(old, lease.leaseToken, "late-result")), "superseded");
  await conflict(state.finalizePublication({ ...lease, to: "published", expectedVectorBatchCount: 0 }), "superseded");
});

test("workerd D1: inherited unknown outcome survives expiry until exact durable evidence reconciles it", { timeout: 30_000 }, async (t) => {
  const db = await migratedD1(t);
  let now = initialTime;
  const options = { db, now: () => now };
  const state = new D1ProcessingStateStore(options);
  const old = await createRequest(state, "native-unknown");
  await state.createOrGetInitialExecution(old.requestId);
  const controller = new ProcessingOperatorController({
    ...options, expectedWorkflow: "content",
    workflow: { get() { assert.fail("Reconciliation must not restart a superseded execution"); } },
    isMissingInstanceError: () => false,
  });
  const lease = { requestId: old.requestId, generation: 1, leaseToken: "unknown-token" };
  await state.claimMutationLease({ ...lease, expiresAt: expiry });
  await state.recordVectorAcceptance(acceptance(old, lease.leaseToken, "unrelated-receipt"));
  await state.transition({ requestId: old.requestId, generation: 1, workflow: "content", from: "revision_recorded", to: "retry_required", stageName: "unknown-upsert", stageStatus: "side_effect_unknown", providerMutationId: "exact-receipt", mutationLeaseToken: lease.leaseToken });
  const newer = await createRequest(state, "native-after-unknown");
  const next = { requestId: newer.requestId, generation: 2, leaseToken: "next-token", expiresAt: nextExpiry };
  await conflict(state.releaseMutationLease(lease));
  now = "2026-09-22T13:00:00.000Z";
  await conflict(state.claimMutationLease(next));
  const action = { requestId: old.requestId, actor: "operator@example.test", reason: "Resolve retained owner from durable evidence" };
  const unresolved = await controller.reconcile({ ...action, actionId: "native-unresolved" });
  assert.equal(unresolved.outcome, "quarantined");
  assert.equal(unresolved.releasedExpiredLease, false);
  assert.equal(unresolved.unresolvedUnknownStages, 1);
  await conflict(state.claimMutationLease(next));
  // Synthetic recovery of the exact durable receipt; the fenced workflow API
  // cannot create serving acceptance for this old request.
  await db.prepare(`INSERT INTO processing_vector_batches
    (request_id,batch_ordinal,operation,generation,expected_ids_digest,expected_count,target_revision_hash,provider_mutation_id,visibility_state,accepted_at,created_at,updated_at)
    SELECT request_id,1,operation,generation,expected_ids_digest,expected_count,target_revision_hash,'exact-receipt',visibility_state,accepted_at,created_at,updated_at
      FROM processing_vector_batches WHERE request_id=? AND batch_ordinal=0`).bind(old.requestId).run();
  await conflict(state.claimMutationLease(next), "lease_conflict");
  const resolved = await controller.reconcile({ ...action, actionId: "native-resolved" });
  assert.equal(resolved.resolvedUnknownStages, 1);
  assert.equal(resolved.unresolvedUnknownStages, 0);
  assert.equal(resolved.releasedExpiredLease, true);
  assert.equal((await db.prepare("SELECT status FROM processing_stage_runs WHERE request_id=?").bind(old.requestId).first()).status, "failed");
  const oldRow = await db.prepare("SELECT state,superseded_by_request_id,cancel_requested_at FROM processing_requests WHERE request_id=?").bind(old.requestId).first();
  assert.equal(oldRow.state, "retry_required");
  assert.equal(oldRow.superseded_by_request_id, newer.requestId);
  assert.equal(oldRow.cancel_requested_at, initialTime);
  assert.equal((await head(db)).head_request_id, newer.requestId);
  assert.equal((await head(db)).generation, 2);
  await state.claimMutationLease(next);
});

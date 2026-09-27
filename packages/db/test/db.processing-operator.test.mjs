import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createProcessingIdempotencyKey,
  createProcessingRevisionHash,
} from "@aic/contracts";
import {
  D1ProcessingOperatorStore,
  D1ProcessingStateStore,
  ProcessingOperatorController,
  reconcileProcessingExecutionStart,
} from "../src/index.ts";

const migrationDirectory = new URL("../../../migrations/d1/", import.meta.url);
const now = "2026-09-05T12:00:00.000000Z";
const leaseExpiry = "2026-09-05T12:31:01.000000Z";
const expiredLease = "2026-09-05T11:59:00.000000Z";

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
    return this.binding.database.prepare(this.sql).get(...this.values) ?? null;
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

class SqliteD1Binding {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new SqliteD1Statement(this, sql);
  }

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

async function requestInput({
  requestId,
  operation = "article_replace",
  entityType = "article",
  entityId = "pastorwood:42",
  snapshot = { articleId: entityId, title: requestId },
  desiredPublication = "published",
}) {
  const revisionHash = await createProcessingRevisionHash(snapshot);
  const idempotencyKey = await createProcessingIdempotencyKey({ operation, entityType, entityId, revisionHash });
  return {
    requestId,
    workflow: operation === "episode_ingest" ? "episode" : "content",
    entityType,
    entityId,
    revisionId: `revision-${requestId}`,
    revisionHash,
    operation,
    idempotencyKey,
    snapshot,
    desiredPublication,
    requestedBy: "operator-42",
    correlationId: `correlation-${requestId}`,
  };
}

function stores(database) {
  const db = new SqliteD1Binding(database);
  const options = { db, now: () => now };
  return {
    db,
    state: new D1ProcessingStateStore(options),
    operator: new D1ProcessingOperatorStore(options),
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

async function retryRequest(state, requestId, stageName, options = {}) {
  await state.transition({
    requestId,
    workflow: "content",
    generation: 1,
    from: "revision_recorded",
    to: "retry_required",
    stageName,
    errorCode: options.errorCode ?? "provider_timeout",
    errorClass: options.errorClass ?? "transient_dependency",
    errorMessage: options.errorMessage ?? "provider failed",
    retryClass: options.retryClass,
    stageStatus: options.stageStatus,
    provider: options.provider,
    model: options.model,
    providerMutationId: options.providerMutationId,
    mutationLeaseToken: options.mutationLeaseToken,
  });
}

for (const [owner, wrongOwner, worker] of [["episode", "content", "indexer"], ["content", "episode", "ingest"]]) {
  for (const action of ["cancel", "resume", "reconcile"]) {
    test(`${worker} controller rejects ${owner} ${action} before any mutation`, async () => {
      const database = await migratedDatabase();
      try {
        const { db, state } = stores(database);
        const request = await state.createOrGetRequest(await requestInput({
          requestId: `wrong-owner-${owner}-${action}`,
          ...(owner === "episode" ? {
            operation: "episode_ingest", entityType: "episode", entityId: "sa_44",
            snapshot: { episodeId: "sa_44" }, desiredPublication: "draft",
          } : {}),
        }));
        await state.createOrGetInitialExecution(request.requestId);
        await state.claimMutationLease({ requestId: request.requestId, generation: 1, leaseToken: "owner-lease", expiresAt: leaseExpiry });
        if (action === "reconcile") {
          await state.recordVectorAcceptance({
            requestId: request.requestId, generation: 1, leaseToken: "owner-lease", batchOrdinal: 0,
            operation: "upsert", expectedIdsDigest: await createProcessingRevisionHash({ ids: ["chunk-1"] }),
            expectedCount: 1, targetRevisionHash: request.revisionHash, providerMutationId: "owner-receipt",
          });
        }
        await state.transition({
          requestId: request.requestId, workflow: owner, generation: 1,
          from: owner === "episode" ? "discovered" : "revision_recorded", to: "retry_required",
          stageName: "provider-call", errorCode: "provider_timeout", errorClass: "transient_dependency",
          retryClass: "transient", mutationLeaseToken: "owner-lease",
          ...(action === "reconcile" ? {
            stageStatus: "side_effect_unknown", providerMutationId: "owner-receipt",
            errorClass: "provider_timeout_unknown", retryClass: "provider_timeout_unknown",
          } : {}),
        });
        database.prepare("UPDATE processing_heads SET mutation_lease_expires_at = ? WHERE head_request_id = ?").run(expiredLease, request.requestId);

        // Full rows include state, resume_sequence, current_execution_id, lease tokens,
        // cancellation fences, stages, executions, receipts, and operator audit rows.
        const snapshot = () => Object.fromEntries([
          "processing_requests", "processing_heads", "processing_stage_runs",
          "processing_executions", "processing_vector_batches", "admin_operation_audit",
        ].map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()]));
        const before = snapshot();
        const changes = database.prepare("SELECT total_changes() AS count").get().count;
        let workflowCalls = 0;
        const workflow = {
          async get(id) {
            workflowCalls += 1;
            return { id, async status() { return { status: "running" }; }, async terminate() { workflowCalls += 1; } };
          },
          async createBatch() { workflowCalls += 1; assert.fail("Existing execution should be found"); },
        };
        const input = {
          requestId: ` ${request.requestId} `, actor: "admin@example.test",
          reason: "Repair provider configuration", actionId: `owner-check-${action}`,
          workflow: wrongOwner, // Spoofed caller identity must not override D1 ownership.
        };
        const wrongController = new ProcessingOperatorController({ db, now: () => now, workflow, expectedWorkflow: wrongOwner });
        await expectCode(wrongController[action](input), "identity_conflict");
        assert.deepEqual(snapshot(), before);
        assert.equal(database.prepare("SELECT total_changes() AS count").get().count, changes);
        assert.equal(workflowCalls, 0);

        // The same eligible action still works when it reaches its actual owner.
        const ownerController = new ProcessingOperatorController({ db, now: () => now, workflow, expectedWorkflow: owner });
        const receipt = await ownerController[action](input);
        assert.equal(receipt.workflow, owner);
        assert.equal(receipt.action, action);
        assert.notDeepEqual(snapshot(), before);
      } finally {
        database.close();
      }
    });
  }
}

test("operator evidence is sanitized, attributed, and excludes input snapshots and vector payloads", async () => {
  const database = await migratedDatabase();
  try {
    const { state, operator } = stores(database);
    const request = await state.createOrGetRequest(await requestInput({ requestId: "operator-evidence" }));
    await retryRequest(state, request.requestId, "embed", {
      retryClass: "transient",
      provider: "hf-inference",
      model: "e5-large",
      errorMessage: "https://provider.invalid/x Authorization: Bearer secret-value token=private-value",
    });
    await operator.resume({
      requestId: request.requestId,
      actor: "admin@example.test",
      reason: "Repair provider configuration",
      actionId: "resume-evidence-1",
    });
    const evidence = await operator.getEvidence(request.requestId);
    assert.equal(evidence.request.requestId, request.requestId);
    assert.equal(evidence.request.lastError.message.includes("secret-value"), false);
    assert.equal(evidence.stages[0].errorMessage.includes("private-value"), false);
    assert.equal(evidence.stages[0].errorMessage.includes("secret-value"), false);
    assert.equal(evidence.stages[0].errorMessage.includes("[redacted-url]"), true);
    assert.equal(evidence.stages[0].errorMessage.includes("[redacted]"), true);
    assert.equal("inputSnapshot" in evidence.request, false);
    assert.equal("snapshot" in evidence, false);
    assert.equal("text" in evidence, false);
    assert.equal("vectors" in evidence, false);
    assert.equal(evidence.stages[0].retryClass, "transient");
    assert.equal(evidence.stages[0].provider, "hf-inference");
    assert.equal(evidence.audit[0].action, "processing_resume");
    assert.equal(evidence.audit[0].actor, "admin@example.test");
    assert.equal(evidence.audit[0].reason, "Repair provider configuration");
    assert.equal(evidence.audit[0].actionId, "resume-evidence-1");
  } finally {
    database.close();
  }
});

test("cancel is idempotent, fences claims and finalizes, and rejects published work", async () => {
  const database = await migratedDatabase();
  try {
    const { state, operator } = stores(database);
    const request = await state.createOrGetRequest(await requestInput({ requestId: "operator-cancel" }));
    const execution = await state.createOrGetInitialExecution(request.requestId);
    const action = { requestId: request.requestId, actor: "cancel@example.test", reason: "Stop duplicate work", actionId: "cancel-action-1" };
    const first = await operator.cancel(action);
    const duplicate = await operator.cancel(action);
    assert.equal(first.outcome, "cancelled");
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.execution?.executionId, execution.executionId);
    assert.equal(database.prepare("SELECT state, cancel_requested_at FROM processing_requests WHERE request_id = ?").get(request.requestId).state, "cancelled");
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_stage_runs WHERE request_id = ? AND stage_name = 'operator-cancel'").get(request.requestId).count, 1);
    await expectCode(state.assertCurrentHead(request.requestId, 1), "cancelled");
    await expectCode(state.claimMutationLease({ requestId: request.requestId, generation: 1, leaseToken: "cancel-lease", expiresAt: leaseExpiry }), "cancelled");
    await expectCode(state.finalizePublication({ requestId: request.requestId, generation: 1, to: "published", expectedVectorBatchCount: 0 }), "cancelled");

    const published = await state.createOrGetRequest(await requestInput({ requestId: "operator-published", entityId: "pastorwood:43" }));
    database.prepare("UPDATE processing_requests SET state = 'published' WHERE request_id = ?").run(published.requestId);
    await expectCode(operator.cancel({
      requestId: published.requestId,
      actor: "cancel@example.test",
      reason: "Too late",
      actionId: "cancel-published-1",
    }), "publication_conflict");
  } finally {
    database.close();
  }
});

test("resume keeps immutable identity, increments sequence once, and distinguishes workflow IDs", async () => {
  const database = await migratedDatabase();
  try {
    const { state, operator } = stores(database);
    const contentInput = await requestInput({ requestId: "operator-resume-content" });
    const content = await state.createOrGetRequest(contentInput);
    await state.createOrGetInitialExecution(content.requestId);
    await retryRequest(state, content.requestId, "chunk", { retryClass: "configuration" });
    const first = await operator.resume({ requestId: content.requestId, actor: "resume@example.test", reason: "Config repaired", actionId: "resume-exactly-once-1" });
    const duplicate = await operator.resume({ requestId: content.requestId, actor: "other@example.test", reason: "Transport retry", actionId: "resume-exactly-once-1" });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.execution?.executionId, first.execution?.executionId);
    const persisted = database.prepare("SELECT revision_hash, idempotency_key, resume_sequence, current_execution_id FROM processing_requests WHERE request_id = ?").get(content.requestId);
    assert.equal(persisted.revision_hash, content.revisionHash);
    assert.equal(persisted.idempotency_key, contentInput.idempotencyKey);
    assert.equal(persisted.resume_sequence, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_executions WHERE request_id = ?").get(content.requestId).count, 2);
    assert.equal(first.execution.workflowInstanceId.startsWith("p6a-"), true);

    const episodeInput = await requestInput({ requestId: "operator-resume-episode", operation: "episode_ingest", entityType: "episode", entityId: "sa_44", snapshot: { episodeId: "sa_44" }, desiredPublication: "draft" });
    const episode = await state.createOrGetRequest(episodeInput);
    await state.transition({ requestId: episode.requestId, workflow: "episode", generation: 1, from: "discovered", to: "retry_required", stageName: "audio", errorCode: "provider_timeout", errorClass: "transient_dependency", retryClass: "transient" });
    const episodeResume = await operator.resume({ requestId: episode.requestId, actor: "resume@example.test", reason: "Audio service repaired", actionId: "resume-episode-1" });
    assert.equal(episodeResume.execution.workflowInstanceId.startsWith("p6e-"), true);
    assert.notEqual(episodeResume.execution.workflowInstanceId, first.execution.workflowInstanceId);
  } finally {
    database.close();
  }
});

test("retry classes remain visible for transient, throttled, visibility-pending, config, auth, and unknown outcomes", async () => {
  const database = await migratedDatabase();
  try {
    const { state, operator } = stores(database);
    const cases = [
      ["transient", "transient_dependency", "provider_timeout"],
      ["throttled", "throttled", "provider_rate_limited"],
      ["visibility_pending", "visibility_pending", "vector_not_visible"],
      ["configuration", "configuration", "invalid_configuration"],
      ["authentication", "authentication", "provider_unauthorized"],
      ["provider_timeout_unknown", "provider_timeout_unknown", "provider_timeout_unknown"],
    ];
    for (const [index, [retryClass, errorClass, errorCode]] of cases.entries()) {
      const requestId = `operator-retry-class-${index}`;
      const request = await state.createOrGetRequest(await requestInput({ requestId, entityId: `pastorwood:${50 + index}` }));
      await retryRequest(state, request.requestId, `stage-${index}`, { retryClass, errorClass, errorCode });
      const evidence = await operator.getEvidence(request.requestId);
      assert.equal(evidence.request.state, "retry_required");
      assert.equal(evidence.request.lastError.class, errorClass);
      assert.equal(evidence.stages[0].retryClass, retryClass);
      assert.equal(evidence.stages[0].errorCode, errorCode);
    }
  } finally {
    database.close();
  }
});

test("unknown outcomes quarantine, deterministic receipts resolve, and safe expired leases release", async () => {
  const database = await migratedDatabase();
  try {
    const { db, state, operator } = stores(database);
    const unknown = await state.createOrGetRequest(await requestInput({ requestId: "operator-unknown" }));
    await state.claimMutationLease({ requestId: unknown.requestId, generation: 1, leaseToken: "unknown-lease", expiresAt: leaseExpiry });
    await retryRequest(state, unknown.requestId, "embed-unknown", { retryClass: "provider_timeout_unknown", errorClass: "provider_timeout_unknown", errorCode: "provider_timeout_unknown", stageStatus: "side_effect_unknown", mutationLeaseToken: "unknown-lease" });
    database.prepare("UPDATE processing_heads SET mutation_lease_expires_at = ? WHERE head_request_id = ?").run(expiredLease, unknown.requestId);
    const quarantined = await operator.reconcile({ requestId: unknown.requestId, actor: "reconcile@example.test", reason: "Provider outcome is not observable", actionId: "reconcile-unknown-1" });
    assert.equal(quarantined.outcome, "quarantined");
    assert.equal(quarantined.unresolvedUnknownStages, 1);
    await expectCode(operator.resume({ requestId: unknown.requestId, actor: "resume@example.test", reason: "Try again", actionId: "resume-quarantined-1" }), "visibility_pending");
    assert.equal(database.prepare("SELECT status FROM processing_stage_runs WHERE request_id = ?").get(unknown.requestId).status, "side_effect_unknown");
    assert.equal(database.prepare("SELECT mutation_owner_request_id FROM processing_heads WHERE head_request_id = ?").get(unknown.requestId).mutation_owner_request_id, unknown.requestId);

    const resolved = await state.createOrGetRequest(await requestInput({ requestId: "operator-reconciled", entityId: "pastorwood:61" }));
    await state.claimMutationLease({ requestId: resolved.requestId, generation: 1, leaseToken: "reconcile-lease", expiresAt: leaseExpiry });
    const digest = await createProcessingRevisionHash({ ids: ["article/chunk-1"] });
    await state.recordVectorAcceptance({ requestId: resolved.requestId, generation: 1, leaseToken: "reconcile-lease", batchOrdinal: 0, operation: "upsert", expectedIdsDigest: digest, expectedCount: 1, targetRevisionHash: resolved.revisionHash, providerMutationId: "mutation-receipt-1" });
    await retryRequest(state, resolved.requestId, "embed-reconciled", { retryClass: "provider_timeout_unknown", errorClass: "provider_timeout_unknown", errorCode: "provider_timeout_unknown", stageStatus: "side_effect_unknown", providerMutationId: "mutation-receipt-1", mutationLeaseToken: "reconcile-lease" });
    const reconciled = await operator.reconcile({ requestId: resolved.requestId, actor: "reconcile@example.test", reason: "Vector receipt confirms acceptance", actionId: "reconcile-receipt-1" });
    assert.equal(reconciled.outcome, "visibility_pending");
    assert.equal(reconciled.resolvedUnknownStages, 1);
    assert.equal(reconciled.unresolvedUnknownStages, 0);
    assert.equal(database.prepare("SELECT status, retry_class FROM processing_stage_runs WHERE request_id = ?").get(resolved.requestId).status, "failed");
    const resumed = await operator.resume({ requestId: resolved.requestId, actor: "resume@example.test", reason: "Receipt reconciled", actionId: "resume-reconciled-1" });
    assert.equal(resumed.execution.resumeSequence, 1);

    const lease = await state.createOrGetRequest(await requestInput({ requestId: "operator-expired-lease", entityId: "pastorwood:60" }));
    await state.claimMutationLease({ requestId: lease.requestId, generation: 1, leaseToken: "expired-lease", expiresAt: leaseExpiry });
    database.prepare("UPDATE processing_heads SET mutation_lease_expires_at = ? WHERE head_request_id = ?").run(expiredLease, lease.requestId);
    const released = await operator.reconcile({ requestId: lease.requestId, actor: "reconcile@example.test", reason: "Release safe expired lease", actionId: "reconcile-expired-1" });
    assert.equal(released.outcome, "lease_released");
    assert.equal(released.releasedExpiredLease, true);
    assert.equal(database.prepare("SELECT mutation_owner_request_id, mutation_lease_token FROM processing_heads WHERE head_request_id = ?").get(lease.requestId).mutation_owner_request_id, null);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM admin_operation_audit WHERE entity_id = ?").bind(lease.requestId).first()).count, 1);
  } finally {
    database.close();
  }
});

test("deterministic Workflow start reconciliation recovers a lost create response", async () => {
  const database = await migratedDatabase();
  try {
    const { db, state } = stores(database);
    const request = await state.createOrGetRequest(await requestInput({ requestId: "operator-start-recovery" }));
    const execution = await state.createOrGetInitialExecution(request.requestId);
    const instances = new Map();
    let createCalls = 0;
    const workflow = {
      async get(id) {
        const instance = instances.get(id);
        if (!instance) {
          const error = new Error("not found");
          error.status = 404;
          throw error;
        }
        return instance;
      },
      async createBatch(batch) {
        createCalls += 1;
        for (const item of batch) instances.set(item.id, { id: item.id, async status() { return { status: "running" }; } });
        throw new Error("response lost after create");
      },
    };
    const recovered = await reconcileProcessingExecutionStart({
      db,
      stateStore: state,
      workflow,
      execution,
      expectedWorkflow: "content",
      isMissingInstanceError: (error) => error?.status === 404,
      now: () => now,
    });
    assert.equal(createCalls, 1);
    assert.equal(recovered.created, false);
    assert.equal(recovered.workflowInstanceId, execution.workflowInstanceId);
    assert.equal(recovered.status, "running");
    assert.equal(database.prepare("SELECT status FROM processing_executions WHERE execution_id = ?").get(execution.executionId).status, "running");
  } finally {
    database.close();
  }
});

test("reconcile marks a request retry_required when its Workflow instance stopped without a terminal state", async () => {
  const database = await migratedDatabase();
  try {
    const { db, state } = stores(database);
    const request = await state.createOrGetRequest(await requestInput({
      requestId: "stopped-workflow",
      operation: "episode_ingest", entityType: "episode", entityId: "2390337141",
      snapshot: { episodeId: "2390337141" }, desiredPublication: "published",
    }));
    const execution = await state.createOrGetInitialExecution(request.requestId);
    database.prepare("UPDATE processing_executions SET status = 'running' WHERE execution_id = ?").run(execution.executionId);
    database.prepare("UPDATE processing_requests SET state = 'index_visibility_pending' WHERE request_id = ?").run(request.requestId);
    const workflow = {
      async get(id) { return { id, async status() { return { status: "errored" }; } }; },
      async createBatch() { assert.fail("Reconcile must not start a new instance"); },
    };
    const controller = new ProcessingOperatorController({ db, now: () => now, workflow, expectedWorkflow: "episode" });
    const receipt = await controller.reconcile({
      requestId: request.requestId, actor: "admin@example.test", reason: "Workflow errored", actionId: "stopped-1",
    });
    assert.equal(receipt.state, "retry_required");
    assert.equal(receipt.outcome, "resume_required");
    assert.equal(database.prepare("SELECT state FROM processing_requests WHERE request_id = ?").get(request.requestId).state, "retry_required");
    assert.equal(database.prepare("SELECT status FROM processing_executions WHERE execution_id = ?").get(execution.executionId).status, "errored");

    // A still-running instance is left alone.
    database.prepare("UPDATE processing_requests SET state = 'transcribing' WHERE request_id = ?").run(request.requestId);
    database.prepare("UPDATE processing_executions SET status = 'running' WHERE execution_id = ?").run(execution.executionId);
    const running = new ProcessingOperatorController({
      db, now: () => now, expectedWorkflow: "episode",
      workflow: { async get(id) { return { id, async status() { return { status: "running" }; } }; }, async createBatch() { assert.fail("unexpected"); } },
    });
    const untouched = await running.reconcile({ requestId: request.requestId, actor: "admin@example.test", reason: "check", actionId: "stopped-2" });
    assert.equal(untouched.state, "transcribing");
  } finally {
    database.close();
  }
});

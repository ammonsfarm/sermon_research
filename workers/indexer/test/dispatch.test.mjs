import assert from "node:assert/strict";
import test from "node:test";

import { ContentWorkflowDispatcher, dispatchContentProcessingRequest } from "../src/dispatch.ts";

const revisionHash = `sha256:${"a".repeat(64)}`;
const idempotencyKey = `p6:article-index:v1:${"b".repeat(64)}`;
const operationContext = {
  boundary: "request",
  request: { method: "POST", path: "/admin/articles/publish" },
  correlation: { correlationId: "correlation-1" },
  signal: new AbortController().signal,
};

const isMissingInstanceError = (error) => error instanceof Error && /missing|not found/iu.test(error.message);

class Statement {
  constructor(binding, sql, values = []) { this.binding = binding; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.binding, this.sql, values); }
  async first() {
    if (this.sql.includes("FROM processing_requests") && !this.sql.includes("JOIN")) return this.binding.request;
    if (this.sql.includes("FROM processing_executions")) return this.binding.executionExists ? this.binding.execution : null;
    throw new Error(`Unexpected query: ${this.sql}`);
  }
  async run() {
    assert.match(this.sql, /UPDATE processing_executions/u);
    this.binding.executionExists = true;
    return { success: true, meta: { changes: 1 } };
  }
}

test("duplicate article replacement keeps one logical Workflow instance and receipt", async () => {
  const binding = {
    request: { request_id: "request-1", revision_hash: revisionHash, idempotency_key: idempotencyKey, operation: "article_replace", generation: 1 },
    execution: { execution_id: "execution-1", workflow_instance_id: "p6a-instance-0", status: "running" },
    executionExists: false,
    prepare(sql) { return new Statement(this, sql); },
  };
  const stateStore = {
    async assertCurrentHead() {},
    async createOrGetInitialExecution() { return { executionId: "execution-1", requestId: "request-1", workflowInstanceId: "p6a-instance-0", resumeSequence: 0, status: binding.executionExists ? binding.execution.status : "starting" }; },
  };
  let createCount = 0;
  let retained;
  const workflow = {
    async get() { if (!retained) throw new Error("missing"); return retained; },
    async createBatch([{ id, params }]) {
      createCount += 1;
      assert.deepEqual(params, { requestId: "request-1", revisionHash });
      retained = { id, async status() { return { status: "running" }; } };
      return [retained];
    },
  };
  const dispatcher = new ContentWorkflowDispatcher({ db: binding, stateStore, workflow, isMissingInstanceError, now: () => new Date("2026-09-21T12:00:00.000Z") });
  const command = { kind: "article_index_replace", idempotencyKey, correlation: operationContext.correlation, payload: { target: "content", requestId: "request-1", revisionHash } };

  const first = await dispatcher.dispatch(operationContext, command);
  const second = await dispatcher.dispatch(operationContext, command);
  binding.execution.status = "complete";
  const completedDuplicate = await dispatcher.dispatch(operationContext, command);
  assert.equal(first.jobId, "execution-1");
  assert.equal(first.duplicateOf, undefined);
  assert.equal(second.jobId, "execution-1");
  assert.equal(second.duplicateOf, "execution-1");
  assert.equal(completedDuplicate.jobId, "execution-1");
  assert.equal(completedDuplicate.duplicateOf, "execution-1");
  assert.equal(createCount, 1);
});

test("content dispatch reconciles a lost Workflow create response by deterministic ID", async () => {
  const binding = {
    request: { request_id: "request-create-loss", revision_hash: revisionHash, idempotency_key: idempotencyKey, operation: "article_replace", generation: 1 },
    execution: { execution_id: "execution-create-loss", workflow_instance_id: "p6a-create-loss", status: "running" },
    executionExists: false,
    prepare(sql) { return new Statement(this, sql); },
  };
  const stateStore = {
    async assertCurrentHead() {},
    async createOrGetInitialExecution() {
      return {
        executionId: "execution-create-loss",
        requestId: "request-create-loss",
        workflowInstanceId: "p6a-create-loss",
        resumeSequence: 0,
        status: binding.executionExists ? "running" : "starting",
      };
    },
  };
  let retained;
  let createCalls = 0;
  const workflow = {
    async get(id) {
      if (!retained) throw new Error("instance not found");
      assert.equal(id, retained.id);
      return retained;
    },
    async createBatch([{ id, params }]) {
      createCalls += 1;
      assert.deepEqual(params, { requestId: "request-create-loss", revisionHash });
      retained = { id, async status() { return { status: "running" }; } };
      throw new Error("response lost after create");
    },
  };
  const dispatcher = new ContentWorkflowDispatcher({ db: binding, stateStore, workflow, isMissingInstanceError, now: () => new Date("2026-09-21T12:00:00.000Z") });
  const receipt = await dispatcher.dispatch(operationContext, {
    kind: "article_index_replace",
    idempotencyKey,
    correlation: operationContext.correlation,
    payload: { target: "content", requestId: "request-create-loss", revisionHash },
  });

  assert.equal(receipt.jobId, "execution-create-loss");
  assert.equal(createCalls, 1);
  assert.equal(binding.executionExists, true);
});

test("unknown Workflow lookup failure never creates a content Workflow", async () => {
  const binding = {
    request: { request_id: "request-lookup-unknown", revision_hash: revisionHash, idempotency_key: idempotencyKey, operation: "article_replace", generation: 1 },
    execution: { execution_id: "execution-lookup-unknown", workflow_instance_id: "p6a-lookup-unknown", status: "starting" },
    executionExists: true,
    prepare(sql) { return new Statement(this, sql); },
  };
  const stateStore = {
    async assertCurrentHead() {},
    async createOrGetInitialExecution() { return { executionId: "execution-lookup-unknown", requestId: "request-lookup-unknown", workflowInstanceId: "p6a-lookup-unknown", resumeSequence: 0, status: "starting" }; },
  };
  let createCalls = 0;
  const workflow = {
    async get() { throw new Error("network unavailable during lookup"); },
    async createBatch() { createCalls += 1; return []; },
  };
  const dispatcher = new ContentWorkflowDispatcher({ db: binding, stateStore, workflow, isMissingInstanceError, now: () => new Date("2026-09-21T12:00:00.000Z") });

  await assert.rejects(
    dispatcher.dispatch(operationContext, {
      kind: "article_index_replace",
      idempotencyKey,
      correlation: operationContext.correlation,
      payload: { target: "content", requestId: "request-lookup-unknown", revisionHash },
    }),
    (error) => error?.code === "publication_conflict",
  );
  assert.equal(createCalls, 0);
});

test("retained Workflow status failure never creates a replacement instance", async () => {
  const binding = {
    request: { request_id: "request-status-failure", revision_hash: revisionHash, idempotency_key: idempotencyKey, operation: "article_replace", generation: 1 },
    execution: { execution_id: "execution-status-failure", workflow_instance_id: "p6a-status-failure", status: "starting" },
    executionExists: true,
    prepare(sql) { return new Statement(this, sql); },
  };
  const stateStore = {
    async assertCurrentHead() {},
    async createOrGetInitialExecution() { return { executionId: "execution-status-failure", requestId: "request-status-failure", workflowInstanceId: "p6a-status-failure", resumeSequence: 0, status: "starting" }; },
  };
  let createCalls = 0;
  const workflow = {
    async get() { return { id: "p6a-status-failure", async status() { throw new Error("status temporarily unavailable"); } }; },
    async createBatch() { createCalls += 1; return []; },
  };
  const dispatcher = new ContentWorkflowDispatcher({ db: binding, stateStore, workflow, isMissingInstanceError, now: () => new Date("2026-09-21T12:00:00.000Z") });

  await assert.rejects(
    dispatcher.dispatch(operationContext, {
      kind: "article_index_replace",
      idempotencyKey,
      correlation: operationContext.correlation,
      payload: { target: "content", requestId: "request-status-failure", revisionHash },
    }),
    (error) => error?.code === "publication_conflict",
  );
  assert.equal(createCalls, 0);
});

test("article and transcript request producers cross BackgroundJobDispatcher with distinct commands", async () => {
  const kinds = [];
  const dispatcher = { async dispatch(_context, command) { kinds.push(command.kind); return { jobId: `job-${command.kind}`, acceptedAt: "2026-09-21T12:00:00.000Z" }; } };
  const stateStore = { async createOrGetRequest(input) { return { requestId: input.requestId, workflow: "content", aggregate: { type: input.operation === "transcript_replace" ? "episode" : "article", id: input.entityId }, revisionHash: input.revisionHash, generation: 1, state: "revision_recorded", duplicate: false }; } };
  const base = { workflow: "content", revisionId: "revision-1", revisionHash, desiredPublication: "published", requestedBy: "test", correlationId: "correlation-1", snapshot: {} };
  await dispatchContentProcessingRequest({ context: operationContext, stateStore, dispatcher, request: { ...base, requestId: "article", entityType: "article", entityId: "pastorwood:10", operation: "article_replace", idempotencyKey } });
  await dispatchContentProcessingRequest({ context: operationContext, stateStore, dispatcher, request: { ...base, requestId: "transcript", entityType: "transcript", entityId: "10", operation: "transcript_replace", idempotencyKey: `p6:transcript-index:v1:${"c".repeat(64)}` } });
  assert.deepEqual(kinds, ["article_index_replace", "semantic_index_replace"]);
});

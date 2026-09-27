import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createProcessingIdempotencyKey,
  createProcessingRevisionHash,
} from "@aic/contracts";
import { D1ProcessingStateStore } from "@aic/db";
import { EpisodeWorkflowDispatcher, reconcileInitialExecutionStart } from "../src/dispatch.ts";

const migrationDirectory = new URL("../../../migrations/d1/", import.meta.url);
const now = "2026-09-05T12:00:00.000Z";

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
    if (this.binding.failNextRunContaining && this.sql.includes(this.binding.failNextRunContaining)) {
      this.binding.failNextRunContaining = null;
      throw new Error("synthetic D1 interruption");
    }
    const before = this.binding.database.prepare("SELECT total_changes() AS count").get().count;
    const result = this.binding.database.prepare(this.sql).run(...this.values);
    const after = this.binding.database.prepare("SELECT total_changes() AS count").get().count;
    return { success: true, meta: { changes: after - before, last_row_id: Number(result.lastInsertRowid) } };
  }
}

class SqliteD1Binding {
  constructor(database) {
    this.database = database;
    this.failNextRunContaining = null;
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

class MissingInstanceError extends Error {}

class FakeWorkflow {
  constructor() {
    this.instances = new Map();
    this.createCalls = 0;
    this.failBeforeCreate = false;
    this.failAfterCreate = false;
    this.returnWrongId = false;
  }

  async get(id) {
    const instance = this.instances.get(id);
    if (!instance) throw new MissingInstanceError("missing");
    if (!this.returnWrongId) return instance;
    return { ...instance, id: `${id}-wrong` };
  }

  async createBatch(batch) {
    this.createCalls += 1;
    if (this.failBeforeCreate) {
      this.failBeforeCreate = false;
      throw new Error("network unavailable before create");
    }
    const created = [];
    for (const input of batch) {
      if (this.instances.has(input.id)) continue;
      const instance = {
        id: input.id,
        params: input.params,
        async status() { return { status: "queued" }; },
      };
      this.instances.set(input.id, instance);
      created.push(instance);
    }
    if (this.failAfterCreate) {
      this.failAfterCreate = false;
      throw new Error("connection lost after create");
    }
    return created;
  }
}

async function episodeInput(requestId, episodeId = "2385860193", title = "Immutable episode") {
  const snapshot = {
    episodeId,
    title,
    enclosureUrl: `https://feeds.example.invalid/tracks/${episodeId}/stream.mp3`,
    source: "soundcloud-rss",
  };
  const revisionHash = await createProcessingRevisionHash(snapshot);
  const idempotencyKey = await createProcessingIdempotencyKey({
    operation: "episode_ingest",
    entityType: "episode",
    entityId: episodeId,
    revisionHash,
  });
  return {
    requestId,
    workflow: "episode",
    entityType: "episode",
    entityId: episodeId,
    revisionId: `soundcloud:${episodeId}:${revisionHash.slice(7)}`,
    revisionHash,
    operation: "episode_ingest",
    idempotencyKey,
    snapshot,
    desiredPublication: "draft",
    requestedBy: "discovery:test",
    correlationId: requestId,
  };
}

function reconciliationInput(binding, stateStore, workflow, requestId) {
  return {
    db: binding,
    stateStore,
    workflow,
    requestId,
    now: () => now,
    isMissingInstanceError: (error) => error instanceof MissingInstanceError,
  };
}

test("initial execution reconciliation converges across all Workflow create crash windows", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const workflow = new FakeWorkflow();

    await stateStore.createOrGetRequest(await episodeInput("request-crash-windows"));

    workflow.failBeforeCreate = true;
    await assert.rejects(
      reconcileInitialExecutionStart(reconciliationInput(binding, stateStore, workflow, "request-crash-windows")),
      (error) => error?.code === "workflow_start_unavailable" && !error.message.includes("network unavailable"),
    );
    assert.equal(workflow.instances.size, 0);

    workflow.failAfterCreate = true;
    const recovered = await reconcileInitialExecutionStart(
      reconciliationInput(binding, stateStore, workflow, "request-crash-windows"),
    );
    assert.equal(recovered.status, "running");
    assert.equal(recovered.workflowStatus, "queued");
    assert.equal(recovered.created, false);

    const afterD1Update = await reconcileInitialExecutionStart(
      reconciliationInput(binding, stateStore, workflow, "request-crash-windows"),
    );
    assert.equal(afterD1Update.workflowInstanceId, recovered.workflowInstanceId);
    assert.equal(afterD1Update.created, false);
    assert.equal(workflow.instances.size, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_executions WHERE request_id = ?").get("request-crash-windows").count, 1);
  } finally {
    database.close();
  }
});

test("a crash after Workflow create but before the D1 running update is repaired by get", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const workflow = new FakeWorkflow();
    await stateStore.createOrGetRequest(await episodeInput("request-d1-crash", "2385860194"));

    binding.failNextRunContaining = "UPDATE processing_executions";
    await assert.rejects(
      reconcileInitialExecutionStart(reconciliationInput(binding, stateStore, workflow, "request-d1-crash")),
      /synthetic D1 interruption/u,
    );
    assert.equal(workflow.instances.size, 1);
    assert.equal(database.prepare("SELECT status FROM processing_executions WHERE request_id = ?").get("request-d1-crash").status, "starting");

    const recovered = await reconcileInitialExecutionStart(
      reconciliationInput(binding, stateStore, workflow, "request-d1-crash"),
    );
    assert.equal(recovered.status, "running");
    assert.equal(workflow.createCalls, 1);
  } finally {
    database.close();
  }
});

test("retained Workflow metadata is validated and a vanished running execution is never recreated", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const workflow = new FakeWorkflow();
    await stateStore.createOrGetRequest(await episodeInput("request-retained", "2385860195"));
    const started = await reconcileInitialExecutionStart(
      reconciliationInput(binding, stateStore, workflow, "request-retained"),
    );

    workflow.returnWrongId = true;
    await assert.rejects(
      reconcileInitialExecutionStart(reconciliationInput(binding, stateStore, workflow, "request-retained")),
      (error) => error?.code === "workflow_identity_conflict",
    );
    workflow.returnWrongId = false;
    workflow.instances.delete(started.workflowInstanceId);
    const createsBefore = workflow.createCalls;
    await assert.rejects(
      reconcileInitialExecutionStart(reconciliationInput(binding, stateStore, workflow, "request-retained")),
      (error) => error?.code === "workflow_instance_vanished",
    );
    assert.equal(workflow.createCalls, createsBefore);
  } finally {
    database.close();
  }
});

test("a superseded starting execution is fenced before Workflow creation", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const workflow = new FakeWorkflow();
    await stateStore.createOrGetRequest(await episodeInput("request-stale", "2385860196", "Old"));
    await stateStore.createOrGetInitialExecution("request-stale");
    await stateStore.createOrGetRequest(await episodeInput("request-current", "2385860196", "New"));

    await assert.rejects(
      reconcileInitialExecutionStart(reconciliationInput(binding, stateStore, workflow, "request-stale")),
      (error) => error?.code === "superseded",
    );
    assert.equal(workflow.createCalls, 0);
  } finally {
    database.close();
  }
});

test("duplicate episode dispatch returns the retained execution without creating another Workflow", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const workflow = new FakeWorkflow();
    const input = await episodeInput("request-duplicate", "2385860197");
    await stateStore.createOrGetRequest(input);
    const dispatcher = new EpisodeWorkflowDispatcher({
      db: binding,
      stateStore,
      workflow,
      now: () => new Date(now),
      isMissingInstanceError: (error) => error instanceof MissingInstanceError,
    });
    const context = {
      boundary: "background",
      correlation: { correlationId: "duplicate-test" },
      job: { id: "job-duplicate", kind: "episode_ingest", attempt: 1, idempotencyKey: input.idempotencyKey },
      signal: new AbortController().signal,
    };
    const command = {
      kind: "episode_ingest",
      idempotencyKey: input.idempotencyKey,
      correlation: context.correlation,
      payload: { target: "episode", requestId: input.requestId, revisionHash: input.revisionHash },
    };

    const first = await dispatcher.dispatch(context, command);
    const duplicate = await dispatcher.dispatch(context, command);

    assert.equal(duplicate.jobId, first.jobId);
    assert.equal(duplicate.duplicateOf, first.jobId);
    assert.equal(workflow.createCalls, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_executions WHERE request_id=?").get(input.requestId).count, 1);
  } finally {
    database.close();
  }
});

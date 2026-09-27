import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ServiceError } from "@aic/contracts";
import { createD1RagInteractionRepository } from "../src/rag-interactions.ts";

const migrationDirectory = new URL("../../../migrations/d1/", import.meta.url);
const at = "2026-09-07T12:00:00.000000Z";
const vectorCitation = {
  vectorId: "a/10:devotional:0002",
  sourceId: "pastorwood:10",
  canonicalUrl: "https://pastorwood.org/synthetic-writing/",
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
    this.binding.runCalls.push({ sql: this.sql, values: this.values });
    const result = this.binding.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class SqliteD1Binding {
  constructor(database) { this.database = database; this.allCalls = []; this.runCalls = []; this.prepareCalls = 0; }
  prepare(sql) { this.prepareCalls += 1; return new SqliteD1Statement(this, sql); }
}

async function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) database.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
  const insert = database.prepare("INSERT INTO users(user_id,clerk_user_id,status,created_at,updated_at) VALUES(?,?,'active',?,?)");
  insert.run("internal-a", "user_clerk_a", at, at);
  insert.run("internal-b", "user_clerk_b", at, at);
  database.prepare(`INSERT INTO episodes
    (episode_id,title,canonical_audio_key,source_system,source_id,status,created_at,updated_at)
    VALUES ('123','Synthetic episode','podcasts/123.mp3','postgresql','123','Draft',?,?)`).run(at, at);
  return database;
}

function operation(overrides = {}) {
  return {
    boundary: "request",
    request: { method: "GET", path: "/api/rag/history" },
    correlation: { correlationId: "synthetic-history" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    userId: "user_clerk_a",
    question: "Synthetic question",
    answer: "Synthetic answer",
    citations: [vectorCitation],
    createdAt: at,
    scope: "writing",
    articleId: "pastorwood:10",
    provider: "silo",
    model: "synthetic-model",
    topK: 8,
    status: "completed",
    durationMs: 12,
    sources: [vectorCitation],
    retrievalLanes: ["article"],
    topEpisodeIds: [],
    coverageNote: "Synthetic coverage",
    totalTokens: 3,
    inputTokens: 2,
    outputTokens: 1,
    ...overrides,
  };
}

async function rejectsSanitized(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "dependency_unavailable");
    assert.equal(error.message, "RAG history is temporarily unavailable.");
    assert.equal(error.cause, undefined);
    assert.equal(error.safeDetails, undefined);
    assert.equal(JSON.stringify(error).includes("synthetic SQL secret"), false);
    return true;
  });
}

test("appends and reads writing history with Clerk identity and no email or raw usage", async () => {
  const database = await fixture();
  try {
    const binding = new SqliteD1Binding(database);
    const repository = createD1RagInteractionRepository({ db: binding, userId: "user_clerk_a" });
    await repository.append(operation(), record());
    const stored = database.prepare("SELECT clerk_user_id,user_email,scope,track_id,article_id,usage_json FROM rag_interactions").get();
    assert.deepEqual({ ...stored }, {
      clerk_user_id: "user_clerk_a", user_email: "", scope: "writing",
      track_id: null, article_id: "pastorwood:10", usage_json: "{}",
    });
    const page = await repository.listForUser(operation(), "user_clerk_a", { limit: 10, scope: "writing", articleId: "pastorwood:10" });
    assert.equal(page.items.length, 1);
    assert.deepEqual(page.items[0], record({ error: "" }));
    assert.equal(binding.allCalls[0].values[0], "user_clerk_a");
    assert.notEqual(binding.allCalls[0].values[0], "internal-a");
    assert.deepEqual(await createD1RagInteractionRepository({ db: binding, userId: "user_clerk_b" }).listForUser(operation(), "user_clerk_b", { limit: 10 }), { items: [] });
  } finally { database.close(); }
});

test("supports service UUID omission and historical non-UUID read IDs", async () => {
  const database = await fixture();
  try {
    const binding = new SqliteD1Binding(database);
    const repository = createD1RagInteractionRepository({ db: binding, userId: "user_clerk_a" });
    const generated = record({ id: undefined, scope: "archive", articleId: undefined });
    await repository.append(operation(), generated);
    assert.match(database.prepare("SELECT id FROM rag_interactions").get().id, /^[0-9a-f-]{36}$/u);
    database.prepare(`INSERT INTO rag_interactions
      (id,clerk_user_id,scope,question,answer,sources_json,created_at)
      VALUES ('legacy-import-id','user_clerk_a','archive','Imported question','Imported answer','[]',?)`).run("2026-09-06T12:00:00.000000Z");
    const page = await repository.listForUser(operation(), "user_clerk_a", { limit: 10 });
    assert.equal(page.items.find((item) => item.id === "legacy-import-id").question, "Imported question");
  } finally { database.close(); }
});

test("rejects cross-user append and list before any SQL", async () => {
  const database = await fixture();
  try {
    const binding = new SqliteD1Binding(database);
    const repository = createD1RagInteractionRepository({ db: binding, userId: "user_clerk_a" });
    const before = binding.prepareCalls;
    await assert.rejects(repository.append(operation(), record({ userId: "user_clerk_b" })), { code: "forbidden" });
    await assert.rejects(repository.listForUser(operation(), "user_clerk_b", { limit: 10 }), { code: "forbidden" });
    assert.equal(binding.prepareCalls, before);
  } finally { database.close(); }
});

test("binds cursors to actor and exact filters with stable keyset pagination", async () => {
  const database = await fixture();
  try {
    const binding = new SqliteD1Binding(database);
    const userA = createD1RagInteractionRepository({ db: binding, userId: "user_clerk_a" });
    const userB = createD1RagInteractionRepository({ db: binding, userId: "user_clerk_b" });
    for (const id of ["00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]) {
      await userA.append(operation(), record({ id, scope: "archive", articleId: undefined }));
    }
    const first = await userA.listForUser(operation(), "user_clerk_a", { limit: 2, scope: "archive" });
    assert.deepEqual(first.items.map((item) => item.id), ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]);
    assert.ok(first.nextCursor);
    const second = await userA.listForUser(operation(), "user_clerk_a", { limit: 2, scope: "archive", cursor: first.nextCursor });
    assert.deepEqual(second.items.map((item) => item.id), ["00000000-0000-4000-8000-000000000003"]);
    await assert.rejects(userA.listForUser(operation(), "user_clerk_a", { limit: 2, scope: "research", cursor: first.nextCursor }), { code: "invalid_argument" });
    await assert.rejects(userB.listForUser(operation(), "user_clerk_b", { limit: 2, scope: "archive", cursor: first.nextCursor }), { code: "forbidden" });
  } finally { database.close(); }
});

test("keeps episode and article filters isolated inside the user predicate", async () => {
  const database = await fixture();
  try {
    const binding = new SqliteD1Binding(database);
    const userA = createD1RagInteractionRepository({ db: binding, userId: "user_clerk_a" });
    const userB = createD1RagInteractionRepository({ db: binding, userId: "user_clerk_b" });
    await userA.append(operation(), record());
    await userA.append(operation(), record({ id: "00000000-0000-4000-8000-000000000002", scope: "episode", articleId: undefined, trackId: "123" }));
    await userB.append(operation(), record({ id: "00000000-0000-4000-8000-000000000003", userId: "user_clerk_b" }));
    assert.deepEqual((await userA.listForUser(operation(), "user_clerk_a", { limit: 10, articleId: "pastorwood:10" })).items.map((item) => item.id), ["00000000-0000-4000-8000-000000000001"]);
    assert.deepEqual((await userA.listForUser(operation(), "user_clerk_a", { limit: 10, trackId: "123" })).items.map((item) => item.id), ["00000000-0000-4000-8000-000000000002"]);
  } finally { database.close(); }
});

test("enforces question, answer, source, row, UUID, target, and generic page bounds", async () => {
  const database = await fixture();
  try {
    const repository = createD1RagInteractionRepository({ db: new SqliteD1Binding(database), userId: "user_clerk_a" });
    const invalidRecords = [
      record({ id: "not-a-uuid" }),
      record({ question: "q".repeat(8001) }),
      record({ answer: "😀".repeat(4097) }),
      record({ citations: Array.from({ length: 121 }, () => vectorCitation) }),
      record({ trackId: "123" }),
      (() => {
        const sources = Array.from({ length: 120 }, (_, i) => ({ ...vectorCitation, canonicalUrl: `https://pastorwood.org/${i}/${"z".repeat(1800)}` }));
        return record({ citations: sources, sources });
      })(),
    ];
    for (const invalidRecord of invalidRecords) await assert.rejects(repository.append(operation(), invalidRecord), { code: "invalid_argument" });
    await assert.rejects(repository.listForUser(operation(), "user_clerk_a", { limit: 101 }), { code: "invalid_argument" });
  } finally { database.close(); }
});

test("preserves vector and non-vector research citations in bounded history", async () => {
  const database = await fixture();
  try {
    const repository = createD1RagInteractionRepository({ db: new SqliteD1Binding(database), userId: "user_clerk_a" });
    const researchCitations = [
      { kind: "vector", citation: vectorCitation },
      { kind: "record", key: "transcript_segments:segment-1", sourceId: "123", canonicalUrl: "/podcast/episodes?trackId=123" },
    ];
    await repository.append(operation(), record({ scope: "research", articleId: undefined, researchCitations }));
    const saved = (await repository.listForUser(operation(), "user_clerk_a", { limit: 10 })).items[0];
    assert.deepEqual(saved.researchCitations, researchCitations);
    assert.deepEqual(saved.citations, [vectorCitation]);
  } finally { database.close(); }
});

test("rejects duplicate/malformed returned rows and strips foreign D1 failures", async () => {
  const row = {
    id: "legacy", clerk_user_id: "user_clerk_a", scope: "archive", track_id: null, article_id: null,
    question: "Q", answer: "A", provider: "", model: "", top_k: 0,
    retrieval_lanes_json: "[]", sources_json: "[]", top_episode_ids_json: "[]",
    coverage_note: "", status: "completed", error: "", duration_ms: 0,
    total_tokens: 0, input_tokens: 0, output_tokens: 0, created_at: at,
  };
  const duplicate = { prepare: () => ({ bind: () => ({ all: async () => ({ success: true, results: [row, row] }) }) }) };
  await assert.rejects(createD1RagInteractionRepository({ db: duplicate, userId: "user_clerk_a" }).listForUser(operation(), "user_clerk_a", { limit: 10 }), { code: "dependency_unavailable" });
  const malformed = { prepare: () => ({ bind: () => ({ all: async () => ({ success: true, results: [{ ...row, sources_json: "{" }] }) }) }) };
  await assert.rejects(createD1RagInteractionRepository({ db: malformed, userId: "user_clerk_a" }).listForUser(operation(), "user_clerk_a", { limit: 10 }), { code: "dependency_unavailable" });
  const foreign = () => new ServiceError({ code: "forbidden", message: "synthetic SQL secret", safeDetails: { raw: "synthetic SQL secret" }, cause: new Error("synthetic SQL secret") });
  const listFailures = [
    (error) => ({ prepare: () => { throw error; } }),
    (error) => ({ prepare: () => ({ bind: () => { throw error; } }) }),
    (error) => ({ prepare: () => ({ bind: () => ({ all: async () => { throw error; } }) }) }),
  ];
  const appendFailures = [
    (error) => ({ prepare: () => { throw error; } }),
    (error) => ({ prepare: () => ({ bind: () => { throw error; } }) }),
    (error) => ({ prepare: () => ({ bind: () => ({ run: async () => { throw error; } }) }) }),
  ];
  for (const makeBinding of listFailures) {
    for (const error of [new Error("synthetic SQL secret"), foreign()]) {
      const repository = createD1RagInteractionRepository({ db: makeBinding(error), userId: "user_clerk_a" });
      await rejectsSanitized(repository.listForUser(operation(), "user_clerk_a", { limit: 10 }));
    }
  }
  for (const makeBinding of appendFailures) {
    for (const error of [new Error("synthetic SQL secret"), foreign()]) {
      const repository = createD1RagInteractionRepository({ db: makeBinding(error), userId: "user_clerk_a" });
      await rejectsSanitized(repository.append(operation(), record()));
    }
  }
});

test("bounds pending D1 history calls by cancellation and deadline", async () => {
  let calls = 0;
  const pending = { prepare: () => ({ bind: () => ({ all: () => { calls += 1; return new Promise(() => {}); } }) }) };
  const repository = createD1RagInteractionRepository({ db: pending, userId: "user_clerk_a" });
  await assert.rejects(repository.listForUser(operation({ deadline: new Date(Date.now() + 75).toISOString() }), "user_clerk_a", { limit: 10 }), { code: "timeout" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(repository.listForUser(operation({ signal: controller.signal }), "user_clerk_a", { limit: 10 }), { code: "cancelled" });
  assert.equal(calls, 1);
});

test("normalizes mixed timestamp precision for chronological keyset pages", async () => {
  const database = await fixture();
  try {
    const binding = new SqliteD1Binding(database);
    const repository = createD1RagInteractionRepository({ db: binding, userId: "user_clerk_a" });
    await repository.append(operation(), record({ id: "00000000-0000-4000-8000-000000000001", createdAt: "2026-09-07T12:00:00.500Z", scope: "archive", articleId: undefined }));
    await repository.append(operation(), record({ id: "00000000-0000-4000-8000-000000000002", createdAt: "2026-09-07T12:00:00.500001Z", scope: "archive", articleId: undefined }));
    database.prepare(`INSERT INTO rag_interactions(id,clerk_user_id,scope,question,answer,sources_json,created_at)
      VALUES ('00000000-0000-4000-8000-000000000003','user_clerk_a','archive','Legacy','Legacy','[]','2026-09-07T12:00:00.500Z')`).run();
    const first = await repository.listForUser(operation(), "user_clerk_a", { limit: 2, scope: "archive" });
    assert.deepEqual(first.items.map((item) => [item.id, item.createdAt]), [
      ["00000000-0000-4000-8000-000000000002", "2026-09-07T12:00:00.500001Z"],
      ["00000000-0000-4000-8000-000000000001", "2026-09-07T12:00:00.500000Z"],
    ]);
    const second = await repository.listForUser(operation(), "user_clerk_a", { limit: 2, scope: "archive", cursor: first.nextCursor });
    assert.deepEqual(second.items.map((item) => [item.id, item.createdAt]), [
      ["00000000-0000-4000-8000-000000000003", "2026-09-07T12:00:00.500000Z"],
    ]);
  } finally { database.close(); }
});

test("rejects malformed history deadlines before D1", async () => {
  const database = await fixture();
  try {
    const binding = new SqliteD1Binding(database);
    const repository = createD1RagInteractionRepository({ db: binding, userId: "user_clerk_a" });
    const before = binding.prepareCalls;
    for (const deadline of ["January 1, 2099", "2099-01-01T00:00:00", "2099-01-01T00:00:00-05:00", "2099-02-30T00:00:00.000Z", "2099-01-01T00:00:00.Z", "2099-01-01T24:00:00Z", "2099-02-29T00:00:00.1Z", "2099-04-31T00:00:00.123456789Z", "2099-01-01T00:00:00+00:00"]) {
      await assert.rejects(repository.listForUser(operation({ deadline }), "user_clerk_a", { limit: 10 }), { code: "invalid_argument" });
    }
    assert.equal(binding.prepareCalls, before);
  } finally { database.close(); }
});

test("admits UTC rag-interactions deadlines independently of fractional precision", async () => {
  const database = await fixture();
  try {
    const binding = new SqliteD1Binding(database);
    const adapter = createD1RagInteractionRepository({ db: binding, userId: "user_clerk_a" });
    for (const fraction of ['', '.1', '.12', '.123', '.123456', '.123456789', `.${'1'.repeat(100)}`]) {
      assert.deepEqual((await adapter.listForUser(operation({ deadline: `2099-01-01T00:00:00${fraction}Z` }), "user_clerk_a", { limit: 10 })).items, []);
    }
    const before = binding.prepareCalls;
    for (const fraction of ['', '.1', '.12', '.123456789']) {
      await assert.rejects(adapter.append(operation(), record({ createdAt: `2026-09-07T12:00:00${fraction}Z` })), { code: "invalid_argument" });
    }
    assert.equal(binding.prepareCalls, before);
  } finally { database.close(); }
});

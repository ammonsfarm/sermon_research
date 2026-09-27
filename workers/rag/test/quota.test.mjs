import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { D1RagQuota } from "../src/quota.ts";

const NOW = 1_800_000_012_345;

class Statement {
  constructor(binding, sql, values = []) { this.binding = binding; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.binding, this.sql, values); }
  async first() {
    this.binding.calls.push({ kind: "first", sql: this.sql, values: this.values });
    return this.binding.database.prepare(this.sql).get(...this.values) ?? null;
  }
  async all() {
    this.binding.calls.push({ kind: "all", sql: this.sql, values: this.values });
    return { success: true, results: this.binding.database.prepare(this.sql).all(...this.values) };
  }
  async run() {
    this.binding.calls.push({ kind: "run", sql: this.sql, values: this.values });
    const result = this.binding.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE users (clerk_user_id TEXT PRIMARY KEY);
    INSERT INTO users VALUES ('user_1');
    CREATE TABLE rag_rate_windows (
      user_id TEXT NOT NULL,
      window_start_ms INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0 CHECK(count >= 0 AND count <= 60),
      PRIMARY KEY (user_id, window_start_ms),
      FOREIGN KEY (user_id) REFERENCES users(clerk_user_id) ON DELETE CASCADE
    );
  `);
  return { database, calls: [], prepare(sql) { return new Statement(this, sql); } };
}

function context() {
  return {
    boundary: "request",
    request: { method: "POST", path: "/api/rag/chat" },
    correlation: { correlationId: "quota-test" },
    signal: new AbortController().signal,
    deadline: new Date(NOW + 55_000).toISOString(),
  };
}

test("atomic concurrent quota admits exactly 60 requests in a 60-second window", async () => {
  const binding = fixture();
  try {
    const quota = new D1RagQuota({ db: binding, now: () => NOW });
    const results = await Promise.all(Array.from({ length: 61 }, () => quota.consume(context(), "user_1")));
    assert.equal(results.filter((result) => result.allowed).length, 60);
    assert.equal(results.filter((result) => !result.allowed).length, 1);
    assert.equal(results.at(-1).retryAfterSeconds, 48);
    assert.equal(binding.database.prepare("SELECT count FROM rag_rate_windows").get().count, 60);
    const writes = binding.calls.filter((call) => call.kind === "first");
    assert.equal(writes.length, 61);
    assert.ok(writes.every((call) => /ON CONFLICT[\s\S]+WHERE count < 60[\s\S]+RETURNING count/iu.test(call.sql)));
    assert.ok(writes.every((call) => !/DELETE/iu.test(call.sql)));
  } finally {
    binding.database.close();
  }
});

test("a new server-time window starts a separate counter and stores no question text", async () => {
  const binding = fixture();
  let now = NOW;
  try {
    const quota = new D1RagQuota({ db: binding, now: () => now });
    assert.equal((await quota.consume(context(), "user_1")).allowed, true);
    now += 60_000;
    assert.equal((await quota.consume(context(), "user_1")).allowed, true);
    const rows = binding.database.prepare("SELECT * FROM rag_rate_windows ORDER BY window_start_ms").all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { user_id: "user_1", window_start_ms: 1_800_000_000_000, count: 1 },
      { user_id: "user_1", window_start_ms: 1_800_000_060_000, count: 1 },
    ]);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["count", "user_id", "window_start_ms"]);
  } finally {
    binding.database.close();
  }
});

test("old-window retention is a separate bounded operation", async () => {
  const binding = fixture();
  try {
    for (let index = 0; index < 8; index += 1) {
      binding.database.prepare("INSERT INTO rag_rate_windows VALUES('user_1', ?, 1)").run(index * 60_000);
    }
    const quota = new D1RagQuota({ db: binding, now: () => NOW });
    assert.equal(await quota.pruneExpired(context(), { retentionMs: 120_000, limit: 3 }), 3);
    assert.equal(binding.database.prepare("SELECT COUNT(*) AS count FROM rag_rate_windows").get().count, 5);
  } finally {
    binding.database.close();
  }
});

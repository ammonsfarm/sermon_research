import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { assignD1UserRole, listD1Users, D1UserAccessRepository } from "../src/index.ts";

function binding(database) {
  return {
    prepare(sql) {
      return {
        sql, values: [],
        bind(...values) { return { ...this, values }; },
        async first() { return database.prepare(this.sql).get(...this.values) ?? null; },
        async all() { return { success: true, results: database.prepare(this.sql).all(...this.values) }; },
      };
    },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const row of statements) database.prepare(row.sql).run(...row.values);
        database.exec("COMMIT");
        return statements.map(() => ({ success: true }));
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}

test("D1 user administration atomically enforces actor authority, unique ownership, last Admin, and audited grants", async () => {
  const database = new DatabaseSync(":memory:");
  const directory = new URL("../../../migrations/d1/", import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) database.exec(readFileSync(new URL(file, directory), "utf8"));
  const db = binding(database);
  for (const [id, email, role] of [["admin", "admin@example.test", "Admin"], ["reader", "reader@example.test", "Read Only"]]) {
    database.prepare("INSERT INTO users(user_id,clerk_user_id,verified_email,created_at,updated_at) VALUES (?,?,?,'2026-01-01T00:00:00.000000Z','2026-01-01T00:00:00.000000Z')").run(id, "user_" + id, email);
    database.prepare("INSERT INTO user_roles(user_id,role,granted_at) VALUES (?,?,'2026-01-01T00:00:00.000000Z')").run(id, role);
  }
  const grant = { email: "reader@example.test", role: "Research User", actorClerkUserId: "user_admin" };
  await assert.rejects(assignD1UserRole(db, { ...grant, actorClerkUserId: "user_reader" }), { code: "conflict" });
  await assert.rejects(assignD1UserRole(db, { ...grant, email: "admin@example.test" }), { code: "conflict" });
  await assert.rejects(assignD1UserRole(db, { ...grant, email: "new@example.test" }), { code: "conflict" });
  assert.equal(database.prepare("SELECT count(*) n FROM admin_operation_audit").get().n, 0);
  assert.equal((await assignD1UserRole(db, grant)).role, "Research User");
  const access = await new D1UserAccessRepository({ db }).getByUserId({ signal: new AbortController().signal }, "user_reader");
  assert.deepEqual(access.roles, ["Research User"]);
  assert.equal(database.prepare("SELECT actor_email FROM admin_operation_audit").get().actor_email, "user_admin");
  assert.equal((await listD1Users(db)).length, 2);
  database.prepare("INSERT INTO users(user_id,clerk_user_id,verified_email,created_at,updated_at) VALUES ('duplicate','user_duplicate','READER@example.test','2026-01-01T00:00:00.000000Z','2026-01-01T00:00:00.000000Z')").run();
  await assert.rejects(assignD1UserRole(db, { ...grant, role: "Admin" }), { code: "conflict" });
  assert.equal(database.prepare("SELECT count(*) n FROM admin_operation_audit").get().n, 1);
  database.close();
});

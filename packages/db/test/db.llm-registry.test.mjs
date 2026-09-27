import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  deleteD1LlmProvider,
  listD1LlmModels,
  listD1LlmProviders,
  listD1LlmUserOverrides,
  resolveD1LlmModelsForUser,
  saveD1LlmModel,
  saveD1LlmProvider,
  setD1DefaultLlmModel,
  setD1LlmRoleAccess,
  setD1LlmUserOverride,
} from "../src/llm-registry.ts";

const migrationDirectory = new URL("../../../migrations/d1/", import.meta.url);
const at = "2026-09-25T12:00:00.000000Z";

class Statement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.database, this.sql, values); }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { success: true, results: this.database.prepare(this.sql).all(...this.values) }; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class Binding {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database, sql); }
  async batch(statements) {
    this.database.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.database.exec("COMMIT"); return results; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}

async function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
  }
  const user = database.prepare("INSERT INTO users(user_id,clerk_user_id,verified_email,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)");
  const role = database.prepare("INSERT INTO user_roles(user_id,role,granted_at) VALUES(?,?,?)");
  user.run("u-admin", "clerk_admin", "admin@example.org", at, at); role.run("u-admin", "Admin", at);
  user.run("u-research", "clerk_research", "research@example.org", at, at); role.run("u-research", "Research User", at);
  user.run("u-reader", "clerk_reader", "reader@example.org", at, at); role.run("u-reader", "Read Only", at);
  const db = new Binding(database);
  for (const [providerId, displayName, baseUrl, remoteModel] of [
    ["gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-3.8-flash"],
    ["muse", "Muse", "https://api.muse.example/v1", "muse-spark-1.3"],
    ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "openai/gpt-6-luna"],
  ]) {
    await saveD1LlmProvider(db, { providerId, displayName, baseUrl, status: "active", apiKey: { ciphertext: `v1:iv:${providerId}`, last4: "abcd" }, actor: "clerk_admin" });
    await saveD1LlmModel(db, { providerId, remoteModel, displayName: remoteModel, apiStyle: "chat", enabled: true });
  }
  return { database, db };
}

test("providers expose key presence and last four characters, never ciphertext", async () => {
  const { db } = await fixture();
  const providers = await listD1LlmProviders(db);
  assert.equal(providers.length, 3);
  assert.equal(providers[0].hasApiKey, true);
  assert.equal(providers[0].apiKeyLast4, "abcd");
  assert.equal(JSON.stringify(providers).includes("v1:iv"), false);
  await saveD1LlmProvider(db, { providerId: "muse", displayName: "Muse", baseUrl: "https://api.muse.example/v1", status: "active", clearApiKey: true, actor: "clerk_admin" });
  assert.equal((await listD1LlmProviders(db)).find((row) => row.providerId === "muse").hasApiKey, false);
});

test("role defaults grant models and user overrides allow or deny on top", async () => {
  const { db } = await fixture();
  await setD1LlmRoleAccess(db, "Research User", ["gemini:gemini-3.8-flash", "muse:muse-spark-1.3"], "clerk_admin");
  await setD1LlmRoleAccess(db, "Admin", ["gemini:gemini-3.8-flash", "muse:muse-spark-1.3", "openrouter:openai/gpt-6-luna"], "clerk_admin");
  const ids = async (clerk) => (await resolveD1LlmModelsForUser(db, clerk)).map((model) => model.modelId);

  assert.deepEqual(await ids("clerk_research"), ["gemini:gemini-3.8-flash", "muse:muse-spark-1.3"]);
  assert.deepEqual(await ids("clerk_reader"), []);

  await setD1LlmUserOverride(db, { clerkUserId: "clerk_research", modelId: "muse:muse-spark-1.3", effect: "deny", actor: "clerk_admin" });
  await setD1LlmUserOverride(db, { clerkUserId: "clerk_research", modelId: "openrouter:openai/gpt-6-luna", effect: "allow", actor: "clerk_admin" });
  assert.deepEqual(await ids("clerk_research"), ["gemini:gemini-3.8-flash", "openrouter:openai/gpt-6-luna"]);
  assert.equal((await listD1LlmUserOverrides(db)).length, 2);

  await setD1LlmUserOverride(db, { clerkUserId: "clerk_research", modelId: "muse:muse-spark-1.3", effect: null, actor: "clerk_admin" });
  assert.deepEqual(await ids("clerk_research"), ["gemini:gemini-3.8-flash", "muse:muse-spark-1.3", "openrouter:openai/gpt-6-luna"]);
});

test("disabled providers, disabled models and missing keys are never resolved", async () => {
  const { db } = await fixture();
  await setD1LlmRoleAccess(db, "Admin", ["gemini:gemini-3.8-flash", "muse:muse-spark-1.3", "openrouter:openai/gpt-6-luna"], "clerk_admin");
  await saveD1LlmProvider(db, { providerId: "gemini", displayName: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", status: "disabled", actor: "clerk_admin" });
  await saveD1LlmModel(db, { providerId: "muse", remoteModel: "muse-spark-1.3", displayName: "Muse Spark 1.3", apiStyle: "chat", enabled: false });
  await saveD1LlmProvider(db, { providerId: "openrouter", displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", status: "active", clearApiKey: true, actor: "clerk_admin" });
  assert.deepEqual(await resolveD1LlmModelsForUser(db, "clerk_admin"), []);
});

test("one default model sorts first and deleting a provider removes its grants", async () => {
  const { db, database } = await fixture();
  await setD1LlmRoleAccess(db, "Admin", ["gemini:gemini-3.8-flash", "openrouter:openai/gpt-6-luna"], "clerk_admin");
  await setD1DefaultLlmModel(db, "openrouter:openai/gpt-6-luna");
  await setD1DefaultLlmModel(db, "openrouter:openai/gpt-6-luna");
  assert.equal((await listD1LlmModels(db)).filter((model) => model.isDefault).length, 1);
  assert.equal((await resolveD1LlmModelsForUser(db, "clerk_admin"))[0].modelId, "openrouter:openai/gpt-6-luna");
  await deleteD1LlmProvider(db, "openrouter");
  assert.equal(database.prepare("SELECT count(*) n FROM llm_model_role_access WHERE model_id LIKE 'openrouter:%'").get().n, 0);
  assert.deepEqual((await resolveD1LlmModelsForUser(db, "clerk_admin")).map((model) => model.modelId), ["gemini:gemini-3.8-flash"]);
});

test("overrides reject unknown users and models", async () => {
  const { db } = await fixture();
  await assert.rejects(setD1LlmUserOverride(db, { clerkUserId: "clerk_nobody", modelId: "gemini:gemini-3.8-flash", effect: "allow", actor: "a" }), { code: "invalid_argument" });
  await assert.rejects(setD1LlmRoleAccess(db, "Wizard", [], "a"), { code: "invalid_argument" });
});

import assert from "node:assert/strict";
import test from "node:test";

import { putKey } from "../src/keys.ts";
import {
  availableModels, chatBody, fetchCatalog, getDefaults, listModels, listProviders, modelChoices, resolveTarget, saveUserModels,
} from "../src/llm.ts";
import { ensureSchema, MIGRATIONS, resetSchemaCache } from "../src/schema.ts";
import { putSetting } from "../src/settings.ts";
import { completeSetup, configureLlm, createApp, fakeProviders, indexedSite, runDocuments, SECRET } from "./helpers.ts";
import { createTestD1 } from "./d1-sqlite.ts";

const messages = [{ role: "user", content: "hi" }] as const;

test("each provider gets its own spelling of the token limit and reasoning effort", () => {
  assert.deepEqual(chatBody({ kind: "openai", model: "gpt-5-mini", effort: "low" }, messages, 100), { model: "gpt-5-mini", messages, max_completion_tokens: 100, reasoning_effort: "low" });
  assert.deepEqual(chatBody({ kind: "google", model: "gemini-2.5-flash", effort: "high" }, messages, 100), { model: "gemini-2.5-flash", messages, max_tokens: 100, reasoning_effort: "high" });
  assert.deepEqual(chatBody({ kind: "meta", model: "muse", effort: "xhigh" }, messages, 100), { model: "muse", messages, max_tokens: 100, reasoning_effort: "xhigh" });
  assert.deepEqual(chatBody({ kind: "openrouter", model: "a/b", effort: "medium" }, messages, 100), { model: "a/b", messages, max_tokens: 100, reasoning: { effort: "medium" } });
  assert.deepEqual(chatBody({ kind: "custom", model: "m", effort: null }, messages, 100), { model: "m", messages, max_tokens: 100 }, "no effort, no field");
  assert.deepEqual(chatBody({ kind: "openai", model: "gpt-4o", effort: null }, messages, 100), { model: "gpt-4o", messages, max_completion_tokens: 100 });
});

test("Anthropic's compatibility layer ignores reasoning_effort, so effort becomes a thinking budget that max_tokens covers", () => {
  const low = chatBody({ kind: "anthropic", model: "claude-x", effort: "low" }, messages, 1000);
  assert.deepEqual(low.thinking, { type: "enabled", budget_tokens: 2048 });
  assert.equal(low.max_tokens, 3048, "the answer keeps its own room");
  assert.equal("reasoning_effort" in low, false);
  const off = chatBody({ kind: "anthropic", model: "claude-x", effort: "none" }, messages, 1000);
  assert.equal("thinking" in off, false);
  assert.equal(off.max_tokens, 1000);
  assert.equal(chatBody({ kind: "anthropic", model: "claude-x", effort: "max" }, messages, 60_000).max_tokens, 64_000, "capped at the output limit");
});

test("model lists are read per provider, with each model's reasoning levels", async () => {
  const lists: Record<string, unknown> = {
    "https://api.openai.com/v1/models": { data: [{ id: "gpt-5-mini" }, { id: "gpt-5.1" }, { id: "gpt-5.2" }, { id: "o3" }, { id: "gpt-4o" }, { id: "gpt-5-chat-latest" }, { id: "text-embedding-3-small" }, { id: "gpt-4o-transcribe" }, { id: "whisper-1" }] },
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000": { models: [
      { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1048576 },
      { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.0-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
    ] },
    "https://api.anthropic.com/v1/models?limit=1000": { data: [
      { id: "claude-a", display_name: "Claude A", max_input_tokens: 200000, capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, max: { supported: false } } } },
      { id: "claude-old", display_name: "Claude Old", capabilities: { effort: { supported: false } } },
    ], has_more: false },
    "https://openrouter.ai/api/v1/models": { data: [
      { id: "x/think", name: "X: Think", context_length: 1000, architecture: { output_modalities: ["text"] }, reasoning: { mandatory: true, supported_efforts: ["high", "medium", "low"] } },
      { id: "x/maybe", name: "X: Maybe", architecture: { output_modalities: ["text"] }, supported_parameters: ["reasoning"] },
      { id: "x/plain", name: "X: Plain", architecture: { output_modalities: ["text"] }, supported_parameters: ["max_tokens"] },
      { id: "x/image", name: "X: Image", architecture: { output_modalities: ["image"] } },
    ] },
    "https://api.meta.ai/v1/models": { data: [{ id: "muse-a" }] },
    "https://gateway.example/v1/models": { data: [{ id: "house" }] },
  };
  const seen: Record<string, Headers> = {};
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen[url] = new Headers(init?.headers);
    return lists[url] ? Response.json(lists[url]) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  const list = async (kind: "openai" | "google" | "anthropic" | "openrouter" | "meta" | "custom", baseUrl: string) =>
    (await fetchCatalog({ kind, name: kind, baseUrl }, "key", fetcher)).map((model) => [model.modelId, model.efforts.join(",")]);

  assert.deepEqual(await list("openai", "https://api.openai.com/v1"), [
    ["gpt-4o", ""], ["gpt-5-chat-latest", ""], ["gpt-5-mini", "minimal,low,medium,high"], ["gpt-5.1", "none,low,medium,high"], ["gpt-5.2", "none,low,medium,high,xhigh"], ["o3", "low,medium,high"],
  ]);
  assert.deepEqual(await list("google", "https://generativelanguage.googleapis.com/v1beta/openai"), [
    ["gemini-2.5-flash", "none,minimal,low,medium,high"], ["gemini-2.5-pro", "low,medium,high"], ["gemini-2.0-flash", ""], ["gemini-3-flash", "minimal,low,medium,high"],
  ]);
  assert.equal(seen["https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"]!.get("x-goog-api-key"), "key");
  assert.deepEqual(await list("anthropic", "https://api.anthropic.com/v1"), [["claude-a", "none,low,medium,high"], ["claude-old", ""]]);
  assert.equal(seen["https://api.anthropic.com/v1/models?limit=1000"]!.get("anthropic-version"), "2023-06-01");
  assert.deepEqual(await list("openrouter", "https://openrouter.ai/api/v1"), [["x/maybe", "none,low,medium,high"], ["x/plain", ""], ["x/think", "low,medium,high"]]);
  assert.deepEqual(await list("meta", "https://api.meta.ai/v1"), [["muse-a", "none,minimal,low,medium,high,xhigh,max"]]);
  assert.deepEqual(await list("custom", "https://gateway.example/v1/"), [["house", ""]]);
  await assert.rejects(fetchCatalog({ kind: "custom", name: "Gateway", baseUrl: "https://nowhere.example/v1" }, "k", fetcher), /Gateway returned HTTP 404 when listing models/);
});

test("an admin saves a key, pulls the model list, adds some or all, and sets the defaults", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  const providers = fakeProviders();
  try {
    const page = await (await app.request("/admin/llm", { cookie })).text();
    for (const name of ["Meta (Muse)", "Google Gemini", "OpenAI", "Anthropic", "OpenRouter"]) assert.match(page, new RegExp(`<h3>${name.replace(/[()]/gu, "\\$&")} `), `${name} is offered by default`);
    assert.match(page, /Key ending 1234 saved · 1 model added/);

    const keyed = await app.request("/admin/llm/provider/meta", { form: { apiKey: "meta-secret-9876" }, cookie });
    assert.equal(keyed.headers.get("Location"), "/admin/llm?notice=key#p-meta");
    assert.match(await (await app.request("/admin/llm?notice=key", { cookie })).text(), /Key ending 9876 saved[\s\S]*Pull the list of models/);

    const pulled = await (await app.request("/admin/llm/provider/meta/fetch", { method: "POST", form: {}, cookie })).text();
    assert.equal(providers.calls.at(-1)?.authorization, "Bearer meta-secret-9876");
    assert.match(pulled, /2 found/);
    assert.match(pulled, /<input type="checkbox" name="model" value="muse-test">/);
    const some = await app.request("/admin/llm/provider/meta/add", { form: { model: ["muse-test"] }, cookie });
    assert.equal(some.headers.get("Location"), "/admin/llm?notice=added#models");
    assert.deepEqual((await listModels(app.env.DB, "meta")).map((model) => model.modelId), ["muse-test"]);
    const none = await app.request("/admin/llm/provider/meta/add", { form: {}, cookie });
    assert.equal(none.status, 400);

    const again = await (await app.request("/admin/llm/provider/meta/fetch", { form: {}, cookie })).text();
    assert.match(again, /name="model" value="muse-test" checked disabled/, "added models are marked, not duplicated");
    await app.request("/admin/llm/provider/meta/add", { form: { all: "1" }, cookie });
    assert.deepEqual((await listModels(app.env.DB, "meta")).map((model) => model.modelId), ["muse-test", "muse-two"]);

    // OpenAI's list drops non-chat models.
    const openai = await (await app.request("/admin/llm/provider/openai/fetch", { form: { q: "gpt-5" }, cookie })).text();
    assert.match(openai, /gpt-5-mini/);
    assert.doesNotMatch(openai, /text-embedding|transcribe|gpt-test/);

    // Defaults: effort must be one the model takes.
    const bogus = await app.request("/admin/llm/defaults", { form: { summaryModel: "openai/gpt-test", chatModel: "meta/muse-two", chatEffort: "extreme", documentModel: "meta/muse-two" }, cookie });
    assert.equal(bogus.status, 400);
    assert.match(await bogus.text(), /Choose a reasoning effort from the list/);
    const ok = await app.request("/admin/llm/defaults", { form: { summaryModel: "openai/gpt-test", summaryEffort: "", chatModel: "meta/muse-two", chatEffort: "max", documentModel: "meta/muse-test", documentEffort: "high" }, cookie });
    assert.equal(ok.headers.get("Location"), "/admin/llm?notice=saved#defaults");
    assert.deepEqual(await getDefaults(app.env.DB), {
      summary: { provider: "openai", model: "gpt-test", effort: null },
      chat: { provider: "meta", model: "muse-two", effort: "max" },
      document: { provider: "meta", model: "muse-test", effort: "high" },
    });
    const unknown = await app.request("/admin/llm/defaults", { form: { summaryModel: "meta/ghost", chatModel: "meta/muse-two", documentModel: "meta/muse-two" }, cookie });
    assert.equal(unknown.status, 400);
    assert.match(await unknown.text(), /Choose a model from the list/);

    // A model turned off can't be chosen or used.
    await app.request("/admin/llm/model/toggle", { form: { key: "meta/muse-two" }, cookie });
    assert.deepEqual((await availableModels(app.env.DB)).map((model) => model.modelId).sort(), ["gpt-test", "muse-test"]);
    await assert.rejects(resolveTarget(app.env, { action: "chat" }), /isn't available/);

    // Edit a model's levels.
    const edit = await app.request("/admin/llm/model", { form: { key: "meta/muse-test", label: "Muse Test", effort: ["low", "high"], defaultEffort: "high" }, cookie });
    assert.equal(edit.headers.get("Location"), "/admin/llm?notice=saved#models");
    const [muse] = await listModels(app.env.DB, "meta");
    assert.deepEqual([muse?.label, muse?.efforts, muse?.defaultEffort], ["Muse Test", ["low", "high"], "high"]);
    const mismatch = await app.request("/admin/llm/model", { form: { key: "meta/muse-test", label: "x", effort: ["low"], defaultEffort: "high" }, cookie });
    assert.equal(mismatch.status, 400);
    const unsupported = await app.request("/admin/llm/defaults", { form: { summaryModel: "openai/gpt-test", chatModel: "meta/muse-test", chatEffort: "max", documentModel: "meta/muse-test" }, cookie });
    assert.equal(unsupported.status, 400);
    assert.match(await unsupported.text(), /Muse Test doesn&#39;t take maximum effort. It takes low, high/);

    // Removing a key makes the provider's models unusable; removing a model drops it.
    await app.request("/admin/llm/provider/meta/remove", { form: {}, cookie });
    assert.equal((await availableModels(app.env.DB)).some((model) => model.providerId === "meta"), false);
    await app.request("/admin/llm/model/remove", { form: { key: "meta/muse-test" }, cookie });
    assert.equal((await listModels(app.env.DB, "meta")).some((model) => model.modelId === "muse-test"), false);
  } finally {
    providers.restore();
  }
});

test("a model can be added by name after a test request, and other providers can be added", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  const providers = fakeProviders();
  try {
    await app.request("/admin/llm/provider/meta", { form: { apiKey: "meta-key" }, cookie });
    const added = await app.request("/admin/llm/model/add", { form: { provider: "meta", modelId: "muse-test" }, cookie });
    assert.equal(added.headers.get("Location"), "/admin/llm?notice=added#models");
    const [model] = await listModels(app.env.DB, "meta");
    assert.deepEqual(model?.efforts, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

    const refused = fakeProviders({ "https://api.openai.com/v1/chat": 404 });
    try {
      const missing = await app.request("/admin/llm/model/add", { form: { provider: "openai", modelId: "gpt-nope" }, cookie });
      assert.equal(missing.status, 400);
      assert.match(await missing.text(), /OpenAI returned HTTP 404 for gpt-nope/);
    } finally {
      refused.restore();
    }
    assert.equal((await listModels(app.env.DB, "openai")).some((each) => each.modelId === "gpt-nope"), false);

    const custom = await app.request("/admin/llm/provider", { form: { name: "House AI", baseUrl: "https://ai.house.example/v1/", apiKey: "house-key-4444" }, cookie });
    assert.equal(custom.headers.get("Location"), "/admin/llm?notice=key#p-house-ai");
    const house = (await listProviders(app.env.DB)).find((provider) => provider.id === "house-ai");
    assert.deepEqual([house?.kind, house?.baseUrl, house?.keyLast4], ["custom", "https://ai.house.example/v1", "4444"]);
    assert.equal((await app.request("/admin/llm/provider", { form: { name: "Bad", baseUrl: "http://x.example", apiKey: "k" }, cookie })).status, 400);
    await app.request("/admin/llm/provider/house-ai/remove", { form: {}, cookie });
    assert.equal((await listProviders(app.env.DB)).some((provider) => provider.id === "house-ai"), false);
    assert.equal(await app.env.DB.prepare("SELECT 1 FROM provider_keys WHERE slot = 'llm:house-ai'").first(), null);
  } finally {
    providers.restore();
  }
});

test("a person limited to some models can only pick, and is only answered by, those", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  await configureLlm(app.env, { provider: "meta", model: "muse-a" });
  await configureLlm(app.env, { provider: "meta", model: "muse-b" });
  await putSetting(app.env.DB, "llm_defaults", {
    summary: { provider: "openai", model: "gpt-test", effort: null },
    chat: { provider: "openai", model: "gpt-test", effort: null },
    document: { provider: "openai", model: "gpt-test", effort: null },
  });
  const member = await app.env.DB.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 'm@x.org', 'Mary', 'member', NULL, '', '') RETURNING id").first<{ id: string }>();
  const id = member!.id;

  assert.equal((await modelChoices(app.env.DB, id)).length, 3, "everyone sees every model by default");
  assert.deepEqual(await modelChoices(app.env.DB, null), [], "visitors don't choose");
  assert.equal((await resolveTarget(app.env, { action: "chat", userId: id })).model, "gpt-test");

  const page = await (await app.request(`/admin/llm/users/${id}`, { cookie })).text();
  assert.match(page, /name="mode" value="site" checked/);
  const empty = await app.request(`/admin/llm/users/${id}`, { form: { mode: "only" }, cookie });
  assert.equal(empty.status, 400, "limiting to nothing is refused");
  const saved = await app.request(`/admin/llm/users/${id}`, { form: { mode: "only", model: ["meta/muse-a", "meta/ghost"] }, cookie });
  assert.equal(saved.headers.get("Location"), "/admin/llm/users");
  assert.match(await (await app.request("/admin/llm/users", { cookie })).text(), /Mary[\s\S]*1 chosen/);

  assert.deepEqual((await modelChoices(app.env.DB, id)).length, 0, "one model is no choice");
  const limited = await resolveTarget(app.env, { action: "chat", userId: id });
  assert.equal(limited.model, "muse-a", "the site default isn't theirs, so their first model answers");
  assert.equal((await resolveTarget(app.env, { action: "chat", userId: id, choice: "openai/gpt-test" })).model, "muse-a", "a choice outside their list is ignored");
  assert.equal((await resolveTarget(app.env, { action: "chat", userId: null })).model, "gpt-test", "sermon processing and visitors follow the site");
  assert.equal((await resolveTarget(app.env, { action: "chat" , userId: "someone-else", choice: "meta/muse-b" })).model, "muse-b", "an unlimited person may choose any model");

  await saveUserModels(app.env.DB, id, ["meta/muse-a", "meta/muse-b"]);
  assert.equal((await resolveTarget(app.env, { action: "chat", userId: id, choice: "meta/muse-b" })).model, "muse-b");
  await app.request(`/admin/llm/users/${id}`, { form: { mode: "site" }, cookie });
  assert.equal((await resolveTarget(app.env, { action: "chat", userId: id })).model, "gpt-test", "back to the site list");
});

test("the Ask box offers a model choice when there is one, and a document remembers it and is written with it", async () => {
  const site = await indexedSite();
  try {
    await configureLlm(site.app.env, { provider: "meta", model: "muse-a", effort: "low" });
    await putSetting(site.app.env.DB, "llm_defaults", {
      summary: { provider: "openai", model: "gpt-test", effort: null },
      chat: { provider: "openai", model: "gpt-test", effort: null },
      document: { provider: "openai", model: "gpt-test", effort: null },
    });
    const home = await (await site.app.request("/", { cookie: site.cookie })).text();
    assert.match(home, /<select id="f-model" name="model"><option value="">Site default<\/option><option value="meta\/muse-a">Meta \(Muse\) · muse-a<\/option><option value="openai\/gpt-test">OpenAI · gpt-test<\/option>/);

    await site.app.request("/research", { form: { question: "An outline on grace", kind: "outline", model: "meta/muse-a" }, cookie: site.cookie });
    const row = await site.app.env.DB.prepare("SELECT model FROM documents").first<{ model: string }>();
    assert.equal(row?.model, "meta/muse-a");
    const start = site.providers.calls.length;
    await runDocuments(site.app);
    const writing = site.providers.calls.slice(start).filter((call) => call.url.endsWith("/chat/completions"));
    assert.ok(writing.length > 0 && writing.every((call) => call.url === "https://api.meta.ai/v1/chat/completions"), "written with the model asked for");

    await site.app.request("/research", { form: { question: "What is grace?", model: "meta/muse-a" }, cookie: site.cookie });
    assert.equal(site.providers.calls.findLast((call) => call.url.endsWith("/chat/completions"))!.url, "https://api.meta.ai/v1/chat/completions", "answers use it too");
    await site.app.request("/research", { form: { question: "What is faith?", model: "meta/ghost" }, cookie: site.cookie });
    assert.equal(site.providers.calls.findLast((call) => call.url.endsWith("/chat/completions"))!.url, "https://api.openai.com/v1/chat/completions", "an unknown choice falls back to the site default");
  } finally {
    site.restore();
  }
});

test("a site that had one answers AI keeps its provider, key, model and efforts", async () => {
  const db = createTestD1();
  resetSchemaCache();
  await db.prepare("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)").run();
  for (const migration of MIGRATIONS.filter((each) => each.version < 15)) {
    await db.batch([...migration.statements.map((sql) => db.prepare(sql)), db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, '')").bind(migration.version)]);
  }
  await putSetting(db, "llm", { baseUrl: "https://api.meta.ai/v1", model: "muse-old", summaryEffort: "high", chatEffort: "minimal", checkedAt: "" });
  await putKey(db, SECRET, "llm", "legacy-key-7777");
  await ensureSchema(db);
  const env = { DB: db, APP_SECRET: SECRET } as never;

  const meta = (await listProviders(db)).find((provider) => provider.id === "meta");
  assert.equal(meta?.keyLast4, "7777", "the old key stays where it is");
  assert.equal((await listProviders(db)).length, 5);
  const [model] = await listModels(db);
  assert.deepEqual([model?.providerId, model?.modelId, model?.efforts.length], ["meta", "muse-old", 7]);
  assert.deepEqual(await getDefaults(db), {
    summary: { provider: "meta", model: "muse-old", effort: "high" },
    chat: { provider: "meta", model: "muse-old", effort: "minimal" },
    document: { provider: "meta", model: "muse-old", effort: "minimal" },
  });
  const target = await resolveTarget(env, { action: "summary" });
  assert.deepEqual([target.apiKey, target.effort, target.baseUrl], ["legacy-key-7777", "high", "https://api.meta.ai/v1"]);

  // An address that isn't one of the five becomes a custom provider.
  const other = createTestD1();
  resetSchemaCache();
  await other.prepare("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)").run();
  for (const migration of MIGRATIONS.filter((each) => each.version < 15)) {
    await other.batch([...migration.statements.map((sql) => other.prepare(sql)), other.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, '')").bind(migration.version)]);
  }
  await putSetting(other, "llm", { baseUrl: "https://gateway.example/v1/", model: "house", checkedAt: "" });
  await ensureSchema(other);
  const custom = (await listProviders(other)).find((provider) => provider.id === "custom");
  assert.deepEqual([custom?.kind, custom?.baseUrl, custom?.keySlot], ["custom", "https://gateway.example/v1", "llm"]);
  assert.deepEqual((await getDefaults(other)).chat, { provider: "custom", model: "house", effort: "low" });
  assert.deepEqual((await listModels(other))[0]?.efforts, [], "a gateway gets no reasoning field");
});

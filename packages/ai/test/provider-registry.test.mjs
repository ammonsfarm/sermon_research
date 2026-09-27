import assert from "node:assert/strict";
import test from "node:test";

import {
  createTextGenerationProvider,
  priceTier,
  decryptProviderApiKey,
  encryptProviderApiKey,
  normalizeProviderBaseUrl,
  preferredApiStyle,
  probeLlmProvider,
} from "../src/index.ts";

const secret = btoa(String.fromCharCode(...new Uint8Array(32).map((_, index) => index + 1)));

test("API keys round-trip and are bound to their provider id", async () => {
  const sealed = await encryptProviderApiKey(secret, "gemini", "sk-test-1234567890");
  assert.match(sealed, /^v1:[^:]+:[^:]+$/u);
  assert.equal(sealed.includes("1234567890"), false);
  assert.equal(await decryptProviderApiKey(secret, "gemini", sealed), "sk-test-1234567890");
  await assert.rejects(decryptProviderApiKey(secret, "openrouter", sealed), { code: "dependency_unavailable" });
  await assert.rejects(encryptProviderApiKey("c2hvcnQ=", "gemini", "sk-test-1234567890"), { code: "invalid_argument" });
});

test("provider URLs are public HTTPS bases with endpoint suffixes removed", () => {
  assert.equal(normalizeProviderBaseUrl("https://openrouter.ai/api/v1/chat/completions"), "https://openrouter.ai/api/v1");
  assert.equal(normalizeProviderBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai/"), "https://generativelanguage.googleapis.com/v1beta/openai");
  for (const bad of ["http://api.example.com/v1", "https://192.168.0.10:4041/v1", "https://user:pw@api.example.com/v1", "https://api.example.com/v1?key=x", "not a url"]) {
    assert.throws(() => normalizeProviderBaseUrl(bad), { code: "invalid_argument" }, bad);
  }
});

test("probe classifies chat, completions and responses support", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "models/gemini-3.8-flash" }, { id: "gemini-3.8-pro" }] });
    if (String(url).endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "p" } }] });
    if (String(url).endsWith("/completions")) return new Response("", { status: 404 });
    if (String(url).endsWith("/responses")) return new Response("", { status: 400 });
    return new Response("", { status: 404 });
  };
  const result = await probeLlmProvider({ fetch, baseUrl: "https://api.example.com/v1", apiKey: "sk-test-123456", model: "gemini-3.8-flash" });
  assert.deepEqual(result.capabilities.models, ["gemini-3.8-flash", "gemini-3.8-pro"]);
  assert.equal(result.capabilities.chat, true);
  assert.equal(result.capabilities.completions, false);
  assert.equal(result.capabilities.responses, null);
  assert.equal(result.capabilities.websocket, false);
  assert.equal(result.capabilities.transport, "https");
  assert.equal(result.error, null);
  assert.equal(preferredApiStyle(result.capabilities), "chat");
});

test("probe reports rejected keys without throwing", async () => {
  const fetch = async () => new Response("", { status: 401 });
  const result = await probeLlmProvider({ fetch, baseUrl: "https://api.example.com/v1", apiKey: "sk-bad-123456" });
  assert.match(result.error, /rejected the API key/u);
  assert.equal(result.capabilities.chat, null);
});

const citation = { sourceId: "S1", title: "Episode", text: "Abide in Christ.", canonicalUrl: "https://example.org/e/1" };
const request = (model) => ({ model, system: "Cite sources.", prompt: "What?", maxOutputTokens: 64, context: [citation] });
const context = { signal: new AbortController().signal };

for (const [apiStyle, suffix, reply] of [
  ["chat", "/chat/completions", { choices: [{ message: { content: "Abide [S1]." } }] }],
  ["completions", "/completions", { choices: [{ text: "Abide [S1]." }] }],
  ["responses", "/responses", { output: [{ type: "message", content: [{ type: "output_text", text: "Abide [S1]." }] }] }],
]) {
  test(`registry generation routes ${apiStyle} requests to the provider`, async () => {
    let seen;
    const fetch = async (url, init) => { seen = { url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization }; return Response.json(reply); };
    const model = { provider: "registry", model: "openrouter:openai/gpt-6-luna" };
    const provider = createTextGenerationProvider({
      fetch,
      allowedModels: [model],
      registry: new Map([[model.model, { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-123456", remoteModel: "openai/gpt-6-luna", apiStyle }]]),
    });
    const answer = await provider.generate(context, request(model));
    assert.equal(seen.url, `https://openrouter.ai/api/v1${suffix}`);
    assert.equal(seen.body.model, "openai/gpt-6-luna");
    assert.equal(seen.auth, "Bearer sk-or-123456");
    assert.equal(answer.text, "Abide [S1].");
    assert.deepEqual(answer.citedSourceIds, ["S1"]);
  });
}

test("registry generation refuses a model without a resolved endpoint", async () => {
  const model = { provider: "registry", model: "missing:model" };
  const provider = createTextGenerationProvider({ fetch: async () => Response.json({}), allowedModels: [model] });
  await assert.rejects(provider.generate(context, request(model)), { code: "dependency_unavailable" });
});

test("probe keeps large model catalogs such as OpenRouter's", async () => {
  const data = Array.from({ length: 1_500 }, (_, index) => ({ id: `vendor/model-${String(index).padStart(4, "0")}`, description: "x".repeat(1_500) }));
  const fetch = async (url) => String(url).endsWith("/models") ? Response.json({ data }) : Response.json({ choices: [{ message: { content: "p" } }] });
  const result = await probeLlmProvider({ fetch, baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-123456", model: "vendor/model-0001" });
  assert.equal(result.capabilities.models.length, 1_500);
  assert.equal(result.error, null);
});

test("probe records per-model pricing and cost tiers when the provider publishes them", async () => {
  const data = [
    { id: "meta-llama/llama-4:free", name: "Llama 4 (free)", context_length: 131072, pricing: { prompt: "0", completion: "0" } },
    { id: "openai/gpt-6-luna", name: "GPT 6 Luna", context_length: 400000, pricing: { prompt: "0.0000025", completion: "0.00001" } },
    { id: "openrouter/auto", name: "Auto", pricing: { prompt: "-1", completion: "-1" } },
  ];
  const fetch = async (url) => String(url).endsWith("/models") ? Response.json({ data }) : Response.json({ choices: [{ message: { content: "p" } }] });
  const { capabilities } = await probeLlmProvider({ fetch, baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-123456", model: "openai/gpt-6-luna" });
  const byId = Object.fromEntries(capabilities.modelDetails.map((detail) => [detail.id, detail]));
  assert.equal(byId["meta-llama/llama-4:free"].tier, "free");
  assert.deepEqual([byId["openai/gpt-6-luna"].inputPerMillion, byId["openai/gpt-6-luna"].outputPerMillion, byId["openai/gpt-6-luna"].tier], [2.5, 10, "$$$"]);
  assert.equal(byId["openrouter/auto"].tier, null);
  assert.equal(byId["openai/gpt-6-luna"].contextLength, 400000);
});

test("price tiers bucket the blended per-million price", () => {
  assert.deepEqual([priceTier(0, 0), priceTier(0.2, 0.6), priceTier(2, 6), priceTier(5, 15), priceTier(15, 75), priceTier(null, 1)], ["free", "$", "$$", "$$$", "$$$$", null]);
});

test("providers without pricing keep a plain model list", async () => {
  const fetch = async (url) => String(url).endsWith("/models") ? Response.json({ data: [{ id: "muse-spark-1.3" }] }) : Response.json({ choices: [{ message: { content: "p" } }] });
  const { capabilities } = await probeLlmProvider({ fetch, baseUrl: "https://api.meta.ai/v1", apiKey: "sk-meta-123456", model: "muse-spark-1.3" });
  assert.deepEqual(capabilities.models, ["muse-spark-1.3"]);
  assert.equal(capabilities.modelDetails, undefined);
});

test("ordinary Markdown labels are not mistaken for generated links", async () => {
  const model = { provider: "registry", model: "gemini:gemini-3.8-flash" };
  const reply = (content) => async () => Response.json({ choices: [{ message: { content } }] });
  const make = (content) => createTextGenerationProvider({
    fetch: reply(content),
    allowedModels: [model],
    registry: new Map([[model.model, { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "sk-test-123456", remoteModel: "gemini-3.8-flash", apiStyle: "chat" }]]),
  });
  const answer = await make("**Key point:** abide daily [S1]. Q&A:Part 6 and John 15:4 agree [S1].").generate(context, request(model));
  assert.match(answer.text, /Key point/u);
  for (const bad of ["See https://evil.example [S1].", "Visit www.evil.example [S1].", "Click [here](x) [S1].", "javascript:alert(1) [S1]"]) {
    await assert.rejects(make(bad).generate(context, request(model)), { code: "dependency_unavailable" }, bad);
  }
});

test("chat replies whose content is a list of parts are accepted", async () => {
  const model = { provider: "registry", model: "muse:muse-spark-1.3" };
  const provider = createTextGenerationProvider({
    fetch: async () => Response.json({ choices: [{ message: { content: [{ type: "text", text: "Abide in Him [S1]." }] }, finish_reason: "stop" }] }),
    allowedModels: [model],
    registry: new Map([[model.model, { baseUrl: "https://api.meta.ai/v1", apiKey: "sk-test-123456", remoteModel: "muse-spark-1.3", apiStyle: "chat" }]]),
  });
  assert.equal((await provider.generate(context, request(model))).text, "Abide in Him [S1].");
});

test("adjacent citations and citation-list lines are not treated as links", async () => {
  const model = { provider: "registry", model: "openrouter:openai/gpt-6-luna" };
  const make = (content) => createTextGenerationProvider({
    fetch: async () => Response.json({ choices: [{ message: { content } }] }),
    allowedModels: [model],
    registry: new Map([[model.model, { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-123456", remoteModel: "openai/gpt-6-luna", apiStyle: "chat" }]]),
  });
  const twoSources = { ...request(model), context: [citation, { ...citation, sourceId: "S2", title: "Episode 2" }] };
  const ok = await make("Grace is a gift [S1][S2].\n[S1]: Sola Gratia episode.").generate(context, twoSources);
  assert.match(ok.text, /\[S1\]\[S2\]/u);
  for (const bad of ["See [the episode][ref] [S1].", "[ref]: https://x.example\nGrace [S1].", "Grace [S1] ![img](x)"]) {
    await assert.rejects(make(bad).generate(context, request(model)), { code: "dependency_unavailable" }, bad);
  }
});

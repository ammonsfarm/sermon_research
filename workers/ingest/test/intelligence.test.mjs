import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SILO_INTELLIGENCE_TOKENS,
  createGeminiIntelligenceProvider,
  createSiloIntelligenceProvider,
} from "../src/intelligence.ts";

const validOptions = (overrides = {}) => ({
  fetch: async () => assert.fail("unexpected provider request"),
  url: "https://silo.example.invalid/v1/chat/completions",
  apiKey: "synthetic-silo-key",
  model: "synthetic-intelligence-model",
  backendMode: "codex-direct",
  reasoning: "medium",
  maxTokens: "4096",
  ...overrides,
});

const input = {
  episodeId: "synthetic-episode",
  title: "Synthetic episode",
  publishDate: "2026-09-21",
  transcript: "Synthetic persisted transcript.",
  transcriptTruncated: false,
};

test("Silo gateway timeout preserves unknown-outcome quarantine classification", async () => {
  const provider = createSiloIntelligenceProvider(validOptions({ fetch: async () => new Response(null, { status: 504 }) }));
  await assert.rejects(provider.generate(input), { name: "IntelligenceProviderError", code: "provider_timeout_unknown" });
});

test("Silo intelligence sends the frozen backend, reasoning shape, and bounded output limit", async () => {
  let outbound;
  const provider = createSiloIntelligenceProvider(validOptions({
    fetch: async (request) => {
      outbound = JSON.parse(await request.text());
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          episodeType: "sermon",
          executiveSummary: "Synthetic summary.",
          longSummary: "Synthetic long summary.",
          mainTopics: ["faith"],
          searchKeywords: ["faith"],
          items: [],
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  }));

  const result = await provider.generate(input);
  assert.equal(result.model, "synthetic-intelligence-model");
  assert.equal(outbound.model, "synthetic-intelligence-model");
  assert.equal(outbound.backend_mode, "codex-direct");
  assert.deepEqual(outbound.reasoning, { effort: "medium" });
  assert.equal(outbound.max_tokens, 4096);
  assert.equal(outbound.stream, false);
  assert.equal("reasoning_effort" in outbound, false);
  assert.match(outbound.messages[0].content, /confidence \(string\)/u);
  assert.match(outbound.messages[0].content, /value \(JSON object, never a string\)/u);
});

test("Silo intelligence rejects invalid provider configuration before any request", () => {
  let requests = 0;
  const fetch = async () => {
    requests += 1;
    return new Response("{}");
  };
  for (const override of [
    { model: "" },
    { model: "\u0000invalid" },
    { backendMode: "auto" },
    { backendMode: "openai-responses", model: "gpt-5.6-luna" },
    { environment: "production", backendMode: "openai-responses", model: "gpt-5.6-luna" },
    { environment: "development", backendMode: "openai-responses", model: "openai-codex/gpt-5.6-luna" },
    { reasoning: "" },
    { reasoning: "xhigh" },
    { maxTokens: 0 },
    { maxTokens: "04096" },
    { maxTokens: "4096.5" },
    { maxTokens: MAX_SILO_INTELLIGENCE_TOKENS + 1 },
  ]) {
    assert.throws(() => createSiloIntelligenceProvider(validOptions({ fetch, ...override })), {
      name: "IntelligenceProviderError",
      code: "configuration",
    });
  }
  assert.equal(requests, 0);
});

test("Gemini intelligence sends OpenAI-compatible JSON mode payload and returns structured artifact", async () => {
  let outbound;
  let outboundHeaders;
  const provider = createGeminiIntelligenceProvider({
    apiKey: "synthetic-gemini-key",
    model: "gemini-3.8-flash",
    fetch: async (request) => {
      outbound = JSON.parse(await request.text());
      outboundHeaders = request.headers;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              episodeType: "interview",
              executiveSummary: "Gemini summary.",
              longSummary: "Gemini long summary.",
              mainTopics: ["technology"],
              searchKeywords: ["ai", "cloudflare"],
              items: [{
                itemType: "key_point",
                label: "Point 1",
                summary: "Details of point 1",
                sourceTimes: ["00:01:00"],
                speakers: ["Host"],
                confidence: "high",
                value: { key: "val" },
              }],
            }),
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await provider.generate(input);
  assert.equal(result.model, "gemini-3.8-flash");
  assert.equal(result.episodeType, "interview");
  assert.equal(result.items.length, 1);
  assert.equal(outbound.model, "gemini-3.8-flash");
  assert.deepEqual(outbound.response_format, { type: "json_object" });
  assert.equal(outbound.stream, false);
  assert.equal(outboundHeaders.get("authorization"), "Bearer synthetic-gemini-key");
});

test("Gemini intelligence maps status codes and aborts to classified errors", async () => {
  const timeoutProvider = createGeminiIntelligenceProvider({
    apiKey: "key",
    fetch: async () => new Response(null, { status: 504 }),
  });
  await assert.rejects(timeoutProvider.generate(input), {
    name: "IntelligenceProviderError",
    code: "provider_timeout_unknown",
  });

  const abortProvider = createGeminiIntelligenceProvider({
    apiKey: "key",
    fetch: async () => {
      const err = new DOMException("The operation was aborted", "AbortError");
      throw err;
    },
  });
  await assert.rejects(abortProvider.generate(input), {
    name: "IntelligenceProviderError",
    code: "provider_timeout_unknown",
  });

  const throttledProvider = createGeminiIntelligenceProvider({
    apiKey: "key",
    fetch: async () => new Response(null, { status: 429 }),
  });
  await assert.rejects(throttledProvider.generate(input), {
    name: "IntelligenceProviderError",
    code: "throttled",
  });

  assert.throws(() => createGeminiIntelligenceProvider({ apiKey: "", fetch: async () => new Response("{}") }), {
    name: "IntelligenceProviderError",
    code: "configuration",
  });
});

function geminiReturning(body) {
  return createGeminiIntelligenceProvider({
    apiKey: "synthetic-gemini-key",
    fetch: async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  });
}

const geminiInput = { episodeId: "2394679365", title: "SAS Chapel: Genesis 38", publishDate: "2026-09-07", transcript: "Synthetic transcript.", transcriptTruncated: false };

test("Gemini intelligence repairs or drops malformed items instead of failing the episode", async () => {
  const provider = geminiReturning({ choices: [{ finish_reason: "stop", message: { content: "```json\n" + JSON.stringify({
    executiveSummary: "Summary.",
    longSummary: "Long summary.",
    mainTopics: ["judah", 7, ""],
    items: [
      { itemType: "Bible Reference", summary: "Genesis 38", confidence: 0.9, sourceTimes: ["00:01:00"], value: "not an object" },
      { itemType: "quote", summary: "" },
      "not an item",
    ],
  }) + "\n```" } }] });
  const result = await provider.generate(geminiInput);
  assert.equal(result.executiveSummary, "Summary.");
  assert.deepEqual(result.mainTopics, ["judah", "7"]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].itemType, "bible_reference");
  assert.equal(result.items[0].confidence, "0.9");
  assert.deepEqual(result.items[0].value, {});
});

test("Gemini intelligence names why a response is unusable", async () => {
  await assert.rejects(geminiReturning({ choices: [{ finish_reason: "length", message: { content: "{\"executive" } }] }).generate(geminiInput), /output limit reached/u);
  await assert.rejects(geminiReturning({ choices: [{ finish_reason: "content_filter", message: { content: null } }] }).generate(geminiInput), /safety filter/u);
  await assert.rejects(geminiReturning({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ longSummary: "x" }) } }] }).generate(geminiInput), /missing executiveSummary/u);
});

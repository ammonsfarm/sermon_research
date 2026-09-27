import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { RoleAuthorizationService } from "../../../packages/auth/src/roles.ts";
import { ServiceError } from "../../../packages/contracts/src/errors.ts";
import { ClerkBackendSessionVerifier } from "../src/clerk-session.ts";
import {
  createRagAuthenticationRequest,
  createRuntimeRagWorker,
  readClerkWorkerConfiguration,
  toRagSourceDetail,
} from "../src/runtime.ts";

function principal() {
  return {
    kind: "user",
    userId: "user_1",
    sessionId: "session_1",
    roles: ["Admin"],
    capabilities: ["internal:read", "research:generate"],
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
}

function request(headers = {}) {
  return new Request("https://rag.invalid/api/rag/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ question: "Synthetic question" }),
  });
}

function emptyD1() {
  const binding = {
    calls: 0,
    prepare(sql) {
      return {
        bind: (..._values) => ({
          all: async () => {
            binding.calls += 1;
            return {
              success: true,
              results: /COUNT\(\*\) AS total FROM research_sources/u.test(sql) ? [{ total: 1 }] : [],
            };
          },
        }),
      };
    },
  };
  return binding;
}

async function search(path, env) {
  const incoming = new Request(`https://rag.invalid${path}`);
  return createRuntimeRagWorker(incoming, env, {
    sessions: { async resolve() { return { kind: "authenticated", principal: principal() }; } },
    authorize: new RoleAuthorizationService(),
  }).fetch(incoming);
}

test("runtime keeps anonymous admission independent of missing bindings", async () => {
  const incoming = request({ "x-aic-auth-principal": "user_admin" });
  const response = await createRuntimeRagWorker(incoming, {}).fetch(incoming);
  assert.equal(response.status, 401);
});

test("runtime fails closed when an authenticated request lacks RAG bindings", async () => {
  const incoming = request();
  const response = await createRuntimeRagWorker(incoming, {}, {
    sessions: { async resolve() { return { kind: "authenticated", principal: principal() }; } },
    authorize: new RoleAuthorizationService(),
  }).fetch(incoming);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.match(body, /temporarily unavailable/);
  assert.doesNotMatch(body, /AIC_DB|AIC_CONTENT_INDEX|OPENAI_API_KEY/);
});

test("invalid server-side provider configuration is a safe 503, not a caller 400", async () => {
  const d1 = {
    prepare() {
      return {
        bind() { return this; },
        async first() { return { count: 1 }; },
      };
    },
  };
  const env = {
    AIC_DB: d1,
    AIC_CONTENT_INDEX: { async query() { throw new Error("must not query"); } },
    AIC_CANONICAL_ORIGIN: "https://aic.example.test",
    OPENAI_API_KEY: "synthetic-openai-key",
    SILO_CHAT_URL: "http://127.0.0.1/private",
    SILO_TEMP_KEY: "synthetic-silo-key",
    SILO_CHAT_MODEL: "synthetic-model",
    AIC_RAG_ALLOW_OPENAI_FALLBACK: "false",
  };
  const incoming = request();
  const response = await createRuntimeRagWorker(incoming, env, {
    sessions: { async resolve() { return { kind: "authenticated", principal: principal() }; } },
    authorize: new RoleAuthorizationService(),
  }).fetch(incoming);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /127\.0\.0\.1|synthetic-.*-key/);
});

test("invalid server-side source repository configuration is a safe 503", async () => {
  const incoming = new Request("https://rag.invalid/api/rag/sources/t%2Fepisode%2F0%2Fhash");
  const response = await createRuntimeRagWorker(incoming, {
    AIC_DB: { prepare() { throw new Error("must not query"); } },
    AIC_CANONICAL_ORIGIN: "http://not-an-approved-origin.invalid",
  }, {
    sessions: { async resolve() { return { kind: "authenticated", principal: principal() }; } },
    authorize: new RoleAuthorizationService(),
  }).fetch(incoming);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /not-an-approved-origin/);
});

test("D1-only episode text and listing searches do not require semantic or generation bindings", async () => {
  for (const path of [
    "/api/episodes/search?q=grace&text_only=1",
    "/api/episodes/search?q=grace&mode=text",
    "/api/episodes/search?q=grace&scope=title",
    "/api/episodes/search?q=",
  ]) {
    const db = emptyD1();
    const response = await search(path, { AIC_DB: db });
    assert.equal(response.status, 200, path);
    assert.ok(db.calls > 0, path);
    assert.deepEqual((await response.json()).results, [], path);
  }
});

test("D1-only hybrid search retains lexical results with safe semantic degradation", async () => {
  const db = emptyD1();
  const response = await search("/api/episodes/search?q=grace", { AIC_DB: db });
  assert.equal(response.status, 200);
  assert.ok(db.calls > 0);
  assert.deepEqual(await response.json(), {
    query: "grace",
    mode: "hybrid",
    results: [],
    total: 0,
    degraded: true,
    degradation: "semantic_unavailable",
  });
});

test("malformed lazy semantic repository configuration degrades instead of becoming a caller error", async () => {
  const originalFetch = globalThis.fetch;
  const db = emptyD1();
  let vectorCalls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: "text-embedding-3-small",
    data: [{ index: 0, embedding: Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0) }],
  }));
  try {
    const response = await search("/api/episodes/search?q=grace", {
      AIC_DB: db,
      AIC_CONTENT_INDEX: {
        async query() {
          vectorCalls += 1;
          return {
            matches: [{
              id: "t/segment-1",
              score: 0.8,
              metadata: {
                source_type: "episode_transcript",
                source_id: "123",
                content_hash: "a".repeat(64),
                chunk_index: 0,
              },
            }],
          };
        },
      },
      AIC_CANONICAL_ORIGIN: "http://invalid.example.test",
      OPENAI_API_KEY: "synthetic-openai-key",
    });
    assert.equal(response.status, 200);
    assert.equal(vectorCalls, 1);
    assert.deepEqual(await response.json(), {
      query: "grace",
      mode: "hybrid",
      results: [],
      total: 0,
      degraded: true,
      degradation: "semantic_unavailable",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public source details expose only a bounded multibyte-safe excerpt DTO", () => {
  const document = {
    vectorId: "t/episode/0/hash",
    sourceType: "episode",
    sourceId: "episode-1",
    title: "Episode title",
    canonicalUrl: "/podcast/episodes?trackId=episode-1",
    text: `${"🙂".repeat(719)}END-secret-tail`,
    contentHash: "internal-hash",
    chunkIndex: 12,
    sourceLocation: { startMs: 1_000, endMs: 2_000 },
    providerPayload: "provider-secret",
  };
  const detail = toRagSourceDetail(document);
  assert.deepEqual(Object.keys(detail).sort(), ["sourceLocation", "sourceType", "sourceUrl", "text", "title", "trackId", "vectorId"]);
  assert.equal([...detail.text].length, 720);
  assert.equal(detail.text.endsWith("E"), true);
  assert.equal(detail.text.includes("secret-tail"), false);
  assert.equal(detail.sourceUrl, document.canonicalUrl);
  assert.equal(detail.trackId, document.sourceId);
  assert.deepEqual(detail.sourceLocation, document.sourceLocation);
});

test("RAG authentication requests preserve cancellation while stripping spoofable headers", () => {
  const controller = new AbortController();
  const incoming = new Request("https://rag.invalid/api/rag/history", {
    headers: { authorization: "Bearer retained", "x-clerk-auth-status": "signed-in" },
    signal: controller.signal,
  });
  const authentication = createRagAuthenticationRequest(incoming);
  assert.equal(authentication.headers.get("authorization"), "Bearer retained");
  assert.equal(authentication.headers.get("x-clerk-auth-status"), null);
  controller.abort();
  assert.equal(authentication.signal.aborted, true);
});

test("Clerk admission preserves operation cancellation instead of translating it to 503", async () => {
  const controller = new AbortController();
  const cancelled = new ServiceError({ code: "cancelled", message: "The request was cancelled." });
  const context = {
    boundary: "request",
    correlation: { correlationId: "correlation-test" },
    signal: controller.signal,
    deadline: "2030-01-01T00:00:00.000Z",
    request: { method: "GET", path: "/api/rag/history" },
  };
  const verifier = new ClerkBackendSessionVerifier(
    new Request("https://rag.invalid/api/rag/history"),
    {
      publishableKey: "pk_test_synthetic",
      secretKey: "sk_test_synthetic",
      jwtKey: "synthetic-jwt-key",
      authorizedParties: ["https://rag.invalid"],
    },
    async () => new Promise(() => undefined),
  );
  const pending = verifier.verify(context, { headers: new Headers({ authorization: "Bearer synthetic" }) });
  controller.abort(cancelled);
  await assert.rejects(pending, (error) => error === cancelled);
});

test("Clerk runtime configuration requires networkless verification and approved origins", () => {
  const complete = {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_synthetic",
    CLERK_SECRET_KEY: "sk_test_synthetic",
    CLERK_JWT_KEY: "synthetic-public-jwt-key",
    AIC_CLERK_AUTHORIZED_PARTIES: "https://aic.example.test,http://localhost:3000",
  };
  assert.deepEqual(readClerkWorkerConfiguration(complete), {
    publishableKey: "pk_test_synthetic",
    secretKey: "sk_test_synthetic",
    jwtKey: "synthetic-public-jwt-key",
    authorizedParties: ["https://aic.example.test", "http://localhost:3000"],
  });
  assert.equal(readClerkWorkerConfiguration({ ...complete, CLERK_JWT_KEY: "" }), null);
  assert.equal(readClerkWorkerConfiguration({ ...complete, AIC_CLERK_AUTHORIZED_PARTIES: "http://aic.example.test" }), null);
  assert.equal(readClerkWorkerConfiguration({ ...complete, CLERK_PUBLISHABLE_KEY: "different" }), null);
});

test("RAG Wrangler configuration is private and contains no routes", async () => {
  const raw = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(raw, /"workers_dev"\s*:\s*false/u);
  assert.match(raw, /"preview_urls"\s*:\s*false/u);
  assert.doesNotMatch(raw, /"routes?"\s*:/u);
  assert.match(raw, /"main"\s*:\s*"src\/index\.ts"/u);
});

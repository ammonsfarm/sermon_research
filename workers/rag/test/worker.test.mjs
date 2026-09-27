import assert from "node:assert/strict";
import test from "node:test";

import { ServiceError } from "../../../packages/contracts/src/errors.ts";
import { D1UserAccessRepository } from "../../../packages/db/src/index.ts";
import { RepositoryBackedSessionReader } from "../../../packages/auth/src/sessions.ts";
import { D1RagQuota } from "../src/quota.ts";
import { createRagWorker } from "../src/worker.ts";

const NOW = 1_800_000_000_000;

const roleCapabilities = {
  User: [],
  Admin: ["internal:read", "research:generate"],
  "Content Manager": ["internal:read", "research:generate"],
  "Research User": ["internal:read", "research:generate"],
  "Read Only": ["internal:read"],
};

function principal(role = "Admin", userId = "user_1") {
  return {
    kind: "user",
    userId,
    sessionId: "session_1",
    roles: [role],
    capabilities: roleCapabilities[role],
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
}

function services(overrides = {}) {
  return {
    async answer() {
      return {
        answer: "Answer [S1]",
        query: "question",
        provider: "silo",
        model: "model",
        sources: [],
        topEpisodeIds: [],
        interactionId: "interaction-1",
      };
    },
    async history() {
      return { items: [] };
    },
    async searchEpisodes() {
      return { query: "", mode: "text", results: [], total: 0 };
    },
    async source() {
      return { vectorId: "t/episode/0/hash", title: "Source", text: "Evidence" };
    },
    ...overrides,
  };
}

function workerFor({ role = "Admin", session, serviceOverrides, quota, authorize, correlationId = "correlation-test" } = {}) {
  return createRagWorker({
    sessions: session ?? {
      async resolve() {
        return { kind: "authenticated", principal: principal(role) };
      },
    },
    authorize: authorize ?? {
      async decide(_context, actor, requirement) {
        return actor?.capabilities.includes(requirement.capability)
          ? { kind: "allow" }
          : { kind: "deny", reason: actor ? "forbidden" : "unauthenticated" };
      },
    },
    quota: quota ?? {
      async consume() {
        return { allowed: true, retryAfterSeconds: 60 };
      },
    },
    services: services(serviceOverrides),
    now: () => NOW,
    correlationId: () => correlationId,
  });
}

function generationRequest(path = "/api/rag/chat", body = { question: "Question?" }, options = {}) {
  return new Request(`https://rag.invalid${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    body: JSON.stringify(body),
    signal: options.signal,
  });
}

test("RAG retains safe web request correlation and replaces unsafe forwarded values", async () => {
  const worker = createRagWorker({
    sessions: { async resolve() { return { kind: "anonymous" }; } },
    authorize: { async decide() { throw new Error("must not authorize"); } },
    quota: { async consume() { throw new Error("must not consume"); } },
    services: services(),
  });
  for (const id of ["corr-web-to-rag-1", "unsafe/query?credential=value", "a".repeat(129)]) {
    const response = await worker.fetch(new Request("https://rag.invalid/api/rag/history", { headers: { "x-correlation-id": id } }));
    assert.equal(response.status, 401);
    const actual = response.headers.get("x-correlation-id");
    assert.match(actual, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    if (id === "corr-web-to-rag-1") assert.equal(actual, id);
    else assert.notEqual(actual, id);
    assert.equal((await response.json()).error.correlationId, actual);
  }
});

test("anonymous callers cannot spoof an administrator principal", async () => {
  let authorizationCalls = 0;
  let quotaCalls = 0;
  let serviceCalls = 0;

  const worker = createRagWorker({
    sessions: {
      async resolve() {
        return { kind: "anonymous" };
      },
    },
    authorize: {
      async decide() {
        authorizationCalls += 1;
        return { kind: "allow" };
      },
    },
    quota: {
      async consume() {
        quotaCalls += 1;
        throw new Error("quota must not be consulted");
      },
    },
    services: {
      async answer() {
        serviceCalls += 1;
        throw new Error("generation/history must not be invoked");
      },
      async history() {
        serviceCalls += 1;
        throw new Error("history must not be invoked");
      },
      async searchEpisodes() {
        serviceCalls += 1;
        throw new Error("search must not be invoked");
      },
      async source() {
        serviceCalls += 1;
        throw new Error("source hydration must not be invoked");
      },
    },
    now: () => NOW,
    correlationId: () => "correlation-test-1",
  });

  const response = await worker.fetch(new Request("https://rag.invalid/api/rag/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-aic-auth-principal": "user_admin",
      "x-clerk-auth-status": "signed-in",
    },
    body: JSON.stringify({ question: "What is abiding in Christ?" }),
  }));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      code: "unauthenticated",
      message: "Authentication required.",
      correlationId: "correlation-test-1",
      retryable: false,
    },
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(authorizationCalls, 0);
  assert.equal(quotaCalls, 0);
  assert.equal(serviceCalls, 0);
});

test("admission retains original credentials but removes every spoofable auth header", async () => {
  let seen;
  const response = await workerFor({
    session: {
      async resolve(_context, credentials) {
        seen = credentials.headers;
        return { kind: "anonymous" };
      },
    },
  }).fetch(generationRequest("/api/rag/chat", { question: "Question?" }, {
    headers: {
      authorization: "Bearer retained-token",
      cookie: "__session=retained-cookie",
      "x-aic-auth-principal": "user_admin",
      "x-aic-auth-signature": "forged",
      "x-clerk-auth-status": "signed-in",
      "x-clerk-auth-token": "forged",
      "x-clerk-request-data": "forged",
    },
  }));
  assert.equal(response.status, 401);
  assert.equal(seen.get("authorization"), "Bearer retained-token");
  assert.equal(seen.get("cookie"), "__session=retained-cookie");
  assert.equal(seen.get("x-aic-auth-principal"), null);
  assert.equal(seen.get("x-aic-auth-signature"), null);
  assert.equal(seen.get("x-clerk-auth-status"), null);
  assert.equal(seen.get("x-clerk-auth-token"), null);
  assert.equal(seen.get("x-clerk-request-data"), null);
});

test("generation capability follows the complete role matrix", async () => {
  for (const [role, expectedStatus] of [
    ["User", 403],
    ["Admin", 200],
    ["Content Manager", 200],
    ["Research User", 200],
    ["Read Only", 403],
  ]) {
    const response = await workerFor({ role }).fetch(generationRequest());
    assert.equal(response.status, expectedStatus, role);
  }
});

test("internal source and search require internal:read while history requires only an active user", async () => {
  for (const role of Object.keys(roleCapabilities)) {
    const worker = workerFor({ role });
    const history = await worker.fetch(new Request("https://rag.invalid/api/rag/history"));
    const source = await worker.fetch(new Request("https://rag.invalid/api/rag/sources/t%2Fepisode%2F0%2Fhash"));
    const search = await worker.fetch(new Request("https://rag.invalid/api/episodes/search?q=faith&mode=text"));
    assert.equal(history.status, 200, `${role} history`);
    assert.equal(source.status, role === "User" ? 403 : 200, `${role} source`);
    assert.equal(search.status, role === "User" ? 403 : 200, `${role} search`);
  }
});

test("ordinary history, source, and search reads consume no generation quota", async () => {
  let quotaCalls = 0;
  const worker = workerFor({
    quota: {
      async consume() {
        quotaCalls += 1;
        throw new Error("GET routes must not consume quota");
      },
    },
  });
  assert.equal((await worker.fetch(new Request("https://rag.invalid/api/rag/history"))).status, 200);
  assert.equal((await worker.fetch(new Request("https://rag.invalid/api/rag/sources/t%2Fepisode%2F0%2Fhash"))).status, 200);
  assert.equal((await worker.fetch(new Request("https://rag.invalid/api/episodes/search?mode=text"))).status, 200);
  assert.equal(quotaCalls, 0);
});

test("missing, disabled, and invalid users are unauthenticated", async () => {
  for (const resolution of [
    { kind: "anonymous" },
    { kind: "invalid", reason: "revoked" },
    { kind: "invalid", reason: "expired" },
    { kind: "invalid", reason: "malformed" },
  ]) {
    const response = await workerFor({
      session: { async resolve() { return resolution; } },
    }).fetch(generationRequest());
    assert.equal(response.status, 401, JSON.stringify(resolution));
  }
});

test("authoritative RAG access hydration rejects missing and disabled user records", async () => {
  const verifier = {
    async verify() {
      return {
        kind: "authenticated",
        userId: "user_new",
        sessionId: "session_new",
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
    },
  };
  const missing = new RepositoryBackedSessionReader({
    verifier,
    access: { async getByUserId() { return null; } },
    now: () => NOW,
    requireAccessRecord: true,
  });
  assert.equal((await workerFor({ session: missing }).fetch(new Request("https://rag.invalid/api/rag/history"))).status, 401);
  assert.equal((await workerFor({ session: missing }).fetch(generationRequest())).status, 401);

  const disabled = new RepositoryBackedSessionReader({
    verifier,
    access: { async getByUserId() { return { userId: "user_new", roles: ["Admin"], disabled: true }; } },
    now: () => NOW,
    requireAccessRecord: true,
  });
  assert.equal((await workerFor({ session: disabled }).fetch(generationRequest())).status, 401);
});

test("authentication dependency errors remain distinct from unauthenticated callers", async () => {
  const response = await workerFor({
    session: {
      async resolve() {
        throw new ServiceError({
          code: "dependency_unavailable",
          message: "Authentication is temporarily unavailable.",
          retryable: true,
          cause: new Error("secret provider detail"),
        });
      },
    },
  }).fetch(generationRequest());
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.match(text, /Authentication is temporarily unavailable/);
  assert.doesNotMatch(text, /secret provider detail/);
});

test("generation JSON is strict and server-owned identity and deadline fields are rejected", async () => {
  for (const extra of [
    { userId: "user_admin" },
    { actor: { userId: "user_admin" } },
    { capability: "research:generate" },
    { deadline: "2099-01-01T00:00:00.000Z" },
    { unknown: true },
  ]) {
    const response = await workerFor().fetch(generationRequest("/api/rag/chat", {
      question: "Question?",
      ...extra,
    }));
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
});

test("request context clamps a propagated deadline to 55 seconds and identity comes from the session", async () => {
  let captured;
  const response = await workerFor({
    serviceOverrides: {
      async answer(context, input) {
        captured = { context, input };
        return services().answer();
      },
    },
  }).fetch(generationRequest("/api/rag/chat", { question: "Question?", topK: 4 }, {
    headers: { "x-aic-deadline": new Date(NOW + 5 * 60_000).toISOString() },
  }));
  assert.equal(response.status, 200);
  assert.equal(captured.input.userId, "user_1");
  assert.equal(captured.input.topK, 4);
  assert.equal(captured.context.deadline, new Date(NOW + 55_000).toISOString());
});

test("an expired propagated deadline stops before authentication and quota", async () => {
  let sessionCalls = 0;
  let quotaCalls = 0;
  const worker = workerFor({
    session: {
      async resolve() {
        sessionCalls += 1;
        return { kind: "authenticated", principal: principal() };
      },
    },
    quota: {
      async consume() {
        quotaCalls += 1;
        return { allowed: true, retryAfterSeconds: 60 };
      },
    },
  });
  const response = await worker.fetch(generationRequest("/api/rag/chat", { question: "Question?" }, {
    headers: { "x-aic-deadline": new Date(NOW - 1).toISOString() },
  }));
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "timeout");
  assert.equal(sessionCalls, 0);
  assert.equal(quotaCalls, 0);
});

test("all retained generation paths map only their bounded route fields", async () => {
  const captured = [];
  const worker = workerFor({
    serviceOverrides: {
      async answer(_context, input) {
        captured.push(input);
        return services().answer();
      },
    },
  });
  for (const [path, body] of [
    ["/api/rag/chat", { question: "Archive?", trackId: "123", topK: 4 }],
    ["/api/research/chat", { question: "Research?", topK: 8 }],
    ["/api/episodes/123/chat", { question: "Episode?", topK: 4 }],
    ["/api/writings/42/chat", { question: "Writing?", topK: 8 }],
  ]) {
    assert.equal((await worker.fetch(generationRequest(path, body))).status, 200, path);
  }
  assert.deepEqual(captured, [
    { userId: "user_1", scope: "archive", question: "Archive?", topK: 4, episodeId: "123" },
    { userId: "user_1", scope: "research", question: "Research?", topK: 8 },
    { userId: "user_1", scope: "episode", question: "Episode?", topK: 4, episodeId: "123" },
    { userId: "user_1", scope: "writing", question: "Writing?", topK: 8, articleId: "pastorwood:42" },
  ]);
});

test("writing chat accepts only a positive decimal post ID", async () => {
  let serviceCalls = 0;
  const worker = workerFor({
    serviceOverrides: {
      async answer() {
        serviceCalls += 1;
        return services().answer();
      },
    },
  });
  for (const target of ["0", "-1", "cms:42", "pastorwood:42", "not-a-post"]) {
    const response = await worker.fetch(generationRequest(`/api/writings/${encodeURIComponent(target)}/chat`));
    assert.equal(response.status, 400, target);
  }
  assert.equal(serviceCalls, 0);
});

test("bounded streaming rejects an oversize body without relying on content-length", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ question: "x".repeat(15_986) }));
  assert.equal(encoded.byteLength, 16_001);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  const request = new Request("https://rag.invalid/api/rag/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  });
  assert.equal(request.headers.has("content-length"), false);
  const response = await workerFor().fetch(request);
  assert.equal(response.status, 413);
});

test("parent cancellation stops a stalled request-body stream", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const request = new Request("https://rag.invalid/api/rag/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({ cancel() { cancelled = true; } }),
    duplex: "half",
    signal: controller.signal,
  });
  const pending = workerFor().fetch(request);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 408);
  assert.equal((await response.json()).error.code, "cancelled");
  assert.equal(cancelled, true);
});

test("wrong methods and malformed JSON return bounded JSON errors", async () => {
  const wrongMethod = await workerFor().fetch(new Request("https://rag.invalid/api/rag/chat", { method: "GET" }));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  const malformed = await workerFor().fetch(new Request("https://rag.invalid/api/rag/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  }));
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get("content-type"), /^application\/json/u);
});

test("quota denial returns 429 with Retry-After and invokes no service", async () => {
  let calls = 0;
  const response = await workerFor({
    quota: { async consume() { return { allowed: false, retryAfterSeconds: 17 }; } },
    serviceOverrides: { async answer() { calls += 1; throw new Error("must not run"); } },
  }).fetch(generationRequest());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "17");
  assert.equal(calls, 0);
});

test("the repeated 61st generation request is rejected after 60 service calls", async () => {
  let admitted = 0;
  let serviceCalls = 0;
  const worker = workerFor({
    quota: {
      async consume() {
        admitted += 1;
        return { allowed: admitted <= 60, retryAfterSeconds: 9 };
      },
    },
    serviceOverrides: {
      async answer() {
        serviceCalls += 1;
        return services().answer();
      },
    },
  });
  const responses = [];
  for (let index = 0; index < 61; index += 1) responses.push(await worker.fetch(generationRequest()));
  assert.equal(responses.filter((response) => response.status === 200).length, 60);
  assert.equal(responses.at(-1).status, 429);
  assert.equal(responses.at(-1).headers.get("retry-after"), "9");
  assert.equal(serviceCalls, 60);
});

test("quota database failure denies generation", async () => {
  let calls = 0;
  const response = await workerFor({
    quota: { async consume() { throw new Error("database secret"); } },
    serviceOverrides: { async answer() { calls += 1; throw new Error("must not run"); } },
  }).fetch(generationRequest());
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  assert.doesNotMatch(await response.text(), /database secret/);
});

test("parent cancellation during quota admission remains a cancelled request", async () => {
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = workerFor({
    quota: {
      async consume(context) {
        entered();
        await new Promise((resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
      },
    },
  }).fetch(generationRequest("/api/rag/chat", { question: "Question?" }, { signal: controller.signal }));
  await started;
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 408);
  assert.equal((await response.json()).error.code, "cancelled");
});

test("the request deadline bounds quota admission that ignores cancellation", async () => {
  let releaseQuota;
  let serviceCalls = 0;
  const quota = new D1RagQuota({
    db: {
      prepare() {
        return {
          bind() {
            return {
              first() {
                return new Promise((resolve) => { releaseQuota = resolve; });
              },
            };
          },
        };
      },
    },
    now: () => NOW,
  });
  const pending = workerFor({
    quota,
    serviceOverrides: {
      async answer() {
        serviceCalls += 1;
        return services().answer();
      },
    },
  }).fetch(generationRequest("/api/rag/chat", { question: "Question?" }, {
    headers: { "x-aic-deadline": new Date(NOW + 5).toISOString() },
  }));

  const response = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);
  releaseQuota({ count: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(response, "hung");
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "timeout");
  assert.equal(serviceCalls, 0);
});

test("parent cancellation bounds authoritative role hydration and launches no later work", async () => {
  const controller = new AbortController();
  let accessStarted;
  let releaseAccess;
  let authorizationCalls = 0;
  let quotaCalls = 0;
  let serviceCalls = 0;
  const started = new Promise((resolve) => { accessStarted = resolve; });
  const session = new RepositoryBackedSessionReader({
    verifier: {
      async verify() {
        return { kind: "authenticated", userId: "user_1", sessionId: "session_1", expiresAt: "2030-01-01T00:00:00.000Z" };
      },
    },
    access: new D1UserAccessRepository({
      db: {
        prepare() {
          return {
            bind() {
              return {
                all() {
                  accessStarted();
                  return new Promise((resolve) => { releaseAccess = resolve; });
                },
              };
            },
          };
        },
      },
    }),
    now: () => NOW,
    requireAccessRecord: true,
  });
  const worker = workerFor({
    session,
    authorize: { async decide() { authorizationCalls += 1; return { kind: "allow" }; } },
    quota: { async consume() { quotaCalls += 1; return { allowed: true, retryAfterSeconds: 60 }; } },
    serviceOverrides: { async answer() { serviceCalls += 1; return services().answer(); } },
  });
  const pending = worker.fetch(generationRequest("/api/rag/chat", { question: "Question?" }, { signal: controller.signal }));
  await started;
  controller.abort();
  const response = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);
  releaseAccess({ success: true, results: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(response, "hung");
  assert.equal(response.status, 408);
  assert.equal((await response.json()).error.code, "cancelled");
  assert.equal(authorizationCalls, 0);
  assert.equal(quotaCalls, 0);
  assert.equal(serviceCalls, 0);
});

test("history is always scoped to the authenticated owner", async () => {
  let capturedUserId;
  const response = await workerFor({
    serviceOverrides: {
      async history(_context, userId) {
        capturedUserId = userId;
        return { items: [{
          id: "interaction-1",
          userId,
          question: "Own question",
          answer: "Own answer",
          citations: [],
          createdAt: "2026-09-10T12:00:00.000Z",
          scope: "archive",
        }] };
      },
    },
  }).fetch(new Request("https://rag.invalid/api/rag/history?scope=archive&limit=10"));
  assert.equal(response.status, 200);
  assert.equal(capturedUserId, "user_1");
  const body = await response.json();
  assert.equal(Array.isArray(body.history), true);
  assert.equal(body.history[0].question, "Own question");
  assert.equal("userId" in body.history[0], false);
});

test("unexpected failures return a correlated redacted envelope", async () => {
  const response = await workerFor({
    correlationId: "safe-correlation",
    serviceOverrides: { async answer() { throw new Error("Bearer secret-token Question?"); } },
  }).fetch(generationRequest());
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.match(text, /safe-correlation/);
  assert.match(text, /The request could not be completed/);
  assert.doesNotMatch(text, /secret-token|Question\?/);
});

test("unknown endpoints and missing sources use JSON 404 envelopes", async () => {
  const worker = workerFor({ serviceOverrides: { async source() { return null; } } });
  for (const request of [
    new Request("https://rag.invalid/api/not-rag"),
    new Request("https://rag.invalid/api/rag/sources/t%2Fmissing"),
  ]) {
    const response = await worker.fetch(request);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type"), /^application\/json/u);
  }
});

test("parent cancellation aborts service work and returns a cancelled envelope", async () => {
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const worker = workerFor({
    serviceOverrides: {
      async answer(context) {
        entered();
        await new Promise((resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("raw abort")), { once: true });
        });
      },
    },
  });
  const pending = worker.fetch(generationRequest("/api/rag/chat", { question: "Question?" }, { signal: controller.signal }));
  await started;
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 408);
  assert.equal((await response.json()).error.code, "cancelled");
});

test("generation forwards a registry model id and prefers it over a provider", async () => {
  let captured;
  const response = await workerFor({
    serviceOverrides: {
      async answer(_context, input) {
        captured = input;
        return services().answer();
      },
    },
  }).fetch(generationRequest("/api/research/chat", { question: "Question?", provider: "silo", model: "openrouter:openai/gpt-6-luna" }));
  assert.equal(response.status, 200);
  assert.equal(captured.modelId, "openrouter:openai/gpt-6-luna");
  assert.equal(captured.provider, undefined);
});

test("model catalog requires generation capability and returns the user's models", async () => {
  const catalog = { source: "registry", models: [{ id: "gemini:gemini-3.8-flash", displayName: "Gemini 3.8 Flash", providerId: "gemini", providerName: "Google Gemini", isDefault: true }] };
  let seenUser;
  const overrides = { async models(_context, userId) { seenUser = userId; return catalog; } };
  const allowed = await workerFor({ role: "Research User", serviceOverrides: overrides }).fetch(new Request("https://rag.invalid/api/rag/models"));
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), catalog);
  assert.equal(seenUser, "user_1");
  const denied = await workerFor({ role: "Read Only", serviceOverrides: overrides }).fetch(new Request("https://rag.invalid/api/rag/models"));
  assert.equal(denied.status, 403);
  const wrongMethod = await workerFor({ serviceOverrides: overrides }).fetch(new Request("https://rag.invalid/api/rag/models", { method: "POST" }));
  assert.equal(wrongMethod.status, 405);
});

test("dependency failures log their cause chain without credentials", async () => {
  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(line);
  try {
    const response = await workerFor({
      serviceOverrides: {
        async answer() {
          throw new ServiceError({ code: "dependency_unavailable", message: "The RAG service is temporarily unavailable.", retryable: true,
            cause: new Error("Embedding request failed (401) for Bearer sk-live-secret") });
        },
      },
    }).fetch(generationRequest());
    assert.equal(response.status, 503);
  } finally {
    console.error = original;
  }
  const entry = JSON.parse(logged.at(-1));
  assert.equal(entry.event, "rag.request_failed");
  assert.equal(entry.correlationId, "correlation-test");
  assert.equal(entry.causes[0].code, "dependency_unavailable");
  assert.match(entry.causes[1].message, /failed \(401\)/u);
  assert.equal(JSON.stringify(entry).includes("sk-live-secret"), false);
});

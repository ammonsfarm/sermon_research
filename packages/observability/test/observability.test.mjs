import assert from "node:assert/strict";
import test from "node:test";

import {
  createCorrelationContext,
  createStructuredLogger,
  healthVersionResponse,
  operationalResponse,
  safeErrorEnvelope,
} from "../src/index.ts";

test("correlation factory validates forwarded IDs and creates distinct IDs", () => {
  const context = createCorrelationContext({
    incomingCorrelationId: "incoming-123",
  });
  assert.equal(context.correlationId, "incoming-123");
  assert.match(context.requestId, /^req-/);
  assert.match(context.traceId, /^trace-/);
  assert.notEqual(context.requestId, context.traceId);
  assert.match(createCorrelationContext({ incomingCorrelationId: "bad value" }).correlationId, /^corr-/);
});

test("operational endpoints fail closed without a release or D1 and disclose no dependency error", async () => {
  const request = new Request("https://example.test/healthz");
  const env = { AIC_ENVIRONMENT: "production", AIC_RELEASE_COMMIT: "a".repeat(40), CF_VERSION_METADATA: { id: "version-1" }, AIC_DB: { prepare: () => ({ first: async () => ({ ok: 1 }) }) } };
  assert.equal((await operationalResponse(request, env)).status, 200);
  assert.equal((await operationalResponse(request, { ...env, AIC_RELEASE_COMMIT: "" })).status, 503);
  const failed = await operationalResponse(request, { ...env, AIC_DB: { prepare: () => { throw new Error("private credential"); } } });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /private credential/);
  assert.equal(await operationalResponse(new Request("https://example.test/"), env), undefined);
  assert.equal((await operationalResponse(new Request(request, { method: "POST" }), env)).status, 405);
  const head = await operationalResponse(new Request(request, { method: "HEAD" }), env);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("cache-control"), "no-store");
});

test("structured logger drops forbidden fields, bounds values, and carries correlation", () => {
  const entries = [];
  const logger = createStructuredLogger((entry) => entries.push(entry));
  const context = { correlation: createCorrelationContext({ incomingCorrelationId: "corr-test" }) };
  logger.write(context, {
    level: "info",
    event: "request.completed",
    fields: {
      route: "/health",
      authorization: "Bearer secret",
      nested: { password: "secret", ok: true },
      body: "should not be logged",
    },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].correlationId, "corr-test");
  assert.deepEqual(entries[0].fields, { route: "/health", nested: { ok: true } });
  assert.equal(JSON.stringify(entries[0]).includes("secret"), false);
});

test("health response uses the shared version contract and status mapping", async () => {
  const response = healthVersionResponse({ version: "1.2.3", commit: "abc123", environment: "test" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    version: "1.2.3",
    commit: "abc123",
    environment: "test",
  });
});

test("unknown errors become safe correlated envelopes", () => {
  const context = { correlation: createCorrelationContext({ incomingCorrelationId: "corr-safe" }) };
  const envelope = safeErrorEnvelope(context, new Error("provider token secret"));
  assert.deepEqual(envelope, { error: {
    code: "internal",
    message: "The request could not be completed.",
    correlationId: "corr-safe",
    retryable: false,
  } });
});

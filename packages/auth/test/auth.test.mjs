import assert from "node:assert/strict";
import test from "node:test";

import {
  CLERK_CONFIGURATION_CONTRACT,
  PortableRouteAccessPolicy,
  RepositoryBackedSessionReader,
  ROLE_CAPABILITIES,
  RoleAuthorizationService,
  assessClerkConfiguration,
  capabilitiesForRoles,
  classifyRoute,
  decideRequestBoundary,
  dynamicPublicSlug,
  loginRedirectLocation,
  normalizeRole,
  publicProofForPath,
  requestReturnUrl,
  resolveApplicationRoute,
  responseFromRequestBoundaryDecision,
  safeRelativeReturnUrl,
} from "../src/index.ts";

const context = {
  boundary: "request",
  correlation: { correlationId: "corr-auth-test" },
  signal: new AbortController().signal,
  request: { method: "GET", path: "/" },
};

function sessionReader(resolution) {
  return { resolve: async () => resolution };
}

const principal = {
  kind: "user",
  userId: "user_test",
  sessionId: "session_test",
  roles: ["Read Only"],
  capabilities: ["internal:read"],
  expiresAt: "2030-01-01T00:00:00.000Z",
};

test("the imported role matrix is centralized without privilege broadening", () => {
  assert.deepEqual(ROLE_CAPABILITIES.User, []);
  assert.deepEqual(ROLE_CAPABILITIES["Read Only"], ["internal:read"]);
  assert.deepEqual(ROLE_CAPABILITIES["Research User"], ["internal:read", "research:generate"]);
  assert.deepEqual(ROLE_CAPABILITIES["Content Manager"], [
    "internal:read",
    "research:generate",
    "content:read",
    "content:manage",
    "audio:preview",
  ]);
  assert.deepEqual(ROLE_CAPABILITIES.Admin, [
    "internal:read",
    "research:generate",
    "content:read",
    "content:manage",
    "audio:preview",
    "pipeline:retry",
    "users:manage",
    "settings:manage",
  ]);
  assert.equal(normalizeRole("content_manager"), "Content Manager");
  assert.equal(normalizeRole("researcher"), "Research User");
  assert.equal(normalizeRole("viewer"), "Read Only");
  assert.equal(normalizeRole("superadmin"), null);
  assert.deepEqual(capabilitiesForRoles(["User", "Read Only"]), ["internal:read"]);
});

test("authorization distinguishes signed-out and signed-in forbidden decisions", async () => {
  const service = new RoleAuthorizationService();
  await assert.doesNotReject(async () => {
    assert.deepEqual(await service.decide(context, null, { capability: "internal:read" }), {
      kind: "deny",
      reason: "unauthenticated",
    });
    assert.deepEqual(await service.decide(context, principal, { capability: "content:manage" }), {
      kind: "deny",
      reason: "forbidden",
    });
    assert.deepEqual(await service.decide(context, principal, { capability: "internal:read" }), {
      kind: "allow",
    });
  });
});

test("session resolution verifies expiry and hydrates only current repository roles", async () => {
  const reader = new RepositoryBackedSessionReader({
    now: () => Date.parse("2026-08-15T12:00:00.000Z"),
    verifier: {
      verify: async () => ({
        kind: "authenticated",
        userId: "user_test",
        sessionId: "session_test",
        expiresAt: "2026-08-15T13:00:00.000Z",
      }),
    },
    access: {
      getByUserId: async () => ({
        userId: "user_test",
        roles: ["Content Manager"],
        disabled: false,
        revision: "rev-1",
      }),
    },
  });
  const result = await reader.resolve(context, { headers: new Headers() });
  assert.equal(result.kind, "authenticated");
  assert.deepEqual(result.principal.roles, ["Content Manager"]);
  assert.deepEqual(result.principal.capabilities, ROLE_CAPABILITIES["Content Manager"]);
  assert.equal("email" in result.principal, false);
  assert.equal("token" in result.principal, false);
});

test("missing access is safe User, while disabled and expired sessions fail closed", async () => {
  const verified = {
    kind: "authenticated",
    userId: "user_test",
    sessionId: "session_test",
    expiresAt: "2026-08-15T13:00:00.000Z",
  };
  const makeReader = (access, session = verified) => new RepositoryBackedSessionReader({
    now: () => Date.parse("2026-08-15T12:00:00.000Z"),
    verifier: { verify: async () => session },
    access: { getByUserId: async () => access },
  });

  const missing = await makeReader(null).resolve(context, { headers: new Headers() });
  assert.equal(missing.kind, "authenticated");
  assert.deepEqual(missing.principal.roles, ["User"]);
  assert.deepEqual(missing.principal.capabilities, []);

  const disabled = await makeReader({ disabled: true, roles: ["Admin"] }).resolve(context, { headers: new Headers() });
  assert.deepEqual(disabled, { kind: "invalid", reason: "revoked" });

  const expired = await makeReader(null, { ...verified, expiresAt: "2026-08-15T11:00:00.000Z" })
    .resolve(context, { headers: new Headers() });
  assert.deepEqual(expired, { kind: "invalid", reason: "expired" });
});

test("malformed runtime role records fail closed instead of becoming User", async () => {
  const reader = new RepositoryBackedSessionReader({
    now: () => Date.parse("2026-08-15T12:00:00.000Z"),
    verifier: {
      verify: async () => ({
        kind: "authenticated",
        userId: "user_test",
        sessionId: "session_test",
        expiresAt: "2026-08-15T13:00:00.000Z",
      }),
    },
    access: {
      getByUserId: async () => ({
        userId: "user_test",
        roles: ["Root"],
        disabled: false,
        revision: "rev-1",
      }),
    },
  });
  await assert.rejects(
    () => reader.resolve(context, { headers: new Headers() }),
    (error) => error?.code === "dependency_unavailable",
  );
});

test("route classification preserves only the four reviewed public API families", () => {
  assert.equal(publicProofForPath("/api/revalidate/strapi"), "shared_revalidation_secret");
  assert.equal(publicProofForPath("/api/public/contact"), "same_site_and_body_validation");
  assert.equal(publicProofForPath("/api/public/subscriptions"), "same_site_and_body_validation");
  assert.equal(publicProofForPath("/api/public/subscriptions/unsubscribe"), "signed_unsubscribe_token");
  assert.equal(publicProofForPath("/api/webhooks/mailchimp"), "webhook_hmac");

  for (const pathname of [
    "/api/public/contact/extra",
    "/api/public/subscriptions-evil",
    "/api/webhooks/mailchimp/extra",
    "/api/rag",
    "/api/admin/users",
  ]) {
    assert.equal(classifyRoute({ method: "POST", pathname }), "private_api", pathname);
  }
});

test("public, private, and application-resolution paths retain their boundaries", () => {
  for (const pathname of ["/", "/login", "/feed", "/media/episodes/42", "/privacy/child", "/_next/app.js"]) {
    assert.equal(classifyRoute({ method: "GET", pathname }), "public", pathname);
  }
  for (const pathname of [
    "/admin",
    "/content/posts",
    "/podcast",
    "/preview/site-pages/1",
    "/admin/export.csv",
    "/content/private.html",
    "/preview/draft.png",
    "/console/app.js",
  ]) {
    assert.equal(classifyRoute({ method: "GET", pathname }), "private_page", pathname);
  }
  for (const pathname of ["/published-cms-page", "/does-not-exist", "/unknown/nested"]) {
    assert.equal(classifyRoute({ method: "GET", pathname }), "application_resolution", pathname);
  }
  assert.equal(classifyRoute({ method: "GET", pathname: "/privacy-impersonator" }), "application_resolution");
  assert.ok(new PortableRouteAccessPolicy());
});

test("signed-out private pages redirect with a safe query-preserving return URL", async () => {
  const request = {
    method: "GET",
    url: "https://preview.example/content/posts?page=2&filter=draft",
    headers: new Headers(),
  };
  assert.equal(requestReturnUrl(request.url), "/content/posts?page=2&filter=draft");
  assert.equal(
    loginRedirectLocation(request.url),
    "/login?redirect_url=%2Fcontent%2Fposts%3Fpage%3D2%26filter%3Ddraft",
  );
  assert.deepEqual(await decideRequestBoundary({ request, context, sessions: sessionReader({ kind: "anonymous" }) }), {
    kind: "redirect",
    status: 307,
    location: "/login?redirect_url=%2Fcontent%2Fposts%3Fpage%3D2%26filter%3Ddraft",
  });
});

test("signed-out private APIs return the correlated JSON contract, never HTML", async () => {
  const decision = await decideRequestBoundary({
    request: { method: "POST", url: "https://preview.example/api/admin/users", headers: new Headers() },
    context,
    sessions: sessionReader({ kind: "invalid", reason: "revoked" }),
  });
  assert.deepEqual(decision, {
    kind: "reject",
    status: 401,
    body: {
      error: {
        code: "unauthenticated",
        message: "Authentication required.",
        correlationId: "corr-auth-test",
        retryable: false,
      },
    },
  });
  const response = responseFromRequestBoundaryDecision(decision);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("x-correlation-id"), "corr-auth-test");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("an unavailable auth dependency fails closed instead of invoking OpenNext", async () => {
  const decision = await decideRequestBoundary({
    request: { method: "GET", url: "https://preview.example/admin", headers: new Headers() },
    context,
    sessions: {
      resolve: async () => {
        const { ServiceError } = await import("@aic/contracts");
        throw new ServiceError({
          code: "dependency_unavailable",
          message: "Authentication is temporarily unavailable.",
          retryable: true,
        });
      },
    },
  });
  assert.equal(decision.kind, "reject");
  assert.equal(decision.status, 503);
  assert.equal(responseFromRequestBoundaryDecision(decision).status, 503);
});

test("signed-in callers are admitted but not granted handler authorization implicitly", async () => {
  const decision = await decideRequestBoundary({
    request: { method: "GET", url: "https://preview.example/content", headers: new Headers() },
    context,
    sessions: sessionReader({ kind: "authenticated", principal }),
  });
  assert.equal(decision.kind, "continue");
  assert.equal(decision.access, "private_page");
  assert.equal(decision.principal, principal);
  assert.equal(principal.capabilities.includes("content:manage"), false);
});

test("public/proof routes and unknown 404 candidates do not require a session", async () => {
  const sessions = { resolve: async () => { throw new Error("session verifier must not run"); } };
  const publicDecision = await decideRequestBoundary({
    request: { method: "GET", url: "https://preview.example/feed", headers: new Headers() },
    context,
    sessions,
  });
  assert.deepEqual(publicDecision, { kind: "continue", access: "public", principal: null });

  const proofDecision = await decideRequestBoundary({
    request: { method: "POST", url: "https://preview.example/api/webhooks/mailchimp", headers: new Headers() },
    context,
    sessions,
  });
  assert.deepEqual(proofDecision, {
    kind: "continue",
    access: "proof_authenticated_public_api",
    principal: null,
    requiredProof: "webhook_hmac",
  });

  const unknown = await decideRequestBoundary({
    request: { method: "GET", url: "https://preview.example/not-a-real-page?x=1", headers: new Headers() },
    context,
    sessions,
  });
  assert.deepEqual(unknown, { kind: "continue", access: "application_resolution", principal: null });
});

test("return URLs reject absolute, scheme-relative, encoded, backslash, and control forms", () => {
  assert.equal(safeRelativeReturnUrl("/podcast?tab=stats"), "/podcast?tab=stats");
  assert.equal(safeRelativeReturnUrl("/search?q=100%25"), "/search?q=100%25");
  assert.equal(safeRelativeReturnUrl("/content?_rsc=yJVSf2-mUsVl2a-v"), "/content");
  assert.equal(safeRelativeReturnUrl("/content?tab=1&_rsc=abc"), "/content?tab=1");
  assert.equal(requestReturnUrl("https://preview.example/content?_rsc=abc"), "/content");
  for (const unsafe of [
    "https://evil.example/",
    "//evil.example/",
    "/%2F%2Fevil.example/",
    "/%252F%252Fevil.example/",
    "/\\evil.example/",
    "/%5Cevil.example/",
    "/ok\r\nLocation:https://evil.example",
  ]) {
    assert.equal(safeRelativeReturnUrl(unsafe), null, unsafe);
  }
});

test("dynamic CMS ownership wins before legacy redirects and outages fail closed", async () => {
  for (const ownership of ["owned", "unavailable"]) {
    let redirects = 0;
    const decision = await resolveApplicationRoute(
      context,
      "https://preview.example/living-page?utm=one",
      {
        dynamicPageOwnership: async () => ownership,
        resolveRedirect: async () => { redirects += 1; return null; },
      },
    );
    assert.deepEqual(decision, { kind: "continue_to_application" });
    assert.equal(redirects, 0);
  }
});

test("legacy redirects follow authoritative CMS misses and preserve request query", async () => {
  const calls = [];
  const decision = await resolveApplicationRoute(
    context,
    "https://preview.example/legacy-page?utm=one&utm=two&fixed=source",
    {
      dynamicPageOwnership: async (_context, slug) => { calls.push(`cms:${slug}`); return "not_owned"; },
      resolveRedirect: async (_context, pathname) => {
        calls.push(`redirect:${pathname}`);
        return { sourcePath: pathname, destination: "/writings/new?fixed=target", status: 308 };
      },
    },
  );
  assert.deepEqual(calls, ["cms:legacy-page", "redirect:/legacy-page"]);
  assert.deepEqual(decision, {
    kind: "redirect",
    status: 308,
    location: "/writings/new?fixed=target&utm=one&utm=two",
  });
});

test("redirect repository outages fail closed instead of falling back to bootstrap", async () => {
  const decision = await resolveApplicationRoute(
    context,
    "https://preview.example/legacy-page?utm=one",
    {
      dynamicPageOwnership: async () => "not_owned",
      resolveRedirect: async () => "unavailable",
    },
  );
  assert.deepEqual(decision, { kind: "unavailable" });
});

test("unknown paths continue to the real router 404 and unsafe redirect targets are ignored", async () => {
  assert.equal(dynamicPublicSlug("/cms-page/"), "cms-page");
  assert.equal(dynamicPublicSlug("/admin"), null);
  assert.equal(dynamicPublicSlug("/unknown/nested"), null);

  const unknown = await resolveApplicationRoute(context, "https://preview.example/unknown/nested?x=1", {
    dynamicPageOwnership: async () => { throw new Error("multi-segment paths are not CMS slugs"); },
    resolveRedirect: async () => null,
  });
  assert.deepEqual(unknown, { kind: "continue_to_application" });

  const unsafe = await resolveApplicationRoute(context, "https://preview.example/old", {
    dynamicPageOwnership: async () => "not_owned",
    resolveRedirect: async () => ({ sourcePath: "/old", destination: "https://evil.example", status: 302 }),
  });
  assert.deepEqual(unsafe, { kind: "continue_to_application" });
});

test("future Clerk readiness is explicit without requiring or exposing current secrets", () => {
  const empty = assessClerkConfiguration({});
  assert.equal(empty.ready, false);
  assert.deepEqual(empty.missing, [
    "clientPublishableKey",
    "secretKey",
    "jwtKey",
    "authorizedParties",
  ]);

  const configured = assessClerkConfiguration({
    clientPublishableKey: "pk_test_synthetic",
    serverPublishableKey: "pk_test_synthetic",
    secretKey: "sk_test_synthetic",
    jwtKey: "synthetic-public-jwt-key",
    authorizedParties: ["https://preview.example", "http://localhost:3000"],
    signInPath: "/login",
    signUpEnabled: false,
  });
  assert.equal(configured.ready, true);
  assert.equal(configured.networklessVerificationConfigured, true);
  assert.equal(JSON.stringify(configured).includes("synthetic"), false);
  assert.equal(CLERK_CONFIGURATION_CONTRACT.secretKey, "CLERK_SECRET_KEY");

  const withoutAlias = assessClerkConfiguration({
    clientPublishableKey: "pk_test_synthetic",
    secretKey: "sk_test_synthetic",
    jwtKey: "synthetic-public-jwt-key",
    authorizedParties: ["https://preview.example"],
  });
  assert.equal(withoutAlias.ready, true);
  assert.equal(withoutAlias.missing.includes("serverPublishableKey"), false);

  const conflictingAlias = assessClerkConfiguration({
    clientPublishableKey: "pk_test_client",
    serverPublishableKey: "pk_test_other",
    secretKey: "sk_test_synthetic",
    jwtKey: "synthetic-public-jwt-key",
    authorizedParties: ["https://preview.example"],
  });
  assert.deepEqual(conflictingAlias.invalid, ["publishableKeys"]);

  const unsafe = assessClerkConfiguration({
    authorizedParties: ["http://preview.example/path"],
    signInPath: "https://evil.example",
    signUpEnabled: true,
  });
  assert.deepEqual(unsafe.invalid, ["authorizedParties", "signInPath", "signUpEnabled"]);
});

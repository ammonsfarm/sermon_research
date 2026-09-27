# `@aic/auth`

Worker-neutral authentication, role/capability authorization, deterministic request admission, and application-route resolution for the Phase 1 migration.

## Integration contract

The supported replacement is split deliberately:

1. A custom outer Worker/OpenNext entry calls `decideRequestBoundary`. It may return the 307 login redirect or correlated API 401 before invoking OpenNext. It performs no CMS, redirect-database, PostgreSQL, or provider-specific work.
2. A Clerk adapter implements `SessionVerifier` with Clerk Backend `authenticateRequest()`, a fixed `authorizedParties` allowlist, and preferably `CLERK_JWT_KEY` for networkless verification. The adapter owns Clerk SDK objects and credentials; none cross `SessionReader`.
3. Protected pages, Route Handlers, and Server Actions independently resolve the same request session and call `AuthorizationService`. Outer admission is never accepted as handler authorization, and no caller-supplied identity header is trusted.
4. `resolveApplicationRoute` belongs in application routing (for example, a narrowly scoped catch-all route or compatible OpenNext wrapper), not in global auth admission. It checks an eligible dynamic CMS slug first, fails closed on CMS lookup unavailability, then resolves a legacy redirect, otherwise continuing to the real router/404.

This package intentionally does not edit or replace `apps/web/proxy.ts`. P1-COMPAT-FIX/OpenNext must wire these APIs, preserve existing handler/action guards during incremental conversion, and prove the integrated Worker behavior before removing the unsupported Node Proxy.

## Future Clerk configuration

`CLERK_CONFIGURATION_CONTRACT` reserves the non-secret and secret input names for the future application. `assessClerkConfiguration` reports only missing/invalid labels and never returns values. No production Clerk app, credential, authorized origin, or Cloudflare secret is created by this package.

The Clerk adapter must validate every token, reject expired/revoked/malformed sessions, set `authorizedParties`, retain `/login`, keep sign-up disabled, and avoid logging tokens, cookies, JWT keys, secret keys, or Clerk objects.

References: [Clerk request authentication](https://clerk.com/docs/guides/sessions/manual-jwt-verification), [Clerk resource-level authorization migration](https://clerk.com/docs/guides/development/upgrading/upgrade-guides/migrate-from-create-route-matcher).

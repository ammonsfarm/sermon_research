# `@aic/observability`

Worker/Node-neutral observability primitives for the Phase 1 service adapters.

The package owns request/correlation/trace ID admission, bounded structured log
fields, safe error responses, and the health/version response shape. It depends
only on `@aic/contracts` and platform-standard `crypto`, `console`, and
`Response` APIs. A caller supplies a log sink when it needs a different
transport; this package does not provision a logging vendor or Cloudflare
resource.

## Safety rules

`createStructuredLogger` removes fields whose names match the frozen forbidden
patterns (authorization, cookies, passwords, secrets, tokens, API keys,
signed/upload URLs, and request/response bodies), including nested fields. It
also bounds nesting, field count, and string length. Request bodies, provider
payloads, RAG questions/answers, stack traces, and error causes are never safe
log fields by default.

`safeErrorEnvelope` delegates to the `@aic/contracts` boundary contract. Unknown
errors become a generic `internal` response and never expose their message,
cause, or stack. `healthVersionResponse` exposes only version, commit,
environment, overall status, and caller-sanitized dependency summaries.

## Integration example

```ts
import {
  createCorrelationContext,
  createStructuredLogger,
  safeErrorResponse,
} from "@aic/observability";

const correlation = createCorrelationContext({
  incomingCorrelationId: request.headers.get("x-correlation-id") ?? undefined,
});
```

Keep the integration at request boundaries. The next compatibility phase can
construct an `OperationContext`, pass it to `logger.write`, and use
`safeErrorResponse` without importing a runtime-specific logger or binding.

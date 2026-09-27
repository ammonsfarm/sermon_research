# AIC ingest discovery foundation

This package owns the bounded SoundCloud RSS discovery pass and the non-atomic
D1-to-Cloudflare-Workflow start reconciliation for Phase 6. It does not host the
episode Workflow, download audio, call providers, or replace the fail-closed
production placeholder/configuration.

## Composition boundary

The later Worker composition supplies generated Cloudflare bindings and joins
these narrow ports:

- `createSoundCloudSource` receives the feed URL and an injected `fetch`.
- `D1DiscoveryRunStore` receives the `AIC_DB`-compatible D1 binding.
- `runEpisodeDiscovery` receives the existing `D1ProcessingStateStore`, the
  discovery run store, and a dispatch function.
- The dispatch function calls `reconcileInitialExecutionStart` with the same D1
  binding, the processing state store, the generated episode Workflow binding,
  and an explicit predicate that recognizes the binding's missing-instance
  error. No provider error code is guessed in this package.
- `createScheduledDiscoveryHandler` derives a unique scheduled slot from the
  controller's UTC minute. Operator catch-up calls `runEpisodeDiscovery`
  directly with a distinct attributed slot.

The Workflow params are limited to `requestId`, `executionId`, and `generation`.
The Workflow reloads the immutable input from D1; RSS payloads are not copied
into Workflow instance metadata.

## Discovery guarantees and bounds

The SoundCloud adapter preserves the numeric track ID extracted from the known
SoundCloud GUID/enclosure forms used by the existing podcast importer. That ID
is the canonical EpisodeId. Mutable title, URL, and date fields remain inside
the canonical processing snapshot, so a changed immutable snapshot produces a
new revision and idempotency key.

RSS reads have these local bounds and checks:

- 2 MiB response limit by default, configurable up to 5 MiB;
- 1 to 100 selected items per call;
- HTTPS feed/enclosure URLs without embedded credentials or fragments;
- XML/RSS content type and valid UTF-8;
- DTD and entity declarations rejected before parsing, with entity processing
  disabled in `fast-xml-parser`;
- conditional `ETag` and `Last-Modified` validators;
- no representation validator is retained while a bounded catch-up reports
  unread newer items, so a correct `304 Not Modified` cannot hide that backlog;
- a stable cursor derived from the SoundCloud track ID, so metadata edits do
  not invalidate the cursor;
- a missing prior cursor fails closed instead of skipping a rotated feed
  window.

With no prior cursor, the first read establishes a bounded baseline from the
newest `maxItems` entries and processes them oldest-to-newest. With a cursor,
catch-up also processes oldest-to-newest and advances by at most `maxItems`, so
more than one bounded pass cannot skip intervening episodes. An initial
historical backfill or an explicit cursor seed is a separate operator decision.

Every feed-created request has `desiredPublication = "draft"`. Feed success
never authorizes publication.

## Durable progress and Workflow reconciliation

`processing_discovery_runs` stores one row for each `(source_adapter,
scheduled_slot)`, including validators, cursor, bounded counts, failure state,
and safe error text. A failed slot is reclaimed with a compare-and-set, so only
one concurrent delivery becomes its source reader. A valid item advances the
run cursor only after both the immutable processing request and its deterministic
`starting` execution row exist.

Recovery scans bounded, eligible current-head requests that either lack their
sequence-zero execution or retain it in `starting`. It allocates a missing
execution before dispatch, so a request committed just before a crash does not
depend on appearing in RSS again. The durable run-owned request/execution rows
repair `new`, `seen`, and `dispatched` evidence without double-counting a later
RSS replay. Prior-run recovery, current-run recovery, and new feed records share
one `maxItems` invocation budget. If Workflow dispatch is interrupted, the same
slot or a later scheduled run performs this recovery before reading more source
items.

Each new run also performs a separate bounded scan for prior `running` or
`failed` audit rows whose stored counts disagree with their durable run-owned
requests and sequence-zero executions. This audit-only repair remains
discoverable after an execution has reached `running`, so a lost dispatch
response cannot strand pre-progress counts. It never calls Workflow and does not
consume the dispatch/source item budget; once repaired, the row no longer
matches later scans.

The accounting scan reads one indexed candidate page per eligible status and,
when one status has unused capacity, at most one indexed continuation page from
the other. It merges and inspects at most twice the requested limit. Each
candidate uses an indexed exact-owner count; there is no global request-history
grouping. A consistent candidate receives a monotonic `updated_at` bump,
including when the injected clock is fixed, so later pages eventually receive
inspection instead of being starved by an old consistent first page.

The start protocol is:

1. allocate/read the deterministic initial D1 execution;
2. confirm the request is still the current, uncancelled head;
3. look up the deterministic Workflow instance ID;
4. if and only if D1 still says `starting` and the instance is confirmed
   missing, call `createBatch([{ id, params }])`;
5. look up the instance again, validate its exact ID/status, and compare-and-set
   the D1 execution status.

This covers a crash before create, a lost create response, a crash after create
before the D1 update, and replay after the D1 update. A missing instance whose
D1 execution was already `running` is reported as vanished and is never
recreated as an implicit retry. Resume remains an attributed operator action in
the processing state store.

The binding surface follows the current Cloudflare
[Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
and the handler factory follows the current
[Scheduled Handler API](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/).

## Local verification

```sh
npm test --workspace @aic/ingest
npm run typecheck --workspace @aic/ingest
```

Tests use only synthetic RSS, an in-memory SQLite-backed D1 adapter, and a fake
Workflow binding. They perform no production or provider reads or writes.

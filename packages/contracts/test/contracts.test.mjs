import assert from "node:assert/strict";
import test from "node:test";

import {
  ADAPTER_IMPLEMENTATIONS,
  PROCESSING_AGGREGATE_TYPES,
  PROCESSING_ENTITY_TYPES,
  PROCESSING_INPUT_SNAPSHOT_MAX_BYTES,
  PROCESSING_OPERATIONS,
  PROCESSING_STATES,
  PROCESSING_TERMINAL_STATES,
  PROCESSING_WORKFLOWS,
  ERROR_HTTP_STATUS,
  MAX_REPOSITORY_PAGE_LIMIT,
  PODCAST_URLS,
  ServiceError,
  assertRepositoryPageRequest,
  correlationId,
  cmsArticleId,
  episodeId,
  episodeAudioObjectKey,
  encodeRepositoryRevision,
  httpStatusForError,
  migrationVectorId,
  objectKey,
  parseRangeHeader,
  pastorWoodArticleId,
  resolveByteRange,
  decodeRepositoryRevision,
  assertProcessingTransition,
  canonicalProcessingAggregate,
  canonicalProcessingSnapshot,
  createProcessingIdempotencyKey,
  createProcessingRevisionHash,
  createProcessingWorkflowInstanceId,
  isAuthenticatedCorpusVisible,
  processingChunkContentHash,
  processingRevisionHash,
  toErrorEnvelope,
} from "../src/index.ts";

const p6Digest = "a".repeat(64);
const secondP6Digest = "b".repeat(64);

test("Phase 6 processing enums are complete and frozen", () => {
  assert.deepEqual(PROCESSING_WORKFLOWS, ["episode", "content"]);
  assert.deepEqual(PROCESSING_ENTITY_TYPES, ["episode", "article", "transcript"]);
  assert.deepEqual(PROCESSING_AGGREGATE_TYPES, ["episode", "article"]);
  assert.deepEqual(PROCESSING_OPERATIONS, [
    "episode_ingest",
    "article_replace",
    "transcript_replace",
    "public_unpublish",
    "public_archive",
    "corpus_erase",
  ]);
  assert.deepEqual(PROCESSING_TERMINAL_STATES, [
    "published",
    "unpublished",
    "archived",
    "corpus_erased",
    "failed",
    "retry_required",
    "superseded",
    "cancelled",
  ]);
  assert.deepEqual(PROCESSING_STATES, [
    "discovered",
    "audio_storing",
    "audio_stored",
    "transcribing",
    "transcript_ready",
    "revision_recorded",
    "chunking",
    "embedding",
    "indexing",
    "index_visibility_pending",
    "stale_vector_deleting",
    "delete_visibility_pending",
    "indexed",
    "intelligence_generating",
    "intelligence_ready",
    "intelligence_embedding",
    "intelligence_indexing",
    "intelligence_visibility_pending",
    "publish_ready",
    "public_unpublish_requested",
    "public_archive_requested",
    "public_hidden",
    "corpus_erase_requested",
    "corpus_hidden",
    "vector_deleting",
    "published",
    "unpublished",
    "archived",
    "corpus_erased",
    "failed",
    "retry_required",
    "superseded",
    "cancelled",
  ]);
});

test("Phase 6 snapshot and hash formats cannot be confused with chunk hashes", async () => {
  assert.equal(PROCESSING_INPUT_SNAPSHOT_MAX_BYTES, 262_144);
  const exactSnapshot = { x: "a".repeat(PROCESSING_INPUT_SNAPSHOT_MAX_BYTES - 8) };
  assert.equal(new TextEncoder().encode(canonicalProcessingSnapshot(exactSnapshot)).byteLength, 262_144);
  assert.throws(
    () => canonicalProcessingSnapshot({ x: `${exactSnapshot.x}a` }),
    /262144/u,
  );
  assert.equal(processingRevisionHash(`sha256:${p6Digest}`), `sha256:${p6Digest}`);
  assert.equal(processingChunkContentHash(p6Digest), p6Digest);
  assert.throws(() => processingRevisionHash(p6Digest), /sha256/u);
  assert.throws(() => processingRevisionHash(`sha256:${p6Digest.toUpperCase()}`), /sha256/u);
  assert.throws(() => processingChunkContentHash(`sha256:${p6Digest}`), /content_hash/u);
  assert.throws(() => processingChunkContentHash(p6Digest.toUpperCase()), /content_hash/u);
  assert.equal(
    await createProcessingRevisionHash({ episodeId: "sa_42", title: "Frozen" }),
    `sha256:b8dcdc2a033ead065c9a99ef0160e9de96559987028f8cab9030f1752ebb35fc`,
  );
});

test("canonical processing aggregates share the episode head for transcript replacement", () => {
  assert.deepEqual(canonicalProcessingAggregate("episode_ingest", "episode", "sa_42"), {
    type: "episode",
    id: "sa_42",
  });
  assert.deepEqual(canonicalProcessingAggregate("transcript_replace", "transcript", "sa_42"), {
    type: "episode",
    id: "sa_42",
  });
  assert.deepEqual(canonicalProcessingAggregate("article_replace", "article", "pastorwood:42"), {
    type: "article",
    id: "pastorwood:42",
  });
  for (const operation of ["public_unpublish", "public_archive", "corpus_erase"]) {
    assert.deepEqual(canonicalProcessingAggregate(operation, "article", "cms:doc-42"), {
      type: "article",
      id: "cms:doc-42",
    });
  }
  assert.throws(
    () => canonicalProcessingAggregate("transcript_replace", "article", "pastorwood:42"),
    /contradict/u,
  );
  assert.throws(
    () => canonicalProcessingAggregate("article_replace", "transcript", "sa_42"),
    /contradict/u,
  );
});

test("Phase 6 transition table accepts only frozen state edges", () => {
  const legal = [
    ["episode", "episode_ingest", "discovered", "audio_storing"],
    ["episode", "episode_ingest", "discovered", "publish_ready"],
    ["episode", "episode_ingest", "index_visibility_pending", "indexed"],
    ["episode", "episode_ingest", "publish_ready", "published"],
    ["content", "article_replace", "revision_recorded", "chunking"],
    ["content", "transcript_replace", "delete_visibility_pending", "indexed"],
    ["content", "public_unpublish", "public_unpublish_requested", "public_hidden"],
    ["content", "public_unpublish", "public_hidden", "unpublished"],
    ["content", "corpus_erase", "corpus_hidden", "vector_deleting"],
    ["content", "corpus_erase", "delete_visibility_pending", "corpus_erased"],
    ["episode", "episode_ingest", "embedding", "retry_required"],
    ["content", "article_replace", "indexing", "superseded"],
  ];
  for (const [workflow, operation, from, to] of legal) {
    assert.doesNotThrow(() => assertProcessingTransition(workflow, operation, from, to));
  }
  for (const [workflow, operation, from, to] of [
    ["episode", "episode_ingest", "discovered", "published"],
    ["episode", "episode_ingest", "indexed", "audio_storing"],
    ["content", "article_replace", "revision_recorded", "published"],
    ["content", "public_unpublish", "public_hidden", "archived"],
    ["content", "article_replace", "delete_visibility_pending", "corpus_erased"],
    ["episode", "episode_ingest", "published", "cancelled"],
  ]) {
    assert.throws(() => assertProcessingTransition(workflow, operation, from, to), /transition/u);
  }
});

test("logical keys and every resume use bounded distinct Workflow instance IDs", async () => {
  const revisionHash = processingRevisionHash(`sha256:${secondP6Digest}`);
  const episodeKey = await createProcessingIdempotencyKey({
    operation: "episode_ingest",
    entityType: "episode",
    entityId: "sa_42",
    revisionHash,
  });
  const transcriptKey = await createProcessingIdempotencyKey({
    operation: "transcript_replace",
    entityType: "transcript",
    entityId: "sa_42",
    revisionHash,
  });
  assert.match(episodeKey, /^p6:episode-ingest:v1:[0-9a-f]{64}$/u);
  assert.match(transcriptKey, /^p6:transcript-index:v1:[0-9a-f]{64}$/u);
  const initial = createProcessingWorkflowInstanceId("episode", episodeKey, 0);
  const resumed = createProcessingWorkflowInstanceId("episode", episodeKey, 1);
  assert.notEqual(initial, resumed);
  assert.match(initial, /^p6e-[0-9a-f]{64}-0$/u);
  assert.match(resumed, /^p6e-[0-9a-f]{64}-1$/u);
  assert.ok(initial.length < 100);
  assert.ok(resumed.length < 100);
});

test("shared authenticated-corpus visibility is deny-first for P6 revisions", () => {
  assert.equal(isAuthenticatedCorpusVisible(null, null), true);
  assert.equal(isAuthenticatedCorpusVisible({ visibility: "inherited", revisionHash: null }, null), true);
  assert.equal(isAuthenticatedCorpusVisible({ visibility: "hidden", revisionHash: null }, null), false);
  assert.equal(isAuthenticatedCorpusVisible({ visibility: "erased", revisionHash: null }, null), false);
  assert.equal(
    isAuthenticatedCorpusVisible(
      { visibility: "visible", revisionHash: `sha256:${p6Digest}` },
      `sha256:${p6Digest}`,
    ),
    true,
  );
  assert.equal(
    isAuthenticatedCorpusVisible(
      { visibility: "visible", revisionHash: `sha256:${p6Digest}` },
      `sha256:${secondP6Digest}`,
    ),
    false,
  );
  assert.equal(isAuthenticatedCorpusVisible(null, `sha256:${p6Digest}`), false);
});

test("episode IDs preserve every observed/accepted stable family", () => {
  for (const value of ["2369479907", "sa_123", "wp-sermon:42", "cms_episode-1"]) {
    assert.equal(episodeId(value), value);
  }
  assert.throws(() => episodeId("../audio"), ServiceError);
});

test("object keys reject host/path traversal forms", () => {
  assert.equal(objectKey("podcasts/2369479907.mp3"), "podcasts/2369479907.mp3");
  assert.throws(() => objectKey("../secret"), ServiceError);
  assert.throws(() => objectKey("/absolute"), ServiceError);
  assert.throws(() => objectKey("bad\\key"), ServiceError);
  assert.throws(() => objectKey("podcasts//bad.mp3"), ServiceError);
});

test("Phase 3 migration identities are deterministic and collision-safe", () => {
  const episode = episodeId("2369479907");
  assert.equal(episodeAudioObjectKey(episode), "podcasts/2369479907.mp3");
  assert.equal(pastorWoodArticleId("14238"), "pastorwood:14238");
  assert.equal(cmsArticleId("cms-document-1"), "cms:cms-document-1");
  assert.equal(
    migrationVectorId("transcript_chunks", "2369479907:speech:0001"),
    "t/2369479907:speech:0001",
  );
  assert.equal(
    migrationVectorId("episode_intelligence_vectors", "2369479907:speech:0001"),
    "i/2369479907:speech:0001",
  );
  assert.throws(() => pastorWoodArticleId("001"), ServiceError);
  assert.throws(
    () => migrationVectorId("pastorwood_post_chunks", "x".repeat(63)),
    ServiceError,
  );
});

test("single HTTP byte ranges parse and resolve deterministically", () => {
  assert.deepEqual(parseRangeHeader(null), { kind: "none" });
  assert.deepEqual(parseRangeHeader("bytes=0-15"), {
    kind: "valid",
    range: { kind: "closed", start: 0, endInclusive: 15 },
  });
  assert.deepEqual(parseRangeHeader("bytes=16-"), {
    kind: "valid",
    range: { kind: "open", start: 16 },
  });
  assert.deepEqual(parseRangeHeader("bytes=-16"), {
    kind: "valid",
    range: { kind: "suffix", length: 16 },
  });
  assert.deepEqual(parseRangeHeader("bytes=0-1,4-5"), { kind: "invalid" });

  assert.deepEqual(resolveByteRange({ kind: "closed", start: 0, endInclusive: 15 }, 10), {
    kind: "satisfied",
    range: { start: 0, endInclusive: 9, length: 10 },
  });
  assert.deepEqual(resolveByteRange({ kind: "suffix", length: 4 }, 10), {
    kind: "satisfied",
    range: { start: 6, endInclusive: 9, length: 4 },
  });
  assert.deepEqual(resolveByteRange({ kind: "open", start: 10 }, 10), {
    kind: "unsatisfiable",
  });
});

test("Phase 4 repository pages and podcast routes are bounded and canonical", () => {
  assert.doesNotThrow(() => assertRepositoryPageRequest({ limit: 1 }));
  assert.doesNotThrow(() => assertRepositoryPageRequest({ limit: MAX_REPOSITORY_PAGE_LIMIT }));
  assert.throws(() => assertRepositoryPageRequest({ limit: 0 }), ServiceError);
  assert.throws(
    () => assertRepositoryPageRequest({ limit: MAX_REPOSITORY_PAGE_LIMIT + 1 }),
    ServiceError,
  );
  assert.throws(
    () => assertRepositoryPageRequest({ limit: 1, cursor: " " }),
    ServiceError,
  );

  assert.equal(PODCAST_URLS.publicAudioUrl(episodeId("2369479907")), "/media/episodes/2369479907");
  assert.equal(PODCAST_URLS.internalAudioUrl(episodeId("wp-sermon:42")), "/api/audio/wp-sermon%3A42");
  assert.equal(PODCAST_URLS.episodePageUrl("grace-and-truth"), "/radio/grace-and-truth/");
  assert.throws(() => PODCAST_URLS.episodePageUrl("."), ServiceError);
  assert.throws(() => PODCAST_URLS.episodePageUrl(".."), ServiceError);
  assert.throws(() => PODCAST_URLS.episodePageUrl("../private"), ServiceError);
});

test("Phase 4 repository revisions use one canonical provider-neutral token", () => {
  const token = encodeRepositoryRevision({
    kind: "episode",
    documentId: "episode-doc-α",
    updatedAt: "2026-08-22T00:00:00.000000Z",
  });
  assert.deepEqual(decodeRepositoryRevision(token), {
    v: 1,
    kind: "episode",
    documentId: "episode-doc-α",
    updatedAt: "2026-08-22T00:00:00.000000Z",
  });
  assert.equal(String(token).includes("="), false);
  assert.throws(() => decodeRepositoryRevision(`${token}=`), ServiceError);
  assert.throws(
    () => encodeRepositoryRevision({
      kind: "episode",
      documentId: " episode-doc ",
      updatedAt: "2026-08-22T00:00:00.000000Z",
    }),
    ServiceError,
  );
  assert.throws(
    () => encodeRepositoryRevision({
      kind: "episode",
      documentId: "episode-doc",
      updatedAt: "2026-02-30T00:00:00.000000Z",
    }),
    ServiceError,
  );
});

test("safe error envelopes correlate responses without leaking causes", () => {
  const cause = new Error("provider token secret");
  const error = new ServiceError({
    code: "dependency_unavailable",
    message: "Audio metadata is temporarily unavailable.",
    retryable: true,
    safeDetails: { retryAfterSeconds: 60 },
    cause,
  });
  const envelope = toErrorEnvelope(error, correlationId("corr-test"));

  assert.equal(httpStatusForError(error), 503);
  assert.equal(ERROR_HTTP_STATUS.range_not_satisfiable, 416);
  assert.deepEqual(envelope, {
    error: {
      code: "dependency_unavailable",
      message: "Audio metadata is temporarily unavailable.",
      correlationId: "corr-test",
      retryable: true,
      details: { retryAfterSeconds: 60 },
    },
  });
  assert.equal(JSON.stringify(envelope).includes("provider token secret"), false);

  const unknown = toErrorEnvelope(cause, correlationId("corr-unknown"));
  assert.equal(unknown.error.code, "internal");
  assert.equal(JSON.stringify(unknown).includes("provider token secret"), false);
});

test("every adapter concern has distinct current and target implementations", () => {
  for (const pair of Object.values(ADAPTER_IMPLEMENTATIONS)) {
    assert.equal(pair.current.stage, "current");
    assert.equal(pair.target.stage, "target");
    assert.notEqual(pair.current.id, pair.target.id);
  }
});

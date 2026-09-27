import assert from "node:assert/strict";
import test from "node:test";

import {
  ServiceError,
  correlationId,
  episodeId,
} from "@aic/contracts";
import {
  R2AudioObjectReader,
  episodeAudioObjectKey,
} from "../src/index.ts";

const EPISODE = episodeId("2369479907");
const KEY = episodeAudioObjectKey(EPISODE);
const BYTES = Uint8Array.from({ length: 32 }, (_, index) => index);

function streamFromChunks(chunks, error) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
        return;
      }
      if (error !== undefined) {
        controller.error(error);
      } else {
        controller.close();
      }
    },
  });
}

function streamFrom(bytes, error) {
  return streamFromChunks(bytes.byteLength > 0 ? [bytes] : [], error);
}

function objectFor(key = KEY, bytes = BYTES, overrides = {}) {
  return {
    key,
    size: bytes.byteLength,
    etag: 'etag-1',
    httpMetadata: { contentType: "audio/mpeg" },
    body: streamFrom(bytes),
    ...overrides,
  };
}

class FakeBucket {
  constructor(object = objectFor()) {
    this.object = object;
    this.headCalls = [];
    this.getCalls = [];
    this.headError = undefined;
    this.getError = undefined;
    this.getNull = false;
  }

  async head(key) {
    this.headCalls.push(key);
    if (this.headError !== undefined) throw this.headError;
    return this.object;
  }

  async get(key, options) {
    this.getCalls.push({ key, options });
    if (this.getError !== undefined) throw this.getError;
    if (this.getNull) return null;
    if (this.object === null) return null;
    const range = options?.range;
    if (range === undefined) return this.object;
    const start = range.offset ?? Math.max(0, this.object.size - (range.suffix ?? 0));
    const end = range.length === undefined ? this.object.size : start + range.length;
    const source = this.object.bodyBytes ?? BYTES;
    return {
      ...this.object,
      size: source.byteLength,
      body: streamFrom(source.slice(start, end)),
    };
  }
}

function context(signal = new AbortController().signal) {
  return {
    boundary: "request",
    signal,
    correlation: { correlationId: correlationId("storage-test") },
    request: { method: "GET", path: `/media/episodes/${EPISODE}` },
  };
}

async function bytesFrom(body) {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

test("derives the canonical object key and maps a full R2 read to 200", async () => {
  const bucket = new FakeBucket(objectFor(KEY, BYTES, { bodyBytes: BYTES }));
  const reader = new R2AudioObjectReader(bucket);
  assert.equal(reader.keyForEpisode(EPISODE), "podcasts/2369479907.mp3");

  const result = await reader.readAudio(context(), EPISODE);
  assert.equal(result.kind, "found");
  assert.equal(result.status, 200);
  assert.deepEqual(result.metadata, {
    key: KEY,
    size: BYTES.byteLength,
    contentType: "audio/mpeg",
    etag: "etag-1",
  });
  assert.deepEqual(await bytesFrom(result.body), BYTES);
  assert.deepEqual(bucket.getCalls, [{ key: KEY, options: undefined }]);
});

test("resolves closed, open, and suffix ranges before issuing one R2 offset/length read", async () => {
  for (const [request, expectedStart, expectedEnd] of [
    [{ kind: "closed", start: 2, endInclusive: 5 }, 2, 5],
    [{ kind: "open", start: 28 }, 28, 31],
    [{ kind: "suffix", length: 4 }, 28, 31],
    [{ kind: "closed", start: 2, endInclusive: 1000 }, 2, 31],
  ]) {
    const bucket = new FakeBucket(objectFor(KEY, BYTES, { bodyBytes: BYTES }));
    const result = await new R2AudioObjectReader(bucket).readAudio(context(), EPISODE, request);
    assert.equal(result.kind, "found");
    assert.equal(result.status, 206);
    assert.deepEqual(result.range, {
      start: expectedStart,
      endInclusive: expectedEnd,
      length: expectedEnd - expectedStart + 1,
    });
    assert.deepEqual(await bytesFrom(result.body), BYTES.slice(expectedStart, expectedEnd + 1));
    assert.deepEqual(bucket.getCalls[0], {
      key: KEY,
      options: { range: { offset: expectedStart, length: expectedEnd - expectedStart + 1 } },
    });
  }
});

test("returns authoritative 416 without calling R2 get for oversized and empty ranges", async () => {
  const bucket = new FakeBucket(objectFor(KEY, BYTES, { bodyBytes: BYTES }));
  const result = await new R2AudioObjectReader(bucket).readAudio(
    context(),
    EPISODE,
    { kind: "closed", start: BYTES.byteLength, endInclusive: BYTES.byteLength + 4 },
  );
  assert.deepEqual(result, { kind: "range_not_satisfiable", size: BYTES.byteLength });
  assert.equal(bucket.getCalls.length, 0);

  const empty = new FakeBucket(objectFor(KEY, new Uint8Array(), { bodyBytes: new Uint8Array() }));
  const emptyReader = new R2AudioObjectReader(empty);
  const full = await emptyReader.readAudio(context(), EPISODE);
  assert.equal(full.kind, "found");
  assert.equal(full.status, 200);
  assert.equal((await bytesFrom(full.body)).byteLength, 0);
  assert.deepEqual(
    await emptyReader.readAudio(context(), EPISODE, { kind: "suffix", length: 1 }),
    { kind: "range_not_satisfiable", size: 0 },
  );
});

test("keeps absent head/get objects distinct from provider failures", async () => {
  const missingHead = new FakeBucket(null);
  const missingReader = new R2AudioObjectReader(missingHead);
  assert.equal(await missingReader.headAudio(context(), EPISODE), null);
  assert.deepEqual(await missingReader.readAudio(context(), EPISODE), { kind: "not_found" });

  const missingGet = new FakeBucket(objectFor(KEY, BYTES, { bodyBytes: BYTES }));
  missingGet.getNull = true;
  assert.deepEqual(
    await new R2AudioObjectReader(missingGet).readAudio(context(), EPISODE),
    { kind: "not_found" },
  );

  const provider = new FakeBucket();
  provider.headError = new Error("private provider detail");
  await assert.rejects(
    () => new R2AudioObjectReader(provider).headAudio(context(), EPISODE),
    (error) => error instanceof ServiceError
      && error.code === "dependency_unavailable"
      && error.retryable
      && !error.message.includes("private provider detail"),
  );

  const getProvider = new FakeBucket();
  getProvider.getError = new Error("private get detail");
  await assert.rejects(
    () => new R2AudioObjectReader(getProvider).readAudio(context(), EPISODE),
    (error) => error instanceof ServiceError
      && error.code === "dependency_unavailable"
      && error.retryable
      && !error.message.includes("private get detail"),
  );
});

test("fails closed on wrong key, MIME, size, and missing body metadata", async () => {
  for (const overrides of [
    { key: "podcasts/other.mp3" },
    { httpMetadata: { contentType: "audio/wav" } },
    { size: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    await assert.rejects(
      () => new R2AudioObjectReader(new FakeBucket(objectFor(KEY, BYTES, overrides)))
        .headAudio(context(), EPISODE),
      (error) => error instanceof ServiceError && error.code === "dependency_unavailable",
    );
  }

  const missingBody = new FakeBucket(objectFor(KEY, BYTES, { body: undefined, bodyBytes: BYTES }));
  await assert.rejects(
    () => new R2AudioObjectReader(missingBody).readAudio(context(), EPISODE),
    (error) => error instanceof ServiceError && error.code === "dependency_unavailable",
  );

  const wrongReadSize = new FakeBucket(objectFor(KEY, BYTES, { bodyBytes: BYTES }));
  wrongReadSize.get = async (key, options) => {
    wrongReadSize.getCalls.push({ key, options });
    return { ...wrongReadSize.object, size: BYTES.byteLength - 1 };
  };
  await assert.rejects(
    () => new R2AudioObjectReader(wrongReadSize).readAudio(context(), EPISODE),
    (error) => error instanceof ServiceError && error.code === "dependency_unavailable",
  );
});

test("translates late provider body failures and checks cancellation", async () => {
  const bucket = new FakeBucket(objectFor(KEY, BYTES, {
    body: streamFromChunks([BYTES.slice(0, 8)], new Error("provider body secret")),
  }));
  const result = await new R2AudioObjectReader(bucket).readAudio(context(), EPISODE);
  assert.equal(result.kind, "found");
  const bodyReader = result.body.getReader();
  const firstChunk = await bodyReader.read();
  assert.deepEqual(firstChunk.value, BYTES.slice(0, 8));
  await assert.rejects(
    () => bodyReader.read(),
    (error) => error instanceof ServiceError
      && error.code === "dependency_unavailable"
      && !error.message.includes("provider body secret"),
  );

  const controller = new AbortController();
  controller.abort("caller stopped");
  await assert.rejects(
    () => new R2AudioObjectReader(new FakeBucket()).readAudio(context(controller.signal), EPISODE),
    (error) => error instanceof ServiceError && error.code === "cancelled",
  );
});

test("rejects short, long, and non-Uint8Array full bodies", async () => {
  const cases = [
    streamFromChunks([BYTES.slice(0, BYTES.byteLength - 1)]),
    streamFromChunks([BYTES, Uint8Array.of(99)]),
    streamFromChunks([BYTES.slice(0, 8), "not-a-byte-chunk"]),
  ];
  for (const body of cases) {
    const bucket = new FakeBucket(objectFor(KEY, BYTES, { body }));
    const result = await new R2AudioObjectReader(bucket).readAudio(context(), EPISODE);
    assert.equal(result.kind, "found");
    await assert.rejects(
      () => bytesFrom(result.body),
      (error) => error instanceof ServiceError && error.code === "dependency_unavailable",
    );
  }
});

test("enforces exact bytes for a ranged body and translates abort during a pending read", async () => {
  const rangeBucket = new FakeBucket(objectFor(KEY, BYTES, { bodyBytes: BYTES }));
  rangeBucket.get = async (key, options) => {
    rangeBucket.getCalls.push({ key, options });
    return {
      ...rangeBucket.object,
      body: streamFromChunks([BYTES.slice(0, 3)]),
    };
  };
  const rangeResult = await new R2AudioObjectReader(rangeBucket).readAudio(
    context(),
    EPISODE,
    { kind: "closed", start: 0, endInclusive: 3 },
  );
  assert.equal(rangeResult.kind, "found");
  await assert.rejects(
    () => bytesFrom(rangeResult.body),
    (error) => error instanceof ServiceError && error.code === "dependency_unavailable",
  );

  let release;
  const pendingBody = new ReadableStream({
    pull(controller) {
      return new Promise((resolve) => {
        release = () => {
          try {
            controller.enqueue(BYTES);
          } catch {
            // The wrapper may cancel the provider stream as the abort arrives.
          }
          resolve();
        };
      });
    },
  });
  const pendingBucket = new FakeBucket(objectFor(KEY, BYTES, { body: pendingBody }));
  const controller = new AbortController();
  const result = await new R2AudioObjectReader(pendingBucket).readAudio(
    context(controller.signal),
    EPISODE,
  );
  assert.equal(result.kind, "found");
  const readPromise = result.body.getReader().read();
  controller.abort("caller stopped during read");
  setTimeout(() => release?.(), 5);
  await assert.rejects(
    () => readPromise,
    (error) => error instanceof ServiceError && error.code === "cancelled",
  );
});

test("rejects malformed runtime range shapes before any R2 call", async () => {
  const malformedRanges = [
    null,
    [],
    { kind: "unknown", start: 0 },
    { kind: "closed", start: 0 },
    { kind: "closed", start: 1.5, endInclusive: 2 },
    { kind: "closed", start: -1, endInclusive: 2 },
    { kind: "closed", start: 3, endInclusive: 2 },
    { kind: "closed", start: 0, endInclusive: Number.MAX_SAFE_INTEGER + 1 },
    { kind: "open", start: Infinity },
    { kind: "open", start: 0, extra: true },
    { kind: "suffix", length: 0 },
    { kind: "suffix", length: -1 },
    { kind: "suffix", length: 1.25 },
  ];
  for (const range of malformedRanges) {
    const bucket = new FakeBucket();
    await assert.rejects(
      () => new R2AudioObjectReader(bucket).readAudio(context(), EPISODE, range),
      (error) => error instanceof ServiceError && error.code === "invalid_argument",
    );
    assert.equal(bucket.headCalls.length, 0);
    assert.equal(bucket.getCalls.length, 0);
  }
});

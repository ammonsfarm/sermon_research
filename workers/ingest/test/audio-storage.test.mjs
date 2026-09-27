import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DEVELOPMENT_AUDIO, developmentAudioSource } from "../src/development-audio.ts";

import { MAX_AUDIO_BYTES } from "../src/audio-transport.ts";
import { storeEpisodeAudio } from "../src/audio-storage.ts";

function zeroStream(total, chunkBytes = 5 * 1024 * 1024) {
  let remaining = total;
  return new ReadableStream({
    pull(controller) {
      if (remaining === 0) return controller.close();
      const length = Math.min(chunkBytes, remaining);
      remaining -= length;
      controller.enqueue(new Uint8Array(length));
    },
  });
}

class FakeBucket {
  constructor() {
    this.objects = new Map();
  }

  async head(key) {
    const object = this.objects.get(key);
    return object ? { ...object, body: undefined } : null;
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { ...object, body: zeroStream(object.size) };
  }

  async put(key, _body, options) {
    const staged = [...this.objects.values()].find((candidate) => candidate.temporary === true);
    if (!staged) throw new Error("missing staged object");
    const object = { key, size: staged.size, customMetadata: options.customMetadata, temporary: false };
    this.objects.set(key, object);
    return object;
  }

  async delete(key) {
    this.objects.delete(key);
  }

  async createMultipartUpload(key) {
    const lengths = [];
    return {
      uploadPart: async (partNumber, value) => {
        assert.ok(value instanceof Uint8Array);
        lengths[partNumber - 1] = value.byteLength;
        return { partNumber, etag: `part-${partNumber}` };
      },
      complete: async () => {
        const size = lengths.reduce((sum, length) => sum + length, 0);
        const object = { key, size, temporary: true };
        this.objects.set(key, object);
        return object;
      },
      abort: async () => { this.objects.delete(key); },
    };
  }
}

function input(sizeBytes, episodeId = "2369479907") {
  return {
    episodeId,
    revisionHash: `sha256:${"a".repeat(64)}`,
    sourceUrl: `https://cf-media.sndcdn.com/${episodeId}.mp3`,
    expectedSizeBytes: sizeBytes,
    durationMs: 60_000,
  };
}

function source(sizeBytes) {
  return async () => ({ body: zeroStream(sizeBytes), sizeBytes, contentType: "audio/mpeg" });
}

test("streaming audio accepts exactly 250 MiB and rejects 250 MiB plus one", async () => {
  const bucket = new FakeBucket();
  const accepted = await storeEpisodeAudio(input(MAX_AUDIO_BYTES), { bucket, openSource: source(MAX_AUDIO_BYTES) });
  const expected = createHash("sha256");
  const zeros = Buffer.alloc(5 * 1024 * 1024);
  for (let offset = 0; offset < MAX_AUDIO_BYTES; offset += zeros.byteLength) expected.update(zeros);
  assert.equal(accepted.sizeBytes, MAX_AUDIO_BYTES);
  assert.equal(accepted.sha256, `sha256:${expected.digest("hex")}`);
  assert.equal(bucket.objects.has(accepted.key), true);

  await assert.rejects(
    storeEpisodeAudio(input(MAX_AUDIO_BYTES + 1, "2369479908"), { bucket, openSource: source(MAX_AUDIO_BYTES + 1) }),
    { code: "invalid_input" },
  );
  assert.equal(bucket.objects.has("podcasts/2369479908.mp3"), false);
});

test("a crash after canonical R2 write reconciles the immutable object on retry", async () => {
  const bucket = new FakeBucket();
  let crashed = false;
  await assert.rejects(storeEpisodeAudio(input(1024), {
    bucket,
    openSource: source(1024),
    afterCanonicalPut: async () => { crashed = true; throw new Error("synthetic crash"); },
  }), /synthetic crash/u);
  assert.equal(crashed, true);
  assert.equal(bucket.objects.has("podcasts/2369479907.mp3"), true);

  const reconciled = await storeEpisodeAudio(input(1024), { bucket, openSource: source(1024) });
  assert.equal(reconciled.key, "podcasts/2369479907.mp3");
  assert.equal([...bucket.objects.keys()].filter((key) => key.startsWith("podcasts/")).length, 1);
  assert.equal([...bucket.objects.keys()].some((key) => key.startsWith("processing/audio/")), false);
});


test("fixed Development fixture uses normal streaming and rejects production, changed locators and bytes", async () => {
  const bytes = await readFile(new URL("./fixtures/mistral-synthetic.mp3", import.meta.url));
  const bucket = new FakeBucket();
  const originalGet = bucket.get.bind(bucket);
  let fixtureBytes = bytes;
  let contentType = "audio/mpeg";
  bucket.get = async key => key === DEVELOPMENT_AUDIO.key
    ? { size: fixtureBytes.length, body: new Response(fixtureBytes).body, httpMetadata: { contentType } }
    : originalGet(key);
  const network = async () => { throw Error("Network must not be used"); };
  const fixture = { ...input(bytes.length), sourceUrl: DEVELOPMENT_AUDIO.url };
  const source = developmentAudioSource("development", bucket, network);
  const options = { bucket, openSource: source.openAudioSource, validateSourceUrl: source.validateSourceUrl };
  const result = await storeEpisodeAudio(fixture, options);
  assert.equal(result.sha256, DEVELOPMENT_AUDIO.sha256);
  for (const environment of ["production", "test", ""]) {
    const denied = developmentAudioSource(environment, bucket, network);
    await assert.rejects(denied.openAudioSource(DEVELOPMENT_AUDIO.url), { code: "invalid_input" });
  }
  for (const suffix of ["?key=other", "#fragment", "/other"]) {
    await assert.rejects(storeEpisodeAudio({ ...fixture, sourceUrl: fixture.sourceUrl + suffix }, options), { code: "invalid_input" });
  }
  await assert.rejects(storeEpisodeAudio(fixture, { bucket, openSource: source.openAudioSource }), { code: "invalid_input" });
  fixtureBytes = Buffer.from(bytes); fixtureBytes[0] ^= 1;
  await assert.rejects(storeEpisodeAudio({ ...fixture, episodeId: "2369479908" }, options), { code: "invalid_input" });
  assert.equal(bucket.objects.has("podcasts/2369479908.mp3"), false);
  fixtureBytes = bytes.subarray(1);
  await assert.rejects(source.openAudioSource(DEVELOPMENT_AUDIO.url), { code: "invalid_input" });
  fixtureBytes = bytes; contentType = "text/plain";
  await assert.rejects(storeEpisodeAudio(fixture, options), { code: "invalid_input" });
});

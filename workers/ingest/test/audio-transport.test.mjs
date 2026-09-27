import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_BUCKET,
  AUDIO_TRANSPORT_BINDINGS,
  AUDIO_TRANSPORT_CONFIG,
  AUDIO_TRANSPORT_SECRETS,
  AudioTransportError,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_MS,
  MISTRAL_TRANSCRIPTION_URL_ALLOWLIST,
  PRESIGN_EXPIRY_SECONDS,
  classifyAudioForTranscription,
  createAudioTransport,
  episodeAudioKey,
  inventoryAudioDurations,
  parseItunesDurationToMs,
} from "../src/audio-transport.ts";

const MISTRAL_URL = "https://api.mistral.ai/v1/audio/transcriptions";
const MISTRAL_MODEL = "voxtral-test-nonprod";
const MISTRAL_KEY = "synthetic-mistral-key";
const ATTEMPT_CONTEXT = { requestId: "p6r-synthetic", revisionHash: `sha256:${"b".repeat(64)}`, generation: 1 };
const persistArtifact = async (context) => ({ artifactKey: `d1:transcript_segments:${context.requestId}` });

function mistralPayload(overrides = {}) {
  return {
    model: MISTRAL_MODEL,
    text: "SYNTHETIC transcript text for contract proof only.",
    language: "en",
    segments: [
      { text: "SYNTHETIC segment one.", start: 0.8, end: 8.1, speaker_id: "speaker_1", type: "transcription_segment" },
      { text: "SYNTHETIC segment two.", start: 8.9, end: 10.9, speaker_id: "speaker_1", type: "transcription_segment" },
    ],
    usage: { prompt_audio_seconds: 11, prompt_tokens: 4, total_tokens: 64, completion_tokens: 60 },
    ...overrides,
  };
}

async function localDigest(payload) {
  const canonical = JSON.stringify({ model: payload.model, text: payload.text, segments: payload.segments.map((s) => ({ text: s.text, start: s.start, end: s.end, ...(s.speaker_id === undefined ? {} : { speakerId: s.speaker_id }) })) });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function descriptor(overrides = {}) {
  return {
    bucket: AUDIO_BUCKET,
    key: "podcasts/2369479907.mp3",
    sizeBytes: 12_345_678,
    sha256: `sha256:${"a".repeat(64)}`,
    durationMs: 754_000,
    episodeId: "2369479907",
    ...overrides,
  };
}

function transport(overrides = {}) {
  const minted = [];
  const events = [];
  const seen = {
    minted,
    events,
    fetchRequests: [],
    fetchBodies: [],
    fetchForms: [],
  };
  const api = createAudioTransport({
    mintUrl: async ({ descriptor: d, expiresInSeconds, attempt }) => {
      minted.push({ key: d.key, expiresInSeconds, attempt });
      assert.equal(expiresInSeconds, PRESIGN_EXPIRY_SECONDS);
      return `https://r2.test.invalid/${d.key}?attempt=${attempt}&X-Amz-Signature=synthetic-${attempt}&expires=${expiresInSeconds}`;
    },
    mistralFetch: async (request) => {
      seen.fetchRequests.push({ url: request.url, method: request.method });
      assert.match(request.headers.get("content-type"), /^multipart\/form-data; boundary=/u);
      seen.fetchForms.push(Object.fromEntries(await request.clone().formData()));
      const bodyText = await request.text();
      seen.fetchBodies.push(bodyText);
      if (overrides.mistralFetch) return overrides.mistralFetch(request, seen);
      return new Response(JSON.stringify(mistralPayload()), { status: 200, headers: { "content-type": "application/json" } });
    },
    mistralUrl: MISTRAL_URL,
    mistralModel: MISTRAL_MODEL,
    mistralApiKey: MISTRAL_KEY,
    persistArtifact,
    onEvent: (event) => events.push(event),
    ...overrides.transport,
  });
  return { api, seen };
}

test("frozen transport contract names, bounds, key shape, and production URL allowlist are exact", () => {
  assert.deepEqual([...AUDIO_TRANSPORT_BINDINGS], ["AIC_DB", "AIC_PODCAST_AUDIO"]);
  assert.deepEqual([...AUDIO_TRANSPORT_SECRETS], [
    "MISTRAL_API_KEY",
    "R2_AUDIO_PRESIGN_ACCESS_KEY_ID",
    "R2_AUDIO_PRESIGN_SECRET_ACCESS_KEY",
  ]);
  assert.deepEqual([...AUDIO_TRANSPORT_CONFIG], [
    "MISTRAL_TRANSCRIPTION_URL",
    "MISTRAL_TRANSCRIPTION_MODEL",
  ]);
  assert.equal(AUDIO_BUCKET, "aic-podcast-audio");
  assert.equal(MAX_AUDIO_BYTES, 262_144_000);
  assert.equal(MAX_AUDIO_DURATION_MS, 3_600_000);
  assert.equal(PRESIGN_EXPIRY_SECONDS, 300);
  assert.deepEqual([...MISTRAL_TRANSCRIPTION_URL_ALLOWLIST], [MISTRAL_URL]);
  assert.equal(episodeAudioKey("2369479907"), "podcasts/2369479907.mp3");
  assert.throws(() => episodeAudioKey("../escape"), { name: "AudioTransportError" });
});

test("MISTRAL_TRANSCRIPTION_URL allowlist never sends the API key to an arbitrary host", async () => {
  for (const badUrl of [
    "https://evil.example.invalid/v1/audio/transcriptions",
    "https://mistral.test.invalid/v1/audio/transcriptions",
    "https://api.mistral.ai/v1/audio/transcriptions?next=/evil",
    "https://api.mistral.ai.evil.example.invalid/v1/audio/transcriptions",
  ]) {
    assert.throws(
      () => createAudioTransport({
        mintUrl: async () => "https://r2.test.invalid/unused",
        mistralFetch: async () => {
          assert.fail("rejected host must never reach fetch");
          return new Response("{}", { status: 200 });
        },
        mistralUrl: badUrl,
        mistralModel: MISTRAL_MODEL,
        mistralApiKey: MISTRAL_KEY,
        persistArtifact,
      }),
      { name: "AudioTransportError", code: "configuration" },
      `host must be rejected: ${badUrl}`,
    );
  }

  let fetches = 0;
  const allowed = createAudioTransport({
    mintUrl: async () => "https://r2.test.invalid/unused",
    mistralFetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify(mistralPayload()), { status: 200, headers: { "content-type": "application/json" } });
    },
    mistralUrl: MISTRAL_URL,
    mistralModel: MISTRAL_MODEL,
    mistralApiKey: MISTRAL_KEY,
    persistArtifact,
  });
  const receipt = await allowed.transcribeAttempt(descriptor(), 0, ATTEMPT_CONTEXT);
  assert.equal(fetches, 1, "frozen allowlisted URL uses the injected fake fetch; no real network call occurs");
  assert.equal(receipt.model, MISTRAL_MODEL);

  const prod = createAudioTransport({
    mintUrl: async () => "https://r2.test.invalid/unused",
    mistralFetch: async () => new Response(JSON.stringify(mistralPayload({ model: "voxtral-mini-latest" })), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    mistralUrl: MISTRAL_URL,
    mistralModel: "voxtral-mini-latest",
    mistralApiKey: MISTRAL_KEY,
    persistArtifact,
  });
  assert.equal((await prod.transcribeAttempt(descriptor(), 0, ATTEMPT_CONTEXT)).model, "voxtral-mini-latest");
  assert.equal(fetches, 1, "rejected hosts must never reach fetch");
});

test("signed URL is minted inside each attempt, differs per retry, and never reaches receipt, events, or errors", async () => {
  const { api, seen } = transport();
  const first = await api.transcribeAttempt(descriptor(), 0, ATTEMPT_CONTEXT);
  const second = await api.transcribeAttempt(descriptor(), 1, ATTEMPT_CONTEXT);

  assert.equal(seen.minted.length, 2);
  assert.deepEqual(seen.minted.map((m) => m.attempt), [0, 1]);
  assert.notEqual(
    seen.fetchBodies[0],
    seen.fetchBodies[1],
    "each attempt must mint and consume a fresh URL",
  );
  for (const body of seen.fetchBodies) {
    assert.match(body, /file_url/u);
    assert.match(body, new RegExp(MISTRAL_MODEL.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }

  for (const receipt of [first, second]) {
    assert.equal(receipt.model, MISTRAL_MODEL);
    assert.equal(receipt.segmentCount, 2);
    assert.match(receipt.artifactDigest, /^[0-9a-f]{64}$/u);
    assert.equal(receipt.artifactDigest, await localDigest(mistralPayload()));
    assert.doesNotMatch(JSON.stringify(receipt), /r2\.test\.invalid|file_url|X-Amz-Signature|synthetic-mistral-key/u);
  }
  assert.doesNotMatch(JSON.stringify(seen.events), /r2\.test\.invalid|X-Amz-Signature|synthetic-mistral-key|file_url/u);
  assert.equal(seen.fetchRequests[0].url, MISTRAL_URL);

  const failing = transport({
    mistralFetch: async () => {
      throw new Error("boom https://r2.test.invalid/podcasts/x.mp3?X-Amz-Signature=secret-leak attempt=9");
    },
  });
  await assert.rejects(failing.api.transcribeAttempt(descriptor(), 0, ATTEMPT_CONTEXT), (error) => {
    assert.equal(error.name, "AudioTransportError");
    assert.doesNotMatch(error.message, /r2\.test\.invalid|secret-leak|X-Amz-Signature|synthetic-mistral-key/u);
    assert.equal(error.code, "provider_timeout_unknown");
    assert.match(error.message, /outcome is unknown after connection loss/u);
    return true;
  });
  assert.doesNotMatch(JSON.stringify(failing.seen.events), /r2\.test\.invalid|secret-leak/u);
});

test("an expired first presigned URL is replaced by a fresh URL on retry", async () => {
  let providerCalls = 0;
  const { api, seen } = transport({
    mistralFetch: async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return new Response(JSON.stringify({ error: "synthetic expired input URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(mistralPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await assert.rejects(api.transcribeAttempt(descriptor(), 0, ATTEMPT_CONTEXT), (error) => {
    assert.equal(error.code, "transcription_unavailable");
    assert.doesNotMatch(error.message, /expired input URL|X-Amz-Signature/u);
    return true;
  });
  const receipt = await api.transcribeAttempt(descriptor(), 1, ATTEMPT_CONTEXT);

  assert.deepEqual(seen.minted.map(({ attempt }) => attempt), [0, 1]);
  assert.notEqual(seen.fetchBodies[0], seen.fetchBodies[1]);
  assert.equal(receipt.artifactKey, `d1:transcript_segments:${ATTEMPT_CONTEXT.requestId}`);
  assert.doesNotMatch(JSON.stringify(receipt), /file_url|X-Amz-Signature|expired input URL/u);
});

test("synthetic Mistral request/response contract proof uses the test fixture without content or secrets", async () => {
  const { api, seen } = transport();
  const receipt = await api.transcribeAttempt(descriptor(), 0, ATTEMPT_CONTEXT);

  assert.equal(seen.fetchRequests.length, 1);
  assert.equal(seen.fetchRequests[0].method, "POST");
  assert.equal(seen.fetchRequests[0].url, MISTRAL_URL);
  assert.deepEqual([...MISTRAL_TRANSCRIPTION_URL_ALLOWLIST], [MISTRAL_URL]);
  const body = seen.fetchForms[0];
  assert.equal(typeof body.file_url, "string");
  assert.equal(body.timestamp_granularities, "segment");
  assert.deepEqual(Object.keys(body).sort(), ["file_url", "model", "timestamp_granularities"]);
  assert.ok(body.file_url.startsWith("https://"));
  assert.equal(body.model, MISTRAL_MODEL);

  assert.deepEqual(Object.keys(receipt).sort(), ["artifactDigest", "artifactKey", "durationMs", "model", "segmentCount"]);
  assert.equal(receipt.segmentCount, 2);
  assert.equal(receipt.artifactDigest, await localDigest(mistralPayload()));
  assert.doesNotMatch(JSON.stringify(receipt), /SYNTHETIC segment|Bearer|file_url|https:\/\//u);

  const decoy = mistralPayload({ artifactDigest: "0".repeat(64), hash: "1".repeat(64) });
  const { api: decoyApi } = transport({
    mistralFetch: async () => new Response(JSON.stringify(decoy), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const decoyReceipt = await decoyApi.transcribeAttempt(descriptor(), 0, ATTEMPT_CONTEXT);
  assert.notEqual(decoyReceipt.artifactDigest, "0".repeat(64), "provider-returned digests must be ignored");
  assert.equal(decoyReceipt.artifactDigest, await localDigest(mistralPayload()));

  for (const bad of [
    mistralPayload({ model: "" }),
    mistralPayload({ text: 7 }),
    mistralPayload({ segments: "nope" }),
    mistralPayload({ segments: [{ text: "x", start: 5, end: 1 }] }),
    { model: MISTRAL_MODEL, text: "ok" },
  ]) {
    const { api: badApi } = transport({
      mistralFetch: async () => new Response(JSON.stringify(bad), { status: 200, headers: { "content-type": "application/json" } }),
    });
    await assert.rejects(badApi.transcribeAttempt(descriptor(), 0, ATTEMPT_CONTEXT), { code: "transcription_unavailable" });
  }

  const rejected = transport({
    mistralFetch: async () => new Response(JSON.stringify({ error: "synthetic throttle" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(rejected.api.transcribeAttempt(descriptor(), 0, ATTEMPT_CONTEXT), (error) => {
    assert.ok(error instanceof AudioTransportError);
    assert.equal(error.code, "throttled");
    assert.doesNotMatch(error.message, /synthetic throttle|r2\.test\.invalid/u);
    return true;
  });
});

test("URL mint failures discard credential-bearing causes before durable processing errors", async () => {
  const { api, seen } = transport({ transport: { mintUrl: async () => {
    throw new Error("Authorization: Bearer credential-canary secret=signing-key-canary Cookie: private-cookie https://r2.test.invalid/?X-Amz-Signature=url-canary");
  } } });
  await assert.rejects(api.transcribeAttempt(descriptor(), 0, ATTEMPT_CONTEXT), (error) => {
    assert.equal(error.code, "transcription_unavailable");
    assert.equal(error.message, "Audio transport minting failed without provider detail.");
    assert.doesNotMatch(JSON.stringify(error), /canary|Authorization|Cookie|r2\.test/);
    return true;
  });
  assert.equal(seen.fetchRequests.length, 0);
});

test("250 MiB bound streams synthetically and 250 MiB + 1 byte is rejected before minting", async () => {
  let mints = 0;
  const single = mistralPayload({ text: "SYNTHETIC single.", segments: [{ text: "SYNTHETIC single.", start: 0, end: 1 }] });
  const api = createAudioTransport({
    mintUrl: async () => {
      mints += 1;
      return "https://r2.test.invalid/unused";
    },
    mistralFetch: async () => new Response(JSON.stringify(single), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    mistralUrl: MISTRAL_URL,
    mistralModel: MISTRAL_MODEL,
    mistralApiKey: MISTRAL_KEY,
    persistArtifact,
  });

  const atLimit = await api.transcribeAttempt(descriptor({ sizeBytes: MAX_AUDIO_BYTES }), 0, ATTEMPT_CONTEXT);
  assert.equal(atLimit.segmentCount, 1);
  assert.equal(mints, 1);

  await assert.rejects(
    api.transcribeAttempt(descriptor({ sizeBytes: MAX_AUDIO_BYTES + 1 }), 0, ATTEMPT_CONTEXT),
    { name: "AudioTransportError", code: "invalid_input" },
  );
  assert.equal(mints, 1, "oversize input must be rejected before URL minting");

  await assert.rejects(api.transcribeAttempt(descriptor({ sizeBytes: 0 }), 0, ATTEMPT_CONTEXT), { code: "invalid_input" });
  assert.equal(classifyAudioForTranscription({ sizeBytes: MAX_AUDIO_BYTES, durationMs: 1_000 }).decision, "transcribe");
  assert.equal(classifyAudioForTranscription({ sizeBytes: MAX_AUDIO_BYTES + 1, durationMs: 1_000 }).decision, "failed");
});

test("audio over the AIC 60-minute gate stays in retry_required/audio_segmentation_required and is never sent", async () => {
  let mints = 0;
  let fetches = 0;
  const single = mistralPayload({ text: "SYNTHETIC single.", segments: [{ text: "SYNTHETIC single.", start: 0, end: 1 }] });
  const api = createAudioTransport({
    mintUrl: async () => {
      mints += 1;
      return "https://r2.test.invalid/unused";
    },
    mistralFetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify(single), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    mistralUrl: MISTRAL_URL,
    mistralModel: MISTRAL_MODEL,
    mistralApiKey: MISTRAL_KEY,
    persistArtifact,
  });

  try {
    await api.transcribeAttempt(descriptor({ durationMs: MAX_AUDIO_DURATION_MS + 1 }), 0, ATTEMPT_CONTEXT);
    assert.fail("over-limit input must stay in retry_required");
  } catch (error) {
    assert.ok(error instanceof AudioTransportError);
    assert.equal(error.code, "audio_segmentation_required");
  }
  assert.equal(mints, 0, "over-limit input must not mint a URL");
  assert.equal(fetches, 0, "over-limit input must not reach Mistral");

  const atLimit = await api.transcribeAttempt(descriptor({ durationMs: MAX_AUDIO_DURATION_MS }), 0, ATTEMPT_CONTEXT);
  assert.equal(atLimit.durationMs, MAX_AUDIO_DURATION_MS);
  assert.equal(mints, 1);
  assert.equal(fetches, 1);

  assert.equal(classifyAudioForTranscription({ sizeBytes: 1_000, durationMs: null }).code, "audio_segmentation_required");
  assert.equal(
    classifyAudioForTranscription({ sizeBytes: 1_000, durationMs: MAX_AUDIO_DURATION_MS + 1 }).code,
    "audio_segmentation_required",
  );
});

test("itunes duration parsing and redacted duration inventory expose no content or secrets", () => {
  assert.equal(parseItunesDurationToMs("12:34"), 754_000);
  assert.equal(parseItunesDurationToMs("1:02:03"), 3_723_000);
  assert.equal(parseItunesDurationToMs("45"), 45_000);
  assert.equal(parseItunesDurationToMs("  05:07  "), 307_000);
  assert.equal(parseItunesDurationToMs(""), null);
  assert.equal(parseItunesDurationToMs("live"), null);
  assert.equal(parseItunesDurationToMs("12:99"), null);
  assert.equal(parseItunesDurationToMs(null), null);

  const summary = inventoryAudioDurations([
    { episodeId: "101", durationMs: parseItunesDurationToMs("12:34") },
    { episodeId: "102", durationMs: parseItunesDurationToMs("45:00") },
    { episodeId: "103", durationMs: parseItunesDurationToMs("1:05:00") },
    { episodeId: "104", durationMs: null },
  ]);

  assert.equal(summary.total, 4);
  assert.equal(summary.withDuration, 3);
  assert.equal(summary.withoutDuration, 1);
  assert.deepEqual(summary.over60Min, ["103"]);
  assert.equal(summary.maxDurationMs, 3_900_000);
  assert.deepEqual(summary.buckets, {
    under10Min: 0,
    min10To30: 1,
    min30To60: 1,
    over60Min: 1,
  });
  assert.doesNotMatch(JSON.stringify(summary), /mp3|transcript|Bearer|https?:\/\/|KEY|SECRET/u);
  assert.throws(() => inventoryAudioDurations([{ episodeId: "../x", durationMs: 1 }]), { code: "invalid_input" });
});

import assert from "node:assert/strict";
import test from "node:test";

import { AudioTransportError } from "../src/audio-transport.ts";
import { IntelligenceProviderError } from "../src/intelligence.ts";
import { runEpisodeIngestWorkflow } from "../src/workflow.ts";

const REVISION = `sha256:${"b".repeat(64)}`;
const CONTENT_HASH = "a".repeat(64);
const now = new Date("2026-09-21T12:00:00.000Z");

function request(overrides = {}) {
  return {
    requestId: "request-episode-1",
    episodeId: "2369479907",
    revisionId: "soundcloud:2369479907:revision",
    revisionHash: REVISION,
    generation: 1,
    desiredPublication: "published",
    idempotencyKey: `p6:episode-ingest:v1:${"c".repeat(64)}`,
    correlationId: "correlation-1",
    snapshot: {},
    ...overrides,
  };
}

function descriptor(overrides = {}) {
  return {
    bucket: "aic-podcast-audio",
    key: "podcasts/2369479907.mp3",
    sizeBytes: 1024,
    sha256: `sha256:${"d".repeat(64)}`,
    durationMs: 60_000,
    episodeId: "2369479907",
    ...overrides,
  };
}

function chunk(family) {
  const transcript = family === "transcript";
  return {
    id: `${transcript ? "t" : "i"}/2369479907:${transcript ? "speech" : "summary"}:0000`,
    text: transcript ? "bounded speech chunk" : "bounded intelligence chunk",
    contentHash: CONTENT_HASH,
    metadata: {
      source_type: transcript ? "episode_transcript" : "episode_intelligence",
      source_id: "2369479907",
      content_subtype: transcript ? "speech" : "episode_intelligence",
      published_day: 20260921,
      content_hash: CONTENT_HASH,
      chunk_index: 0,
    },
  };
}

function manifest(family) {
  const item = chunk(family);
  return { family, ids: [item.id], idDigest: family === "transcript" ? "1".repeat(64) : "2".repeat(64), embeddingBatchCount: 1, chunks: [item] };
}

function stateStore(initial = "discovered", options = {}) {
  let state = initial;
  const accepted = new Map();
  const visible = [];
  return {
    accepted,
    visible,
    get state() { return state; },
    async assertCurrentHead() {},
    async claimMutationLease() {},
    async releaseMutationLease() {},
    async transition(command) {
      assert.equal(command.from, state, `${command.stageName} must fence the current state`);
      state = command.to;
      return { requestId: command.requestId, stageName: command.stageName, state, status: "complete", replayed: false };
    },
    async recordVectorAcceptance(command) {
      accepted.set(`${command.batchOrdinal}:${command.operation}`, command);
      if (options.failAfterAcceptanceOnce && (options.failOperation === undefined || options.failOperation === command.operation)) {
        options.failAfterAcceptanceOnce = false;
        throw new Error("synthetic crash after acceptance receipt");
      }
    },
    async recordVectorVisibility(command) { visible.push(command); },
  };
}

function vectorize({ settleAfterSleeps = 1 } = {}) {
  const pending = new Map();
  const current = new Map();
  let sleeps = 0;
  let upserts = 0;
  let deletes = 0;
  return {
    current,
    get upserts() { return upserts; },
    get deletes() { return deletes; },
    async upsert(records) {
      upserts += 1;
      for (const record of records) pending.set(record.id, record);
      return { mutationId: `upsert-${upserts}` };
    },
    async deleteByIds(ids) { deletes += 1; ids.forEach((id) => current.delete(id)); return { mutationId: `delete-${deletes}` }; },
    async getByIds(ids) { return ids.flatMap((id) => current.has(id) ? [current.get(id)] : []); },
    async queryById(id) {
      const value = current.get(id);
      return { count: value ? 1 : 0, matches: value ? [{ id, metadata: value.metadata, score: 1 }] : [] };
    },
    settle() {
      sleeps += 1;
      if (sleeps < settleAfterSleeps) return;
      for (const [id, value] of pending) current.set(id, value);
      pending.clear();
    },
  };
}

function steps(options = {}) {
  const names = [];
  const outputs = [];
  const cache = options.cache ?? new Map();
  const attempts = new Map();
  return {
    names,
    outputs,
    async do(name, configOrCallback, maybeCallback) {
      names.push(name);
      if (cache.has(name)) return cache.get(name);
      const callback = maybeCallback ?? configOrCallback;
      try {
        const value = await callback();
        cache.set(name, value);
        outputs.push({ name, value });
        return value;
      } catch (error) {
        const count = attempts.get(name) ?? 0;
        attempts.set(name, count + 1);
        if (options.retryOnce === name && count === 0) return this.do(name, configOrCallback, maybeCallback);
        throw error;
      }
    },
    async sleep(name) { names.push(name); options.onSleep?.(name); },
  };
}

function embeddings() {
  return {
    async embedBatch(_context, input) {
      return input.inputs.map(({ customId }) => ({
        customId,
        values: Array(1536).fill(0.25),
        dimensions: 1536,
        model: "text-embedding-3-small",
      }));
    },
  };
}

function repository(workflowRequest, store, options = {}) {
  const proofs = new Map();
  const visible = new Set();
  let finalized = false;
  let storeAudioCalls = 0;
  return {
    get finalized() { return finalized; },
    get storeAudioCalls() { return storeAudioCalls; },
    visible,
    async loadRequest(event) { assert.deepEqual(event, { requestId: workflowRequest.requestId, revisionHash: REVISION }); return workflowRequest; },
    async loadAudioDescriptor() { return options.audioReceipt ?? null; },
    async storeAudio() { storeAudioCalls += 1; return options.audio ?? descriptor(); },
    async persistAudioDescriptor() {},
    async persistTranscriptArtifact() { return { artifactKey: `d1:transcript_segments:${workflowRequest.requestId}` }; },
    async loadTranscriptReceipt() { return options.transcriptReceipt ?? null; },
    async commitTranscript(_request, receipt) { assert.match(receipt.artifactDigest, /^[0-9a-f]{64}$/u); },
    async materializeManifest(_request, family) {
      const target = manifest(family);
      return { family, ids: target.ids, idDigest: target.idDigest, embeddingBatchCount: 1 };
    },
    async loadEmbeddingBatch(_request, family) {
      const target = manifest(family);
      return {
        batch: { inputs: target.chunks.map((item) => ({ id: item.id, text: item.text, contentHash: item.contentHash, estimatedTokens: 8 })), estimatedTokens: 8 },
        chunks: target.chunks,
      };
    },
    async recordPreparedVectors(_request, _target, chunks, records) {
      const byId = new Map(chunks.map((item) => [item.id, item]));
      records.forEach((item) => proofs.set(item.id, { id: item.id, vectorDigest: item.vectorDigest, metadata: byId.get(item.id).metadata }));
    },
    async loadVectorProofRecords(_request, ids) { return ids.map((id) => proofs.get(id)); },
    async loadAcceptedMutation(_request, ordinal, operation, ids) {
      const accepted = store.accepted.get(`${ordinal}:${operation}`);
      return accepted ? { mutationId: accepted.providerMutationId, state: operation === "upsert" ? "accepted" : "delete_accepted", ids, idDigest: accepted.expectedIdsDigest.slice(7) } : null;
    },
    async markVectorsAccepted() {},
    async markVectorsVisible(_request, ids) { ids.forEach((id) => visible.add(id)); },
    async listStaleVectorIds(_request, family) { return options.staleIds?.[family] ?? []; },
    async markVectorsDeleted() {},
    async loadIntelligenceInput() { return { episodeId: workflowRequest.episodeId, title: "Episode", publishDate: "2026-09-21", transcript: "persisted transcript", transcriptTruncated: false }; },
    async persistIntelligenceArtifact(_request, artifact) { return { artifactKey: `d1:episode_intelligence:${workflowRequest.requestId}`, artifactDigest: "e".repeat(64), itemCount: artifact.items.length, model: artifact.model }; },
    async loadIntelligenceReceipt() { return options.intelligenceReceipt ?? null; },
    async finalizeEpisode(_request, expectedVectorBatchCount) {
      assert.equal(expectedVectorBatchCount, 2);
      assert.equal(visible.has(chunk("transcript").id), true);
      assert.equal(visible.has(chunk("intelligence").id), true);
      finalized = true;
    },
  };
}

function audioTransport(error) {
  return {
    calls: 0,
    async transcribeAttempt(_descriptor, _attempt, context) {
      this.calls += 1;
      if (error) throw error;
      return { artifactKey: `d1:transcript_segments:${context.requestId}`, model: "voxtral-test", segmentCount: 1, artifactDigest: "f".repeat(64), durationMs: 60_000 };
    },
  };
}

function intelligenceProvider() {
  let calls = 0;
  return {
    get calls() { return calls; },
    async generate() {
      calls += 1;
      return { model: "silo-test", episodeType: "sermon", executiveSummary: "Summary", longSummary: "Long summary", mainTopics: ["faith"], searchKeywords: ["faith"], items: [] };
    },
  };
}

const intelligence = intelligenceProvider();

test("the 17-stage flow waits for eventual transcript and intelligence visibility before publication", async () => {
  const workflowRequest = request();
  const store = stateStore();
  const vectors = vectorize({ settleAfterSleeps: 2 });
  const repo = repository(workflowRequest, store);
  const step = steps({ onSleep: () => vectors.settle() });

  await runEpisodeIngestWorkflow(step, { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
    repository: repo, stateStore: store, audioTransport: audioTransport(), intelligence,
    embeddings: embeddings(), vectorize: vectors, now: () => now,
  });

  assert.equal(store.state, "publish_ready");
  assert.equal(repo.finalized, true);
  assert.ok(step.names.includes("load-and-validate-input"));
  assert.ok(step.names.includes("stream-audio-to-r2"));
  assert.ok(step.names.includes("transcribe-audio-attempt-0"));
  assert.ok(step.names.includes("generate-intelligence"));
  assert.ok(step.names.includes("finalize-episode"));
  assert.ok(step.names.filter((name) => name.includes("visibility") && name.includes("sleep")).length >= 3);
  assert.equal(step.outputs.some(({ value }) => JSON.stringify(value)?.includes("persisted transcript") || JSON.stringify(value)?.includes('"values"') || JSON.stringify(value)?.includes("X-Amz-Signature")), false);
});

test("restart after audio preparation reuses only the stable descriptor and transcribes once", async () => {
  const workflowRequest = request({ desiredPublication: "draft" });
  const stable = descriptor();
  const cache = new Map([
    ["load-and-validate-input", workflowRequest],
    ["claim-audio-mutation", true],
    ["stream-audio-to-r2", stable],
    ["verify-audio", undefined],
    ["prepare-transcription-input", stable],
  ]);
  const store = stateStore("transcribing");
  const vectors = vectorize();
  const transcript = audioTransport();
  const repo = repository(workflowRequest, store);
  await runEpisodeIngestWorkflow(steps({ cache, onSleep: () => vectors.settle() }), { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
    repository: repo, stateStore: store, audioTransport: transcript, intelligence,
    embeddings: embeddings(), vectorize: vectors, now: () => now,
  });
  assert.equal(transcript.calls, 1);
  assert.equal(store.state, "publish_ready");
  assert.equal(repo.finalized, false, "discovery-only draft work must stop at publish_ready");
});

test("a durable transcript receipt replays without calling the transcription provider", async () => {
  const workflowRequest = request();
  const stable = descriptor();
  const cache = new Map([
    ["load-and-validate-input", workflowRequest],
    ["claim-audio-mutation", true],
    ["stream-audio-to-r2", stable],
    ["verify-audio", undefined],
    ["prepare-transcription-input", stable],
  ]);
  const store = stateStore("transcribing");
  const vectors = vectorize();
  const transcript = audioTransport();
  const repo = repository(workflowRequest, store, {
    transcriptReceipt: {
      artifactKey: `d1:transcript_segments:${workflowRequest.requestId}`,
      model: "voxtral-test",
      segmentCount: 1,
      artifactDigest: "f".repeat(64),
      durationMs: 60_000,
    },
  });

  await runEpisodeIngestWorkflow(steps({ cache, onSleep: () => vectors.settle() }), { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
    repository: repo, stateStore: store, audioTransport: transcript, intelligence,
    embeddings: embeddings(), vectorize: vectors, now: () => now,
  });

  assert.equal(transcript.calls, 0, "the durable transcript artifact must be replayed");
  assert.equal(store.state, "publish_ready");
});

test("a durable audio receipt replays without rewriting R2", async () => {
  const workflowRequest = request();
  const store = stateStore();
  const vectors = vectorize();
  const repo = repository(workflowRequest, store, { audioReceipt: descriptor() });

  await runEpisodeIngestWorkflow(steps({ onSleep: () => vectors.settle() }), { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
    repository: repo, stateStore: store, audioTransport: audioTransport(), intelligence,
    embeddings: embeddings(), vectorize: vectors, now: () => now,
  });

  assert.equal(repo.storeAudioCalls, 0, "the canonical R2 object must replay from its durable descriptor");
  assert.equal(repo.finalized, true);
});

test("a crash after Vectorize acceptance retries without a duplicate provider mutation", async () => {
  const workflowRequest = request();
  const store = stateStore("discovered", { failAfterAcceptanceOnce: true, failOperation: "upsert" });
  const vectors = vectorize();
  const repo = repository(workflowRequest, store);
  await runEpisodeIngestWorkflow(steps({ retryOnce: "upsert-acceptance-transcript-0", onSleep: () => vectors.settle() }), { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
    repository: repo, stateStore: store, audioTransport: audioTransport(), intelligence,
    embeddings: embeddings(), vectorize: vectors, now: () => now,
  });
  assert.equal(vectors.upserts, 2, "one transcript and one intelligence upsert; the transcript acceptance is not duplicated");
  assert.equal(repo.finalized, true);
});

test("a failed Vectorize delete acceptance ledger step replays without a duplicate delete", async () => {
  const workflowRequest = request({ desiredPublication: "draft" });
  const store = stateStore("discovered", { failAfterAcceptanceOnce: true, failOperation: "delete" });
  const vectors = vectorize();
  const repo = repository(workflowRequest, store, {
    staleIds: {
      transcript: ["t/2369479907:speech:0001"],
      intelligence: ["i/2369479907:summary:0001"],
    },
  });
  const step = steps({ retryOnce: "delete-stale-acceptance-transcript-0", onSleep: () => vectors.settle() });
  await runEpisodeIngestWorkflow(step, { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
    repository: repo, stateStore: store, audioTransport: audioTransport(), intelligence,
    embeddings: embeddings(), vectorize: vectors, now: () => now,
  });
  assert.equal(vectors.deletes, 2, "the transcript and intelligence deletes each run once");
  assert.equal(repo.finalized, false, "draft work stops before publication");
  assert.equal(store.state, "publish_ready");
});

test("a durable intelligence receipt replays without calling the intelligence provider", async () => {
  const workflowRequest = request();
  const store = stateStore();
  const vectors = vectorize();
  const provider = intelligenceProvider();
  const repo = repository(workflowRequest, store, {
    intelligenceReceipt: {
      artifactKey: `d1:episode_intelligence:${workflowRequest.requestId}`,
      artifactDigest: "e".repeat(64),
      itemCount: 0,
      model: "silo-test",
    },
  });

  await runEpisodeIngestWorkflow(steps({ onSleep: () => vectors.settle() }), { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
    repository: repo, stateStore: store, audioTransport: audioTransport(), intelligence: provider,
    embeddings: embeddings(), vectorize: vectors, now: () => now,
  });

  assert.equal(provider.calls, 0, "the durable intelligence artifact must be replayed");
  assert.equal(repo.finalized, true);
  assert.equal(store.state, "publish_ready");
});

test("provider throttle and timeout become retry_required without publication", async () => {
  for (const code of ["throttled", "provider_timeout_unknown"]) {
    const workflowRequest = request();
    const store = stateStore();
    const repo = repository(workflowRequest, store);
    await runEpisodeIngestWorkflow(steps(), { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
      repository: repo,
      stateStore: store,
      audioTransport: audioTransport(new AudioTransportError(code, `synthetic ${code}`, true)),
      intelligence,
      embeddings: embeddings(),
      vectorize: vectorize(),
      now: () => now,
    });
    assert.equal(store.state, "retry_required");
    assert.equal(repo.finalized, false);
  }
});

test("invalid intelligence is never persisted or published and the existing retry can recover", async () => {
  for (const recover of [false, true]) {
    const workflowRequest = request();
    const store = stateStore();
    const vectors = vectorize();
    const repo = repository(workflowRequest, store);
    let calls = 0, persisted = 0, disposition;
    const persist = repo.persistIntelligenceArtifact;
    repo.persistIntelligenceArtifact = async (...args) => { persisted++; return persist(...args); };
    const transition = store.transition;
    store.transition = async command => { if (command.to === "retry_required") disposition = command; return transition(command); };
    const step = steps({ retryOnce: recover ? "generate-intelligence" : undefined, onSleep: () => vectors.settle() });
    const runStep = step.do;
    step.do = function (name, config, callback) {
      if (name === "generate-intelligence") assert.deepEqual(config.retries, { limit: 8, delay: "15 seconds", backoff: "exponential" });
      return runStep.call(this, name, config, callback);
    };
    await runEpisodeIngestWorkflow(step, { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
      repository: repo, stateStore: store, audioTransport: audioTransport(),
      intelligence: { async generate() {
        calls++;
        if (!recover || calls === 1) throw new IntelligenceProviderError("invalid_provider_response", "Synthetic invalid artifact.");
        return intelligence.generate();
      } },
      embeddings: embeddings(), vectorize: vectors, now: () => now,
    });
    assert.equal(persisted, recover ? 1 : 0);
    assert.equal(repo.finalized, recover);
    assert.equal(store.state, recover ? "publish_ready" : "retry_required");
    if (!recover) {
      assert.equal(disposition.errorCode, "invalid_provider_response");
      assert.equal(disposition.retryClass, "invalid_provider_response");
      assert.equal(step.names.includes("chunk-intelligence"), false);
    }
  }
});

test("over-60-minute audio remains on the audio_segmentation_required hold", async () => {
  const workflowRequest = request();
  const store = stateStore();
  const repo = repository(workflowRequest, store, { audio: descriptor({ durationMs: 3_600_001 }) });
  const transcript = audioTransport();
  await runEpisodeIngestWorkflow(steps(), { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
    repository: repo, stateStore: store, audioTransport: transcript, intelligence,
    embeddings: embeddings(), vectorize: vectorize(), now: () => now,
  });
  assert.equal(store.state, "retry_required");
  assert.equal(transcript.calls, 0);
  assert.equal(repo.finalized, false);
});

test("episode visibility accepts reordered metadata but rejects missing, extra, or changed fields", async () => {
  for (const change of ["reorder", "missing", "extra", "changed"]) {
    const workflowRequest = request();
    const store = stateStore();
    const vectors = vectorize();
    const alter = metadata => {
      const reordered = Object.fromEntries(Object.entries(metadata).reverse());
      if (change === "missing") delete reordered.content_hash;
      if (change === "extra") reordered.unexpected = "extra";
      if (change === "changed") reordered.content_hash = "0".repeat(64);
      return reordered;
    };
    const get = vectors.getByIds.bind(vectors);
    const query = vectors.queryById.bind(vectors);
    vectors.getByIds = async ids => (await get(ids)).map(row => ({ ...row, metadata: alter(row.metadata) }));
    vectors.queryById = async (...args) => {
      const response = await query(...args);
      return { ...response, matches: response.matches.map(row => ({ ...row, metadata: alter(row.metadata) })) };
    };
    const repo = repository(workflowRequest, store);
    await runEpisodeIngestWorkflow(steps({ onSleep: () => vectors.settle() }), { requestId: workflowRequest.requestId, revisionHash: REVISION }, {
      repository: repo, stateStore: store, audioTransport: audioTransport(), intelligence,
      embeddings: embeddings(), vectorize: vectors, now: () => now,
    });
    assert.equal(repo.finalized, change === "reorder", change);
    assert.equal(store.state, change === "reorder" ? "publish_ready" : "retry_required", change);
  }
});

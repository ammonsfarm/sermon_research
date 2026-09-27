import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createProcessingIdempotencyKey, createProcessingRevisionHash } from "@aic/contracts";
import { D1ProcessingStateStore, createD1SearchRepositories } from "@aic/db";
import { requestEpisodePublication } from "../src/publication.ts";
import { D1EpisodeIngestRepository } from "../src/repository.ts";

const migrations = new URL("../../../migrations/d1/", import.meta.url);
const at = "2026-09-21T12:00:00.000Z";

class Statement {
  constructor(binding, sql, values = []) { this.binding = binding; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.binding, this.sql, values); }
  async first() { return this.binding.db.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { success: true, results: this.binding.db.prepare(this.sql).all(...this.values) }; }
  async run() {
    const before = this.binding.db.prepare("SELECT total_changes() count").get().count;
    const result = this.binding.db.prepare(this.sql).run(...this.values);
    const after = this.binding.db.prepare("SELECT total_changes() count").get().count;
    return { success: true, meta: { changes: after - before, last_row_id: Number(result.lastInsertRowid) } };
  }
}

class Binding {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

async function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(await readFile(new URL(file, migrations), "utf8"));
  }
  return db;
}

async function episodeRequest() {
  const snapshot = {
    source: "soundcloud-rss",
    episodeId: "2369479907",
    title: "Synthetic episode",
    publishDate: "2026-09-21",
    pubDateRaw: "Mon, 21 Sep 2026 12:00:00 GMT",
    soundcloudUrl: "https://soundcloud.com/aic/synthetic",
    enclosureUrl: "https://cf-media.sndcdn.com/synthetic.mp3",
    enclosureType: "audio/mpeg",
    enclosureLength: 1024,
    duration: "12:34",
    author: "AIC",
    explicit: "no",
    summary: "Synthetic summary",
    subtitle: "Synthetic subtitle",
    description: "Synthetic description",
    imageUrl: "https://images.example.invalid/synthetic.jpg",
    category: "Podcast",
    detail: "Synthetic detail",
    guid: "synthetic-guid",
  };
  const revisionHash = await createProcessingRevisionHash(snapshot);
  return {
    requestId: "request-repository",
    workflow: "episode",
    entityType: "episode",
    entityId: snapshot.episodeId,
    revisionId: `soundcloud:${snapshot.episodeId}:${revisionHash.slice(7)}`,
    revisionHash,
    operation: "episode_ingest",
    idempotencyKey: await createProcessingIdempotencyKey({ operation: "episode_ingest", entityType: "episode", entityId: snapshot.episodeId, revisionHash }),
    snapshot,
    desiredPublication: "published",
    requestedBy: "synthetic",
    correlationId: "repository-test",
  };
}

test("D1 repository persists bounded transcript and intelligence artifacts before returning manifests", async () => {
  const db = await database();
  try {
    const binding = new Binding(db);
    const state = new D1ProcessingStateStore({ db: binding, now: () => at });
    const input = await episodeRequest();
    const receipt = await state.createOrGetRequest(input);
    const repository = new D1EpisodeIngestRepository({
      db: binding,
      bucket: {},
      openAudioSource: async () => { throw new Error("not used"); },
      now: () => at,
    });
    const request = await repository.loadRequest({ requestId: receipt.requestId, revisionHash: receipt.revisionHash });
    const audio = {
      bucket: "aic-podcast-audio",
      key: "podcasts/2369479907.mp3",
      sizeBytes: 1024,
      sha256: `sha256:${"a".repeat(64)}`,
      durationMs: 754_000,
      episodeId: "2369479907",
    };
    await repository.persistAudioDescriptor(request, audio);
    const media = db.prepare("SELECT asset_id, status, size_bytes, sha256, mime_type, destination_bucket FROM media_assets WHERE canonical_object_key = ?").get(audio.key);
    assert.deepEqual({ ...media }, {
      asset_id: "podcast-audio:2369479907", status: "verified", size_bytes: 1024, sha256: "a".repeat(64),
      mime_type: "audio/mpeg", destination_bucket: "aic-podcast-audio",
    });
    const transcript = {
      model: "voxtral-test",
      text: "Synthetic transcript.",
      segments: [{ text: "Synthetic transcript.", start: 0, end: 2, speakerId: "speaker-1" }],
      artifactDigest: "b".repeat(64),
    };
    const artifact = await repository.persistTranscriptArtifact({ requestId: request.requestId, revisionHash: request.revisionHash, generation: request.generation }, audio, transcript);
    assert.equal(artifact.artifactKey, `d1:transcript_segments:${request.requestId}`);
    await repository.commitTranscript(request, { artifactKey: artifact.artifactKey, model: transcript.model, segmentCount: 1, artifactDigest: transcript.artifactDigest, durationMs: audio.durationMs });
    const transcriptManifest = await repository.materializeManifest(request, "transcript");
    assert.equal(transcriptManifest.ids.length, 1);
    assert.match(transcriptManifest.ids[0], /^t\//u);

    const intelligenceArtifact = {
      model: "silo-test",
      episodeType: "sermon",
      executiveSummary: "Executive summary",
      longSummary: "Long summary",
      mainTopics: ["faith"],
      searchKeywords: ["faith"],
      items: [{ itemType: "theme", label: "Faith", summary: "Theme summary", sourceTimes: ["00:00"], speakers: ["speaker-1"], confidence: "high", value: {} }],
    };
    const intelligence = await repository.persistIntelligenceArtifact(request, intelligenceArtifact);
    assert.equal(intelligence.itemCount, 1);
    const intelligenceManifest = await repository.materializeManifest(request, "intelligence");
    assert.ok(intelligenceManifest.ids.length >= 4);
    assert.equal(intelligenceManifest.ids.every((id) => id.startsWith("i/")), true);
    await repository.commitTranscript(request, { artifactKey: artifact.artifactKey, model: transcript.model, segmentCount: 1, artifactDigest: transcript.artifactDigest, durationMs: audio.durationMs });
    await repository.persistIntelligenceArtifact(request, intelligenceArtifact);
    assert.equal(db.prepare("SELECT count(*) count FROM research_sources WHERE episode_id=? AND processing_revision_hash=?").get(request.episodeId, request.revisionHash).count, 3);

    for (const [family, target, ordinal] of [["transcript", transcriptManifest, 0], ["intelligence", intelligenceManifest, 20_000]]) {
      for (let batchOrdinal = 0; batchOrdinal < target.embeddingBatchCount; batchOrdinal += 1) {
        const prepared = await repository.loadEmbeddingBatch(request, family, batchOrdinal);
        const records = prepared.batch.inputs.map((item) => ({ id: item.id, values: new Float32Array(1536), vectorDigest: "c".repeat(64) }));
        await repository.recordPreparedVectors(request, target, prepared.chunks, records);
        await repository.markVectorsAccepted(request, records.map(({ id }) => id), `mutation-${family}`);
        await repository.markVectorsVisible(request, records.map(({ id }) => id), `mutation-${family}`);
        // A resumed request replays acceptance; visible vectors stay visible.
        await repository.markVectorsAccepted(request, records.map(({ id }) => id), `mutation-${family}`);
        assert.equal(db.prepare(`SELECT count(*) count FROM vector_documents WHERE vector_id IN (${records.map(() => "?").join(",")}) AND processing_visibility_state='visible'`).get(...records.map(({ id }) => id)).count, records.length);
        db.prepare(`INSERT INTO processing_vector_batches(request_id,batch_ordinal,operation,generation,
          expected_ids_digest,expected_count,target_revision_hash,provider_mutation_id,visibility_state,
          accepted_at,visible_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          request.requestId, ordinal + batchOrdinal, "upsert", request.generation, `sha256:${target.idDigest}`,
          records.length, request.revisionHash, `mutation-${family}`, "visible", at, at, at, at,
        );
      }
    }
    db.prepare("UPDATE processing_requests SET state='publish_ready' WHERE request_id=?").run(request.requestId);
    await repository.finalizeEpisode(request, 2);
    assert.equal(db.prepare("SELECT transcript_status FROM episode_documents WHERE episode_id=?").get(request.episodeId).transcript_status, "Completed");
    assert.equal(db.prepare("SELECT status FROM episode_intelligence WHERE episode_id=?").get(request.episodeId).status, "complete");
    assert.equal(db.prepare("SELECT state FROM processing_requests WHERE request_id=?").get(request.requestId).state, "published");
    assert.equal(db.prepare("SELECT count(*) count FROM search_publications WHERE published_revision_id=?").get(request.revisionId).count, transcriptManifest.ids.length + intelligenceManifest.ids.length);
    const ids = [...transcriptManifest.ids, ...intelligenceManifest.ids];
    const context = { boundary: "request", request: { method: "GET", path: "/synthetic" },
      correlation: { correlationId: "episode-hydration" }, signal: new AbortController().signal };
    for (const access of [{ kind: "public-published" }, { kind: "authenticated-corpus", userId: "synthetic-user" }]) {
      const reader = createD1SearchRepositories({ db: binding, canonicalOrigin: "https://example.test", access }).searchDocuments;
      assert.equal((await reader.getByVectorIds(context, ids)).length, ids.length);
      const original = db.prepare("SELECT snapshot_json FROM editorial_revisions WHERE revision_id=?").get(request.revisionId).snapshot_json;
      const badHash = { ...JSON.parse(original), processingRevisionHash: `sha256:${"f".repeat(64)}` };
      const badAudio = { ...JSON.parse(original), audio: { ...audio, episodeId: "999999" } };
      for (const [entityId, snapshotJson, pointer] of [
        ["999999", original, request.revisionId],
        [request.episodeId, JSON.stringify(badHash), request.revisionId],
        [request.episodeId, JSON.stringify(badAudio), request.revisionId],
        [request.episodeId, original, "missing-revision"],
      ]) {
        db.prepare("UPDATE editorial_revisions SET entity_id=?,snapshot_json=? WHERE revision_id=?").run(entityId, snapshotJson, request.revisionId);
        db.prepare("UPDATE episode_documents SET published_revision_id=? WHERE episode_id=?").run(pointer, request.episodeId);
        await assert.rejects(reader.getByVectorIds(context, ids), { code: "dependency_unavailable" });
      }
      db.prepare("UPDATE episode_documents SET published_revision_id=? WHERE episode_id=?").run(request.revisionId, request.episodeId);
      db.prepare("UPDATE editorial_revisions SET entity_id=?,snapshot_json=? WHERE revision_id=?").run(`episode:${request.episodeId}`, original, request.revisionId);
      assert.equal((await reader.getByVectorIds(context, ids)).length, ids.length, "legacy document-ID revisions still hydrate");
      db.prepare("UPDATE editorial_revisions SET entity_id=? WHERE revision_id=?").run(request.episodeId, request.revisionId);
    }
  } finally {
    db.close();
  }
});


test("private publication creates one new immutable request and refuses stale drafts", async () => {
  const db = await database();
  try {
    const binding = new Binding(db);
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => at });
    const draft = { ...await episodeRequest(), desiredPublication: "draft" };
    await stateStore.createOrGetRequest(draft);
    const input = { requestId: draft.requestId, revisionHash: draft.revisionHash, generation: 1, actor: "synthetic-editor" };
    const options = { db: binding, stateStore, dispatch: async id => ({ jobId: id, acceptedAt: at }) };
    await assert.rejects(requestEpisodePublication(options, input), { code: "stale_generation" });
    db.prepare("UPDATE processing_requests SET state='publish_ready' WHERE request_id=?").run(draft.requestId);
    const first = await requestEpisodePublication(options, input);
    const replay = await requestEpisodePublication(options, input);
    assert.equal(first.generation, 2);
    assert.equal(replay.requestId, first.requestId);
    assert.equal(replay.duplicate, true);
    assert.equal(db.prepare("SELECT count(*) AS n FROM processing_requests").get().n, 2);
    const original = db.prepare("SELECT desired_publication,input_snapshot_json FROM processing_requests WHERE request_id=?").get(draft.requestId);
    assert.equal(original.desired_publication, "draft");
    assert.deepEqual(JSON.parse(original.input_snapshot_json), draft.snapshot);
    assert.equal(db.prepare("SELECT desired_publication FROM processing_requests WHERE request_id=?").get(first.requestId).desired_publication, "published");
  } finally { db.close(); }
});

test("fixture discriminator is rejected outside explicit Development", async () => {
  const db = await database();
  try {
    const binding = new Binding(db);
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => at });
    const draft = await episodeRequest();
    draft.snapshot.source = "development-fixture";
    draft.revisionHash = await createProcessingRevisionHash(draft.snapshot);
    draft.idempotencyKey = await createProcessingIdempotencyKey(draft);
    await stateStore.createOrGetRequest(draft);
    for (const environment of [undefined, "production", "development"]) {
      const repository = new D1EpisodeIngestRepository({ db: binding, bucket: {}, openAudioSource: async () => {}, environment });
      const promise = repository.loadRequest({ requestId: draft.requestId, revisionHash: draft.revisionHash });
      if (environment === "development") {
        const loaded = await promise;
        assert.equal(loaded.snapshot.source, "development-fixture");
        await repository.persistAudioDescriptor(loaded, { bucket: "aic-podcast-audio", key: `podcasts/${loaded.episodeId}.mp3`,
          sizeBytes: 1024, sha256: `sha256:${"a".repeat(64)}`, durationMs: 1000, episodeId: loaded.episodeId });
        assert.equal(db.prepare("SELECT source_system FROM episodes WHERE episode_id=?").get(loaded.episodeId).source_system, "development-fixture");
      }
      else await assert.rejects(promise, { code: "invalid_input" });
    }
  } finally { db.close(); }
});

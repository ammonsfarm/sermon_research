import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createD1ResearchSourceRepository } from "../src/research.ts";

const migrationDirectory = new URL("../../../migrations/d1/", import.meta.url);
const at = "2026-09-07T12:00:00.000000Z";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

class Statement {
  constructor(binding, sql, values = []) { this.binding = binding; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.binding, this.sql, values); }
  async first() { this.binding.calls.push({ sql: this.sql, values: this.values }); return this.binding.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { this.binding.calls.push({ sql: this.sql, values: this.values }); return { success: true, results: this.binding.database.prepare(this.sql).all(...this.values) }; }
  async run() { const result = this.binding.database.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
}
class Binding {
  constructor(database) { this.database = database; this.calls = []; }
  prepare(sql) { return new Statement(this, sql); }
}

async function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort()) db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
  return db;
}

function record(table, fields) {
  const [primaryKey, action] = { episode_intelligence: ["track_id", "migrate_d1"], episode_intelligence_items: ["id", "migrate_d1"], transcript_segments: ["segment_id", "migrate_d1"] }[table];
  const fieldsJson = canonical(fields);
  return { source_schema: "public", source_table: table, source_record_id: sha256(canonical({ [primaryKey]: fields[primaryKey] })), target_table: table, classification_action: action, fields_json: fieldsJson, source_fingerprint: sha256(fieldsJson), created_at: at };
}

// Rows generated once by the search projection pipeline; regenerate if research_sources columns change.
const generatedRows = JSON.parse(readFileSync(new URL("./fixtures/research-sources.json", import.meta.url), "utf8"));

function seed(db) {
  for (const [id, title, date, detail] of [["7", "Faith & Hope", "2026-08-01", "Canonical orchard story"], ["8", "Other episode", "2026-07-01", "Other detail"]]) {
    db.prepare(`INSERT INTO episodes(episode_id,title,publish_date,album,category,detail,source_file,canonical_audio_key,source_system,source_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, title, date, "Synthetic album", "Sermon", detail, `${id}.mp3`, `podcasts/${id}.mp3`, "postgresql", id, "Draft", at, at);
    db.prepare(`INSERT INTO episode_documents(document_id,episode_id,source_type,slug,title,status,visibility,content_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(`doc-${id}`, id, "podcast", `episode-${id}`, title, "Draft", "private", sha256(`doc-${id}`), at, at);
  }
  const sql = `INSERT INTO research_sources(source_key,source_table,source_record_id,episode_id,article_id,entity_type,entity_id,kind,item_type,title,publish_date,text,text_sha256,start_ms,end_ms,sequence_number,speakers_json,source_model,metadata_json,source_fingerprint,processing_revision_hash) VALUES(${Array(21).fill("?").join(",")})`;
  for (const row of generatedRows) { db.prepare(sql).run(...row); db.prepare("INSERT INTO research_sources_fts(rowid,title,text) SELECT rowid,title,text FROM research_sources WHERE source_key=?").run(row[0]); }
  db.prepare("INSERT INTO podtrac_episodes(podtrac_episode_id,episode_id,title,created_at,updated_at) VALUES('p7','7','Faith & Hope',?,?)").run(at, at);
  const vectorText = "The exact verified phrase is here.";
  const vectorHash = sha256(vectorText);
  const vectorMarker = {
    version: 1,
    manifestSha256: "1".repeat(64),
    sourceFingerprint: sha256("vector-source"),
    sourceRecordId: "record:t/7:speech:0010",
    sourceTable: "transcript_chunks",
    sourceField: "text",
    sourceUpdatedAt: at,
    textSha256: vectorHash,
    title: "Faith & Hope",
    publishDate: "2026-08-01",
    contentSubtype: "speech",
    vectorizeMetadata: { source_type: "episode_transcript", source_id: "7", content_subtype: "speech", published_day: 20260801, content_hash: vectorHash, chunk_index: 10 },
    entityType: "episode",
    entityId: "7",
    accessScope: "authenticated-corpus",
    processingRevisionHash: null,
    startMs: 2000,
    endMs: 3000,
  };
  db.prepare(`INSERT INTO vector_documents(vector_id,source_table,source_custom_id,source_type,source_id,content_subtype,content_hash,chunk_index,published_day,embedding_model,dimensions,vector_digest,metadata_digest,status,updated_at,record_id,source_field,authoritative_text,metadata_json) VALUES('t/7:speech:0010','transcript_chunks','7:speech:0010','episode_transcript','7','speech',?,10,20260801,'text-embedding-3-small',1536,?,?,'verified',?,'record:t/7:speech:0010','text',?,?)`).run(vectorHash, "1".repeat(64), "2".repeat(64), at, vectorText, JSON.stringify({ p5Hydration: vectorMarker }));
}

function seedSegment(db, episodeId, index, text) {
  const segmentId = `bulk-${episodeId}-${String(index).padStart(4, "0")}`;
  const key = `transcript_segments:${segmentId}`;
  db.prepare(`INSERT INTO research_sources(source_key,source_table,source_record_id,episode_id,article_id,entity_type,entity_id,kind,item_type,title,publish_date,text,text_sha256,start_ms,end_ms,sequence_number,speakers_json,source_model,metadata_json,source_fingerprint,processing_revision_hash)
    VALUES(?,'transcript_segments',?,?,NULL,'episode',?,'segment','speech','','',?,?,NULL,NULL,?,'[]','',?,?,NULL)`).run(
    key, sha256(canonical({ segment_id: segmentId })), episodeId, episodeId,
    text, sha256(text), index, canonical({ projectionVersion: 1, manifestSha256: "1".repeat(64) }), sha256(`fingerprint:${key}`),
  );
  db.prepare("INSERT INTO research_sources_fts(rowid,title,text) SELECT rowid,title,text FROM research_sources WHERE source_key=?").run(key);
}

function seedEpisode(db, id, title, detail = "common", date = "2026-06-01") {
  db.prepare(`INSERT INTO episodes(episode_id,title,publish_date,album,category,detail,source_file,canonical_audio_key,source_system,source_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, title, date, "Synthetic album", "Sermon", detail, `${id}.mp3`, `podcasts/${id}.mp3`, "postgresql", id, "Draft", at, at,
  );
  db.prepare(`INSERT INTO episode_documents(document_id,episode_id,source_type,slug,title,status,visibility,content_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    `doc-${id}`, id, "podcast", `episode-${id}`, title, "Draft", "private", sha256(`doc-${id}`), at, at,
  );
}

function seedItem(db, episodeId, id, text) {
  const key = `episode_intelligence_items:${id}`;
  db.prepare(`INSERT INTO research_sources(source_key,source_table,source_record_id,episode_id,article_id,entity_type,entity_id,kind,item_type,title,publish_date,text,text_sha256,start_ms,end_ms,sequence_number,speakers_json,source_model,metadata_json,source_fingerprint,processing_revision_hash)
    VALUES(?,'episode_intelligence_items',?,?,NULL,'episode',?,'item','notable_quotes','Rank witness','',?,?,NULL,NULL,NULL,'[]','',?,?,NULL)`).run(
    key, sha256(canonical({ id })), episodeId, episodeId, text, sha256(text),
    canonical({ projectionVersion: 1, manifestSha256: "1".repeat(64) }), sha256(`fingerprint:${key}`),
  );
  db.prepare("INSERT INTO research_sources_fts(rowid,title,text) SELECT rowid,title,text FROM research_sources WHERE source_key=?").run(key);
}

async function fixture() { const db = await migratedDatabase(); seed(db); return db; }
const operation = (overrides = {}) => ({ boundary: "request", request: { method: "GET", path: "/synthetic" }, correlation: { correlationId: "research-test" }, signal: new AbortController().signal, ...overrides });
const reader = (binding, access = { kind: "authenticated-corpus", userId: "user_synthetic" }) => createD1ResearchSourceRepository({ db: binding, access });

test("reads actual generated projection output and expands only same-episode detail neighbors without network", async () => {
  const db = await fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network path must stay unused"); };
  try {
    const repository = reader(new Binding(db));
    const structured = await repository.searchStructured(operation(), "verified structured", 10);
    assert.equal(structured[0].key, "episode_intelligence_items:9007199254740993");
    assert.match(structured[0].contentHash, /^[0-9a-f]{64}$/u);
    assert.equal((await repository.listInterviewInventory(operation(), 10))[0].sourceType, "structured.interviews");
    assert.equal((await repository.getSummaries(operation(), ["7"]))[0].sourceType, "structured.summary");
    const details = await repository.getTranscriptDetails(operation(), "exact verified phrase", ["7"], 10);
    assert.deepEqual(details.map((row) => row.key), ["transcript_segments:segment-7-9", "transcript_segments:segment-7-10", "transcript_segments:segment-7-11"]);
    assert.ok(details.every((row) => row.episodeId === "7"));
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test("treats FTS syntax as literal input and enforces bounds and zero-read settings before SQL", async () => {
  const db = await fixture();
  try {
    const binding = new Binding(db);
    const repository = reader(binding);
    assert.deepEqual(await repository.searchStructured(operation(), "verified OR structured", 10), []);
    assert.equal((await repository.searchStructured(operation(), 'verified "structured"', 10)).length, 1);
    for (const call of [
      () => repository.searchStructured(operation(), "x".repeat(8001), 1),
      () => repository.searchStructured(operation(), Array(33).fill("term").join(" "), 1),
      () => repository.searchStructured(operation(), "term", 61),
      () => repository.listInterviewInventory(operation(), -1),
      () => repository.listInterviewInventory(operation(), 1.5),
      () => repository.getSummaries(operation(), Array(13).fill("7")),
      () => repository.getTranscriptDetails(operation(), "term", Array(21).fill("7"), 1),
      () => repository.getTranscriptDetails(operation(), "term", ["7"], 61),
    ]) await assert.rejects(call(), { code: "invalid_argument" });
    const calls = binding.calls.length;
    assert.deepEqual(await repository.listInterviewInventory(operation(), 0), []);
    assert.deepEqual(await repository.getTranscriptDetails(operation(), "term", [], 10), []);
    assert.deepEqual(await repository.getTranscriptDetails(operation(), "term", ["7"], 0), []);
    assert.equal(binding.calls.length, calls);
    assert.ok(binding.calls.some((call) => call.values.includes('"verified" "structured"')));
  } finally { db.close(); }
});

test("preserves canonical presentation, scope mapping, exact filters, stable sorts, and queryless listing", async () => {
  const db = await fixture();
  try {
    const binding = new Binding(db);
    const repository = reader(binding);
    const title = await repository.searchEpisodes(operation(), { query: "orchard", scope: "title", sort: "relevance", limit: 10 });
    assert.deepEqual(title[0], { trackId: "7", title: "Faith & Hope", publishDate: "2026-08-01", album: "Synthetic album", category: "Sermon", detail: "Canonical orchard story", sourceFile: "7.mp3", hasTranscript: true, hasIntelligence: true, hasVectors: true, hasPodtrac: true, hitTypes: ["episode.title_or_detail"], snippet: "Faith & Hope", score: 0.25 });
    assert.deepEqual((await repository.searchEpisodes(operation(), { query: "verified interview", scope: "interview", sort: "relevance", limit: 10 }))[0].hitTypes, ["intelligence.item.interviews"]);
    assert.deepEqual(await repository.searchEpisodes(operation(), { query: "verified interview", scope: "passage", sort: "relevance", limit: 10 }), []);
    assert.deepEqual((await repository.searchEpisodes(operation(), { query: "exact verified phrase", episodeId: "8", scope: "all", sort: "date_desc", limit: 10 })).map((row) => row.trackId), ["8"]);
    assert.deepEqual(await repository.searchEpisodes(operation(), { query: "exact verified phrase", scope: "all", sort: "date_desc", publishedFrom: "2026-08-02", limit: 10 }), []);
    const listed = await repository.listEpisodes(operation(), { scope: "all", sort: "date_desc", limit: 10 });
    assert.deepEqual(listed[0], { trackId: "7", title: "Faith & Hope", publishDate: "2026-08-01", album: "Synthetic album", category: "Sermon", detail: "Canonical orchard story", sourceFile: "7.mp3", hasTranscript: true, hasIntelligence: true, hasVectors: true, hasPodtrac: true, hitTypes: [], snippet: "", score: 0 });
    assert.deepEqual(listed.map((row) => row.trackId), ["7", "8"]);
    assert.deepEqual((await repository.listEpisodes(operation(), { scope: "all", sort: "date_asc", limit: 10 })).map((row) => row.trackId), ["8", "7"]);
    assert.deepEqual((await repository.listEpisodes(operation(), { scope: "all", sort: "title_asc", limit: 10 })).map((row) => row.trackId), ["7", "8"]);
    assert.ok(binding.calls.every((call) => !call.sql.includes("migration_source_records")));
    await assert.rejects(repository.listEpisodes(operation(), { scope: "all", sort: "date_desc", publishedFrom: "2026-02-30", limit: 10 }), { code: "invalid_argument" });
    await assert.rejects(repository.searchEpisodes(operation(), { query: "x", scope: "all", sort: "relevance", limit: 81 }), { code: "invalid_argument" });
  } finally { db.close(); }
});

test("deduplicates keyword candidates before the episode cap and keeps undated ascending matches last", async () => {
  const db = await fixture();
  try {
    for (let index = 100; index < 180; index += 1) seedSegment(db, "7", index, "candidate saturation phrase");
    seedSegment(db, "8", 200, "candidate saturation phrase");
    const repository = reader(new Binding(db));
    assert.deepEqual((await repository.searchEpisodes(operation(), { query: "candidate saturation phrase", scope: "all", sort: "date_desc", limit: 2 })).map((row) => row.trackId), ["7", "8"]);
    db.prepare("UPDATE episodes SET publish_date='' WHERE episode_id='8'").run();
    assert.deepEqual((await repository.searchEpisodes(operation(), { query: "candidate saturation phrase", scope: "all", sort: "date_asc", limit: 2 })).map((row) => row.trackId), ["7", "8"]);
  } finally { db.close(); }
});

test("validates bounded research and vector evidence selected for canonical results", async () => {
  const db = await fixture();
  try {
    for (let index = 300; index < 500; index += 1) seedSegment(db, "7", index, `nonwitness ${index}`);
    const binding = new Binding(db);
    const repository = reader(binding);
    assert.equal((await repository.listEpisodes(operation(), { scope: "all", sort: "date_desc", limit: 1 }))[0].hasVectors, true);
    const evidenceCall = binding.calls.find((call) => call.sql.includes("evidence_kind"));
    assert.ok(evidenceCall);
    assert.equal(evidenceCall.sql.includes("SELECT r.*"), false);

    const originalMetadata = db.prepare("SELECT metadata_json FROM vector_documents WHERE vector_id='t/7:speech:0010'").get().metadata_json;
    for (const mutation of [
      (marker) => { marker.entityId = "8"; },
      (marker) => { marker.textSha256 = "f".repeat(64); },
    ]) {
      const parsed = JSON.parse(originalMetadata);
      mutation(parsed.p5Hydration);
      db.prepare("UPDATE vector_documents SET metadata_json=? WHERE vector_id='t/7:speech:0010'").run(JSON.stringify(parsed));
      await assert.rejects(repository.searchEpisodes(operation(), { query: "verified structured", scope: "all", sort: "relevance", limit: 1 }), { code: "dependency_unavailable" });
      await assert.rejects(repository.listEpisodes(operation(), { scope: "all", sort: "date_desc", limit: 1 }), { code: "dependency_unavailable" });
    }
    // An unhydrated vector (no marker) is not claimed as evidence rather than failing the request.
    db.prepare("UPDATE vector_documents SET metadata_json='{}' WHERE vector_id LIKE 't/7:%'").run();
    assert.equal((await repository.listEpisodes(operation(), { scope: "all", sort: "date_desc", limit: 1 }))[0].hasVectors, false);
    db.prepare("UPDATE vector_documents SET metadata_json=? WHERE vector_id='t/7:speech:0010'").run(originalMetadata);
    assert.equal((await repository.listEpisodes(operation(), { scope: "all", sort: "date_desc", limit: 1 }))[0].hasVectors, true);
    db.prepare("UPDATE vector_documents SET metadata_json=? WHERE vector_id='t/7:speech:0010'").run(originalMetadata);
    const summary = db.prepare("SELECT text,text_sha256,metadata_json FROM research_sources WHERE source_key='episode_intelligence:7'").get();
    db.prepare("UPDATE research_sources SET text=?,text_sha256=? WHERE source_key='episode_intelligence:7'").run("x".repeat(80_001), sha256("x".repeat(80_001)));
    await assert.rejects(repository.listEpisodes(operation(), { scope: "all", sort: "date_desc", limit: 1 }), { code: "dependency_unavailable" });
    db.prepare("UPDATE research_sources SET text=?,text_sha256=?,metadata_json=? WHERE source_key='episode_intelligence:7'").run(summary.text, summary.text_sha256, JSON.stringify({ projectionVersion: 1, manifestSha256: "1".repeat(64), padding: "x".repeat(16_384) }));
    await assert.rejects(repository.listEpisodes(operation(), { scope: "all", sort: "date_desc", limit: 1 }), { code: "dependency_unavailable" });
    db.prepare("UPDATE research_sources SET metadata_json=? WHERE source_key='episode_intelligence:7'").run(summary.metadata_json);
  } finally { db.close(); }
});

test("rejects mismatched summary identity and bounds duplicate summary aliases", async () => {
  const db = await fixture();
  try {
    const source = db.prepare("SELECT * FROM research_sources WHERE source_key='episode_intelligence:7'").get();
    db.prepare(`INSERT INTO research_sources(source_key,source_table,source_record_id,episode_id,article_id,entity_type,entity_id,kind,item_type,title,publish_date,text,text_sha256,start_ms,end_ms,sequence_number,speakers_json,source_model,metadata_json,source_fingerprint,processing_revision_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "episode_intelligence:999", source.source_table, sha256(canonical({ track_id: "999" })), source.episode_id, source.article_id, source.entity_type, source.entity_id,
      source.kind, source.item_type, source.title, source.publish_date, "alias poison summary", sha256("alias poison summary"), source.start_ms, source.end_ms,
      source.sequence_number, source.speakers_json, source.source_model, source.metadata_json, source.source_fingerprint, source.processing_revision_hash,
    );
    db.prepare("INSERT INTO research_sources_fts(rowid,title,text) SELECT rowid,title,text FROM research_sources WHERE source_key='episode_intelligence:999'").run();
    const binding = new Binding(db);
    const repository = reader(binding);
    await assert.rejects(repository.searchStructured(operation(), "alias poison", 10), { code: "dependency_unavailable" });
    assert.deepEqual((await repository.getSummaries(operation(), ["7"])).map((row) => row.key), ["episode_intelligence:7"]);
    const call = binding.calls.findLast((entry) => entry.sql.includes("r.kind='summary'"));
    assert.match(call.sql, /LIMIT \?/u);
    assert.equal(call.values.at(-1), 1);
  } finally { db.close(); }
});

test("fails closed for public reads, absent projection, malformed selected rows, and missing documents", async () => {
  const db = await fixture();
  try {
    const publicBinding = new Binding(db);
    const publicReader = reader(publicBinding, { kind: "public-published" });
    assert.deepEqual(await publicReader.searchStructured(operation(), "verified", 10), []);
    assert.deepEqual(await publicReader.listEpisodes(operation(), { scope: "all", sort: "date_desc", limit: 10 }), []);
    assert.equal(publicBinding.calls.length, 0);
    db.exec("DELETE FROM research_sources");
    await assert.rejects(reader(new Binding(db)).listEpisodes(operation(), { scope: "all", sort: "date_desc", limit: 10 }), { code: "dependency_unavailable" });
  } finally { db.close(); }
  const malformed = await fixture();
  try {
    malformed.prepare("UPDATE research_sources SET metadata_json='{}' WHERE source_key='episode_intelligence_items:9007199254740993'").run();
    await assert.rejects(reader(new Binding(malformed)).searchStructured(operation(), "verified structured", 10), { code: "dependency_unavailable" });
    malformed.prepare("UPDATE research_sources SET metadata_json=?,text_sha256=? WHERE source_key='episode_intelligence_items:9007199254740993'").run(canonical({ projectionVersion: 1, manifestSha256: "2".repeat(64) }), "f".repeat(64));
    await assert.rejects(reader(new Binding(malformed)).searchStructured(operation(), "verified structured", 10), { code: "dependency_unavailable" });
    malformed.prepare("UPDATE research_sources SET metadata_json='{}' WHERE source_key='episode_intelligence:7'").run();
    await assert.rejects(reader(new Binding(malformed)).searchEpisodes(operation(), { query: "orchard", scope: "title", sort: "relevance", limit: 10 }), { code: "dependency_unavailable" });
    malformed.prepare("DELETE FROM episode_documents WHERE episode_id='7'").run();
    await assert.rejects(reader(new Binding(malformed)).searchEpisodes(operation(), { query: "orchard", scope: "title", sort: "relevance", limit: 10 }), { code: "dependency_unavailable" });
  } finally { malformed.close(); }
});

test("cancels stalled and cumulative D1 reads at one bounded supplemental deadline", async () => {
  const never = new Promise(() => {});
  const repository = reader({ prepare: () => ({ bind() { return this; }, all: () => never }) });
  await assert.rejects(repository.searchStructured({ ...operation(), deadline: new Date(Date.now() + 10).toISOString() }, "verified", 1), { code: "timeout" });

  const db = await fixture();
  const realNow = Date.now;
  let now = 1_000_000;
  try {
    Date.now = () => now;
    class AdvancingStatement extends Statement {
      bind(...values) { return new AdvancingStatement(this.binding, this.sql, values); }
      async all() { now += 1_700; return super.all(); }
    }
    const binding = new Binding(db);
    binding.prepare = (sql) => new AdvancingStatement(binding, sql);
    await assert.rejects(reader(binding).listEpisodes(operation(), { scope: "all", sort: "date_desc", limit: 1 }), { code: "timeout" });
  } finally { Date.now = realNow; db.close(); }
});

test("keeps stronger FTS matches before limit one for structured, episode, and transcript witnesses", async () => {
  const db = await fixture();
  try {
    seedItem(db, "7", "rank-strong", "rankgrace rankgrace rankgrace rankgrace rankgrace");
    seedItem(db, "8", "rank-weak", `rankgrace ${"filler ".repeat(100)}`);
    seedSegment(db, "7", 900, "seedgrace seedgrace seedgrace seedgrace seedgrace");
    for (let index = 300; index < 320; index += 1) seedSegment(db, "8", index, `seedgrace ${"filler ".repeat(100)}${index}`);
    const repository = reader(new Binding(db));
    assert.equal((await repository.searchStructured(operation(), "rankgrace", 1))[0].episodeId, "7");
    assert.equal((await repository.searchEpisodes(operation(), { query: "rankgrace", scope: "all", sort: "relevance", limit: 1 }))[0].trackId, "7");
    assert.deepEqual((await repository.getTranscriptDetails(operation(), "seedgrace", ["7", "8"], 1)).map((item) => item.key), ["transcript_segments:bulk-7-0900"]);
  } finally { db.close(); }
});

test("uses SQLite ASCII-lower and binary ordering with stable limit prefixes", async () => {
  const db = await fixture();
  try {
    const rows = [
      ["100", "!alpha"], ["101", "Alpha"], ["102", "alpha"], ["103", "Same"],
      ["104", "Same"], ["105", "Ω"], ["106", "😀"],
    ];
    for (const [id, title] of rows) seedEpisode(db, id, title);
    const repository = reader(new Binding(db));
    const cases = [
      ["title_asc", ["100", "101", "102", "103", "104", "105", "106"]],
      ["relevance", ["100", "101", "103", "104", "102", "105", "106"]],
      ["date_asc", ["100", "101", "102", "103", "104", "105", "106"]],
      ["date_desc", ["100", "101", "102", "103", "104", "105", "106"]],
    ];
    for (const [sort, expected] of cases) {
      for (let limit = 1; limit <= expected.length; limit += 1) {
        const actual = await repository.searchEpisodes(operation(), { query: "common", scope: "title", sort, limit });
        assert.deepEqual(actual.map((item) => item.trackId), expected.slice(0, limit), `${sort} limit ${limit}`);
      }
    }
  } finally { db.close(); }
});

test("rejects malformed research deadlines before D1", async () => {
  const binding = { prepare: () => { throw new Error("D1 must not run"); } };
  const repository = reader(binding);
  for (const deadline of ["January 1, 2099", "2099-01-01T00:00:00", "2099-01-01T00:00:00-05:00", "2099-02-30T00:00:00.000Z", "2099-01-01T00:00:00.Z", "2099-01-01T24:00:00Z", "2099-02-29T00:00:00.1Z", "2099-04-31T00:00:00.123456789Z", "2099-01-01T00:00:00+00:00"]) {
    await assert.rejects(repository.searchStructured(operation({ deadline }), "term", 1), { code: "invalid_argument" });
  }
});

test("admits UTC research deadlines independently of fractional precision", async () => {
  const database = await fixture();
  try {
    const adapter = reader(new Binding(database));
    for (const fraction of ['', '.1', '.12', '.123', '.123456', '.123456789', `.${'1'.repeat(100)}`]) {
      assert.equal((await adapter.searchStructured(operation({ deadline: `2099-01-01T00:00:00${fraction}Z` }), "verified structured", 10)).length, 1);
    }
  } finally { database.close(); }
});

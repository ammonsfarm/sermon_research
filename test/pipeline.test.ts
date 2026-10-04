import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";
import { DEFAULT_CONCURRENCY, dispatchQueued, recordFeed } from "../src/episodes.ts";
import { hourlyTick } from "../src/imports.ts";
import { NonRetryableError } from "cloudflare:workflows";
import { batchEnd, mergeCleaned } from "../src/cleanup.ts";
import { decodeMp3 } from "../src/mp3.ts";
import { MUSE_SAMPLE_RATE, quietestSplit, turnsToSegments, wavFile } from "../src/muse.ts";
import { buildChunks, parseSummary, summarize, type PipelineStep, runEpisode } from "../src/pipeline.ts";
import { ensureSchema, resetSchemaCache } from "../src/schema.ts";
import { isDue, localSlot, type Schedule } from "../src/schedule.ts";
import { getSetting, putSetting } from "../src/settings.ts";
import { AUDIO_BYTES, completeSetup, createApp, fakeProviders, type MuseUpload, ORIGIN, PROVIDERS, readMuseUpload, SCHEDULE_FORM, type TestApp, TONES_MP3 } from "./helpers.ts";

/** Runs workflow steps inline, like a Workflow run with no retries. */
const inlineStep: PipelineStep = { do: (_name, _config, callback) => callback() };

async function episodes(app: TestApp) {
  const { results } = await app.env.DB.prepare("SELECT id, guid, status, stage, attempts, error FROM episodes ORDER BY published_at DESC")
    .all<{ id: string; guid: string; status: string; stage: string | null; attempts: number; error: string | null }>();
  return results;
}

function feedOf(count: number) {
  return {
    title: "Big feed",
    episodes: Array.from({ length: count }, (_unused, index) => ({
      guid: `g-${index}`, title: `Episode ${index}`, publishedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      audioUrl: `https://cdn.example.org/${index}.mp3`, durationSeconds: 1800, description: null, author: null,
    })),
  };
}

test("the import step shows cost estimates and queues only the chosen number of episodes", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    const cookie = await completeSetup(app, { count: 1 });
    const rows = await episodes(app);
    assert.deepEqual(rows.map((row) => [row.guid, row.status]), [["ep-2", "running"], ["ep-1", "not_imported"]]);
    assert.deepEqual(app.workflow.created.map((run) => run.params.episodeId), [rows[0]!.id]);
    assert.equal(app.workflow.created[0]!.id, `${rows[0]!.id}-1`);
    assert.deepEqual(await getSetting(app.env.DB, "schedule"), { frequency: "weekly", weekday: 0, hour: 9, timeZone: "America/Chicago" });

    const dashboard = await (await app.request("/admin/episodes", { cookie })).text();
    assert.match(dashboard, /Faith &amp; Works/);
    assert.match(dashboard, /<meta http-equiv="refresh" content="10">/, "the page refreshes itself while work runs");
    assert.match(dashboard, /1 working, 0 waiting/);
    assert.match(dashboard, /<strong>Working<\/strong> · attempt 1<br><span class="hint">Starting · updated just now/);
    assert.match(dashboard, /Every Sunday at 09:00 America\/Chicago/);
    assert.match(dashboard, /Import all 1 older episodes/);
    assert.equal((await app.request("/setup/import", { cookie })).headers.get("Location"), "/admin/episodes", "the wizard is finished");
  } finally {
    providers.restore();
  }
});

test("the import page lists choices with estimated minutes and cost", async () => {
  const stopped = createApp();
  const again = fakeProviders();
  try {
    const cookie = await completeSetup(stopped, { stopBefore: "/setup/import" });
    const page = await stopped.request("/setup/import", { cookie });
    const body = await page.text();
    assert.equal(page.status, 200);
    assert.match(body, /Grace Church Sermons has 2 episodes with audio/);
    assert.match(body, /None, only new ones/);
    assert.match(body, /All 2/);
    assert.match(body, /About 91 minutes of audio · transcription \$0\.09/);
    const bad = await stopped.request("/setup/import", { form: { count: "2", ...SCHEDULE_FORM, timeZone: "Mars/Olympus" }, cookie });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /Enter a time zone/);
    assert.equal((await episodes(stopped)).length, 0, "nothing is recorded until the form is valid");
  } finally {
    again.restore();
  }
});

test("an episode runs end to end: transcript, summary, chunks and vectors", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    await completeSetup(app, { count: 1 });
    const [episode] = await episodes(app);
    await runEpisode(app.env, inlineStep, episode!.id);

    const [done] = await episodes(app);
    assert.equal(done!.status, "done");
    assert.equal(done!.stage, null);
    const transcription = providers.calls.find((call) => call.url === "https://api.mistral.ai/v1/audio/transcriptions");
    assert.equal(transcription?.authorization, "Bearer mistral-key-5678");
    assert.deepEqual([...app.audio.keys()], [`episodes/${episode!.id}.mp3`], "the audio is copied into R2 first");
    assert.equal(app.audio.get(`episodes/${episode!.id}.mp3`)?.contentType, "audio/mpeg");
    const row = await app.env.DB.prepare("SELECT audio_key, audio_bytes FROM episodes WHERE id = ?").bind(episode!.id).first();
    assert.deepEqual({ ...row }, { audio_key: `episodes/${episode!.id}.mp3`, audio_bytes: AUDIO_BYTES.byteLength });

    const summary = await app.env.DB.prepare("SELECT summary, topics_json, scriptures_json FROM summaries WHERE episode_id = ?").bind(episode!.id).first();
    assert.deepEqual({ ...summary }, { summary: "Grace is a gift.", topics_json: "[\"grace\"]", scriptures_json: "[\"Ephesians 2:8\"]" });
    const summarizing = providers.calls.find((call) => call.url.endsWith("/chat/completions") && JSON.stringify(call.body).includes("Grace Church"));
    assert.ok(summarizing, "the prompt names the church from settings");

    const { results: chunks } = await app.env.DB.prepare("SELECT id, kind, start_seconds, end_seconds FROM chunks WHERE episode_id = ? ORDER BY seq").bind(episode!.id).all();
    assert.deepEqual(chunks.map((chunk) => ({ ...chunk })), [
      { id: `${episode!.id}:0`, kind: "summary", start_seconds: null, end_seconds: null },
      { id: `${episode!.id}:1`, kind: "transcript", start_seconds: 0, end_seconds: 11 },
    ]);
    assert.deepEqual([...app.vectors.stored.keys()], [`${episode!.id}:0`, `${episode!.id}:1`]);
    assert.deepEqual(app.vectors.stored.get(`${episode!.id}:1`)?.metadata, { episodeId: episode!.id, kind: "transcript", seq: 1, start: 0 });

    // Running again (a retry) reuses stored work and leaves the same chunks.
    const before = providers.calls.length;
    await runEpisode(app.env, inlineStep, episode!.id);
    assert.equal(providers.calls.filter((call, index) => index >= before && call.url.includes("mistral")).length, 0);
    assert.equal(app.vectors.stored.size, 2);
  } finally {
    providers.restore();
  }
});

test("Mistral's draft is kept, cleaned up by the answers AI, and only the cleaned transcript is summarized and indexed", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    await completeSetup(app, { count: 1 });
    const [episode] = await episodes(app);
    await runEpisode(app.env, inlineStep, episode!.id);
    assert.equal((await episodes(app))[0]!.status, "done");

    const draft = await app.env.DB.prepare("SELECT text, segments_json, model FROM transcripts_draft WHERE episode_id = ?").bind(episode!.id).first<{ text: string; segments_json: string; model: string }>();
    assert.equal(draft?.text, "Welcome. church. Today we read a fusions 2:8.", "the draft is exactly what Mistral heard");
    assert.equal(draft?.model, "voxtral-mini-latest");
    const transcript = await app.env.DB.prepare("SELECT text, segments_json, model, cleaned_by FROM transcripts WHERE episode_id = ?").bind(episode!.id).first<{ text: string; segments_json: string; model: string; cleaned_by: string }>();
    assert.equal(transcript?.text, "Welcome, church. Today we read Ephesians 2:8.");
    assert.deepEqual(JSON.parse(transcript!.segments_json), [
      { text: "Welcome, church.", start: 0, end: 4.5 },
      { text: "Today we read Ephesians 2:8.", start: 4.5, end: 11 },
    ], "the cleaned segments keep Mistral's timings");
    assert.deepEqual([transcript?.model, transcript?.cleaned_by], ["voxtral-mini-latest", "gpt-test"]);

    const chats = providers.calls.filter((call) => call.url.endsWith("/chat/completions")).map((call) => JSON.stringify(call.body));
    const cleaning = chats.findIndex((body) => body.includes("You are a transcript editor"));
    const summarizing = chats.findIndex((body) => body.includes("You summarize sermons"));
    assert.ok(cleaning >= 0 && cleaning < summarizing, "cleanup comes before the summary");
    assert.match(chats[cleaning]!, /Do NOT summarize, rewrite, or remove spoken content/);
    assert.match(chats[cleaning]!, /Sermon: \\"Faith & Works\\"\\nChurch: Grace Church/);
    assert.match(chats[cleaning]!, /\[\{\\"id\\":1,\\"text\\":\\"Welcome\. church\.\\"\},\{\\"id\\":2,/, "segments go as JSON with their IDs");
    assert.match(chats[summarizing]!, /Today we read Ephesians 2:8\./);
    assert.doesNotMatch(chats.slice(summarizing).join(""), /a fusions/, "nothing after cleanup sees the draft");
    const chunk = await app.env.DB.prepare("SELECT text FROM chunks WHERE episode_id = ? AND kind = 'transcript'").bind(episode!.id).first<{ text: string }>();
    assert.equal(chunk?.text, "Welcome, church. Today we read Ephesians 2:8.", "search indexes the cleaned words");

    // A retry doesn't clean again.
    const before = providers.calls.length;
    await runEpisode(app.env, inlineStep, episode!.id);
    assert.equal(providers.calls.slice(before).filter((call) => JSON.stringify(call.body ?? "").includes("transcript editor")).length, 0);
  } finally {
    providers.restore();
  }
});

test("a long transcript is cleaned a batch at a time, and a retry carries on from the last saved batch", async () => {
  const app = createApp();
  const providers = fakeProviders();
  const faked = globalThis.fetch;
  // 30 sentences of about 500 characters: more than one cleanup batch.
  const long = Array.from({ length: 30 }, (_unused, index) => ({ text: `Sentence ${index + 1} about a fusions. ${"word ".repeat(95).trim()}.`, start: index * 10, end: index * 10 + 10 }));
  let cleanups = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.mistral.ai/v1/audio/transcriptions") return Response.json({ text: "", segments: long });
    // The second batch fails once.
    if (url.endsWith("/chat/completions") && String(init?.body).includes("transcript editor") && ++cleanups === 2) return new Response("{\"error\":\"busy\"}", { status: 503 });
    return faked(input, init);
  }) as typeof fetch;
  try {
    await completeSetup(app, { count: 1 });
    const [episode] = await episodes(app);
    await runEpisode(app.env, inlineStep, episode!.id);
    const failed = (await episodes(app))[0]!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /The answers AI returned HTTP 503/);
    const saved = await app.env.DB.prepare("SELECT cleaned_json FROM transcripts_draft WHERE episode_id = ?").bind(episode!.id).first<{ cleaned_json: string }>();
    const progress = JSON.parse(saved!.cleaned_json) as string[];
    assert.ok(progress.length > 0 && progress.length < long.length, "the first batches are saved");
    assert.match(progress[0]!, /^Sentence 1 about Ephesians\./);

    await runEpisode(app.env, inlineStep, episode!.id);
    assert.equal((await episodes(app))[0]!.status, "done");
    const asked = providers.calls.filter((call) => JSON.stringify(call.body ?? "").includes("transcript editor")).map((call) => JSON.stringify(call.body));
    assert.equal(asked.filter((body) => body.includes("Sentence 1 about")).length, 1, "a retry doesn't clean the saved batches again");
    assert.equal(asked.length, 2, "the failed batch is the only one sent again");
    const transcript = await app.env.DB.prepare("SELECT segments_json FROM transcripts WHERE episode_id = ?").bind(episode!.id).first<{ segments_json: string }>();
    const segments = JSON.parse(transcript!.segments_json) as { text: string; start: number }[];
    assert.equal(segments.length, 30);
    assert.ok(segments.every((segment, index) => segment.text.startsWith(`Sentence ${index + 1} about Ephesians.`) && segment.start === index * 10));
  } finally {
    providers.restore();
  }
});

test("cleanup keeps the draft wherever the answers AI drops, rewrites or garbles a segment", () => {
  const items = [
    { id: 1, text: "Welcome. church." },
    { id: 2, text: "Today we read a fusions 2:8 and we see that grace is a gift from God." },
    { id: 3, text: "Amen." },
  ];
  assert.deepEqual(mergeCleaned(items, JSON.stringify([
    { id: 1, text: "Welcome, church." },
    { id: 2, text: "Grace is a gift." },
    { id: 99, text: "Invented." },
  ])), ["Welcome, church.", items[1]!.text, "Amen."], "a summarized segment and a missing one keep the draft; unknown IDs are ignored");
  assert.deepEqual(mergeCleaned(items, "Here you go:\n```json\n{\"segments\": [{\"id\": \"3\", \"text\": \" Amen!  \"}]}\n```"), [items[0]!.text, items[1]!.text, "Amen!"], "wrapped replies and string IDs are read");
  assert.deepEqual(mergeCleaned(items, "Sorry, I can't help with that."), items.map((item) => item.text), "a reply that isn't JSON changes nothing");
  assert.deepEqual(mergeCleaned(items, "[{\"id\": 1, \"text\": \"\"}]"), items.map((item) => item.text), "an emptied segment keeps the draft");
});

test("cleanup batches stay within their budget but always take at least one segment", () => {
  const segments = [100, 100, 100, 500, 50].map((chars, index) => ({ text: "x".repeat(chars), start: index, end: index + 1 }));
  assert.equal(batchEnd(segments, 0, 300), 3);
  assert.equal(batchEnd(segments, 3, 300), 4, "an oversized segment goes alone");
  assert.equal(batchEnd(segments, 4, 300), 5);
});

test("a failed episode records the provider's error and can be retried from the dashboard", async () => {
  const app = createApp();
  let cookie = "";
  const setup = fakeProviders();
  try {
    cookie = await completeSetup(app, { count: 1 });
  } finally {
    setup.restore();
  }
  const [episode] = await episodes(app);
  const failing = fakeProviders({ "https://api.mistral.ai/v1/audio/transcriptions": 500 });
  try {
    await runEpisode(app.env, inlineStep, episode!.id);
  } finally {
    failing.restore();
  }
  const [failed] = await episodes(app);
  assert.equal(failed!.status, "failed");
  assert.match(failed!.error ?? "", /Mistral transcription returned HTTP 500/);
  assert.match(await (await app.request("/admin/episodes", { cookie })).text(), /Retry/);

  const retried = await app.request("/admin/episodes/queue", { form: { id: episode!.id }, cookie });
  assert.equal(retried.headers.get("Location"), "/admin/episodes");
  const [running] = await episodes(app);
  assert.equal(running!.status, "running");
  assert.equal(running!.attempts, 2);
  assert.equal(app.workflow.created.at(-1)?.id, `${episode!.id}-2`, "each attempt gets its own workflow id");
});

test("importing older episodes from the dashboard queues them all", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    const cookie = await completeSetup(app, { count: 0 });
    assert.deepEqual((await episodes(app)).map((row) => row.status), ["not_imported", "not_imported"]);
    await app.request("/admin/episodes/queue", { form: { all: "1" }, cookie });
    assert.deepEqual((await episodes(app)).map((row) => row.status), ["running", "running"]);
  } finally {
    providers.restore();
  }
});

test("dispatch runs two at once by default, fails stale runs and keeps episodes queued if Workflows is down", async () => {
  const app = createApp();
  await ensureSchema(app.env.DB);
  await recordFeed(app.env.DB, feedOf(5));
  assert.equal(await dispatchQueued(app.env), DEFAULT_CONCURRENCY);
  assert.equal(await dispatchQueued(app.env), 0, "no free slots");
  const running = (await episodes(app)).filter((row) => row.status === "running");
  assert.deepEqual(running.map((row) => row.guid), ["g-4", "g-3"], "newest first");

  // Six hours later the runs are presumed lost.
  const later = Date.now() + 7 * 3_600_000;
  app.workflow.failing = true;
  assert.equal(await dispatchQueued(app.env, later), 0);
  const rows = await episodes(app);
  assert.deepEqual(rows.map((row) => row.status), ["failed", "failed", "queued", "queued", "queued"]);
  assert.match(rows[0]!.error ?? "", /stopped reporting progress/);
});

test("a transcripts_draft table made before the app's migrations gets the review's column", async () => {
  const app = createApp();
  // As the owner's local tools made it, before version 11 existed.
  await app.env.DB.prepare(`CREATE TABLE transcripts_draft (
    episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
    text TEXT NOT NULL, segments_json TEXT NOT NULL CHECK (json_valid(segments_json)), model TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
  const columns = async () => (await app.env.DB.prepare("SELECT name FROM pragma_table_info('transcripts_draft')").all<{ name: string }>()).results.map((row) => row.name);
  const providers = fakeProviders();
  try {
    await completeSetup(app, { count: 1 });
    assert.deepEqual(await columns(), ["episode_id", "text", "segments_json", "model", "created_at", "cleaned_json"]);
    const [episode] = await episodes(app);
    await runEpisode(app.env, inlineStep, episode!.id);
    assert.equal((await episodes(app))[0]!.status, "done", "the transcript review saves its progress and finishes");
    const transcript = await app.env.DB.prepare("SELECT cleaned_by FROM transcripts WHERE episode_id = ?").bind(episode!.id).first<{ cleaned_by: string }>();
    assert.equal(transcript?.cleaned_by, "gpt-test");

    // Production had the column added by hand first: running version 13 there adds nothing and still records it.
    await app.env.DB.prepare("DELETE FROM schema_migrations WHERE version = 13").run();
    resetSchemaCache();
    await ensureSchema(app.env.DB);
    assert.equal((await columns()).filter((name) => name === "cleaned_json").length, 1);
    assert.ok(await app.env.DB.prepare("SELECT 1 FROM schema_migrations WHERE version = 13").first());
  } finally {
    providers.restore();
  }
});

test("checking the feed only queues episodes it hasn't seen", async () => {
  const app = createApp();
  await ensureSchema(app.env.DB);
  assert.equal(await recordFeed(app.env.DB, feedOf(3), { backfill: 1 }), 1);
  assert.equal(await recordFeed(app.env.DB, feedOf(3)), 0, "known episodes are skipped, including ones not imported");
  assert.equal(await recordFeed(app.env.DB, feedOf(5)), 2);
  assert.deepEqual((await episodes(app)).map((row) => row.status), ["queued", "queued", "queued", "not_imported", "not_imported"]);
});

test("check now reports what it found", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    const cookie = await completeSetup(app, { count: 2 });
    const checked = await app.request("/admin/episodes/check", { form: {}, cookie });
    assert.equal(checked.headers.get("Location"), `/admin/episodes?notice=${encodeURIComponent("No new episodes.")}`);
    assert.equal((await getSetting<{ queued: number }>(app.env.DB, "last_check"))?.queued, 0);
  } finally {
    providers.restore();
  }
});

test("schedule slots follow the church's time zone", () => {
  const sunday9Chicago = new Date("2026-09-27T14:00:00Z"); // 09:00 CDT
  assert.deepEqual(localSlot(sunday9Chicago, "America/Chicago"), { slot: "2026-09-27T09", weekday: 0, hour: 9 });
  const weekly: Schedule = { frequency: "weekly", weekday: 0, hour: 9, timeZone: "America/Chicago" };
  assert.equal(isDue(weekly, sunday9Chicago, null), true);
  assert.equal(isDue(weekly, sunday9Chicago, "2026-09-27T09"), false, "once per slot");
  assert.equal(isDue(weekly, new Date("2026-09-28T14:00:00Z"), null), false, "wrong day");
  assert.equal(isDue({ ...weekly, frequency: "daily" }, new Date("2026-09-28T14:00:00Z"), null), true);
  assert.equal(isDue(weekly, new Date("2026-09-27T15:00:00Z"), null), false, "wrong hour");
});

test("the hourly cron checks the feed only when due", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    await ensureSchema(app.env.DB);
    await hourlyTick(app.env, new Date("2026-09-27T14:00:00Z"));
    assert.equal(await getSetting(app.env.DB, "last_check"), null, "nothing runs before setup is finished");

    await completeSetup(app, { count: 0 });
    await worker.scheduled({ scheduledTime: Date.parse("2026-09-27T13:00:00Z"), cron: "0 * * * *", noRetry() {} }, app.env);
    assert.equal(await getSetting(app.env.DB, "last_check"), null, "not the scheduled hour");

    await worker.scheduled({ scheduledTime: Date.parse("2026-09-27T14:00:00Z"), cron: "0 * * * *", noRetry() {} }, app.env);
    assert.equal(await getSetting(app.env.DB, "last_scheduled_slot"), "2026-09-27T09");
    assert.ok(await getSetting(app.env.DB, "last_check"));

    await putSetting(app.env.DB, "last_check", null);
    await worker.scheduled({ scheduledTime: Date.parse("2026-09-27T14:30:00Z"), cron: "0 * * * *", noRetry() {} }, app.env);
    assert.equal(await getSetting(app.env.DB, "last_check"), null, "a slot runs once");
  } finally {
    providers.restore();
  }
});

test("the schedule can be changed from admin", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    const cookie = await completeSetup(app);
    const saved = await app.request("/admin/schedule", { form: { frequency: "daily", weekday: "0", hour: "20", timeZone: "Europe/London" }, cookie });
    assert.match(decodeURIComponent(saved.headers.get("Location") ?? ""), /Every day at 20:00 Europe\/London/);
    const bad = await app.request("/admin/schedule", { form: { frequency: "hourly", weekday: "0", hour: "20", timeZone: "UTC" }, cookie });
    assert.equal(bad.status, 400);
  } finally {
    providers.restore();
  }
});

test("summaries are parsed leniently and transcripts chunk with time ranges", () => {
  assert.deepEqual(parseSummary("Sure! {\"summary\": \" Hi \", \"topics\": [\"a\", 3, \"\"], \"scriptures\": \"no\"} Thanks"), { summary: "Hi", mainScripture: null, topics: ["a"], scriptures: [] });
  assert.equal(parseSummary("{\"summary\": \"Hi\", \"mainScripture\": \" Matthew  5:21—26 \"}").mainScripture, "Matthew 5:21-26");
  assert.equal(parseSummary("{\"summary\": \"Hi\", \"mainScripture\": \"None\"}").mainScripture, null);
  assert.throws(() => parseSummary("no json here"), /didn't return the summary as JSON/);
  assert.throws(() => parseSummary("{\"summary\": \"\"}"), /empty summary/);

  const long = "x".repeat(700);
  const chunks = buildChunks(
    [{ text: long, start: 0, end: 60 }, { text: long, start: 60, end: 120 }, { text: "end", start: 120, end: 125 }],
    { summary: "S", mainScripture: "John 15:1-11", topics: ["t"], scriptures: [] },
  );
  assert.deepEqual(chunks.map((chunk) => [chunk.seq, chunk.kind, chunk.start, chunk.end]), [
    [0, "summary", null, null], [1, "transcript", 0, 60], [2, "transcript", 60, 125],
  ]);
  assert.equal(chunks[0]!.text, "S\nMain text: John 15:1-11\nTopics: t", "the main text is indexed for search with the summary");
});

test("a summary cut off by the length limit gets a clear error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ choices: [{ finish_reason: "length", message: { content: "{\"summary\": \"Grace is" } }] })) as typeof fetch;
  try {
    await assert.rejects(
      summarize({ llm: { baseUrl: "https://llm.example", model: "m", checkedAt: "" }, apiKey: "k", ministry: null, title: "T", publishedAt: null, transcript: "words" }),
      /ran out of room/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("summaries send the summary reasoning effort to Meta's API and to no one else", async () => {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ choices: [{ message: { content: "{\"summary\": \"Grace is a gift.\"}" } }] });
  }) as typeof fetch;
  try {
    const input = { apiKey: "k", ministry: null, title: "T", publishedAt: null, transcript: "words" };
    await summarize({ ...input, llm: { baseUrl: "https://llm.example", model: "m", summaryEffort: "high", checkedAt: "" } });
    await summarize({ ...input, llm: { baseUrl: "https://api.meta.ai/v1", model: "muse", checkedAt: "" } });
    await summarize({ ...input, llm: { baseUrl: "https://api.meta.ai/v1", model: "muse", summaryEffort: "medium", chatEffort: "max", checkedAt: "" } });
    assert.equal("reasoning_effort" in bodies[0]!, false);
    assert.equal(bodies[1]!.reasoning_effort, "low", "sites saved before the setting existed get low");
    assert.equal(bodies[2]!.reasoning_effort, "medium", "the summary effort, not the chat one");
  } finally {
    globalThis.fetch = original;
  }
});

test("processing a sermon uses the summary reasoning effort for every answers-AI call, speaker included", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    await completeSetup(app, { count: 1 });
    await putSetting(app.env.DB, "llm", { baseUrl: "https://api.meta.ai/v1", model: "muse", summaryEffort: "high", chatEffort: "minimal", checkedAt: "" });
    const [episode] = await episodes(app);
    await runEpisode(app.env, inlineStep, episode!.id);
    const chats = providers.calls.filter((call) => call.url === "https://api.meta.ai/v1/chat/completions");
    assert.match(JSON.stringify(chats.map((call) => call.body)), /who preached each sermon/, "the speaker step ran");
    assert.match(JSON.stringify(chats.map((call) => call.body)), /You are a transcript editor/, "the cleanup step ran");
    assert.ok(chats.length >= 3);
    assert.deepEqual([...new Set(chats.map((call) => (call.body as { reasoning_effort?: string }).reasoning_effort))], ["high"]);
  } finally {
    providers.restore();
  }
});

test("transcription gets a signed link to our copy of the audio, never the church's own link", async () => {
  const app = createApp();
  const original = globalThis.fetch;
  let fileUrl = "";
  const providers = fakeProviders();
  const faked = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "https://api.mistral.ai/v1/audio/transcriptions") fileUrl = String((init?.body as FormData).get("file_url"));
    return faked(input, init);
  }) as typeof fetch;
  try {
    await completeSetup(app, { count: 1 });
    const [episode] = await episodes(app);
    await runEpisode(app.env, inlineStep, episode!.id);
    assert.match(fileUrl, new RegExp(`^${ORIGIN}/audio/${episode!.id}\\?expires=\\d+&signature=[\\w-]+$`));
    const link = new URL(fileUrl);
    const served = await app.request(link.pathname + link.search);
    assert.equal(served.status, 200, "the signed link works without signing in");
  } finally {
    providers.restore();
    globalThis.fetch = original;
  }
});

test("a bot-check page instead of audio fails the episode with a clear message", async () => {
  const app = createApp();
  const setup = fakeProviders();
  try {
    await completeSetup(app, { count: 1 });
  } finally {
    setup.restore();
  }
  const [episode] = await episodes(app);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>Just a moment...</html>", { headers: { "Content-Type": "text/html; charset=UTF-8" } })) as typeof fetch;
  try {
    await runEpisode(app.env, inlineStep, episode!.id);
  } finally {
    globalThis.fetch = original;
  }
  const [failed] = await episodes(app);
  assert.equal(failed!.status, "failed");
  assert.match(failed!.error ?? "", /web page instead of the audio file/);
  assert.equal(app.audio.size, 0);
});

test("admins choose how many episodes run at once and can retry every failure", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    const cookie = await completeSetup(app, { count: 0 });
    await recordFeed(app.env.DB, feedOf(6), { backfill: 6 });
    const bad = await app.request("/admin/episodes/concurrency", { form: { concurrency: "9" }, cookie });
    assert.match(decodeURIComponent(bad.headers.get("Location") ?? ""), /Choose between 1 and 5/);
    const saved = await app.request("/admin/episodes/concurrency", { form: { concurrency: "1" }, cookie });
    assert.match(decodeURIComponent(saved.headers.get("Location") ?? ""), /up to 1 episode at once/);
    assert.equal(await dispatchQueued(app.env), 0, "saving already started the one allowed run");
    assert.equal((await episodes(app)).filter((row) => row.status === "running").length, 1);

    await app.request("/admin/episodes/concurrency", { form: { concurrency: "3" }, cookie });
    assert.equal((await episodes(app)).filter((row) => row.status === "running").length, 3);
    assert.match(await (await app.request("/admin/episodes", { cookie })).text(), /<option value="3" selected>/);

    await app.env.DB.prepare("UPDATE episodes SET status = 'failed', error = 'boom' WHERE status = 'running'").run();
    const page = await (await app.request("/admin/episodes", { cookie })).text();
    assert.match(page, /Retry all 3 failed/);
    await app.request("/admin/episodes/queue", { form: { failed: "1" }, cookie });
    const rows = await episodes(app);
    assert.equal(rows.filter((row) => row.status === "failed").length, 0);
    assert.equal(rows.filter((row) => row.status === "running").length, 3);
  } finally {
    providers.restore();
  }
});

test("the dashboard shows when the background worker last ran and stops refreshing when idle", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    const cookie = await completeSetup(app, { count: 0 });
    let page = await (await app.request("/admin/episodes", { cookie })).text();
    assert.doesNotMatch(page, /http-equiv="refresh"/);
    assert.match(page, /Background worker<\/dt><dd>hasn(?:'|&#39;|&#x27;)t run yet/);
    await hourlyTick(app.env, new Date());
    page = await (await app.request("/admin/episodes", { cookie })).text();
    assert.match(page, /Background worker<\/dt><dd>last ran just now/);
  } finally {
    providers.restore();
  }
});

// ---------------------------------------------------------------- Muse transcription

const museCalls = (providers: ReturnType<typeof fakeProviders>) => providers.calls.filter((call) => call.url === "https://api.meta.ai/v1/asr/transcribe");

/** Loudness of the decoded audio between two times, as root mean square. */
function rms(samples: Int16Array, fromSeconds: number, toSeconds: number): number {
  const part = samples.subarray(Math.round(fromSeconds * MUSE_SAMPLE_RATE), Math.round(toSeconds * MUSE_SAMPLE_RATE));
  return Math.sqrt(part.reduce((total, sample) => total + sample * sample, 0) / part.length);
}

test("MP3 audio decodes to 16 kHz mono, the same samples however it's split into parts", async () => {
  const whole = new Int16Array(6 * MUSE_SAMPLE_RATE);
  const all = await decodeMp3(new Response(TONES_MP3).body!, MUSE_SAMPLE_RATE, 0, whole);
  assert.equal(all.more, false);
  assert.ok(all.samples > 5.5 * MUSE_SAMPLE_RATE && all.samples < 5.6 * MUSE_SAMPLE_RATE, `5.5 s plus the encoder's padding, got ${all.samples / MUSE_SAMPLE_RATE} s`);
  assert.ok(rms(whole, 0.2, 2.3) > 500 && rms(whole, 3.3, 5.3) > 500, "both tones come through, downmixed to mono");
  assert.ok(rms(whole, 2.65, 3.05) < 50, "the silence stays silent");

  const first = new Int16Array(2 * MUSE_SAMPLE_RATE);
  const start = await decodeMp3(new Response(TONES_MP3).body!, MUSE_SAMPLE_RATE, 0, first);
  assert.deepEqual(start, { samples: 2 * MUSE_SAMPLE_RATE, more: true }, "a full part says more audio follows");
  const rest = new Int16Array(6 * MUSE_SAMPLE_RATE);
  const end = await decodeMp3(new Response(TONES_MP3).body!, MUSE_SAMPLE_RATE, start.samples, rest);
  assert.equal(start.samples + end.samples, all.samples);
  assert.deepEqual([...first, ...rest.subarray(0, end.samples)], [...whole.subarray(0, all.samples)], "parts join without a gap or an overlap");

  const notMp3 = await decodeMp3(new Response(AUDIO_BYTES).body!, MUSE_SAMPLE_RATE, 0, new Int16Array(100));
  assert.deepEqual(notMp3, { samples: 0, more: false });
});

test("a full part ends at its quietest moment, and WAV files are mono 16-bit PCM", async () => {
  const samples = new Int16Array(6 * MUSE_SAMPLE_RATE);
  await decodeMp3(new Response(TONES_MP3).body!, MUSE_SAMPLE_RATE, 0, samples);
  const split = quietestSplit(samples, 4 * MUSE_SAMPLE_RATE, MUSE_SAMPLE_RATE, 2) / MUSE_SAMPLE_RATE;
  assert.ok(split > 2.55 && split < 3.15, `splits in the silence at 2.5 to 3.1 s, got ${split}`);
  assert.equal(quietestSplit(samples, 1_000, MUSE_SAMPLE_RATE, 2), 1_000, "a part too short to search ends where it is");

  const wav = wavFile(new Int16Array([1, -2]));
  const view = new DataView(wav.buffer);
  const ascii = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
  assert.deepEqual([ascii(0), view.getUint32(4, true), ascii(8), ascii(12), view.getUint32(16, true)], ["RIFF", 40, "WAVE", "fmt ", 16]);
  assert.deepEqual([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint32(28, true), view.getUint16(32, true), view.getUint16(34, true)], [1, 1, 16_000, 32_000, 2, 16]);
  assert.deepEqual([ascii(36), view.getUint32(40, true), view.getInt16(44, true), view.getInt16(46, true)], ["data", 4, 1, -2]);
});

test("Muse turns become segments in seconds from the start of the sermon", () => {
  assert.deepEqual(turnsToSegments({
    turns: [
      { turnId: 1, startMs: 4_250, endMs: 9_000, transcript: "  Turn with me   to Romans. " },
      { turnId: 0, startMs: 0, endMs: 4_100, transcript: "Good morning." },
      { turnId: 2, startMs: 9_000, endMs: 9_500, transcript: "   " },
      { turnId: 3, startMs: "soon", endMs: 10_000, transcript: "Unplaced." },
    ],
  }, 570, 600), [
    { text: "Good morning.", start: 570, end: 574.1 },
    { text: "Turn with me to Romans.", start: 574.25, end: 579 },
  ], "offset by where the part starts, in order, without empty or untimed turns");
  assert.deepEqual(turnsToSegments({ transcript: "All of it.", turns: [] }, 30, 12.5), [{ text: "All of it.", start: 30, end: 42.5 }], "a reply without turns covers the part");
  assert.deepEqual(turnsToSegments({ turns: [] }, 0, 10), []);
});

test("Muse transcribes MP3 audio part by part, split at pauses, and a retry carries on from the last saved part", async () => {
  const app = createApp();
  const providers = fakeProviders();
  const faked = globalThis.fetch;
  let museRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://cdn.example.org/")) return new Response(TONES_MP3, { headers: { "Content-Type": "audio/mpeg", "Content-Length": String(TONES_MP3.byteLength) } });
    // The second part hits Muse's rate limit once.
    if (url === "https://api.meta.ai/v1/asr/transcribe" && ++museRequests === 3) return Response.json({ type: "rate_limit", message: "Too many sessions" }, { status: 429 });
    return faked(input, init);
  }) as typeof fetch;
  const parts = { partSeconds: 4, minPartSeconds: 1, searchSeconds: 2 };
  try {
    const cookie = await completeSetup(app, { count: 1 });
    assert.equal((await app.request("/admin/transcription", { form: PROVIDERS.muse, cookie })).headers.get("Location"), "/admin?saved=1");
    const [episode] = await episodes(app);
    await runEpisode(app.env, inlineStep, episode!.id, parts);

    const failed = (await episodes(app))[0]!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /^Muse says the account is at its limit .* \(HTTP 429\)\..* It said: "Too many sessions"$/u);
    const progress = await app.env.DB.prepare("SELECT done_samples, segments_json FROM transcription_progress WHERE episode_id = ?").bind(episode!.id).first<{ done_samples: number; segments_json: string }>();
    const firstPart = progress!.done_samples / MUSE_SAMPLE_RATE;
    assert.ok(firstPart > 2.55 && firstPart < 3.15, `the first part ends in the pause, at ${firstPart} s`);
    assert.equal(JSON.parse(progress!.segments_json).length, 2);

    await runEpisode(app.env, inlineStep, episode!.id, parts);
    assert.equal((await episodes(app))[0]!.status, "done");
    const sent = museCalls(providers).slice(1).map((call) => call.body as MuseUpload);
    assert.equal(sent.length, 2, "the check, then each part once: the saved part isn't sent again");
    assert.equal(museCalls(providers)[1]!.authorization, "Bearer muse-key-4321");
    for (const upload of sent) {
      assert.deepEqual(upload.request, { mode: "ENDPOINTING", model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" });
      assert.equal(upload.requestHeaders, "Content-Disposition: form-data; name=\"request\"\r\nContent-Type: application/json", "the request part is JSON, without a filename");
      assert.match(upload.audioHeaders, /name="audio"; filename="audio\.wav"\r\nContent-Type: audio\/wav/);
      assert.deepEqual([upload.wav.riff, upload.wav.format, upload.wav.channels, upload.wav.rate, upload.wav.bits], ["RIFF", 1, 1, 16_000, 16]);
      assert.ok(upload.wav.samples.length <= 4 * MUSE_SAMPLE_RATE, "no part is longer than the limit");
    }
    assert.equal(sent[0]!.wav.samples.length, progress!.done_samples);

    const draft = await app.env.DB.prepare("SELECT segments_json, model FROM transcripts_draft WHERE episode_id = ?").bind(episode!.id).first<{ segments_json: string; model: string }>();
    assert.equal(draft?.model, "muse-voice-transcribe-1.0");
    const segments = JSON.parse(draft!.segments_json) as { text: string; start: number; end: number }[];
    const half = (seconds: number) => Math.round(seconds * 1000 / 2) / 1000;
    const secondPart = sent[1]!.wav.samples.length / MUSE_SAMPLE_RATE;
    assert.deepEqual(segments.map((segment) => segment.text), ["First half.", "Second half.", "First half.", "Second half."]);
    assert.deepEqual(segments.map((segment) => segment.start), [0, half(firstPart), firstPart, firstPart + half(secondPart)].map((seconds) => Math.round(seconds * 1000) / 1000), "the second part's turns are offset by the first part's length");
    assert.equal(await app.env.DB.prepare("SELECT count(*) AS n FROM transcription_progress").first<{ n: number }>().then((row) => row?.n), 0, "progress is cleared once done");
    assert.equal(providers.calls.filter((call) => call.url.includes("mistral.ai/v1/audio")).length, 0, "Mistral isn't used");
    const transcript = await app.env.DB.prepare("SELECT cleaned_by FROM transcripts WHERE episode_id = ?").bind(episode!.id).first<{ cleaned_by: string }>();
    assert.equal(transcript?.cleaned_by, "gpt-test", "Muse's draft is cleaned up like Mistral's");
  } finally {
    providers.restore();
  }
});

test("when Muse times out on a part, the retry and every later episode send shorter ones", async () => {
  const app = createApp();
  const providers = fakeProviders();
  const faked = globalThis.fetch;
  // Muse's gateway gives up on anything over 2.5 seconds.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://cdn.example.org/")) return new Response(TONES_MP3, { headers: { "Content-Type": "audio/mpeg", "Content-Length": String(TONES_MP3.byteLength) } });
    if (url === "https://api.meta.ai/v1/asr/transcribe") {
      const upload = await readMuseUpload(init!.body as Blob, new Headers(init!.headers).get("Content-Type") ?? "");
      if (upload.wav.samples.length > 2.5 * MUSE_SAMPLE_RATE) return new Response("error code: 504", { status: 504 });
    }
    return faked(input, init);
  }) as typeof fetch;
  const limits = { partSeconds: 4, minPartSeconds: 1, searchSeconds: 2 };
  try {
    const cookie = await completeSetup(app, { count: 2 });
    await app.request("/admin/transcription", { form: PROVIDERS.muse, cookie });
    const [first, second] = await episodes(app);
    await runEpisode(app.env, inlineStep, first!.id, limits);
    const failed = (await episodes(app))[0]!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "Muse timed out transcribing this part (HTTP 504). It said: \"error code: 504\" The next try sends 2-second parts.");
    assert.equal(await getSetting<number>(app.env.DB, "muse_part_seconds"), 2);

    const before = museCalls(providers).length;
    await runEpisode(app.env, inlineStep, first!.id, limits);
    await runEpisode(app.env, inlineStep, second!.id, limits);
    assert.deepEqual((await episodes(app)).map((row) => row.status), ["done", "done"], "both finish without timing out again");
    const lengths = museCalls(providers).slice(before).map((call) => (call.body as MuseUpload).wav.samples.length / MUSE_SAMPLE_RATE);
    assert.ok(lengths.length >= 6 && lengths.every((seconds) => seconds <= 2), `every part is 2 seconds or less: ${lengths.join(", ")}`);
    const draft = await app.env.DB.prepare("SELECT segments_json FROM transcripts_draft WHERE episode_id = ?").bind(first!.id).first<{ segments_json: string }>();
    const segments = JSON.parse(draft!.segments_json) as { start: number; end: number }[];
    assert.ok(segments.every((segment, index) => index === 0 || segment.start >= segments[index - 1]!.end - 0.001), "the shorter parts still join up in order");
    assert.ok(segments.at(-1)!.end > 5.5, "the whole recording is covered");
  } finally {
    providers.restore();
  }
});

test("Muse explains audio it can't read instead of sending it, without retrying", async () => {
  const app = createApp();
  const providers = fakeProviders();
  // Records what each step throws, as Workflows would see it.
  const thrown: unknown[] = [];
  const recording: PipelineStep = { do: async (_name, _config, callback) => callback().catch((error: unknown) => { thrown.push(error); throw error; }) };
  try {
    const cookie = await completeSetup(app, { count: 1 });
    await app.request("/admin/transcription", { form: PROVIDERS.muse, cookie });
    const [episode] = await episodes(app);
    await runEpisode(app.env, recording, episode!.id);
    assert.ok(thrown[0] instanceof NonRetryableError, "Workflows doesn't retry a format it can't convert");
    const failed = (await episodes(app))[0]!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "The audio couldn't be read as MP3. Switch to Mistral in Admin → Transcription, then retry.");
    assert.equal(museCalls(providers).length, 1, "only the key check reached Muse");

    await app.env.DB.prepare("UPDATE episodes SET audio_key = 'episodes/x.m4a' WHERE id = ?").bind(episode!.id).run();
    app.audio.set("episodes/x.m4a", { bytes: AUDIO_BYTES, contentType: "audio/mp4" });
    await runEpisode(app.env, recording, episode!.id);
    assert.ok(thrown.at(-1) instanceof NonRetryableError);
    assert.match((await episodes(app))[0]!.error ?? "", /^This site can only convert MP3s to the WAV that Muse accepts, and this episode's audio is \.m4a\./u);
  } finally {
    providers.restore();
  }
});

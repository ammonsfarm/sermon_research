import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";
import { dispatchQueued, MAX_RUNNING, recordFeed } from "../src/episodes.ts";
import { hourlyTick } from "../src/imports.ts";
import { buildChunks, parseSummary, type PipelineStep, runEpisode } from "../src/pipeline.ts";
import { ensureSchema } from "../src/schema.ts";
import { isDue, localSlot, type Schedule } from "../src/schedule.ts";
import { getSetting, putSetting } from "../src/settings.ts";
import { completeSetup, createApp, fakeProviders, SCHEDULE_FORM, type TestApp } from "./helpers.ts";

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
      audioUrl: `https://cdn.example.org/${index}.mp3`, durationSeconds: 1800,
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
    assert.match(dashboard, /Working \(transcribing\)/);
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

test("dispatch runs at most three at once, fails stale runs and keeps episodes queued if Workflows is down", async () => {
  const app = createApp();
  await ensureSchema(app.env.DB);
  await recordFeed(app.env.DB, feedOf(5));
  assert.equal(await dispatchQueued(app.env), MAX_RUNNING);
  assert.equal(await dispatchQueued(app.env), 0, "no free slots");
  const running = (await episodes(app)).filter((row) => row.status === "running");
  assert.deepEqual(running.map((row) => row.guid), ["g-4", "g-3", "g-2"], "newest first");

  // Six hours later the runs are presumed lost.
  const later = Date.now() + 7 * 3_600_000;
  app.workflow.failing = true;
  assert.equal(await dispatchQueued(app.env, later), 0);
  const rows = await episodes(app);
  assert.deepEqual(rows.map((row) => row.status), ["failed", "failed", "failed", "queued", "queued"]);
  assert.match(rows[0]!.error ?? "", /stopped reporting progress/);
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
  assert.deepEqual(parseSummary("Sure! {\"summary\": \" Hi \", \"topics\": [\"a\", 3, \"\"], \"scriptures\": \"no\"} Thanks"), { summary: "Hi", topics: ["a"], scriptures: [] });
  assert.throws(() => parseSummary("no json here"), /didn't return the summary as JSON/);
  assert.throws(() => parseSummary("{\"summary\": \"\"}"), /empty summary/);

  const long = "x".repeat(700);
  const chunks = buildChunks(
    [{ text: long, start: 0, end: 60 }, { text: long, start: 60, end: 120 }, { text: "end", start: 120, end: 125 }],
    { summary: "S", topics: ["t"], scriptures: [] },
  );
  assert.deepEqual(chunks.map((chunk) => [chunk.seq, chunk.kind, chunk.start, chunk.end]), [
    [0, "summary", null, null], [1, "transcript", 0, 60], [2, "transcript", 60, 125],
  ]);
  assert.equal(chunks[0]!.text, "S\nTopics: t");
});

import assert from "node:assert/strict";
import test from "node:test";

import { recordFeed } from "../src/episodes.ts";
import { runEpisode } from "../src/pipeline.ts";
import { completeSetup, cookieFrom, createApp, fakeProviders, indexedSite, inlineStep, PROVIDERS, type TestApp, TONES_MP3 } from "./helpers.ts";

function feedOf(count: number) {
  return {
    title: "Big feed",
    episodes: Array.from({ length: count }, (_unused, index) => ({
      guid: `g-${index}`, title: `Episode ${index} - Series ${index % 3}`, publishedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      audioUrl: `https://cdn.example.org/${index}.mp3`, durationSeconds: 1800, description: null, author: null,
    })),
  };
}

/** The rows of the episode table on an admin episodes page. */
function rows(page: string): string[] {
  return page.split("<tbody>")[1]!.split("</tbody>")[0]!.split("<tr>").slice(1);
}

async function episode(app: TestApp, id: string) {
  return app.env.DB.prepare("SELECT status, stage, redo, error FROM episodes WHERE id = ?").bind(id).first<{ status: string; stage: string | null; redo: string | null; error: string | null }>();
}

const isChat = (call: { url: string }) => call.url.endsWith("/chat/completions");
const asks = (calls: { url: string; body: unknown }[], text: string) => calls.filter((call) => isChat(call) && JSON.stringify(call.body).includes(text)).length;

test("the episodes list finds episodes by title, series, speaker or date and status, 200 at a time", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  await recordFeed(app.env.DB, feedOf(250));
  await app.env.DB.batch([
    app.env.DB.prepare("UPDATE episodes SET status = 'done' WHERE guid LIKE 'g-%' AND CAST(substr(guid, 3) AS INTEGER) < 100"),
    app.env.DB.prepare("UPDATE episodes SET status = 'failed', error = 'Broken' WHERE guid IN ('g-200', 'g-201', 'g-202')"),
    app.env.DB.prepare("UPDATE episodes SET speaker = 'Phil Friesen' WHERE guid IN ('g-5', 'g-6')"),
  ]);
  const get = async (search = "") => (await app.request(`/admin/episodes${search}`, { cookie })).text();

  const first = await get();
  assert.equal(rows(first).length, 200);
  assert.match(first, /Showing 1–200 of 252 episodes\. <a href="\/admin\/episodes\?page=2">Next 52<\/a>/);
  assert.match(first, /<option value="failed">Failed \(3\)<\/option>/);
  const second = await get("?page=2");
  assert.equal(rows(second).length, 52);
  assert.match(second, /Showing 201–252 of 252 episodes\. <a href="\/admin\/episodes">Previous 200<\/a>/);

  const byTitle = await get("?q=+Episode++12+");
  assert.deepEqual(rows(byTitle).map((row) => /Episode \d+/u.exec(row)?.[0]), ["Episode 129", "Episode 128", "Episode 127", "Episode 126", "Episode 125", "Episode 124", "Episode 123", "Episode 122", "Episode 121", "Episode 120", "Episode 12"], "anywhere in the title, newest first, with spaces tidied");
  assert.match(byTitle, /<input id="f-q" name="q" type="search" value="Episode 12"/);
  assert.equal(rows(await get("?q=Series+2")).length, 83, "the series is part of the title");
  assert.equal(rows(await get("?q=phil")).length, 2, "speakers match, ignoring case");
  assert.equal(rows(await get("?q=2026-02")).length, 28, "dates match from the start");
  assert.match(await get("?q=%25"), /No episodes match\./, "% is a literal, not a wildcard");

  const failed = await get("?status=failed");
  assert.equal(rows(failed).length, 3);
  assert.match(failed, /<option value="failed" selected>Failed \(3\)<\/option>/);
  const both = await get("?q=Series+1&status=done");
  assert.equal(rows(both).length, 33);
  assert.match(both, /Showing 1–33 of 33 matching episodes\. <a href="\/admin\/episodes">Clear<\/a>|<a href="\/admin\/episodes">Clear<\/a>[\s\S]*Showing 1–33 of 33 matching episodes\./);
  assert.equal(rows(await get("?status=nonsense")).length, 200, "an unknown status shows everything");
});

test("re-processing the summary keeps the sermon up and redoes only the summary and search vectors", async () => {
  const site = await indexedSite();
  try {
    const [id] = site.ids as [string];
    const before = site.providers.calls.length;
    const started = site.app.workflow.created.length;
    const response = await site.app.request(`/episodes/${id}/reprocess`, { form: { from: "summary" }, cookie: site.cookie });
    assert.match(response.headers.get("Location") ?? "", /^\/admin\/episodes\?status=reprocessing&notice=Re-processing/u);
    assert.deepEqual(site.app.workflow.created.slice(started).map((run) => run.params.episodeId), [id], "a run starts straight away");
    assert.deepEqual({ ...await episode(site.app, id) }, { status: "done", stage: "transcribe", redo: "summary", error: null });
    assert.equal((await site.app.request(`/episodes/${id}`, { cookie: site.cookie })).status, 200, "the sermon stays up while it's redone");
    assert.match(await (await site.app.request("/admin/episodes?status=reprocessing", { cookie: site.cookie })).text(), /<strong>Re-processing<\/strong> · attempt 2/);

    await runEpisode(site.app.env, inlineStep, id);
    const calls = site.providers.calls.slice(before);
    assert.equal(calls.filter((call) => call.url.includes("mistral.ai")).length, 0, "not transcribed again");
    assert.equal(asks(calls, "You are a transcript editor"), 0, "not rewritten again");
    assert.equal(asks(calls, "You summarize sermons"), 1);
    assert.ok(calls.some((call) => call.url === "https://api.openai.com/v1/embeddings"), "the search vectors are rebuilt");
    assert.deepEqual({ ...await episode(site.app, id) }, { status: "done", stage: null, redo: null, error: null });
  } finally {
    site.restore();
  }
});

test("re-processing the transcript from the audio redoes every step, from the stored copy", async () => {
  const site = await indexedSite();
  try {
    const [id] = site.ids as [string];
    await site.app.env.DB.prepare("UPDATE transcripts SET text = 'Old words.' WHERE episode_id = ?").bind(id).run();
    const before = site.providers.calls.length;
    await site.app.request(`/episodes/${id}/reprocess`, { form: { from: "transcribe" }, cookie: site.cookie });
    await runEpisode(site.app.env, inlineStep, id);
    const calls = site.providers.calls.slice(before);
    assert.equal(calls.filter((call) => call.url.startsWith("https://cdn.example.org/")).length, 0, "the audio already in R2 is used, not downloaded again");
    assert.equal(calls.filter((call) => call.url === "https://api.mistral.ai/v1/audio/transcriptions").length, 1);
    assert.equal(asks(calls, "You are a transcript editor"), 1);
    assert.equal(asks(calls, "You summarize sermons"), 1);
    assert.ok(calls.some((call) => call.url === "https://api.openai.com/v1/embeddings"));
    const transcript = await site.app.env.DB.prepare("SELECT text FROM transcripts WHERE episode_id = ?").bind(id).first<{ text: string }>();
    assert.equal(transcript?.text, "Welcome, church. Today we read Ephesians 2:8.");
    assert.equal((await episode(site.app, id))?.redo, null);
  } finally {
    site.restore();
  }
});

test("a rewrite starts again from Mistral's draft, or from the transcript when there's no draft", async () => {
  const site = await indexedSite();
  try {
    const [withDraft, withoutDraft] = site.ids as [string, string];
    // The last rewrite's saved progress would otherwise finish it straight away.
    await site.app.env.DB.prepare("UPDATE transcripts SET text = 'Old words.' WHERE episode_id = ?").bind(withDraft).run();
    let before = site.providers.calls.length;
    await site.app.request(`/episodes/${withDraft}/reprocess`, { form: { from: "rewrite" }, cookie: site.cookie });
    await runEpisode(site.app.env, inlineStep, withDraft);
    let calls = site.providers.calls.slice(before);
    assert.equal(calls.filter((call) => call.url.includes("mistral.ai")).length, 0);
    assert.match(JSON.stringify(calls.find((call) => isChat(call) && JSON.stringify(call.body).includes("transcript editor"))?.body), /a fusions/, "the draft's own words go to the editor");
    assert.equal(asks(calls, "You summarize sermons"), 1);
    assert.equal((await site.app.env.DB.prepare("SELECT text FROM transcripts WHERE episode_id = ?").bind(withDraft).first<{ text: string }>())?.text, "Welcome, church. Today we read Ephesians 2:8.");

    // Sermons transcribed before drafts were kept, like the ones from the owner's local tools.
    await site.app.env.DB.prepare("DELETE FROM transcripts_draft WHERE episode_id = ?").bind(withoutDraft).run();
    before = site.providers.calls.length;
    await site.app.request(`/episodes/${withoutDraft}/reprocess`, { form: { from: "rewrite" }, cookie: site.cookie });
    await runEpisode(site.app.env, inlineStep, withoutDraft);
    calls = site.providers.calls.slice(before);
    assert.match(JSON.stringify(calls.find((call) => isChat(call) && JSON.stringify(call.body).includes("transcript editor"))?.body), /Welcome, church\./, "rewritten from the current transcript");
    assert.deepEqual({ ...await episode(site.app, withoutDraft) }, { status: "done", stage: null, redo: null, error: null });
  } finally {
    site.restore();
  }
});

test("re-processing the search vectors asks no AI, and a pending request keeps the earlier step", async () => {
  const site = await indexedSite();
  try {
    const [id] = site.ids as [string];
    site.app.workflow.failing = true; // so the request stays waiting
    await site.app.request(`/episodes/${id}/reprocess`, { form: { from: "index" }, cookie: site.cookie });
    assert.equal((await episode(site.app, id))?.redo, "index");
    await site.app.request(`/episodes/${id}/reprocess`, { form: { from: "summary" }, cookie: site.cookie });
    assert.equal((await episode(site.app, id))?.redo, "summary", "an earlier step widens it");
    await site.app.request(`/episodes/${id}/reprocess`, { form: { from: "index" }, cookie: site.cookie });
    assert.equal((await episode(site.app, id))?.redo, "summary", "a later one doesn't narrow it");
    assert.match(await (await site.app.request(`/episodes/${id}`, { cookie: site.cookie })).text(), /Waiting to re-process from: Summary\./);

    await site.app.env.DB.prepare("UPDATE episodes SET redo = 'index' WHERE id = ?").bind(id).run();
    const before = site.providers.calls.length;
    await runEpisode(site.app.env, inlineStep, id);
    const calls = site.providers.calls.slice(before);
    assert.equal(calls.filter(isChat).length, 0);
    assert.ok(calls.some((call) => call.url === "https://api.openai.com/v1/embeddings"));
    assert.equal((await episode(site.app, id))?.redo, null);
  } finally {
    site.restore();
  }
});

test("a failed re-process keeps the sermon up, shows why, and can be retried", async () => {
  const site = await indexedSite();
  const working = globalThis.fetch;
  try {
    const [id] = site.ids as [string];
    await site.app.request(`/episodes/${id}/reprocess`, { form: { from: "summary" }, cookie: site.cookie });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith("/chat/completions")
      ? new Response("{\"error\":\"down\"}", { status: 500 }) : working(input, init)) as typeof fetch;
    await runEpisode(site.app.env, inlineStep, id);
    globalThis.fetch = working;

    const failed = await episode(site.app, id);
    assert.deepEqual([failed?.status, failed?.stage, failed?.redo], ["done", null, "summary"]);
    assert.match(failed?.error ?? "", /The answers AI returned HTTP 500/);
    const sermon = await site.app.request(`/episodes/${id}`, { cookie: site.cookie });
    assert.equal(sermon.status, 200, "still up, with its earlier summary");
    assert.match(await sermon.text(), /Re-processing failed: The answers AI returned HTTP 500/);
    const dashboard = await (await site.app.request("/admin/episodes", { cookie: site.cookie })).text();
    assert.match(dashboard, /<strong>Re-processing failed<\/strong>[\s\S]*?The sermon still shows its earlier version\.[\s\S]*?<button class="quiet" type="submit">Retry<\/button>/);
    assert.match(dashboard, /Retry all 1 failed/);
    assert.match(dashboard, /<option value="reprocessing">Re-processing \(1\)<\/option>/);

    const started = site.app.workflow.created.length;
    await site.app.request("/admin/episodes/queue", { form: { id }, cookie: site.cookie });
    assert.equal(site.app.workflow.created.length, started + 1);
    await runEpisode(site.app.env, inlineStep, id);
    assert.deepEqual({ ...await episode(site.app, id) }, { status: "done", stage: null, redo: null, error: null });
  } finally {
    globalThis.fetch = working;
    site.restore();
  }
});

test("re-processing goes ahead of the queue, waits while one is running, and is for admins only", async () => {
  const site = await indexedSite();
  try {
    const [id, other] = site.ids as [string, string];
    // Two new episodes are waiting; the re-process still starts first.
    await recordFeed(site.app.env.DB, feedOf(2));
    await site.app.env.DB.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('processing', '{\"concurrency\":1}', '2026-01-01')").run();
    const started = site.app.workflow.created.length;
    await site.app.request(`/episodes/${id}/reprocess`, { form: { from: "index" }, cookie: site.cookie });
    assert.deepEqual(site.app.workflow.created.slice(started).map((run) => run.params.episodeId), [id]);

    const busy = await site.app.request(`/episodes/${id}/reprocess`, { form: { from: "transcribe" }, cookie: site.cookie });
    assert.match(decodeURIComponent(busy.headers.get("Location") ?? ""), /can't be re-processed right now/);
    assert.equal((await episode(site.app, id))?.redo, "index", "a running re-process isn't changed");
    assert.match(await (await site.app.request(`/episodes/${id}`, { cookie: site.cookie })).text(), /Re-processing now: Starting\./);

    const body = await (await site.app.request("/admin/members", { form: { name: "Sam", email: "sam@example.org" }, cookie: site.cookie })).text();
    const token = /invite\?token=([A-Za-z0-9_-]+)/u.exec(body)![1]!;
    const member = cookieFrom(await site.app.request("/invite", { form: { token, password: "a long enough password", confirm: "a long enough password" } }));
    assert.equal((await site.app.request(`/episodes/${other}/reprocess`, { form: { from: "index" }, cookie: member })).status, 403);
    assert.doesNotMatch(await (await site.app.request(`/episodes/${other}`, { cookie: member })).text(), /Re-process/);
    assert.equal((await episode(site.app, other))?.redo, null);
  } finally {
    site.restore();
  }
});

test("re-processing isn't offered for episodes that never finished", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    const cookie = await completeSetup(app, { count: 1 });
    const { id } = (await app.env.DB.prepare("SELECT id FROM episodes WHERE status = 'running'").first<{ id: string }>())!;
    const response = await app.request(`/episodes/${id}/reprocess`, { form: { from: "summary" }, cookie });
    assert.match(decodeURIComponent(response.headers.get("Location") ?? ""), /can't be re-processed right now/);
    assert.equal((await episode(app, id))?.redo, null);
  } finally {
    providers.restore();
  }
});

test("re-transcribing with Muse sends the audio to Muse again, part by part", async () => {
  const app = createApp();
  const providers = fakeProviders();
  const faked = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith("https://cdn.example.org/")
    ? new Response(TONES_MP3, { headers: { "Content-Type": "audio/mpeg", "Content-Length": String(TONES_MP3.byteLength) } })
    : faked(input, init)) as typeof fetch;
  const parts = { partSeconds: 4, minPartSeconds: 1, searchSeconds: 2 };
  const muse = () => providers.calls.filter((call) => call.url === "https://api.meta.ai/v1/asr/transcribe").length;
  try {
    const cookie = await completeSetup(app, { count: 1 });
    await app.request("/admin/transcription", { form: PROVIDERS.muse, cookie });
    const { id } = (await app.env.DB.prepare("SELECT id FROM episodes").first<{ id: string }>())!;
    await runEpisode(app.env, inlineStep, id, parts);
    assert.equal((await episode(app, id))?.status, "done");
    await app.env.DB.prepare("UPDATE transcripts_draft SET text = 'Old draft.' WHERE episode_id = ?").bind(id).run();

    const before = muse();
    await app.request(`/episodes/${id}/reprocess`, { form: { from: "transcribe" }, cookie });
    await runEpisode(app.env, inlineStep, id, parts);
    assert.equal(muse() - before, 2, "both parts are sent again");
    const draft = await app.env.DB.prepare("SELECT text, model FROM transcripts_draft WHERE episode_id = ?").bind(id).first<{ text: string; model: string }>();
    assert.deepEqual([draft?.text, draft?.model], ["First half. Second half. First half. Second half.", "muse-voice-transcribe-1.0"]);
    assert.deepEqual({ ...await episode(app, id) }, { status: "done", stage: null, redo: null, error: null });
  } finally {
    providers.restore();
  }
});

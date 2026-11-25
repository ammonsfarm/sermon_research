import assert from "node:assert/strict";
import test from "node:test";

import { dispatchQueued, recordFeed } from "../src/episodes.ts";
import { checkFeed } from "../src/imports.ts";
import { runEpisode } from "../src/pipeline.ts";
import { ensureSchema } from "../src/schema.ts";
import { AudioUpload, looksLikeMp3, MAX_UPLOAD_BYTES, readMultipart } from "../src/upload.ts";
import { ADMIN, AUDIO_BYTES, completeSetup, cookieFrom, createApp, fakeProviders, inlineStep, ORIGIN, PROVIDERS, type TestApp, TONES_MP3 } from "./helpers.ts";

const DETAILS = { title: "The Good Shepherd", date: "2026-03-15", speaker: "pastor jane doe", series: "I Am", scripture: "John 10:1–18", description: "A guest Sunday at the lake." };

/** The upload form as a browser sends it: the details, then the file. */
function uploadBody(details: Record<string, string> = DETAILS, file: Uint8Array | null = TONES_MP3, filename = "sermon.mp3"): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(details)) form.set(name, value);
  if (file) form.set("audio", new File([file], filename, { type: "audio/mpeg" }));
  return form;
}

async function uploads(app: TestApp) {
  const { results } = await app.env.DB.prepare(
    "SELECT id, guid, title, published_at, audio_url, audio_key, audio_bytes, status, attempts, error, speaker, speaker_source, description, main_scripture FROM episodes WHERE guid LIKE 'upload:%' ORDER BY created_at",
  ).all<{ id: string; guid: string; title: string; published_at: string; audio_url: string | null; audio_key: string; audio_bytes: number; status: string; attempts: number; error: string | null; speaker: string | null; speaker_source: string | null; description: string | null; main_scripture: string | null }>();
  return results;
}

test("an admin uploads an MP3 with its details, and it's processed like a podcast episode", async () => {
  const app = createApp();
  const original = globalThis.fetch;
  const providers = fakeProviders();
  const faked = globalThis.fetch;
  let fileUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "https://api.mistral.ai/v1/audio/transcriptions") fileUrl = String((init?.body as FormData).get("file_url"));
    return faked(input, init);
  }) as typeof fetch;
  try {
    const cookie = await completeSetup(app);
    const form = await (await app.request("/admin/episodes/upload", { cookie })).text();
    assert.match(form, /<form method="post" action="\/admin\/episodes\/upload" enctype="multipart\/form-data"/);
    assert.match(form, /<input id="f-audio" name="audio" type="file" accept="\.mp3,audio\/mpeg"/);
    assert.match(form, /<option value="Pastor Jane Doe"><\/option>/, "the ministry's speakers are suggested");
    assert.match(form, /<a href="\/admin\/episodes\/upload" aria-current="page">Upload a sermon<\/a>/, "it's in the admin menu");
    assert.match(await (await app.request("/admin/episodes", { cookie })).text(), /<a href="\/admin\/episodes\/upload">Upload a sermon<\/a>/);

    const uploaded = await app.request("/admin/episodes/upload", { body: uploadBody(), cookie });
    assert.equal(uploaded.status, 303);
    assert.match(decodeURIComponent(uploaded.headers.get("Location") ?? ""), /^\/admin\/episodes\?notice=“The Good Shepherd” was uploaded/u);

    const [row] = await uploads(app);
    assert.deepEqual({ ...row }, {
      id: row!.id, guid: `upload:${row!.id}`, title: "The Good Shepherd - I Am", published_at: "2026-03-15T12:00:00.000Z", audio_url: null,
      audio_key: `episodes/${row!.id}.mp3`, audio_bytes: TONES_MP3.byteLength, status: "running", attempts: 1, error: null,
      speaker: "Jane Doe", speaker_source: "admin", description: "A guest Sunday at the lake.", main_scripture: "John 10:1-18",
    });
    assert.deepEqual(app.audio.get(row!.audio_key), { bytes: TONES_MP3, contentType: "audio/mpeg" }, "the file is stored in R2 byte for byte");
    assert.deepEqual(app.workflow.created.map((run) => run.id), [`${row!.id}-1`], "its workflow run starts straight away");

    const dashboard = await (await app.request("/admin/episodes", { cookie })).text();
    assert.match(dashboard, /The Good Shepherd - I Am<br><span class="hint">2026-03-15 · Jane Doe · Uploaded<\/span>/);
    assert.match(dashboard, /<strong>Working<\/strong> · attempt 1/);

    const before = providers.calls.length;
    await runEpisode(app.env, inlineStep, row!.id);
    const [done] = await uploads(app);
    assert.equal(done!.status, "done");
    assert.deepEqual([done!.speaker, done!.speaker_source], ["Jane Doe", "admin"], "the AI doesn't change the preacher an admin entered");
    const calls = providers.calls.slice(before);
    assert.equal(calls.filter((call) => call.url.startsWith("https://cdn.example.org/")).length, 0, "nothing is downloaded");
    assert.match(fileUrl, new RegExp(`^${ORIGIN}/audio/${row!.id}\\?expires=\\d+&signature=[\\w-]+$`), "Mistral gets a signed link to the stored upload");
    assert.equal((await app.request(fileUrl.slice(ORIGIN.length))).status, 200, "which works without signing in");
    const summary = await app.env.DB.prepare("SELECT summary, main_scripture FROM summaries WHERE episode_id = ?").bind(row!.id).first();
    assert.deepEqual({ ...summary }, { summary: "Grace is a gift.", main_scripture: "John 10:1-18" }, "the admin's passage is kept over the AI's");
    assert.ok(app.vectors.stored.has(`${row!.id}:0`), "it's indexed for search");

    assert.match(await (await app.request("/episodes", { cookie })).text(), /The Good Shepherd/);
    const sermon = await (await app.request(`/episodes/${row!.id}`, { cookie })).text();
    assert.match(sermon, new RegExp(`<audio[^>]* src="/audio/${row!.id}"`), "the player uses the stored copy");
    assert.match(sermon, /Jane Doe/);
    const played = await app.request(`/audio/${row!.id}`, { cookie });
    assert.equal(played.headers.get("Content-Type"), "audio/mpeg");
    assert.deepEqual(new Uint8Array(await played.arrayBuffer()), TONES_MP3);
  } finally {
    providers.restore();
    globalThis.fetch = original;
  }
});

test("only the title, date and file are needed; the AI names the preacher and chooses the passage", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    const cookie = await completeSetup(app);
    assert.equal((await app.request("/admin/episodes/upload", { body: uploadBody({ title: "Untitled Evening", date: "2025-12-24" }, AUDIO_BYTES), cookie })).status, 303);
    const [row] = await uploads(app);
    assert.deepEqual([row!.title, row!.speaker, row!.speaker_source, row!.main_scripture, row!.description], ["Untitled Evening", null, null, null, null]);
    await runEpisode(app.env, inlineStep, row!.id);
    const [done] = await uploads(app);
    assert.equal(done!.status, "done");
    assert.equal(done!.speaker_source, "ai", "the answers AI was asked who preached");
    const summary = await app.env.DB.prepare("SELECT main_scripture FROM summaries WHERE episode_id = ?").bind(row!.id).first<{ main_scripture: string }>();
    assert.equal(summary!.main_scripture, "Ephesians 2:1-10");
  } finally {
    providers.restore();
  }
});

test("the feed check leaves uploaded sermons alone, and an upload before the first import doesn't import the whole feed", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    const cookie = await completeSetup(app);
    await app.request("/admin/episodes/upload", { body: uploadBody(), cookie });
    const [before] = await uploads(app);
    assert.deepEqual(await checkFeed(app.env), { queued: 0 });
    const [after] = await uploads(app);
    assert.deepEqual({ ...after, updated_at: null }, { ...before, updated_at: null });
    const count = await app.env.DB.prepare("SELECT count(*) AS n FROM episodes").first<{ n: number }>();
    assert.equal(count!.n, 3, "two feed episodes and the upload, with no duplicate");
  } finally {
    providers.restore();
  }

  const fresh = createApp();
  await ensureSchema(fresh.env.DB);
  await fresh.env.DB.prepare("INSERT INTO episodes (id, guid, title, status, created_at, updated_at, audio_key) VALUES ('u1', 'upload:u1', 'Early upload', 'done', 'now', 'now', 'episodes/u1.mp3')").run();
  const feed = { title: "Feed", episodes: [1, 2, 3].map((n) => ({ guid: `g-${n}`, title: `Episode ${n}`, publishedAt: `2026-01-0${n}T00:00:00.000Z`, audioUrl: `https://cdn.example.org/${n}.mp3`, durationSeconds: 60, description: null, author: null })) };
  assert.equal(await recordFeed(fresh.env.DB, feed, { backfill: 1 }), 1, "the first import still queues only the chosen number");
});

test("a file that isn't an MP3, a missing file and missing details are turned away, and nothing is kept", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  const m4a = new Uint8Array([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypM4A  and the rest of an AAC file")]);

  const wrongType = await app.request("/admin/episodes/upload", { body: uploadBody(DETAILS, m4a, "sermon.mp3"), cookie });
  assert.equal(wrongType.status, 400);
  const page = await wrongType.text();
  assert.match(page, /That file isn&#39;t an MP3\. Convert it to MP3 and upload it again\./);
  assert.match(page, /name="title" type="text" value="The Good Shepherd"/, "the details are kept");
  assert.match(page, /Choose the file again/);

  const noFile = await app.request("/admin/episodes/upload", { body: uploadBody(DETAILS, null), cookie });
  assert.match(await noFile.text(), /Choose the sermon&#39;s MP3 file\./);
  const emptyFile = await app.request("/admin/episodes/upload", { body: uploadBody(DETAILS, new Uint8Array()), cookie });
  assert.match(await emptyFile.text(), /Choose the sermon&#39;s MP3 file\./);

  const noDetails = await app.request("/admin/episodes/upload", { body: uploadBody({ title: " ", date: "15/03/2026" }), cookie });
  assert.equal(noDetails.status, 400);
  const errors = await noDetails.text();
  assert.match(errors, /Enter the sermon&#39;s title\./);
  assert.match(errors, /Enter the date as year, month and day/);
  assert.match(await (await app.request("/admin/episodes/upload", { body: uploadBody({ ...DETAILS, date: "2999-01-01" }), cookie })).text(), /That date is in the future\./);

  const tooLarge = await app.request("/admin/episodes/upload", { body: uploadBody(), cookie, headers: { "Content-Length": String(MAX_UPLOAD_BYTES + 2 * 1024 * 1024) } });
  assert.equal(tooLarge.status, 413);
  assert.match(await tooLarge.text(), /That file is over 100 MB/);

  assert.equal((await app.request("/admin/episodes/upload", { form: { title: "Not an upload" }, cookie })).status, 400, "a form without a file part");
  assert.deepEqual(await uploads(app), []);
  assert.equal(app.audio.size, 0, "nothing is left in R2");
  assert.equal(app.workflow.created.length, 0);
});

test("only admins can upload, and only from the site's own pages", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  assert.equal((await app.request("/admin/episodes/upload")).headers.get("Location"), "/login");
  assert.equal((await app.request("/admin/episodes/upload", { body: uploadBody() })).headers.get("Location"), "/login");
  assert.equal((await app.request("/admin/episodes/upload", { body: uploadBody(), cookie, headers: { Origin: "https://elsewhere.example" } })).status, 403);

  const invited = await app.request("/admin/members", { form: { name: "Mark Member", email: "mark@example.org" }, cookie });
  const invite = /\/invite\?token=[A-Za-z0-9_-]+/u.exec(await invited.text())?.[0];
  assert.ok(invite, "the invite link is shown");
  const member = cookieFrom(await app.request("/invite", { form: { token: new URL(`https://x${invite}`).searchParams.get("token")!, password: ADMIN.password, confirm: ADMIN.password } }));
  assert.equal((await app.request("/admin/episodes/upload", { body: uploadBody(), cookie: member })).status, 403);
  assert.deepEqual(await uploads(app), []);
  assert.equal(app.audio.size, 0);
});

test("a failed upload shows its error and can be retried, and Muse transcribes it from the stored MP3", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    const cookie = await completeSetup(app);
    assert.equal((await app.request("/admin/transcription", { form: PROVIDERS.muse, cookie })).headers.get("Location"), "/admin?saved=1");
    await app.request("/admin/episodes/upload", { body: uploadBody(), cookie });
    const [row] = await uploads(app);

    // The stored copy goes missing: there's no feed link to fetch it from again.
    const stored = app.audio.get(row!.audio_key)!;
    app.audio.delete(row!.audio_key);
    await runEpisode(app.env, inlineStep, row!.id);
    const [failed] = await uploads(app);
    assert.equal(failed!.status, "failed");
    assert.match(failed!.error ?? "", /uploaded audio is missing from storage\. Upload it again/);

    app.audio.set(row!.audio_key, stored);
    assert.equal((await app.request("/admin/episodes/queue", { form: { id: row!.id }, cookie })).headers.get("Location"), "/admin/episodes");
    assert.equal(app.workflow.created.at(-1)?.id, `${row!.id}-2`);
    await runEpisode(app.env, inlineStep, row!.id, { partSeconds: 4, minPartSeconds: 1, searchSeconds: 2 });
    const [done] = await uploads(app);
    assert.deepEqual([done!.status, done!.error], ["done", null]);
    assert.ok(providers.calls.filter((call) => call.url === "https://api.meta.ai/v1/asr/transcribe").length >= 2, "Muse got the upload in parts");
    const draft = await app.env.DB.prepare("SELECT model FROM transcripts_draft WHERE episode_id = ?").bind(row!.id).first<{ model: string }>();
    assert.equal(draft!.model, "muse-voice-transcribe-1.0");
  } finally {
    providers.restore();
  }
});

test("uploads take their place in the queue under the episodes-at-once setting", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  for (const title of ["One", "Two", "Three"]) await app.request("/admin/episodes/upload", { body: uploadBody({ title, date: "2026-02-01" }, AUDIO_BYTES), cookie });
  assert.deepEqual((await uploads(app)).map((row) => row.status), ["running", "running", "queued"]);
  await app.env.DB.prepare("UPDATE episodes SET status = 'done', stage = NULL WHERE status = 'running'").run();
  assert.equal(await dispatchQueued(app.env), 1);
});

/** A stream that hands the bytes over a few at a time, so boundaries fall across chunks. */
function trickle(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) controller.close();
      else controller.enqueue(bytes.slice(at, at += size));
    },
  });
}

test("a form is read as it arrives, whatever sizes its pieces come in", async () => {
  // Bytes that look like the start of a boundary, to check they stay in the file.
  const file = new Uint8Array([...TONES_MP3.slice(0, 5000), 13, 10, 45, 45, 13, 10, 45, 45, 88, ...TONES_MP3.slice(5000, 9000)]);
  const request = new Request("https://x.example/", { method: "POST", body: uploadBody({ title: "Ünïcode “title”", notes: "" }, file) });
  const boundary = /boundary=(.+)$/u.exec(request.headers.get("Content-Type")!)![1]!;
  const body = new Uint8Array(await request.arrayBuffer());
  for (const size of [1, 7, 64, 4096, body.length]) {
    const fields = new Map<string, string>();
    const chunks: Uint8Array[] = [];
    await readMultipart(trickle(body, size), boundary, ({ name, filename }) => {
      if (filename !== null) return (chunk) => { chunks.push(chunk.slice()); };
      fields.set(name, "");
      const decoder = new TextDecoder();
      return (chunk) => { fields.set(name, fields.get(name)! + decoder.decode(chunk, { stream: true })); };
    });
    assert.deepEqual([...fields], [["title", "Ünïcode “title”"], ["notes", ""]], `fields, ${size} bytes at a time`);
    assert.deepEqual(new Uint8Array(await new Blob(chunks).arrayBuffer()), file, `file, ${size} bytes at a time`);
  }
  await assert.rejects(readMultipart(trickle(body.slice(0, body.length - 40), 512), boundary, () => () => undefined), /ended early/, "a cut-off upload is an error");
});

test("a large file goes to R2 a part at a time, and one over the limit or not an MP3 leaves nothing behind", async () => {
  const app = createApp();
  const big = new AudioUpload(app.env.AUDIO, "episodes/big.mp3", { partBytes: 4096 });
  for (let at = 0; at < TONES_MP3.length; at += 1000) await big.write(TONES_MP3.subarray(at, at + 1000));
  assert.equal(await big.finish(), true);
  assert.ok(TONES_MP3.length > 3 * 4096, "the fixture spans several parts");
  assert.deepEqual(app.audio.get("episodes/big.mp3"), { bytes: TONES_MP3, contentType: "audio/mpeg" });
  await big.discard();
  assert.equal(app.audio.size, 0, "a stored upload can be removed when the sermon can't be saved");

  const over = new AudioUpload(app.env.AUDIO, "episodes/over.mp3", { partBytes: 4096, maxBytes: 10_000 });
  await over.write(TONES_MP3.subarray(0, 9000));
  await over.write(TONES_MP3.subarray(9000, 12_000));
  assert.equal(over.problem, "too_large");
  assert.equal(await over.finish(), false);

  const text = new AudioUpload(app.env.AUDIO, "episodes/text.mp3", { partBytes: 4096 });
  await text.write(new TextEncoder().encode("<!doctype html>".repeat(1000)));
  assert.equal(await text.finish(), false);
  assert.equal(text.problem, "not_mp3");
  assert.equal(app.audio.size, 0);

  assert.equal(looksLikeMp3(TONES_MP3), true);
  assert.equal(looksLikeMp3(new Uint8Array([0, 0, 0xff, 0xfb, 0x90, 0x00])), true, "a frame after padding");
  assert.equal(looksLikeMp3(new Uint8Array([0xff, 0xf1, 0x50, 0x80])), false, "AAC frames aren't MP3");
  assert.equal(looksLikeMp3(new TextEncoder().encode("RIFF....WAVEfmt ")), false);
});

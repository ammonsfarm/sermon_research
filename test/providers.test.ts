import assert from "node:assert/strict";
import test from "node:test";

import { getKey } from "../src/keys.ts";
import { isMetaApi, MuseTranscribeError, museTranscribe, providerMessage, reasoningFields, sendEmail } from "../src/providers.ts";
import { getSetting, type LlmSettingsRecord, type TranscriptionSettings } from "../src/settings.ts";
import { ADMIN, completeSetup, cookieFrom, createApp, fakeProviders, FEED_URL, MINISTRY, type MuseUpload, PROVIDERS, SECRET } from "./helpers.ts";

async function atStep(step: string) {
  const app = createApp();
  const cookie = cookieFrom(await app.request("/setup", { form: ADMIN }));
  await app.request("/setup/ministry", { form: MINISTRY, cookie });
  const order = ["podcast", "llm", "embeddings", "transcription", "email"];
  const forms: Record<string, Record<string, string>> = {
    podcast: { intent: "save", feedUrl: FEED_URL }, llm: PROVIDERS.llm, embeddings: PROVIDERS.embeddings, transcription: PROVIDERS.transcription,
  };
  const providers = fakeProviders();
  for (const earlier of order.slice(0, order.indexOf(step))) await app.request(`/setup/${earlier}`, { form: forms[earlier]!, cookie });
  providers.restore();
  return { app, cookie };
}

test("the podcast step previews the feed before saving it", async () => {
  const { app, cookie } = await atStep("podcast");
  const providers = fakeProviders();
  try {
    const preview = await app.request("/setup/podcast", { form: { intent: "check", feedUrl: FEED_URL }, cookie });
    const body = await preview.text();
    assert.equal(preview.status, 200);
    assert.match(body, /Grace Church Sermons/);
    assert.match(body, /Faith &amp; Works \(2026-09-14\)/);
    assert.equal((await app.request("/admin", { cookie })).headers.get("Location"), "/setup/podcast", "a preview saves nothing");

    const bad = await app.request("/setup/podcast", { form: { intent: "check", feedUrl: "https://feeds.example.org/missing.rss" }, cookie });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /The feed returned HTTP 404/);
  } finally {
    providers.restore();
  }
});

test("the answers AI step sends a real test request and stores the key encrypted", async () => {
  const { app, cookie } = await atStep("llm");
  const providers = fakeProviders();
  try {
    const saved = await app.request("/setup/llm", { form: { ...PROVIDERS.llm, baseUrl: "https://gateway.example/v1/" }, cookie });
    assert.equal(saved.headers.get("Location"), "/setup/embeddings");
    const call = providers.calls.at(-1)!;
    assert.equal(call.url, "https://gateway.example/v1/chat/completions");
    assert.equal(call.authorization, "Bearer sk-llm-key-1234");
    assert.equal((call.body as { model: string }).model, "gpt-test");
    assert.equal("reasoning_effort" in (call.body as object), false, "other providers get no reasoning field");
    const llm = await getSetting<LlmSettingsRecord>(app.env.DB, "llm");
    assert.deepEqual([llm?.summaryEffort, llm?.chatEffort], ["low", "low"], "a missing choice means low");
    const row = await app.env.DB.prepare("SELECT ciphertext, last4 FROM provider_keys WHERE slot = 'llm'").first<{ ciphertext: string; last4: string }>();
    assert.equal(row?.last4, "1234");
    assert.doesNotMatch(row?.ciphertext ?? "", /sk-llm/u);
    assert.equal(await getKey(app.env.DB, SECRET, "llm"), "sk-llm-key-1234");
  } finally {
    providers.restore();
  }
});

test("Meta's API gets reasoning efforts: low for the check, the admin's two choices once saved", async () => {
  const { app, cookie } = await atStep("llm");
  const providers = fakeProviders();
  const muse = { ...PROVIDERS.llm, baseUrl: "https://api.meta.ai/v1", model: "muse-test" };
  const select = (page: string, name: string) => new RegExp(`<select id="f-${name}" name="${name}">.*?</select>`, "su").exec(page)?.[0] ?? "";
  try {
    const invalid = await app.request("/setup/llm", { form: { ...muse, summaryEffort: "high", chatEffort: "extreme" }, cookie });
    assert.equal(invalid.status, 400);
    const page = await invalid.text();
    assert.match(page, /<div class="field invalid"><label for="f-chatEffort">Chat reasoning effort<\/label>[\s\S]*?Choose a reasoning effort from the list/);
    assert.doesNotMatch(page, /<div class="field invalid"><label for="f-summaryEffort">/);
    assert.match(select(page, "summaryEffort"), /<option value="high" selected>/, "the valid choice is kept");
    assert.equal(providers.calls.length, 0, "nothing is sent with an unknown effort");

    const saved = await app.request("/setup/llm", { form: { ...muse, summaryEffort: "high", chatEffort: "minimal" }, cookie });
    assert.equal(saved.headers.get("Location"), "/setup/embeddings");
    const call = providers.calls.at(-1)!;
    assert.equal(call.url, "https://api.meta.ai/v1/chat/completions");
    assert.equal((call.body as { reasoning_effort?: string }).reasoning_effort, "low", "the 16-token check doesn't need more");
    const llm = await getSetting<LlmSettingsRecord>(app.env.DB, "llm");
    assert.deepEqual([llm?.summaryEffort, llm?.chatEffort], ["high", "minimal"]);
    const form = await (await app.request("/setup/llm", { cookie })).text();
    assert.match(select(form, "summaryEffort"), /<option value="low">Low \(default\)<\/option>.*<option value="high" selected>High<\/option>/su);
    assert.match(select(form, "chatEffort"), /<option value="minimal" selected>Minimal<\/option>/);
    assert.match(form, /<label for="f-summaryEffort">Summary reasoning effort<\/label>\n<p class="hint">For each new sermon: the full-text review of its transcript \(spelling of names and places, capital letters, stray periods\), its summary/);
  } finally {
    providers.restore();
  }
});

test("a rejected key or bad address is explained and nothing is saved", async () => {
  const { app, cookie } = await atStep("llm");
  const providers = fakeProviders({ "https://api.openai.com/v1/chat": 401 });
  try {
    const rejected = await app.request("/setup/llm", { form: PROVIDERS.llm, cookie });
    assert.equal(rejected.status, 400);
    const body = await rejected.text();
    assert.match(body, /refused the request \(HTTP 401\)\. It said: &quot;nope&quot;/);
    assert.doesNotMatch(body, /sk-llm-key-1234/, "the key is never echoed back");
    const insecure = await app.request("/setup/llm", { form: { ...PROVIDERS.llm, baseUrl: "http://gateway.example/v1" }, cookie });
    assert.match(await insecure.text(), /Use an https:\/\/ address/);
    assert.equal(await app.env.DB.prepare("SELECT count(*) AS n FROM provider_keys").first<{ n: number }>().then((row) => row?.n), 0);
  } finally {
    providers.restore();
  }
});

test("embeddings reuse the OpenAI answers key when left blank", async () => {
  const { app, cookie } = await atStep("embeddings");
  const providers = fakeProviders();
  try {
    const page = await (await app.request("/setup/embeddings", { cookie })).text();
    assert.match(page, /reuse the key from the Answers AI step/);
    const saved = await app.request("/setup/embeddings", { form: { apiKey: "" }, cookie });
    assert.equal(saved.headers.get("Location"), "/setup/transcription");
    assert.equal(providers.calls.at(-1)?.authorization, "Bearer sk-llm-key-1234");
    assert.equal((providers.calls.at(-1)?.body as { model: string }).model, "text-embedding-3-small");
  } finally {
    providers.restore();
  }
});

test("transcription is Mistral unless the admin picks Muse, which is checked with a second of silence", async () => {
  const { app, cookie } = await atStep("transcription");
  const providers = fakeProviders();
  try {
    const form = await (await app.request("/setup/transcription", { cookie })).text();
    assert.match(form, /<input type="radio" name="provider" value="mistral" checked><span><strong>Mistral<\/strong>/);
    assert.match(form, /<input type="radio" name="provider" value="muse"><span><strong>Muse<\/strong><br><span class="hint">Meta&#39;s muse-voice-transcribe-1\.0\. Muse only accepts WAV, so this site converts your feed&#39;s MP3s to WAV/);

    const unknown = await app.request("/setup/transcription", { form: { provider: "whisper", apiKey: "k" }, cookie });
    assert.equal(unknown.status, 400);
    assert.match(await unknown.text(), /Choose Mistral or Muse\./);
    assert.equal(providers.calls.length, 0, "nothing is sent for an unknown service");

    const refused = fakeProviders({ "https://api.meta.ai/v1/asr/transcribe": 401 });
    try {
      const rejected = await app.request("/setup/transcription", { form: PROVIDERS.muse, cookie });
      assert.equal(rejected.status, 400);
      const page = await rejected.text();
      assert.match(page, /Muse refused the transcription key \(HTTP 401\)\. Check it in Admin → Transcription\. It said: &quot;nope&quot;/);
      assert.match(page, /value="muse" checked/, "the choice is kept");
    } finally {
      refused.restore();
    }

    const saved = await app.request("/setup/transcription", { form: PROVIDERS.muse, cookie });
    assert.equal(saved.headers.get("Location"), "/setup/email");
    const check = providers.calls.at(-1)!;
    assert.equal(check.url, "https://api.meta.ai/v1/asr/transcribe");
    assert.equal(check.authorization, "Bearer muse-key-4321");
    const upload = check.body as MuseUpload;
    assert.deepEqual([upload.wav.rate, upload.wav.channels, upload.wav.samples.length, upload.wav.samples.every((sample) => sample === 0)], [16_000, 1, 16_000, true]);
    const setting = await getSetting<TranscriptionSettings>(app.env.DB, "transcription");
    assert.deepEqual([setting?.provider, setting?.model], ["muse", "muse-voice-transcribe-1.0"]);
    assert.match(await (await app.request("/setup/transcription", { cookie })).text(), /value="muse" checked/);

    // Mistral is still the default, checked as before.
    await app.request("/setup/transcription", { form: PROVIDERS.transcription, cookie });
    assert.equal(providers.calls.at(-1)?.url, "https://api.mistral.ai/v1/models");
    const mistral = await getSetting<TranscriptionSettings>(app.env.DB, "transcription");
    assert.deepEqual([mistral?.provider, mistral?.model], ["mistral", "voxtral-mini-latest"]);
  } finally {
    providers.restore();
  }
});

test("the admin overview names the transcription service", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  assert.match(await (await app.request("/admin", { cookie })).text(), /<dd>Mistral voxtral-mini-latest · key ending 5678<\/dd>/);
  const providers = fakeProviders();
  try {
    await app.request("/admin/transcription", { form: PROVIDERS.muse, cookie });
  } finally {
    providers.restore();
  }
  assert.match(await (await app.request("/admin", { cookie })).text(), /<dd>Muse muse-voice-transcribe-1\.0 · key ending 4321<\/dd>/);
  await app.env.DB.prepare("UPDATE settings SET value_json = json_remove(value_json, '$.provider') WHERE key = 'transcription'").run();
  assert.match(await (await app.request("/admin", { cookie })).text(), /<dd>Mistral muse-voice-transcribe-1\.0/, "a setting saved before Muse was offered reads as Mistral");
});

test("Muse's documented errors are explained, with Muse's own message", async () => {
  const replying = (status: number) => (async () => Response.json({ type: "invalid_request", code: "x", param: null, message: `Reason ${status}` }, { status })) as typeof fetch;
  const wav = new Uint8Array(44);
  const cases: [number, RegExp][] = [
    [400, /^Muse couldn't use the audio \(HTTP 400\)\. Each part must be mono 16-bit WAV, at most 10 minutes long\. It said: "Reason 400"$/u],
    [401, /^Muse refused the transcription key \(HTTP 401\)\./u],
    [413, /^Muse says the audio part is over its 32 MB limit \(HTTP 413\)\. It said: "Reason 413"$/u],
    [429, /^Muse says the account is at its limit for transcriptions running at once or per hour \(HTTP 429\)\./u],
    [500, /^Muse transcription returned HTTP 500\. It said: "Reason 500"$/u],
    [504, /^Muse timed out transcribing this part \(HTTP 504\)\. It said: "Reason 504"$/u],
  ];
  for (const [status, message] of cases) {
    const error = await museTranscribe(wav, "k", replying(status)).then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof MuseTranscribeError, `HTTP ${status}`);
    assert.equal(error.status, status);
    assert.match(error.message, message);
  }
  await assert.rejects(museTranscribe(wav, "k", (async () => { throw new TypeError("network"); }) as typeof fetch), /^Error: Muse transcription didn't respond/u);
});

test("steps can't be skipped ahead in the wizard", async () => {
  const { app, cookie } = await atStep("llm");
  assert.equal((await app.request("/setup/transcription", { cookie })).headers.get("Location"), "/setup/llm");
  assert.equal((await app.request("/setup/transcription", { form: PROVIDERS.transcription, cookie })).headers.get("Location"), "/setup/llm");
  assert.equal((await app.request("/admin/llm", { cookie })).headers.get("Location"), "/setup/llm");
});

test("after setup, admins edit a connection and blank keys keep the saved one", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  const page = await (await app.request("/admin/transcription", { cookie })).text();
  assert.match(page, /A key ending in 5678 is saved/);
  const providers = fakeProviders();
  try {
    const saved = await app.request("/admin/transcription", { form: { apiKey: "" }, cookie });
    assert.equal(saved.headers.get("Location"), "/admin?saved=1");
    assert.equal(providers.calls.at(-1)?.authorization, "Bearer mistral-key-5678");
  } finally {
    providers.restore();
  }
  assert.equal((await app.request("/setup/llm", { cookie })).headers.get("Location"), "/admin/llm");
});

test("members can't reach the setup or admin steps", async () => {
  const app = createApp();
  await completeSetup(app);
  const member = await app.env.DB.prepare("INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ('m1', 'm@example.org', 'M', 'member', '2026-01-01', '2026-01-01')").run();
  assert.equal(member.meta.changes, 1);
  const { createSession } = await import("../src/auth.ts");
  const cookie = `__Host-sr_session=${await createSession(app.env.DB, "m1")}`;
  assert.equal((await app.request("/admin/llm", { cookie })).status, 403);
  assert.equal((await app.request("/admin/llm", { form: PROVIDERS.llm, cookie })).status, 403);
});

test("provider errors pass on the provider's own message, such as an unverified Resend domain", async () => {
  const resend = (async () => Response.json(
    { statusCode: 403, name: "validation_error", message: "The sermons.example.org domain is not verified. Please, add and verify your domain." },
    { status: 403 },
  )) as typeof fetch;
  await assert.rejects(
    sendEmail({ apiKey: "re_x", from: "a@sermons.example.org", to: "b@example.org", subject: "s", text: "t" }, resend),
    /Resend refused the request \(HTTP 403\)\. It said: "The sermons\.example\.org domain is not verified/,
  );
  assert.equal(providerMessage("{\"error\":{\"message\":\"Incorrect API key\",\"type\":\"x\"}}"), "Incorrect API key");
  assert.equal(providerMessage("<html><body>Not found</body></html>"), "");
  assert.equal(providerMessage("plain  text\nerror"), "plain text error");
  assert.equal(providerMessage(""), "");
});

test("every provider call identifies itself, and a password in the Resend key field is caught", async () => {
  const { app, cookie } = await atStep("email");
  const providers = fakeProviders();
  try {
    const autofilled = await app.request("/setup/email", { form: { ...PROVIDERS.email, apiKey: "correct horse battery" }, cookie });
    assert.equal(autofilled.status, 400);
    assert.match(await autofilled.text(), /Resend keys start with re_/);
    assert.equal(providers.calls.filter((call) => call.url.includes("resend")).length, 0, "nothing is sent with a non-Resend key");

    const saved = await app.request("/setup/email", { form: PROVIDERS.email, cookie });
    assert.equal(saved.headers.get("Location"), "/setup/import");
    const resend = providers.calls.find((call) => call.url === "https://api.resend.com/emails");
    assert.match(resend?.userAgent ?? "", /^sermon-research\//);
  } finally {
    providers.restore();
  }
});

test("only Meta's API addresses get a reasoning field", () => {
  assert.equal(isMetaApi("https://api.meta.ai/v1"), true);
  assert.equal(isMetaApi("https://eu.api.meta.ai/v1"), true);
  assert.equal(isMetaApi("https://api.openai.com/v1"), false);
  assert.equal(isMetaApi("https://gateway.example/api.meta.ai/v1"), false, "a path mentioning it isn't Meta's API");
  assert.equal(isMetaApi("not a url"), false);
  assert.deepEqual(reasoningFields("https://api.meta.ai/v1"), { reasoning_effort: "low" });
  assert.deepEqual(reasoningFields("https://api.meta.ai/v1", "xhigh"), { reasoning_effort: "xhigh" });
  assert.deepEqual(reasoningFields("https://generativelanguage.googleapis.com/v1beta/openai", "high"), {});
});

import assert from "node:assert/strict";
import test from "node:test";

import { getKey } from "../src/keys.ts";
import { getDefaults, listModels } from "../src/llm.ts";
import { MuseTranscribeError, museTranscribe, providerMessage, sendEmail, serverBaseUrl, ServerTranscribeError, serverTranscribe } from "../src/providers.ts";
import { getSetting, type TranscriptionSettings } from "../src/settings.ts";
import { ADMIN, completeSetup, cookieFrom, createApp, fakeProviders, FEED_URL, MINISTRY, type MuseUpload, PROVIDERS, SECRET, SERVER_URL, type ServerUpload } from "./helpers.ts";

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

test("the answers AI step tests the model, stores the key encrypted and makes it the choice for every job", async () => {
  const { app, cookie } = await atStep("llm");
  const providers = fakeProviders();
  try {
    const saved = await app.request("/setup/llm", { form: PROVIDERS.llm, cookie });
    assert.equal(saved.headers.get("Location"), "/setup/embeddings");
    const call = providers.calls.find((each) => each.url.endsWith("/chat/completions"))!;
    assert.equal(call.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(call.authorization, "Bearer sk-llm-key-1234");
    assert.equal((call.body as { model: string }).model, "gpt-test");
    assert.equal((call.body as { max_completion_tokens?: number }).max_completion_tokens, 64, "OpenAI takes max_completion_tokens");
    assert.equal("max_tokens" in (call.body as object), false);
    assert.equal("reasoning_effort" in (call.body as object), false, "the check sends no reasoning field");
    const models = await listModels(app.env.DB);
    assert.deepEqual(models.map((model) => [model.providerId, model.modelId, model.enabled]), [["openai", "gpt-test", true]]);
    const choice = { provider: "openai", model: "gpt-test", effort: null };
    assert.deepEqual(await getDefaults(app.env.DB), { summary: choice, chat: choice, document: choice });
    const row = await app.env.DB.prepare("SELECT ciphertext, last4 FROM provider_keys WHERE slot = 'llm:openai'").first<{ ciphertext: string; last4: string }>();
    assert.equal(row?.last4, "1234");
    assert.doesNotMatch(row?.ciphertext ?? "", /sk-llm/u);
    assert.equal(await getKey(app.env.DB, SECRET, "llm:openai"), "sk-llm-key-1234");
  } finally {
    providers.restore();
  }
});

test("the wizard takes Meta's Muse and any other OpenAI-compatible address", async () => {
  const { app, cookie } = await atStep("llm");
  const providers = fakeProviders();
  try {
    const muse = await app.request("/setup/llm", { form: { ...PROVIDERS.llm, provider: "meta", model: "muse-test" }, cookie });
    assert.equal(muse.headers.get("Location"), "/setup/embeddings");
    const [model] = await listModels(app.env.DB, "meta");
    assert.deepEqual(model?.efforts, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.equal((await getDefaults(app.env.DB)).chat?.effort, "low", "Muse starts at low effort");
    assert.equal((providers.calls.find((each) => each.url.endsWith("/chat/completions"))!.body as { reasoning_effort?: string }).reasoning_effort, undefined);

    const gateway = await app.request("/setup/llm", { form: { ...PROVIDERS.llm, provider: "custom", baseUrl: "https://gateway.example/v1/", model: "house-model" }, cookie });
    assert.equal(gateway.headers.get("Location"), "/setup/embeddings");
    assert.equal(providers.calls.findLast((each) => each.url.endsWith("/chat/completions"))!.url, "https://gateway.example/v1/chat/completions");
    assert.deepEqual((await listModels(app.env.DB, "custom")).map((each) => [each.modelId, each.efforts]), [["house-model", []]], "no reasoning field for an unknown gateway");
    const insecure = await app.request("/setup/llm", { form: { ...PROVIDERS.llm, provider: "custom", baseUrl: "http://gateway.example/v1" }, cookie });
    assert.match(await insecure.text(), /Use an https:\/\/ address/);
    const unknown = await app.request("/setup/llm", { form: { ...PROVIDERS.llm, provider: "nope" }, cookie });
    assert.match(await unknown.text(), /Choose a provider from the list/);
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
    assert.match(body, /OpenAI returned HTTP 401 for gpt-test\. It said: &quot;nope&quot;/);
    assert.doesNotMatch(body, /sk-llm-key-1234/, "the key is never echoed back");
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
    assert.match(await unknown.text(), /Choose Mistral, Muse or your own server\./);
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
  const server = fakeProviders();
  try {
    await app.request("/admin/transcription", { form: { ...PROVIDERS.server, apiKey: "server-key-2468" }, cookie });
  } finally {
    server.restore();
  }
  assert.match(await (await app.request("/admin", { cookie })).text(), /<dd>Your server \(Systran\/faster-whisper-large-v3\) · key ending 2468<\/dd>/);
});

test("an admin's own transcription server is checked with a second of silence and never gets Mistral's key", async () => {
  const { app, cookie } = await atStep("transcription");
  const providers = fakeProviders();
  const serverCalls = () => providers.calls.filter((call) => call.url.startsWith(SERVER_URL));
  try {
    const form = await (await app.request("/setup/transcription", { cookie })).text();
    assert.match(form, /<input type="radio" name="provider" value="server"><span><strong>Your own server<\/strong>/);
    assert.match(form, /name="baseUrl" type="url"/);

    const invalid = await app.request("/setup/transcription", { form: { ...PROVIDERS.server, baseUrl: "http://whisper.example.org/v1", model: "" }, cookie });
    assert.equal(invalid.status, 400);
    const page = await invalid.text();
    assert.match(page, /Use an https:\/\/ address\./);
    assert.match(page, /Enter the model name your server expects\./);
    assert.match(page, /value="server" checked/, "the choice is kept");
    assert.match(page, /value="http:\/\/whisper\.example\.org\/v1"/, "and what was typed");
    assert.equal(serverCalls().length, 0);

    // Mistral's key is saved first; switching to a server without a key must not send it.
    await app.request("/setup/transcription", { form: PROVIDERS.transcription, cookie });
    const saved = await app.request("/setup/transcription", { form: { ...PROVIDERS.server, baseUrl: `${SERVER_URL}/audio/transcriptions/` }, cookie });
    assert.equal(saved.headers.get("Location"), "/setup/email");
    const check = serverCalls().at(-1)!;
    assert.equal(check.url, `${SERVER_URL}/audio/transcriptions`, "a pasted endpoint is trimmed to the base address");
    assert.equal(check.method, "POST");
    assert.equal(check.authorization, null, "no key, and never the Mistral one");
    const upload = check.body as ServerUpload;
    assert.deepEqual(upload.fields, { model: "Systran/faster-whisper-large-v3", response_format: "verbose_json", "timestamp_granularities[]": "segment" });
    assert.deepEqual([upload.file.name, upload.file.type, upload.file.bytes.byteLength], ["check.wav", "audio/wav", 44 + 32_000], "one second of 16 kHz mono silence");
    assert.ok(upload.streamed);
    const setting = await getSetting<TranscriptionSettings>(app.env.DB, "transcription");
    assert.deepEqual([setting?.provider, setting?.model, setting?.baseUrl], ["server", "Systran/faster-whisper-large-v3", SERVER_URL]);
    assert.equal(await getKey(app.env.DB, SECRET, "transcription"), "mistral-key-5678", "Mistral's key stays for switching back");
    assert.equal(await getKey(app.env.DB, SECRET, "transcription:server"), null);
    const reopened = await (await app.request("/setup/transcription", { cookie })).text();
    assert.match(reopened, /value="server" checked/);
    assert.match(reopened, new RegExp(`name="baseUrl" type="url" value="${SERVER_URL}"`));

    // A key is kept in the server's own slot, reused when left blank, and can be removed.
    await app.request("/setup/transcription", { form: { ...PROVIDERS.server, apiKey: "server-key-2468" }, cookie });
    assert.equal(serverCalls().at(-1)!.authorization, "Bearer server-key-2468");
    assert.equal(await getKey(app.env.DB, SECRET, "transcription:server"), "server-key-2468");
    await app.request("/setup/transcription", { form: PROVIDERS.server, cookie });
    assert.equal(serverCalls().at(-1)!.authorization, "Bearer server-key-2468");
    await app.request("/setup/transcription", { form: { ...PROVIDERS.server, noKey: "1" }, cookie });
    assert.equal(serverCalls().at(-1)!.authorization, null);
    assert.equal(await getKey(app.env.DB, SECRET, "transcription:server"), null);
  } finally {
    providers.restore();
  }

  const down = fakeProviders({ [SERVER_URL]: 404 });
  try {
    const refused = await app.request("/setup/transcription", { form: PROVIDERS.server, cookie });
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /Your transcription server has nothing at https:\/\/whisper\.example\.org\/v1\/audio\/transcriptions \(HTTP 404\)/);
  } finally {
    down.restore();
  }
});

test("a transcription server's failures are explained, and its segments are read from verbose_json", async () => {
  assert.equal(serverBaseUrl(" https://a.example/v1/ "), "https://a.example/v1");
  assert.equal(serverBaseUrl("https://a.example/v1/audio/transcriptions"), "https://a.example/v1");
  assert.equal(serverBaseUrl("http://a.example/v1"), null);
  const server = { baseUrl: SERVER_URL, model: "whisper-1", apiKey: null };
  const audio = new Uint8Array([1, 2, 3]);
  const upload = { body: audio, bytes: audio.byteLength, filename: "a.mp3", contentType: "audio/mpeg" };
  const replying = (status: number, body: unknown = { error: { message: `Reason ${status}` } }) => (async () => Response.json(body, { status })) as typeof fetch;
  const cases: [number, RegExp][] = [
    [401, /^Your transcription server refused the request \(HTTP 401\)\. Check the key in Admin → Transcription\. It said: "Reason 401"$/u],
    [413, /too large \(HTTP 413\)/u],
    [524, /^Cloudflare stopped waiting for your transcription server \(HTTP 524\)\. A Cloudflare proxy or Tunnel .* waits only 100 seconds/u],
    [530, /couldn't be reached \(HTTP 530\)/u],
    [500, /^Your transcription server returned HTTP 500\. It said: "Reason 500"$/u],
  ];
  for (const [status, message] of cases) {
    const error = await serverTranscribe(server, upload, replying(status)).then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof ServerTranscribeError, `HTTP ${status}`);
    assert.match(error.message, message);
  }
  await assert.rejects(serverTranscribe(server, upload, (async () => { throw new TypeError("network"); }) as typeof fetch), /didn't respond\. Check that it's running and reachable from the internet over https\./u);
  await assert.rejects(serverTranscribe(server, upload, (async () => new Response("<html>")) as typeof fetch), /replied, but not with JSON/u);

  const verbose = { text: "a b", segments: [{ id: 0, start: 0, end: 1.5, text: " a " }, { id: 1, start: 1.5, end: 2, text: "  " }, { id: 2, start: 2, end: 3, text: "b" }] };
  assert.deepEqual(await serverTranscribe(server, upload, replying(200, verbose)), [{ text: "a", start: 0, end: 1.5 }, { text: "b", start: 2, end: 3 }], "empty segments are dropped");
  assert.deepEqual(await serverTranscribe(server, upload, replying(200, { text: " Just text. " })), [{ text: "Just text.", start: 0, end: 0 }], "a server that ignores verbose_json still gives the text");
  assert.deepEqual(await serverTranscribe(server, upload, replying(200, { text: "" })), []);
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

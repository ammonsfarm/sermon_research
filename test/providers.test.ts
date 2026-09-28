import assert from "node:assert/strict";
import test from "node:test";

import { getKey } from "../src/keys.ts";
import { providerMessage, sendEmail } from "../src/providers.ts";
import { ADMIN, completeSetup, cookieFrom, createApp, fakeProviders, FEED_URL, MINISTRY, PROVIDERS, SECRET } from "./helpers.ts";

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
    const row = await app.env.DB.prepare("SELECT ciphertext, last4 FROM provider_keys WHERE slot = 'llm'").first<{ ciphertext: string; last4: string }>();
    assert.equal(row?.last4, "1234");
    assert.doesNotMatch(row?.ciphertext ?? "", /sk-llm/u);
    assert.equal(await getKey(app.env.DB, SECRET, "llm"), "sk-llm-key-1234");
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

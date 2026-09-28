import assert from "node:assert/strict";
import test from "node:test";

import { completeSetup, cookieFrom, createApp, fakeProviders } from "./helpers.ts";

function linkFrom(body: unknown): string {
  const text = (body as { text: string }).text;
  const match = /https:\/\/sermons\.example\.org(\/login\/link\?token=[\w-]+)/u.exec(text);
  assert.ok(match, text);
  return match[1]!;
}

test("with email off, the sign-in page offers passwords only and link requests do nothing", async () => {
  const app = createApp();
  await completeSetup(app);
  assert.doesNotMatch(await (await app.request("/login")).text(), /Email me a link/);
  const providers = fakeProviders();
  try {
    const response = await app.request("/login/link", { form: { email: "jane@example.org" } });
    assert.match(await response.text(), /Check your email/);
    assert.equal(providers.calls.length, 0);
  } finally {
    providers.restore();
  }
});

test("a sign-in link works once, after a button press, and gives a 30-day session", async () => {
  const app = createApp();
  await completeSetup(app, { email: true });
  assert.match(await (await app.request("/login")).text(), /Email me a link/);
  const providers = fakeProviders();
  try {
    await app.request("/login/link", { form: { email: "JANE@example.org" } });
    const sent = providers.calls.at(-1)!;
    assert.equal(sent.url, "https://api.resend.com/emails");
    assert.deepEqual((sent.body as { to: string[] }).to, ["jane@example.org"]);
    assert.equal((sent.body as { from: string }).from, "Grace Church <sermons@grace.example>");
    const path = linkFrom(sent.body);

    const visit = await app.request(path);
    assert.equal(visit.status, 200, "opening the link only shows a button");
    const token = new URL(`https://x${path}`).searchParams.get("token")!;
    assert.equal((await app.request(path)).status, 200, "a scanner's visit doesn't spend it");

    const confirmed = await app.request("/login/link/confirm", { form: { token } });
    assert.equal(confirmed.headers.get("Location"), "/admin");
    assert.match(confirmed.headers.get("Set-Cookie") ?? "", /Max-Age=2592000/);
    assert.equal((await app.request("/admin", { cookie: cookieFrom(confirmed) })).status, 200);

    assert.equal((await app.request("/login/link/confirm", { form: { token } })).status, 410, "single use");
    assert.equal((await app.request(path)).status, 410);
  } finally {
    providers.restore();
  }
});

test("links expire after 15 minutes", async () => {
  const app = createApp();
  await completeSetup(app, { email: true });
  const providers = fakeProviders();
  try {
    await app.request("/login/link", { form: { email: "jane@example.org" } });
    const token = new URL(`https://x${linkFrom(providers.calls.at(-1)!.body)}`).searchParams.get("token")!;
    await app.env.DB.prepare("UPDATE login_links SET expires_at = ?").bind(new Date(Date.now() - 1000).toISOString()).run();
    assert.equal((await app.request("/login/link/confirm", { form: { token } })).status, 410);
  } finally {
    providers.restore();
  }
});

test("unknown emails get the same page and no email; requests are rate limited", async () => {
  const app = createApp();
  await completeSetup(app, { email: true });
  const providers = fakeProviders();
  try {
    const unknown = await app.request("/login/link", { form: { email: "stranger@example.org" } });
    assert.match(await unknown.text(), /If stranger@example\.org has an account here/);
    assert.equal(providers.calls.length, 0);
    for (let attempt = 0; attempt < 12; attempt += 1) await app.request("/login/link", { form: { email: "jane@example.org" }, headers: { "CF-Connecting-IP": `192.0.2.${attempt}` } });
    assert.equal(providers.calls.length, 10, "at most 10 emails per address per 15 minutes");
  } finally {
    providers.restore();
  }
});

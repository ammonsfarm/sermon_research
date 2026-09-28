import assert from "node:assert/strict";
import test from "node:test";

import { runEpisode, type PipelineStep } from "../src/pipeline.ts";
import { formatTime, renderAnswer } from "../src/research.ts";
import { completeSetup, cookieFrom, createApp, fakeProviders, type TestApp } from "./helpers.ts";

const inlineStep: PipelineStep = { do: (_name, _config, callback) => callback() };

/** A finished site with both feed episodes processed. Leaves fake providers installed. */
async function indexedSite(): Promise<{ app: TestApp; cookie: string; ids: string[]; restore(): void }> {
  const app = createApp();
  const providers = fakeProviders();
  const cookie = await completeSetup(app, { count: 2 });
  const { results } = await app.env.DB.prepare("SELECT id FROM episodes ORDER BY published_at DESC").all<{ id: string }>();
  const ids = results.map((row) => row.id);
  for (const id of ids) await runEpisode(app.env, inlineStep, id);
  return { app, cookie, ids, restore: providers.restore };
}

async function makePublic(app: TestApp, cookie: string, dailyQuestions = 200) {
  const saved = await app.request("/admin/research", { form: { access: "public", dailyQuestions: String(dailyQuestions) }, cookie });
  assert.equal(saved.headers.get("Location"), "/admin?saved=1");
}

test("research is members-only by default", async () => {
  const site = await indexedSite();
  try {
    for (const path of ["/research", "/episodes", `/episodes/${site.ids[0]}`]) {
      assert.equal((await site.app.request(path)).headers.get("Location"), "/login", path);
    }
    assert.match(await (await site.app.request("/")).text(), /Sign in to ask questions/);
    assert.equal((await site.app.request("/research", { cookie: site.cookie })).status, 200);
  } finally {
    site.restore();
  }
});

test("a question gets a cited answer with linked sources", async () => {
  const site = await indexedSite();
  try {
    const response = await site.app.request("/research", { form: { question: "What is grace?" }, cookie: site.cookie });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /Salvation is by grace <sup><a href="#source-1">1<\/a><\/sup>/);
    assert.match(body, /&lt;b&gt;\[9\]&lt;\/b&gt;/, "unknown citations and markup stay as escaped text");
    assert.match(body, new RegExp(`<li id="source-1"><a href="/episodes/${site.ids[0]}#t-0">Faith &amp; Works</a>`));
    assert.match(body, /· 0:00/, "transcript sources show their timestamp");
  } finally {
    site.restore();
  }
});

test("episode search matches keywords, then related meaning", async () => {
  const site = await indexedSite();
  try {
    const all = await (await site.app.request("/episodes", { cookie: site.cookie })).text();
    assert.match(all, /Faith &amp; Works/);
    assert.match(all, /Grace Alone/);

    const byTitle = await (await site.app.request("/episodes?q=Alone", { cookie: site.cookie })).text();
    assert.match(byTitle, /Grace Alone/);
    assert.match(byTitle, /<h2>Related<\/h2>[\s\S]*Faith &amp; Works/, "semantic matches the keywords missed");

    const byScripture = await (await site.app.request("/episodes?q=Ephesians%202", { cookie: site.cookie })).text();
    assert.doesNotMatch(byScripture, /No episodes match/);

    const wildcard = await (await site.app.request("/episodes?q=%25", { cookie: site.cookie })).text();
    assert.doesNotMatch(wildcard.split("<h2>Related</h2>")[0]!, /episode-list/, "% is a literal, not a wildcard");
  } finally {
    site.restore();
  }
});

test("episode pages show the summary, audio and timestamped transcript", async () => {
  const site = await indexedSite();
  try {
    const response = await site.app.request(`/episodes/${site.ids[0]}`, { cookie: site.cookie });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /<audio controls preload="none" src="https:\/\/cdn.example.org\/ep2.mp3\?a=1&amp;b=2">/);
    assert.match(body, /Grace is a gift\./);
    assert.match(body, /<strong>Scripture:<\/strong> Ephesians 2:8/);
    assert.match(body, /<div class="passage" id="t-1">/);
    assert.match(body, /href="https:\/\/cdn.example.org\/ep2.mp3\?a=1&amp;b=2#t=0">Listen from 0:00/);
    assert.equal((await site.app.request("/episodes/00000000-0000-0000-0000-000000000000", { cookie: site.cookie })).status, 404);
  } finally {
    site.restore();
  }
});

test("public mode lets visitors in, with per-visitor and daily limits", async () => {
  const site = await indexedSite();
  try {
    await makePublic(site.app, site.cookie, 3);
    assert.equal((await site.app.request("/episodes")).status, 200);
    assert.match(await (await site.app.request("/")).text(), /Ask a question/);

    const ask = (ip: string) => site.app.request("/research", { form: { question: "What is grace?" }, headers: { "CF-Connecting-IP": ip } });
    for (let i = 0; i < 3; i += 1) assert.equal((await ask(`203.0.113.${i}`)).status, 200);
    const capped = await ask("203.0.113.9");
    assert.equal(capped.status, 429);
    assert.match(await capped.text(), /limit of questions for today/);
    assert.equal((await site.app.request("/research", { form: { question: "Admins aren't capped" }, cookie: site.cookie })).status, 200);

    await makePublic(site.app, site.cookie, 1000);
    let status = 0;
    for (let i = 0; i < 21 && status !== 429; i += 1) status = (await ask("198.51.100.7")).status;
    assert.equal(status, 429, "one visitor is limited per hour");
    assert.equal((await ask("198.51.100.8")).status, 200, "other visitors are not");
  } finally {
    site.restore();
  }
});

test("admins invite members, who set a password and can then research", async () => {
  const site = await indexedSite();
  try {
    const created = await site.app.request("/admin/members", { form: { name: "Sam Member", email: "Sam@Example.org" }, cookie: site.cookie });
    const body = await created.text();
    assert.equal(created.status, 200);
    assert.match(body, /Sam Member is invited/);
    const link = /https:\/\/sermons\.example\.org\/invite\?token=([A-Za-z0-9_-]+)/u.exec(body);
    assert.ok(link, "the invite link is shown once");
    const token = link[1]!;

    assert.equal((await site.app.request("/admin/members", { form: { name: "Dup", email: "sam@example.org" }, cookie: site.cookie })).status, 400);
    assert.match(await (await site.app.request(`/invite?token=${token}`)).text(), /Welcome, Sam Member/);
    const weak = await site.app.request("/invite", { form: { token, password: "short", confirm: "short" } });
    assert.equal(weak.status, 400);

    const accepted = await site.app.request("/invite", { form: { token, password: "a long enough password", confirm: "a long enough password" } });
    assert.equal(accepted.headers.get("Location"), "/research");
    const member = cookieFrom(accepted);
    assert.equal((await site.app.request("/research", { cookie: member })).status, 200);
    assert.equal((await site.app.request("/admin", { cookie: member })).status, 403, "members aren't admins");
    assert.equal((await site.app.request("/invite", { form: { token, password: "a long enough password", confirm: "a long enough password" } })).status, 410, "invites work once");

    const signedIn = await site.app.request("/login", { form: { email: "sam@example.org", password: "a long enough password" } });
    assert.equal(signedIn.headers.get("Location"), "/");

    const { id } = (await site.app.env.DB.prepare("SELECT id FROM users WHERE email = 'sam@example.org'").first<{ id: string }>())!;
    await site.app.request("/admin/members/remove", { form: { id }, cookie: site.cookie });
    assert.equal((await site.app.request("/research", { cookie: member })).headers.get("Location"), "/login", "removing a member signs them out");
  } finally {
    site.restore();
  }
});

test("invites are emailed when email is set up", async () => {
  const app = createApp();
  const providers = fakeProviders();
  try {
    const cookie = await completeSetup(app, { email: true });
    await app.request("/admin/members", { form: { name: "Pat", email: "pat@example.org" }, cookie });
    const sent = providers.calls.filter((call) => call.url === "https://api.resend.com/emails").at(-1);
    assert.deepEqual((sent?.body as { to?: unknown })?.to, ["pat@example.org"]);
    assert.match(String((sent?.body as { text?: unknown })?.text), /\/invite\?token=/);
  } finally {
    providers.restore();
  }
});

test("answers render safely and times format", () => {
  assert.equal(renderAnswer("A [1]. B [3].", 2).value, "<p>A <sup><a href=\"#source-1\">1</a></sup>. B [3].</p>");
  assert.equal(formatTime(3725), "1:02:05");
  assert.equal(formatTime(65.9), "1:05");
  assert.equal(formatTime(null), "");
});

import assert from "node:assert/strict";
import test from "node:test";

import { signedAudioUrl } from "../src/audio.ts";
import { fileName, splitTitle } from "../src/documents.ts";
import { renderMarkdown } from "../src/markdown.ts";
import { formatTime, renderAnswer } from "../src/research.ts";
import { describeScope, parseScope, scopeIds, seriesOf, titleWithoutSeries } from "../src/scope.ts";
import { segmentsByChunk } from "../src/sermons.ts";
import { AUDIO_BYTES, DOCUMENT_REPLY, completeSetup, cookieFrom, createApp, fakeProviders, indexedSite, ORIGIN, runDocuments, SECRET, type TestApp } from "./helpers.ts";

/** Invites a member and returns their session cookie. */
async function inviteMember(app: TestApp, adminCookie: string): Promise<string> {
  const body = await (await app.request("/admin/members", { form: { name: "Sam Member", email: "sam@example.org" }, cookie: adminCookie })).text();
  const token = /invite\?token=([A-Za-z0-9_-]+)/u.exec(body)![1]!;
  return cookieFrom(await app.request("/invite", { form: { token, password: "a long enough password", confirm: "a long enough password" } }));
}

async function makePublic(app: TestApp, cookie: string, dailyQuestions = 200) {
  const saved = await app.request("/admin/research", { form: { access: "public", dailyQuestions: String(dailyQuestions) }, cookie });
  assert.equal(saved.headers.get("Location"), "/admin?saved=1");
}

test("research is members-only by default", async () => {
  const site = await indexedSite();
  try {
    for (const path of ["/episodes", `/episodes/${site.ids[0]}`, "/library"]) {
      assert.equal((await site.app.request(path)).headers.get("Location"), "/login", path);
    }
    const signedOut = await (await site.app.request("/")).text();
    assert.match(signedOut, /Sign in to ask questions/);
    assert.doesNotMatch(signedOut, /aria-label="Main"/, "no navigation to pages visitors can't open");
    const home = await (await site.app.request("/", { cookie: site.cookie })).text();
    assert.match(home, /<h1>Ask the sermons<\/h1>/, "the home page is Ask once signed in");
    assert.match(home, /<nav class="tabs-main" aria-label="Main"><a href="\/" aria-current="page">Ask<\/a><a href="\/episodes">Sermons<\/a><a href="\/library">Library<\/a><a href="\/admin">Admin<\/a><\/nav>/);
    assert.match(home, /<span class="who">Jane Admin<\/span>/);
    assert.equal((await site.app.request("/research", { cookie: site.cookie })).headers.get("Location"), "/", "the old address still works");
    const admin = await (await site.app.request("/admin/episodes", { cookie: site.cookie })).text();
    assert.match(admin, /<nav class="side" aria-label="Admin">/);
    assert.match(admin, /<li><a href="\/admin\/episodes" aria-current="page">Episodes<\/a><\/li>/);
    assert.match(admin, /<a href="\/admin" aria-current="page">Admin<\/a>/);
  } finally {
    site.restore();
  }
});

test("a question gets a cited answer with linked sources", async () => {
  const site = await indexedSite();
  try {
    const asked = await site.app.request("/research", { form: { question: "What is grace?" }, cookie: site.cookie });
    const location = asked.headers.get("Location") ?? "";
    assert.match(location, /^\/ask\/[0-9a-f-]{36}#turn-[0-9a-f-]{36}$/u, "signed-in answers are kept as a conversation");
    const response = await site.app.request(location.split("#")[0]!, { cookie: site.cookie });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /<p class="question">What is grace\?<\/p>/);
    assert.match(body, /Salvation is by grace <sup><a href="#t1-source-1">1<\/a><\/sup>/);
    assert.match(body, /&lt;b&gt;\[9\]&lt;\/b&gt;/, "unknown citations and markup stay as escaped text");
    assert.match(body, new RegExp(`<li id="t1-source-1"><span class="n">1</span> <a href="/episodes/${site.ids[0]}#t-0">Faith &amp; Works</a>`));
    assert.match(body, /· 0:00/, "transcript sources show their timestamp");
    assert.match(body, /Scope: <strong>All sermons<\/strong>/);

    // A follow-up joins the same conversation and sends the earlier exchange to the AI.
    const thread = location.split("#")[0]!.slice("/ask/".length);
    const followUp = await site.app.request("/research", { form: { question: "And faith?", thread }, cookie: site.cookie });
    assert.match(followUp.headers.get("Location") ?? "", new RegExp(`^/ask/${thread}#turn-`));
    const prompt = JSON.stringify(site.providers.calls.findLast((call) => call.url.endsWith("/chat/completions"))?.body);
    assert.match(prompt, /Earlier in this conversation:.*Q: What is grace\?/);
    const both = await (await site.app.request(`/ask/${thread}`, { cookie: site.cookie })).text();
    assert.match(both, /What is grace\?[\s\S]*And faith\?/);
    assert.match(both, /href="#t2-source-1"/, "each answer links to its own sources");

    const library = await (await site.app.request("/library", { cookie: site.cookie })).text();
    assert.match(library, new RegExp(`<a href="/ask/${thread}">What is grace\\?</a><br>\\s*<span class="hint">2 questions`));
    const member = await inviteMember(site.app, site.cookie);
    assert.equal((await site.app.request(`/ask/${thread}`, { cookie: member })).status, 404, "conversations are private");
    assert.equal((await site.app.request("/research", { form: { question: "Sneaky follow-up", thread }, cookie: member })).headers.get("Location"), "/");

    assert.equal((await site.app.request(`/ask/${thread}/delete`, { form: {}, cookie: site.cookie })).headers.get("Location"), "/library");
    assert.equal((await site.app.request(`/ask/${thread}`, { cookie: site.cookie })).status, 404);
  } finally {
    site.restore();
  }
});

test("episode search matches keywords, then related meaning", async () => {
  const site = await indexedSite();
  try {
    const all = await (await site.app.request("/episodes", { cookie: site.cookie })).text();
    assert.match(all, /<h1>Sermons<\/h1>/);
    assert.match(all, /Faith &amp; Works/);
    assert.match(all, /Grace Alone/);
    assert.match(all, /<li class="chip">grace<\/li><li class="chip">Ephesians 2:1-10<\/li>/, "cards show topics and the main text");
    assert.match(all, /<a href="\/episodes" aria-current="page">Sermons<\/a>/);

    const byTitle = await (await site.app.request("/episodes?q=Alone", { cookie: site.cookie })).text();
    assert.match(byTitle, /Grace Alone/);
    assert.match(byTitle, /<h2>Related in meaning<\/h2>[\s\S]*Faith &amp; Works/, "semantic matches the keywords missed");

    const byScripture = await (await site.app.request("/episodes?q=Ephesians%202", { cookie: site.cookie })).text();
    assert.doesNotMatch(byScripture, /No sermons match/);

    const wildcard = await (await site.app.request("/episodes?q=%25", { cookie: site.cookie })).text();
    assert.doesNotMatch(wildcard.split("Related in meaning")[0]!, /class="card"/, "% is a literal, not a wildcard");

    const oldest = await (await site.app.request("/episodes?sort=oldest", { cookie: site.cookie })).text();
    assert.ok(oldest.indexOf("Grace Alone") < oldest.indexOf("Faith &amp; Works"), "oldest first");
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
    assert.match(body, new RegExp(`<audio id="player" controls preload="metadata" src="/audio/${site.ids[0]}">`), "plays our own copy");
    assert.match(body, /<script src="\/assets\/app.js" defer><\/script>/);
    assert.match(body, /<input type="checkbox" id="follow" checked> Follow along as it plays/);
    assert.match(body, /<span class="seg" data-start="0" data-end="4.5">Welcome, church.<\/span> <span class="seg" data-start="4.5" data-end="11">Today we read Ephesians 2:8.<\/span>/, "each timed sentence can be highlighted and clicked");
    assert.match(body, /Grace is a gift\./);
    assert.match(body, /<h3>Main text<\/h3><ul class="chips"><li class="chip">Ephesians 2:1-10<\/li><\/ul>\n<h3>Also mentioned<\/h3><ul class="chips"><li class="chip">Ephesians 2:8<\/li><\/ul>/);
    assert.match(body, /<button type="button" role="tab" id="tab-ask" aria-controls="panel-ask">Ask<\/button>/);
    assert.match(body, new RegExp(`<input type="hidden" name="scope_episode" value="${site.ids[0]}">`), "the Ask panel is limited to this sermon");
    assert.match(body, /<input type="hidden" name="kind" value="outline">/);
    assert.match(body, /<div class="passage" id="t-1">/);
    assert.match(body, new RegExp(`href="/audio/${site.ids[0]}#t=0" data-seek="0">Listen from 0:00`));
    const script = await site.app.request("/assets/app.js");
    assert.equal(script.headers.get("Content-Type"), "text/javascript; charset=utf-8");
    assert.match(await script.text(), /word-active/);
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
    const home = await (await site.app.request("/")).text();
    assert.match(home, /<h1>Ask the sermons<\/h1>/);
    assert.match(home, /<a href="\/" aria-current="page">Ask<\/a><a href="\/episodes">Sermons<\/a><\/nav>/, "visitors see Ask and Sermons, not Library");
    const visitor = await site.app.request("/research", { form: { question: "What is grace?" }, headers: { "CF-Connecting-IP": "192.0.2.1" } });
    assert.equal(visitor.status, 200, "visitors get the answer on the page");
    assert.match(await visitor.text(), /Salvation is by grace/);

    const ask = (ip: string) => site.app.request("/research", { form: { question: "What is grace?" }, headers: { "CF-Connecting-IP": ip } });
    for (let i = 0; i < 2; i += 1) assert.equal((await ask(`203.0.113.${i}`)).status, 200);
    const capped = await ask("203.0.113.9");
    assert.equal(capped.status, 429);
    assert.match(await capped.text(), /limit of questions for today/);
    assert.equal((await site.app.request("/research", { form: { question: "Admins aren't capped" }, cookie: site.cookie })).status, 303);

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
    assert.equal(accepted.headers.get("Location"), "/");
    const member = cookieFrom(accepted);
    assert.match(await (await site.app.request("/", { cookie: member })).text(), /<h1>Ask the sermons<\/h1>/);
    assert.equal((await site.app.request("/admin", { cookie: member })).status, 403, "members aren't admins");
    assert.equal((await site.app.request("/invite", { form: { token, password: "a long enough password", confirm: "a long enough password" } })).status, 410, "invites work once");

    const signedIn = await site.app.request("/login", { form: { email: "sam@example.org", password: "a long enough password" } });
    assert.equal(signedIn.headers.get("Location"), "/");

    const { id } = (await site.app.env.DB.prepare("SELECT id FROM users WHERE email = 'sam@example.org'").first<{ id: string }>())!;
    await site.app.request("/admin/members/remove", { form: { id }, cookie: site.cookie });
    assert.equal((await site.app.request("/library", { cookie: member })).headers.get("Location"), "/login", "removing a member signs them out");
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
  assert.equal(renderAnswer("A [1]. B [3].", 2).value, "<p>A <sup><a href=\"#source-1\">1</a></sup>. B [3].</p>\n");
  assert.equal(renderAnswer("- one [2]", 2, "t3-source").value, "<ul><li>one <sup><a href=\"#t3-source-2\">2</a></sup></li></ul>\n", "answers may use simple lists");
  assert.equal(formatTime(3725), "1:02:05");
  assert.equal(formatTime(65.9), "1:05");
  assert.equal(formatTime(null), "");
});

test("episode audio is served from R2 to members, with ranges, and to signed links", async () => {
  const site = await indexedSite();
  try {
    const path = `/audio/${site.ids[0]}`;
    assert.equal((await site.app.request(path)).status, 404, "strangers can't play members-only audio");

    const whole = await site.app.request(path, { cookie: site.cookie });
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("Content-Type"), "audio/mpeg");
    assert.equal(whole.headers.get("Accept-Ranges"), "bytes");
    assert.deepEqual(new Uint8Array(await whole.arrayBuffer()), AUDIO_BYTES);

    const part = await site.app.request(path, { cookie: site.cookie, headers: { Range: "bytes=0-2" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("Content-Range"), `bytes 0-2/${AUDIO_BYTES.byteLength}`);
    assert.equal(await part.text(), "ID3");

    const signed = new URL(await signedAudioUrl(SECRET, ORIGIN, site.ids[0]!));
    assert.equal((await site.app.request(signed.pathname + signed.search)).status, 200, "the transcription service uses a signed link");
    const other = new URL(await signedAudioUrl(SECRET, ORIGIN, site.ids[1]!));
    assert.equal((await site.app.request(`${path}${other.search}`)).status, 404, "a link signed for one episode doesn't open another");
    const expired = new URL(await signedAudioUrl(SECRET, ORIGIN, site.ids[0]!, Date.now() - 3 * 3_600_000));
    assert.equal((await site.app.request(expired.pathname + expired.search)).status, 404, "signed links expire");
  } finally {
    site.restore();
  }
});

test("transcript sentences are grouped under the passage they were indexed in", () => {
  const segments = [
    { text: "a", start: 0, end: 5 }, { text: "b", start: 5, end: 9 }, { text: "c", start: 9, end: 14 },
    { text: " ", start: 14, end: 15 }, { text: "d", start: 15, end: 20 },
  ];
  const groups = segmentsByChunk([{ start_seconds: 0 }, { start_seconds: 9 }], segments);
  assert.deepEqual(groups.map((group) => group.map((segment) => segment.text)), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(segmentsByChunk([], segments), []);
});

test("members create Markdown documents from the sermons, then view, download and delete them", async () => {
  const site = await indexedSite();
  try {
    const ask = await site.app.request("/", { cookie: site.cookie });
    assert.match(await ask.text(), /<option value="outline">Sermon outline<\/option>/);

    const created = await site.app.request("/research", { form: { question: "An outline on grace", kind: "outline" }, cookie: site.cookie });
    const location = created.headers.get("Location") ?? "";
    assert.match(location, /^\/documents\/[0-9a-f-]{36}$/u);
    const id = location.split("/").at(-1)!;
    assert.deepEqual(site.app.documentRuns.created, [{ id, params: { documentId: id } }], "writing happens in a background run");

    // While it's written, the page follows the progress and there's nothing to download yet.
    const writing = await (await site.app.request(location, { cookie: site.cookie })).text();
    assert.match(writing, /<meta http-equiv="refresh" content="10">/);
    assert.match(writing, /<p class="live">Starting · updated just now<\/p>/);
    assert.doesNotMatch(writing, /Download \.md/);
    assert.equal((await site.app.request(`${location}.md`, { cookie: site.cookie })).headers.get("Location"), location);
    assert.match(await (await site.app.request("/library", { cookie: site.cookie })).text(), /Sermon outline · \d{4}-\d\d-\d\d · Writing…/);

    await runDocuments(site.app);
    const chats = site.providers.calls.filter((call) => call.url.endsWith("/chat/completions")).slice(-2).map((call) => JSON.stringify(call.body));
    assert.match(chats[0]!, /You plan documents/);
    assert.match(chats[0]!, /1\. \\"Grace Alone\\" \(2026-09-07\)\. Speaker: Jane Doe\. Main text: Ephesians 2:1-10\. Scripture: Ephesians 2:8\. Topics: grace/, "the planner sees every sermon's speaker, main text, scripture and topics");
    assert.match(chats[1]!, /sermon outline/);
    assert.match(chats[1]!, /Grace Church/);
    assert.equal(chats[1]!.match(/Today we read Ephesians 2:8\./gu)?.length, 2, "the outline is written from both sermons' full transcripts");
    assert.match(chats[1]!, /Aim for about 900 words\./);

    const view = await site.app.request(location, { cookie: site.cookie });
    const body = await view.text();
    assert.equal(view.status, 200);
    assert.match(body, /<h1>Saved by Grace<\/h1>/, "the Markdown title becomes the page title");
    assert.match(body, /<strong>Big idea:<\/strong> grace is a gift <sup><a href="#source-1">1<\/a><\/sup>/);
    assert.match(body, /<h2>Main points<\/h2>/);
    assert.match(body, /<ol><li>Grace is unearned <sup><a href="#source-1">1<\/a><\/sup><ul><li>Read Ephesians 2:8<\/li><\/ul><\/li><li>Faith receives it/);
    assert.doesNotMatch(body, /<script>alert/);
    assert.doesNotMatch(body, /href="javascript:/);
    assert.match(body, /<ol class="sources">/);
    assert.match(body, new RegExp(`href="${location}.md" download>Download .md`));

    const download = await site.app.request(`${location}.md`, { cookie: site.cookie });
    assert.equal(download.headers.get("Content-Type"), "text/markdown; charset=utf-8");
    assert.equal(download.headers.get("Content-Disposition"), 'attachment; filename="saved-by-grace.md"');
    const markdown = await download.text();
    assert.match(markdown, /^# Saved by Grace\n\n\*\*Big idea:\*\* grace is a gift \[1\]\./u);
    assert.match(markdown, new RegExp(`\\n## Sources\\n\\n1\\. \\[[^\\]]+\\]\\(https://sermons\\.example\\.org/episodes/(${site.ids.join("|")})#t-\\d+\\), 2026-09-\\d\\d`));

    assert.equal((await site.app.request("/documents", { cookie: site.cookie })).headers.get("Location"), "/library");
    const list = await (await site.app.request("/library", { cookie: site.cookie })).text();
    assert.match(list, new RegExp(`<a href="${location}">Saved by Grace</a> <a class="hint" href="${location}.md" download>.md</a>`));
    assert.match(list, /Sermon outline ·/);
    assert.match(await (await site.app.request("/", { cookie: site.cookie })).text(), /<h2>Recent documents<\/h2><ul class="list-plain"><li><a href="\/documents\/[0-9a-f-]+">Saved by Grace<\/a>/);

    // Another member can't see it; signed-out visitors are sent to sign in.
    const member = await inviteMember(site.app, site.cookie);
    assert.equal((await site.app.request(location, { cookie: member })).status, 404);
    assert.equal((await site.app.request(`${location}.md`, { cookie: member })).status, 404);
    assert.doesNotMatch(await (await site.app.request("/library", { cookie: member })).text(), /Saved by Grace/);
    assert.equal((await site.app.request(`${location}/delete`, { form: {}, cookie: member })).status, 404, "members can't delete others' documents");
    assert.equal((await site.app.request(location)).headers.get("Location"), "/login");

    const deleted = await site.app.request(`${location}/delete`, { form: {}, cookie: site.cookie });
    assert.equal(deleted.headers.get("Location"), "/library");
    assert.equal((await site.app.request(location, { cookie: site.cookie })).status, 404);
  } finally {
    site.restore();
  }
});

test("signed-out visitors in public mode can ask but not create documents", async () => {
  const site = await indexedSite();
  try {
    await makePublic(site.app, site.cookie);
    const page = await (await site.app.request("/")).text();
    assert.match(page, /<option value="outline" disabled>/);
    assert.match(page, /Sign in<\/a> to keep conversations and create outlines/);
    const refused = await site.app.request("/research", { form: { question: "Study questions on grace", kind: "questions" } });
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /Sign in to create documents/);
    assert.equal((await site.app.env.DB.prepare("SELECT count(*) AS n FROM documents").first<{ n: number }>())?.n, 0);
  } finally {
    site.restore();
  }
});

test("Markdown renders the document subset and escapes everything else", () => {
  const rendered = String(renderMarkdown([
    "## Points", "", "- one *two* `three` __four__", "  - nested [link](https://example.org/a?b=1&c=2)", "- back [bad](javascript:alert(1)) [9]",
    "", "> quoted **text**", "", "---", "", "A paragraph", "continues <b>here</b>.",
  ].join("\n"), 2));
  assert.equal(rendered, [
    "<h2>Points</h2>",
    '<ul><li>one <em>two</em> <code>three</code> <strong>four</strong><ul><li>nested <a href="https://example.org/a?b=1&amp;c=2">link</a></li></ul></li><li>back [bad](javascript:alert(1)) [9]</li></ul>',
    "<blockquote><p>quoted <strong>text</strong></p>\n</blockquote>",
    "<hr>",
    "<p>A paragraph continues &lt;b&gt;here&lt;/b&gt;.</p>",
    "",
  ].join("\n"));
  assert.deepEqual(splitTitle("```md\n# A *Title*\n\nBody\n```", "fallback"), { title: "A Title", body: "Body" });
  assert.deepEqual(splitTitle("No title here", "fallback"), { title: "fallback", body: "No title here" });
  assert.equal(fileName("Grace & Peace: Week 1!"), "grace-peace-week-1.md");
  assert.equal(fileName("!!!"), "document.md");
});

test("questions and documents can be limited to a series, dates or chosen sermons", async () => {
  const site = await indexedSite();
  try {
    const [newer, older] = site.ids as [string, string];
    const home = await (await site.app.request("/", { cookie: site.cookie })).text();
    assert.match(home, /<details class="scope">\s*<summary>Scope: All sermons<\/summary>/);
    assert.match(home, new RegExp(`<option value="${older}">2026-09-07 · Grace Alone · Jane Doe</option>`));

    const asked = await site.app.request("/research", { form: { question: "What is grace?", scope_episode: older }, cookie: site.cookie });
    const thread = await (await site.app.request((asked.headers.get("Location") ?? "").split("#")[0]!, { cookie: site.cookie })).text();
    assert.match(thread, /Scope: <strong>“Grace Alone”<\/strong>/);
    assert.deepEqual((site.app.vectors.queries.at(-1) as { filter?: unknown }).filter, { episodeId: { $in: [older] } });
    assert.doesNotMatch(thread, new RegExp(`/episodes/${newer}#`), "only the chosen sermon is cited");

    // Dates are inclusive and combine with other limits.
    await site.app.request("/research", { form: { question: "What is grace?", scope_from: "2026-09-10", scope_to: "2026-09-30" }, cookie: site.cookie });
    assert.deepEqual((site.app.vectors.queries.at(-1) as { filter?: unknown }).filter, { episodeId: { $in: [newer] } });

    const none = await site.app.request("/research", { form: { question: "What is grace?", scope_from: "2030-01-01" }, cookie: site.cookie });
    assert.equal(none.status, 400);
    assert.match(await none.text(), /No sermons match that scope/);

    // A sermon page's Create buttons write from that sermon only, without a planning step.
    const outline = await site.app.request("/research", { form: { question: "Sermon outline for “Grace Alone”", kind: "outline", scope_episode: older }, cookie: site.cookie });
    const before = site.providers.calls.length;
    await runDocuments(site.app);
    const chats = site.providers.calls.slice(before).filter((call) => call.url.endsWith("/chat/completions"));
    assert.equal(chats.length, 1);
    assert.match(JSON.stringify(chats[0]!.body), /sermon outline/);
    assert.doesNotMatch(JSON.stringify(chats[0]!.body), /Faith & Works/);
    const doc = await (await site.app.request(outline.headers.get("Location")!, { cookie: site.cookie })).text();
    assert.match(doc, /<h1>Saved by Grace<\/h1>/);
    assert.match(doc, /Scope: <strong>“Grace Alone”<\/strong>/);
    assert.match(doc, new RegExp(`/episodes/${older}#`));
    assert.doesNotMatch(doc, new RegExp(`/episodes/${newer}#`), "only the chosen sermon is cited");
  } finally {
    site.restore();
  }
});

test("series come from the part of a title after the last dash", () => {
  assert.equal(seriesOf("Turn to Me - Haggai: Build What Matters"), "Haggai: Build What Matters");
  assert.equal(seriesOf("Faith - Hope - Love - 1 Corinthians"), "1 Corinthians");
  assert.equal(seriesOf("Grace Alone"), null);
  assert.equal(titleWithoutSeries("Turn to Me - Haggai: Build What Matters"), "Turn to Me");
  const entries = [
    { id: "a", title: "One - Matthew", publishedAt: "2026-01-04T00:00:00Z", series: "Matthew", speaker: "Jane Doe" },
    { id: "b", title: "Two - Haggai", publishedAt: "2026-02-01T00:00:00Z", series: "Haggai", speaker: "John Smith" },
    { id: "c", title: "Three - Matthew", publishedAt: "2026-03-01T00:00:00Z", series: "Matthew", speaker: null },
  ];
  assert.equal(scopeIds({}, entries), null);
  assert.deepEqual(scopeIds({ series: "Matthew" }, entries), ["a", "c"]);
  assert.deepEqual(scopeIds({ series: "Matthew", from: "2026-02-01" }, entries), ["c"]);
  assert.deepEqual(scopeIds({ to: "2026-02-01" }, entries), ["a", "b"]);
  assert.deepEqual(scopeIds({ speaker: "jane doe" }, entries), ["a"], "speakers match regardless of case");
  assert.equal(describeScope({ series: "Matthew", speaker: "Jane Doe" }, entries), "Series: Matthew, Speaker: Jane Doe");
  assert.equal(describeScope({ series: "Matthew", from: "2026-02-01" }, entries), "Series: Matthew, from 2026-02-01");
  assert.equal(describeScope({ episodes: ["a", "b"] }, entries), "2 chosen sermons");
  assert.deepEqual(parseScope(new URLSearchParams("scope_series=Matthew&scope_speaker=Jane+Doe&scope_from=nope&scope_episode=x&scope_to=2026-03-01")), { series: "Matthew", speaker: "Jane Doe", to: "2026-03-01" });
});

test("full transcripts download as Markdown or plain text, for people who can view the sermons", async () => {
  const site = await indexedSite();
  try {
    const id = site.ids[0]!;
    const page = await (await site.app.request(`/episodes/${id}`, { cookie: site.cookie })).text();
    assert.match(page, new RegExp(`href="/episodes/${id}/transcript.md" download`));
    assert.equal((await site.app.request(`/episodes/${id}/transcript.md`)).headers.get("Location"), "/login");
    const md = await site.app.request(`/episodes/${id}/transcript.md`, { cookie: site.cookie });
    assert.equal(md.headers.get("Content-Type"), "text/markdown; charset=utf-8");
    assert.match(md.headers.get("Content-Disposition") ?? "", /attachment; filename="2026-09-14-faith-works-transcript\.md"/);
    const markdown = await md.text();
    assert.match(markdown, /^# Faith & Works\n\n2026-09-14 · John Smith · Grace Church\n\n## Summary\n\nGrace is a gift\./u);
    assert.match(markdown, /## Transcript\n\n\*\*0:00\*\* Welcome, church\./u);
    const txt = await (await site.app.request(`/episodes/${id}/transcript.txt`, { cookie: site.cookie })).text();
    assert.match(txt, /^Faith & Works\n2026-09-14 · John Smith · Grace Church\n\n\[0:00\] Welcome, church\./u);
    assert.equal((await site.app.request("/episodes/00000000-0000-0000-0000-000000000000/transcript.txt", { cookie: site.cookie })).status, 404);
  } finally {
    site.restore();
  }
});

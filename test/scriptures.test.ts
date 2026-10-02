import assert from "node:assert/strict";
import test from "node:test";

import { hourlyTick } from "../src/imports.ts";
import { parseNumbered } from "../src/research.ts";
import { normalizeReference, sameReference } from "../src/scriptures.ts";
import { indexedSite, type TestApp } from "./helpers.ts";

const isChat = (call: { url: string }) => call.url.endsWith("/chat/completions");

async function mainTexts(app: TestApp) {
  const { results } = await app.env.DB.prepare("SELECT e.title, s.main_scripture FROM summaries s JOIN episodes e ON e.id = s.episode_id ORDER BY e.published_at DESC")
    .all<{ title: string; main_scripture: string | null }>();
  return results.map((row) => [row.title, row.main_scripture]);
}

test("the summary names the main passage, kept apart from everything else mentioned", async () => {
  const site = await indexedSite();
  try {
    const [newer] = site.ids as [string, string];
    assert.deepEqual(await mainTexts(site.app), [["Faith & Works", "Ephesians 2:1-10"], ["Grace Alone", "Ephesians 2:1-10"]]);
    const prompt = JSON.stringify(site.providers.calls.filter(isChat).find((call) => JSON.stringify(call.body).includes("You summarize sermons"))!.body);
    assert.match(prompt, /\\"mainScripture\\": \\"the passage the sermon preaches from/);
    assert.match(prompt, /with the main passage first/);
    assert.match(prompt, /a verse quoted in passing isn't it/);
    const summaryChunk = await site.app.env.DB.prepare("SELECT text FROM chunks WHERE episode_id = ? AND seq = 0").bind(newer).first<{ text: string }>();
    assert.equal(summaryChunk?.text, "Grace is a gift.\nMain text: Ephesians 2:1-10\nTopics: grace\nScripture: Ephesians 2:8");

    const cards = await (await site.app.request("/episodes", { cookie: site.cookie })).text();
    assert.doesNotMatch(cards, /<li class="chip">Ephesians 2:8<\/li>/, "cards show the main text, not the first reference");
    const search = await (await site.app.request("/episodes?q=2%3A1-10", { cookie: site.cookie })).text();
    assert.match(search.split("Related in meaning")[0]!, /Faith &amp; Works/, "keyword search matches the main text");
    const markdown = await (await site.app.request(`/episodes/${newer}/transcript.md`, { cookie: site.cookie })).text();
    assert.match(markdown, /## Summary\n\nGrace is a gift\.\n\n\*\*Main text:\*\* Ephesians 2:1-10\n\n\*\*Topics:\*\* grace\n\n\*\*Scripture:\*\* Ephesians 2:8/);
  } finally {
    site.restore();
  }
});

test("sermons summarized before main texts were kept get one hourly or on request", async () => {
  const site = await indexedSite();
  try {
    const [newer, older] = site.ids as [string, string];
    await site.app.env.DB.prepare("UPDATE summaries SET main_scripture = NULL").run();
    const cards = await (await site.app.request("/episodes", { cookie: site.cookie })).text();
    assert.match(cards, /<li class="chip">Ephesians 2:8<\/li>/, "until it's chosen, cards show the first reference as before");
    assert.match(await (await site.app.request("/admin/episodes", { cookie: site.cookie })).text(),
      /<dt>Main texts<\/dt><dd>0 chosen · 2 waiting for the AI, which checks hourly <form class="inline" method="post" action="\/admin\/episodes\/scriptures"/);

    const before = site.providers.calls.length;
    await hourlyTick(site.app.env, new Date());
    assert.deepEqual(await mainTexts(site.app), [["Faith & Works", ""], ["Grace Alone", "Ephesians 2:8-10"]], "an empty main text means the sermon has none");
    const asked = site.providers.calls.slice(before).filter(isChat).map((call) => JSON.stringify(call.body)).find((body) => body.includes("main Bible passage"))!;
    assert.match(asked, /\d\. \\"Faith & Works\\" \(2026-09-14\)\\nReferences it mentions: Ephesians 2:8\\nTranscript start: Welcome, church\. Today we read Ephesians 2:8\.…/);
    assert.match(await (await site.app.request("/admin/episodes", { cookie: site.cookie })).text(), /<dt>Main texts<\/dt><dd>1 chosen<\/dd>/);

    // A topical sermon shows its references under Scripture, and its card shows none.
    const topical = await (await site.app.request(`/episodes/${newer}`, { cookie: site.cookie })).text();
    assert.doesNotMatch(topical, /<h3>Main text<\/h3>/);
    assert.match(topical, /<h3>Scripture<\/h3><ul class="chips"><li class="chip">Ephesians 2:8<\/li><\/ul>/);
    assert.match(await (await site.app.request(`/episodes/${older}`, { cookie: site.cookie })).text(), /<h3>Main text<\/h3><ul class="chips"><li class="chip">Ephesians 2:8-10<\/li><\/ul>/);

    await site.app.env.DB.prepare("UPDATE summaries SET main_scripture = NULL WHERE episode_id = ?").bind(older).run();
    const now = await site.app.request("/admin/episodes/scriptures", { form: {}, cookie: site.cookie });
    assert.equal(decodeURIComponent(now.headers.get("Location") ?? ""), "/admin/episodes?notice=Checked 1 sermon for their main text.");
    assert.deepEqual((await mainTexts(site.app))[1], ["Grace Alone", "Ephesians 2:8-10"]);
    assert.equal((await site.app.request("/admin/episodes/scriptures", { form: {} })).headers.get("Location"), "/login");
  } finally {
    site.restore();
  }
});

test("references are tidied and compared loosely", () => {
  assert.equal(normalizeReference(" Matthew  5:21–26. "), "Matthew 5:21-26");
  assert.equal(normalizeReference("Proverbs 19"), "Proverbs 19");
  for (const empty of ["null", "None", "topical", "", 7, null]) assert.equal(normalizeReference(empty), null);
  assert.ok(sameReference("Matthew 5:21–26", "matthew 5:21-26"));
  assert.ok(!sameReference("Matthew 5:21-26", "Matthew 5:21"));
  assert.ok(!sameReference(null, null));
  assert.deepEqual(parseNumbered("Here: {\"2\": \"b\", \"1\": \"a\"}", 3, (value) => value ?? null, "things"), ["a", "b", null]);
  assert.throws(() => parseNumbered("nope", 1, String, "main passages"), /didn't return the main passages as JSON/);
});

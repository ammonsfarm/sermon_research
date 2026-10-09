import assert from "node:assert/strict";
import test from "node:test";

import { hourlyTick } from "../src/imports.ts";
import type { Passage } from "../src/research.ts";
import { asPart, assemble, parsePlan, toPlaceholders, withinBudget } from "../src/writing.ts";
import { fakeProviders, indexedSite, runDocuments } from "./helpers.ts";

const isChat = (call: { url: string }) => call.url.endsWith("/chat/completions");

test("long documents are planned, then written part by part from full transcripts", async () => {
  const site = await indexedSite();
  try {
    const [newer, older] = site.ids as [string, string];
    const created = await site.app.request("/research", { form: { question: "A book on grace, one chapter per sermon, 10 minutes of reading each", kind: "custom" }, cookie: site.cookie });
    const location = created.headers.get("Location")!;
    const before = site.providers.calls.length;
    await runDocuments(site.app);
    const chats = site.providers.calls.slice(before).filter(isChat).map((call) => JSON.stringify(call.body));
    assert.equal(chats.length, 3, "one plan, then one call per part");
    assert.match(chats[0]!, /split it into parts in reading order/);

    // Each part reads its own sermon in full, knows the whole plan, and sees how the part before it ended.
    assert.match(chats[1]!, /\[2\] \\"Grace Alone\\" \(2026-09-07, Jane Doe\), at 0:00:\\nWelcome, church\. Today we read Ephesians 2:8\./);
    assert.doesNotMatch(chats[1]!, /\\"Faith & Works\\"/);
    assert.match(chats[1]!, /1\. Chapter 1: Grace Alone: Grace is a gift\.\\n2\. Chapter 2: Faith and Works: Faith receives it\./);
    assert.match(chats[1]!, /Write part 1 only: \\"Chapter 1: Grace Alone\\"\. It covers: Grace is a gift\. Aim for about 2,300 words\./);
    assert.doesNotMatch(chats[1]!, /ended like this/);
    assert.match(chats[2]!, /\\"Faith & Works\\" \(2026-09-14, John Smith\)/);
    assert.doesNotMatch(chats[2]!, /\\"Grace Alone\\" \(/);
    assert.match(chats[2]!, /Part 1 ended like this\. Carry on from it without repeating it:\\n\\n….*What is grace\?/);
    assert.doesNotMatch(chats[2]!, /\{\{cite/, "the next part sees plain text, not citation placeholders");
    assert.match(chats[2]!, /Aim for about 5,000 words\./, "lengths are capped");

    const page = await (await site.app.request(location, { cookie: site.cookie })).text();
    assert.match(page, /<h1>Grace, Chapter by Chapter<\/h1>/);
    assert.doesNotMatch(page, /http-equiv="refresh"/);
    assert.equal(page.match(/<h2>Chapter from the model<\/h2>/gu)?.length, 2);

    // Citations are numbered across the whole document, in the order they're first cited.
    const markdown = await (await site.app.request(`${location}.md`, { cookie: site.cookie })).text();
    assert.ok(markdown.startsWith("# Grace, Chapter by Chapter\n\n## Chapter from the model\n\nThe preacher told a story about a gift [1]. Faith receives it [2, 1]. Not a source.\n\n### Questions\n\n1. What is grace? [2, 1]\n\n## Chapter from the model\n\nThe preacher told a story about a gift [3]. Faith receives it [4, 3]."));
    const sources = "## Sources\n\n"
      + `1. [Grace Alone](https://sermons.example.org/episodes/${older}#t-1), 2026-09-07, at 0:00\n`
      + `2. [Grace Alone](https://sermons.example.org/episodes/${older}#t-0), 2026-09-07, summary\n`
      + `3. [Faith & Works](https://sermons.example.org/episodes/${newer}#t-1), 2026-09-14, at 0:00\n`
      + `4. [Faith & Works](https://sermons.example.org/episodes/${newer}#t-0), 2026-09-14, summary\n`;
    assert.ok(markdown.endsWith(sources), markdown);
  } finally {
    site.restore();
  }
});

test("a document that can't be written shows why and can be tried again; stalled runs fail hourly", async () => {
  const site = await indexedSite();
  site.restore();
  let providers = fakeProviders({ "https://api.openai.com/v1/chat/completions": 500 });
  try {
    const created = await site.app.request("/research", { form: { question: "A book on grace", kind: "custom" }, cookie: site.cookie });
    const location = created.headers.get("Location")!;
    const id = location.split("/").at(-1)!;
    await runDocuments(site.app);
    const failed = await (await site.app.request(location, { cookie: site.cookie })).text();
    assert.match(failed, /This document couldn't be written: OpenAI returned HTTP 500 for gpt-test\./);
    assert.match(failed, new RegExp(`<form class="inline" method="post" action="/documents/${id}/retry"><button type="submit">Try again</button></form>`));
    assert.doesNotMatch(failed, /http-equiv="refresh"/);
    assert.match(await (await site.app.request("/library", { cookie: site.cookie })).text(), /Couldn&#39;t be written/);

    providers.restore();
    providers = fakeProviders();
    const retried = await site.app.request(`${location}/retry`, { form: {}, cookie: site.cookie });
    assert.equal(retried.headers.get("Location"), location);
    assert.match(site.app.documentRuns.created[0]!.id, new RegExp(`^${id}-\\d+$`), "each attempt is its own run");
    await runDocuments(site.app);
    assert.match(await (await site.app.request(location, { cookie: site.cookie })).text(), /<h1>Grace, Chapter by Chapter<\/h1>/);
    await site.app.request(`${location}/retry`, { form: {}, cookie: site.cookie });
    assert.equal(site.app.documentRuns.created.length, 0, "a finished document isn't written again");

    // If Workflows can't take the run, nothing is saved and the person can try again.
    site.app.documentRuns.failing = true;
    const refused = await site.app.request("/research", { form: { question: "Another book", kind: "custom" }, cookie: site.cookie });
    assert.equal(refused.status, 503);
    assert.match(await refused.text(), /Writing couldn&#39;t start right now/);
    assert.equal((await site.app.env.DB.prepare("SELECT count(*) AS n FROM documents").first<{ n: number }>())?.n, 1);
    site.app.documentRuns.failing = false;

    // A run that stops reporting progress is failed by the hourly tick.
    const stalled = (await site.app.request("/research", { form: { question: "A third book", kind: "custom" }, cookie: site.cookie })).headers.get("Location")!.split("/").at(-1)!;
    await site.app.env.DB.prepare("UPDATE documents SET updated_at = ? WHERE id = ?").bind(new Date(Date.now() - 3 * 3_600_000).toISOString(), stalled).run();
    await hourlyTick(site.app.env, new Date());
    const row = await site.app.env.DB.prepare("SELECT status, error FROM documents WHERE id = ?").bind(stalled).first<{ status: string; error: string }>();
    assert.deepEqual({ ...row }, { status: "failed", error: "The writing stopped reporting progress. Try again." });
  } finally {
    providers.restore();
  }
});

test("plans are read leniently and kept within limits", () => {
  const sermons = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const plan = parsePlan("Here you go:\n```json\n{\"title\": \"# A Book\", \"parts\": [{\"heading\": \"Intro\", \"brief\": \"Why  it\\nmatters\", \"sermons\": []}, {\"heading\": \"One\", \"sermons\": [3, \"1\", 9, 1], \"words\": 40}]}\n```", sermons);
  assert.deepEqual(plan, {
    title: "A Book",
    episodeIds: ["a", "c"],
    parts: [{ heading: "Intro", brief: "Why it matters", episodeIds: [], words: 0 }, { heading: "One", brief: "", episodeIds: ["c", "a"], words: 150 }],
  });
  assert.throws(() => parsePlan("not json", sermons), /didn't return the document's plan as JSON/);
  assert.throws(() => parsePlan("{\"title\": \"X\", \"parts\": [{\"heading\": \"A\", \"sermons\": [7]}]}", sermons), /didn't find sermons for this request/);
  const many = parsePlan(JSON.stringify({ parts: Array.from({ length: 40 }, () => ({ heading: "P", sermons: [1] })) }), sermons);
  assert.equal(many.parts.length, 30);
  assert.equal(many.title, "");
});

test("citations are renumbered across parts, and oversized sources keep the closest passages", () => {
  const passage = (episodeId: string, seq: number, text = "x"): Omit<Passage, "n"> => ({
    chunkId: `${episodeId}:${seq}`, episodeId, title: episodeId, publishedAt: null,
    kind: seq === 0 ? "summary" : "transcript", seq, start: seq === 0 ? null : seq * 10, text,
  });
  const numbered = (rows: Omit<Passage, "n">[]): Passage[] => rows.map((row, index) => ({ ...row, n: index + 1 }));

  const first = toPlaceholders("A [2]. B [1, 2] and [1–2]. C [7].", numbered([passage("e1", 0), passage("e1", 1)]));
  assert.equal(first.markdown, "A {{cite e1:1}}. B {{cite e1:0 e1:1}} and {{cite e1:0 e1:1}}. C.");
  const second = toPlaceholders("D [1] [2].", numbered([passage("e2", 0), passage("e2", 1)]));
  const joined = assemble([first, second]);
  assert.equal(joined.markdown, "A [1]. B [2, 1] and [2, 1]. C.\n\nD [3] [4].");
  assert.deepEqual(joined.sources.map((source) => [source.n, source.episodeId, source.seq]), [[1, "e1", 1], [2, "e1", 0], [3, "e2", 0], [4, "e2", 1]]);

  assert.equal(asPart("```markdown\n# Title\n\nText\n```", "H"), "## Title\n\nText");
  assert.equal(asPart("Just text", "Chapter 2"), "## Chapter 2\n\nJust text");
  assert.equal(asPart("## Kept\n\nText", "H"), "## Kept\n\nText");

  const hundred = "x".repeat(100);
  const rows = [passage("e1", 0, hundred), passage("e1", 1, hundred), passage("e1", 2, hundred), passage("e1", 3, hundred)];
  assert.equal(withinBudget(rows, [], 400).length, 4, "whole transcripts when they fit");
  assert.deepEqual(withinBudget(rows, ["e1:3", "e1:1", "e1:2"], 250).map((row) => row.chunkId), ["e1:0", "e1:3"], "the summary, then the closest passages, in reading order");
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { BIBLE, bibleState, BOOKS, buildPassages, importBible, parseReference, parseVerses, passageLabel, referencesIn, searchBible, unzipFile } from "../src/bible.ts";
import { nearest } from "../src/research.ts";
import { BIBLE_VERSES, completeSetup, cookieFrom, createApp, fakeProviders, indexedSite, inlineStep, zipOf } from "./helpers.ts";

test("the book table covers the 66 books and 1,189 chapters", () => {
  assert.equal(BOOKS.length, 66);
  assert.equal(BOOKS.reduce((sum, book) => sum + book.chapters, 0), 1189);
  assert.equal(new Set(BOOKS.map((book) => book.slug)).size, 66);
  assert.deepEqual([BOOKS[21]!.slug, BOOKS[39]!.testament, BOOKS[38]!.testament], ["song-of-solomon", "new", "old"]);
});

test("references are recognised, and ordinary searches aren't", () => {
  const place = (text: string) => {
    const found = parseReference(text);
    return found ? `${found.book.name} ${found.chapter ?? "-"}:${found.verse ?? "-"}` : null;
  };
  assert.equal(place("John 3:16"), "John 3:16");
  assert.equal(place("  john 3 "), "John 3:-");
  assert.equal(place("1 Cor 13"), "1 Corinthians 13:-");
  assert.equal(place("II Timothy 2.15-17"), "2 Timothy 2:15");
  assert.equal(place("1john 4:8"), "1 John 4:8");
  assert.equal(place("Psalm 23"), "Psalms 23:-");
  assert.equal(place("Song of Songs 2:1"), "Song of Solomon 2:1");
  assert.equal(place("Eph. 2:8–10"), "Ephesians 2:8");
  assert.equal(place("Jn 1:1"), "John 1:1");
  assert.equal(place("Jude 5"), "Jude 1:5", "a one-chapter book is cited by verse");
  assert.equal(place("Jude 1:5"), "Jude 1:5");
  assert.equal(place("Romans"), "Romans -:-");
  assert.equal(place("John 22"), null, "John has 21 chapters");
  for (const search of ["love your enemies", "rom", "the lord is my shepherd", "faith 2", "3 things", ""]) assert.equal(place(search), null, search);
});

test("a zip's file is found whether deflated or stored, and a damaged archive is refused", async () => {
  const files = { "a_about.htm": "about", "a_vpl.txt": "GEN 1:1 In the beginning.\n".repeat(50) };
  for (const deflate of [true, false]) {
    const found = await unzipFile(zipOf(files, deflate), "_vpl.txt");
    assert.equal(new TextDecoder().decode(found!), files["a_vpl.txt"]);
  }
  assert.equal(await unzipFile(zipOf(files), "_vpl.sql"), null);
  assert.equal(await unzipFile(new TextEncoder().encode("<html>Checking your browser</html>"), "_vpl.txt"), null);
  assert.equal(await unzipFile(zipOf(files).subarray(40), "_vpl.txt"), null);
});

test("verses are read as written and grouped into passages within a chapter", () => {
  const verses = parseVerses(BIBLE_VERSES);
  assert.equal(verses.length, 9, "the empty Acts 8:37 is left out");
  assert.deepEqual(verses[0], { book: 1, chapter: 1, verse: 1, text: "In the beginning, God created the heavens and the earth." });
  const passages = buildPassages(verses);
  assert.deepEqual(passages.map(passageLabel), ["Genesis 1:1-2", "Psalms 23:1", "Psalms 23:2", "John 3:16-17", "Acts 8:36-38", "Jude 1:5"]);
  assert.equal(passages[0]!.id, "bible:1:1:1");
  assert.equal(passages[0]!.text, "In the beginning, God created the heavens and the earth. The earth was formless and empty.");
});

test("an admin adds the Bible; people read it, search it, and sermon searches leave it out", async () => {
  const site = await indexedSite();
  try {
    const { app, cookie } = site;
    assert.doesNotMatch(await (await app.request("/", { cookie })).text(), /href="\/bible"/, "no tab before it's added");
    assert.match(await (await app.request("/bible", { cookie })).text(), /hasn’t been added|hasn&#39;t been added/);
    const sermonVectors = app.vectors.stored.size;

    const adminPage = await (await app.request("/admin/bible", { cookie })).text();
    assert.match(adminPage, /Add the World English Bible/);
    assert.equal((await app.request("/admin/bible", { cookie, form: {} })).status, 303);
    assert.equal(app.bibleRuns.length, 1);
    assert.equal((await bibleState(app.env.DB))!.status, "working");
    await app.request("/admin/bible", { cookie, form: {} });
    assert.equal(app.bibleRuns.length, 1, "a second press while it's working starts nothing");

    await importBible(app.env, inlineStep);
    const state = (await bibleState(app.env.DB))!;
    assert.deepEqual([state.status, state.verses, state.passages, state.indexed, state.error], ["done", 9, 6, 6, null]);
    const download = site.providers.calls.find((call) => call.url === BIBLE.url)!;
    assert.match(download.userAgent ?? "", /sermon-research/);
    const embedded = site.providers.calls.filter((call) => call.url.endsWith("/embeddings")).flatMap((call) => (call.body as { input: string[] }).input);
    assert.ok(embedded.some((text) => text.startsWith("John 3:16-17 (World English Bible)\nFor God so loved the world")));
    assert.equal(app.vectors.stored.size, sermonVectors + 6);
    assert.deepEqual(app.vectors.stored.get("bible:43:3:16")!.metadata, { episodeId: "bible", kind: "bible", book: 43, chapter: 3 });
    assert.match(await (await app.request("/admin/bible", { cookie })).text(), /9 verses; 6 of 6 passages searchable by meaning/);

    const home = await (await app.request("/bible", { cookie })).text();
    assert.match(home, /href="\/bible"[^>]*aria-current="page"/);
    assert.match(home, /href="\/bible\/song-of-solomon"/);
    for (const [typed, to] of [["John 3:16", "/bible/john/3#v16"], ["jude 5", "/bible/jude/1#v5"], ["Romans", "/bible/romans"]] as const) {
      const response = await app.request(`/bible?q=${encodeURIComponent(typed)}`, { cookie });
      assert.deepEqual([response.status, response.headers.get("Location")], [303, to]);
    }

    const chapter = await (await app.request("/bible/john/3", { cookie })).text();
    assert.match(chapter, /<h1>John 3<\/h1>/);
    assert.match(chapter, /<span class="verse" id="v16"><sup>16<\/sup>For God so loved the world/);
    assert.match(chapter, /rel="prev">← John 2</);
    assert.match(chapter, /rel="next">John 4 →</);
    assert.match(chapter, /href="\/episodes\?q=John\+3"/);
    assert.match(await (await app.request("/bible/jude/1", { cookie })).text(), /&lt;i&gt;&amp;&lt;\/i&gt;/, "the text is escaped");
    assert.equal((await app.request("/bible/jude", { cookie })).headers.get("Location"), "/bible/jude/1");
    assert.match(await (await app.request("/bible/psalms", { cookie })).text(), /href="\/bible\/psalms\/150">150</);
    for (const missing of ["/bible/john/22", "/bible/john/4", "/bible/enoch", "/bible/enoch/1"]) assert.equal((await app.request(missing, { cookie })).status, 404, missing);

    const before = app.vectors.queries.length;
    const results = await (await app.request("/bible?q=shepherd", { cookie })).text();
    assert.deepEqual((app.vectors.queries.at(-1) as { filter?: unknown }).filter, { episodeId: "bible" });
    assert.equal(app.vectors.queries.length, before + 1);
    assert.match(results, /Closest in meaning/);
    assert.match(results, /href="\/bible\/john\/3#v16">John 3:16-17</);
    assert.match(results, /Verses with these words[\s\S]*href="\/bible\/psalms\/23#v1">Psalms 23:1</);
    assert.doesNotMatch(results, /Welcome, church/, "no sermon passages among the Bible's");
    assert.deepEqual((await searchBible(app.env, "light", 2)).map(passageLabel), ["Genesis 1:1-2", "Psalms 23:1"]);

    const matches = await nearest(app.env, "grace", 100);
    assert.deepEqual((app.vectors.queries.at(-1) as { filter?: unknown }).filter, { episodeId: { $ne: "bible" } });
    assert.equal(matches.length, sermonVectors);
    assert.ok(matches.every((match) => !match.id.startsWith("bible:")));

    await app.env.DB.prepare("INSERT INTO bible_passages (id, book, chapter, verse_start, verse_end, text, indexed) VALUES ('bible:1:1:9', 1, 1, 9, 9, 'Old division', 1)").run();
    await app.env.VECTORS.upsert([{ id: "bible:1:1:9", values: [0], metadata: { episodeId: "bible" } }]);
    await importBible(app.env, inlineStep);
    assert.deepEqual(app.vectors.deleted.filter((id) => id.startsWith("bible:")), ["bible:1:1:9"], "adding it again drops passages the new text doesn't have");
    assert.equal((await bibleState(app.env.DB))!.indexed, 6);

    const signedOut = await app.request("/bible");
    assert.deepEqual([signedOut.status, signedOut.headers.get("Location")], [303, "/login"], "members only until research is public");
  } finally {
    site.restore();
  }
});

test("before the Bible is added, sermon searches are unfiltered as they were", async () => {
  const site = await indexedSite();
  try {
    await nearest(site.app.env, "grace", 5);
    assert.equal((site.app.vectors.queries.at(-1) as { filter?: unknown }).filter, undefined);
  } finally {
    site.restore();
  }
});

test("a failed download is reported, and only admins can add the Bible", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  const providers = fakeProviders({ "https://ebible.org/": 503 });
  try {
    await app.request("/admin/bible", { cookie, form: {} });
    await importBible(app.env, inlineStep);
    const state = (await bibleState(app.env.DB))!;
    assert.equal(state.status, "failed");
    assert.match(state.error!, /eBible\.org returned HTTP 503/);
    assert.match(await (await app.request("/admin/bible", { cookie })).text(), /Adding the Bible stopped: eBible\.org returned HTTP 503/);
    assert.equal((await app.request("/admin/bible", { form: {} })).headers.get("Location"), "/login");
    assert.equal(app.bibleRuns.length, 1);
    assert.equal(cookieFrom(await app.request("/bible", { cookie })), "");
  } finally {
    providers.restore();
  }
});

test("references written in a question are found", () => {
  const found = (text: string) => referencesIn(text).map((mention) => `${mention.book.name} ${mention.chapter}:${mention.from ?? "-"}-${mention.to ?? "-"}`);
  assert.deepEqual(found("What does Romans 8:28-30 mean, and how does it fit with 1 John 4?"), ["Romans 8:28-30", "1 John 4:---"]);
  assert.deepEqual(found("compare john 3:16, John 3:16 and II Tim. 2:15"), ["John 3:16-16", "2 Timothy 2:15-15"]);
  assert.deepEqual(found("Jude 5 and Psalm 23"), ["Jude 1:5-5", "Psalms 23:---"]);
  assert.deepEqual(found("I have 3 questions about acts of kindness, mark my words, and the 12 disciples"), []);
  assert.deepEqual(found("John 99:1"), []);
  assert.equal(found("Gen 1, Ex 2, Lev 3, Num 4, Deut 5").length, 3, "at most three");
});

test("Ask answers from the Bible, or from the sermons and the Bible together", async () => {
  const site = await indexedSite();
  try {
    const { app, cookie } = site;
    const prompts = () => site.providers.calls.filter((call) => call.url.endsWith("/chat/completions")).map((call) => (call.body as { messages: { content: string }[] }).messages);

    assert.doesNotMatch(await (await app.request("/", { cookie })).text(), /name="scope_sources"/, "no choice until the Bible is added");
    await app.request("/research", { cookie, form: { question: "What is grace?", scope_sources: "bible" } });
    assert.doesNotMatch(prompts().at(-1)![1]!.content, /The Bible,/, "asking for the Bible before it's added answers from the sermons");

    await importBible(app.env, inlineStep);
    const page = await (await app.request("/", { cookie })).text();
    assert.match(page, /<select id="f-sources" name="scope_sources"><option value="">Sermons<\/option><option value="both">Sermons and the Bible<\/option><option value="bible">The Bible<\/option>/);

    await app.request("/research", { cookie, form: { question: "What is grace?" } });
    assert.doesNotMatch(prompts().at(-1)![1]!.content, /The Bible,/, "sermons alone unless asked");

    const asked = await app.request("/research", { cookie, form: { question: "What does John 3:16 say about love?", scope_sources: "bible", scope_series: "No such series" } });
    assert.equal(asked.status, 303, "a sermon scope doesn't matter when only the Bible is asked");
    const [system, user] = prompts().at(-1)!.map((message) => message.content) as [string, string];
    assert.match(system, /study the Bible\. Answer only from the numbered sources, which are passages from the Bible \(World English Bible\)/);
    assert.match(user, /^Sources:\n\n\[1\] The Bible, John 3:16-17 \(World English Bible\):\nFor God so loved the world/, "the verse the question names comes first");
    assert.doesNotMatch(user, /Grace Alone|Welcome, church/);
    assert.equal((user.match(/The Bible, John 3:16-17/g) ?? []).length, 1, "and isn't repeated by the search");
    const thread = asked.headers.get("Location")!;
    const conversation = await (await app.request(thread.split("#")[0]!, { cookie })).text();
    assert.match(conversation, /Scope: <strong>The Bible<\/strong>/);
    assert.match(conversation, /<a href="\/bible\/john\/3#v16">John 3:16-17<\/a>\s*<span class="hint">World English Bible<\/span>/);
    assert.match(conversation, /name="scope_sources" value="bible"/, "a follow-up keeps asking the Bible");
    assert.doesNotMatch(conversation, /id="f-sources"/);

    await app.request("/research", { cookie, form: { question: "And the shepherd?", thread: thread.split("#")[0]!.split("/").at(-1)!, scope_sources: "" } });
    assert.match(prompts().at(-1)![1]!.content, /\[1\] The Bible, John 3:16-17/, "the follow-up is searched with the question before it");
    assert.doesNotMatch(prompts().at(-1)![1]!.content, /Welcome, church/);

    const both = await app.request("/research", { cookie, form: { question: "What is grace?", scope_sources: "both" } });
    const [bothSystem, bothUser] = prompts().at(-1)!.map((message) => message.content) as [string, string];
    assert.match(bothSystem, /You help people study sermons preached at Grace Church\..*each marked "The Bible"\. Make clear which is which/);
    assert.match(bothUser, /\[1\] "(Grace Alone|Faith & Works)"/, "sermons first");
    assert.match(bothUser, /Welcome, church/);
    assert.match(bothUser, /\] The Bible, Genesis 1:1-2 \(World English Bible\)/);
    const numbers = [...bothUser.matchAll(/^\[(\d+)\] /gm)].map((match) => Number(match[1]));
    assert.deepEqual(numbers, numbers.map((_n, index) => index + 1), "one run of numbers across both");
    const bothPage = await (await app.request(both.headers.get("Location")!.split("#")[0]!, { cookie })).text();
    assert.match(bothPage, /Scope: <strong>All sermons, and the Bible<\/strong>/);
    assert.match(bothPage, /href="\/episodes\/[0-9a-f-]{36}#t-\d+"/);
    assert.match(bothPage, /href="\/bible\/genesis\/1#v1"/);

    const documents = app.documentRuns.created.length;
    await app.request("/research", { cookie, form: { question: "An outline on grace", kind: "outline", scope_sources: "bible" } });
    assert.equal(app.documentRuns.created.length, documents + 1, "documents are still written from the sermons");
    const saved = await app.env.DB.prepare("SELECT scope_json FROM documents ORDER BY created_at DESC LIMIT 1").first<{ scope_json: string }>();
    assert.doesNotMatch(saved!.scope_json, /sources/);
  } finally {
    site.restore();
  }
});

test("an admin sets what answers draw on and how much each search brings back", async () => {
  const site = await indexedSite();
  try {
    const { app, cookie } = site;
    await importBible(app.env, inlineStep);
    const sources = async (form: Record<string, string>) => {
      await app.request("/research", { cookie, form });
      const user = (site.providers.calls.filter((call) => call.url.endsWith("/chat/completions")).at(-1)!.body as { messages: { content: string }[] }).messages[1]!.content;
      return [...user.matchAll(/^\[\d+\] (?:The Bible, )?(.+?)(?: \(|:$)/gm)].map((match) => match[1]!);
    };
    const save = (changes: Record<string, string>) => app.request("/admin/sources", { cookie, form: {
      defaultSources: "", sermons_hits: "8", sermons_before: "2", sermons_after: "2", sermons_maxChars: "60000",
      bible_hits: "12", bible_before: "1", bible_after: "1", bible_maxChars: "30,000", ...changes,
    } });

    const page = await (await app.request("/admin/sources", { cookie })).text();
    assert.match(page, /name="bible_hits" type="number" min="1" max="40" step="1" value="12"/);
    assert.match(page, /name="sermons_before" type="number" min="0" max="10" step="1" value="2"/);
    assert.match(page, /href="\/admin\/sources" aria-current="page">Answer sources</);

    assert.deepEqual(await sources({ question: "What is light?", scope_sources: "bible" }), ["Genesis 1:1-2", "Psalms 23:1-2", "John 3:16-17", "Acts 8:36-38", "Jude 1:5"], "to start with, each match brings the passage on either side, joined to it");

    assert.equal((await save({ bible_hits: "2", bible_before: "0", bible_after: "0" })).headers.get("Location"), "/admin/sources?saved=1");
    assert.deepEqual(await sources({ question: "What is light?", scope_sources: "bible" }), ["Genesis 1:1-2", "Psalms 23:1"]);
    await save({ bible_hits: "2", bible_before: "0", bible_after: "1" });
    assert.deepEqual(await sources({ question: "What is light?", scope_sources: "bible" }), ["Genesis 1:1-2", "Psalms 23:1-2"]);
    await save({ bible_hits: "2", bible_before: "1", bible_after: "0" });
    assert.deepEqual(await sources({ question: "What is light?", scope_sources: "bible" }), ["Genesis 1:1-2", "Psalms 23:1"], "nothing comes before a chapter's first passage");
    await save({ bible_before: "0", bible_after: "0", bible_maxChars: "1000" });
    assert.deepEqual(await sources({ question: "What is light?", scope_sources: "bible" }), ["Genesis 1:1-2", "Psalms 23:1"], "the closest that fit the character limit");
    assert.deepEqual(await sources({ question: "What does Jude 5 say?", scope_sources: "bible" }), ["Jude 1:5", "Genesis 1:1-2", "Psalms 23:1"], "a verse the question names still comes first");

    const before = await sources({ question: "What is grace?" });
    assert.ok(before.length > 1);
    await save({ sermons_hits: "1", sermons_before: "0", sermons_after: "0" });
    assert.equal((await sources({ question: "What is grace?" })).length, 1);
    await save({ sermons_hits: "1", sermons_before: "0", sermons_after: "0", sermons_maxChars: "1000", bible_hits: "1" });
    assert.equal((await sources({ question: "What is grace?", scope_sources: "both" })).length, 2, "one of each");

    assert.doesNotMatch(await (await app.request("/", { cookie })).text(), /<option value="both" selected>/);
    await save({ defaultSources: "both" });
    assert.match(await (await app.request("/", { cookie })).text(), /<option value="both" selected>Sermons and the Bible/);
    assert.match(await (await app.request("/admin/sources", { cookie })).text(), /<option value="both" selected>/);

    const bad = await save({ bible_hits: "0", sermons_maxChars: "many" });
    assert.equal(bad.status, 400);
    const said = await bad.text();
    assert.match(said, /The Bible: “Passages to find” must be a whole number from 1 to 40\./);
    assert.match(said, /Sermons: “Character limit” must be a whole number from 1,000 to 400,000\./);
    assert.match(await (await app.request("/admin/sources", { cookie })).text(), /name="bible_hits"[^>]*value="12"/, "nothing was saved");

    await app.request("/admin/sources", { cookie, form: { intent: "reset" } });
    assert.match(await (await app.request("/admin/sources", { cookie })).text(), /name="sermons_hits"[^>]*value="8"/);
    assert.equal((await app.request("/admin/sources", { form: { intent: "reset" } })).headers.get("Location"), "/login");
  } finally {
    site.restore();
  }
});

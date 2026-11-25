import assert from "node:assert/strict";
import { test } from "node:test";

import { importBible } from "../src/bible.ts";
import { importOriginals, originalsState, originalVerses, parseGreek, parseHebrew, psalmTitleVerses, toOriginal, withoutCantillation } from "../src/originals.ts";
import { completeSetup, createApp, fakeProviders, GREEK_FILES, hebrewBook, indexedSite, inlineStep } from "./helpers.ts";

test("English chapter and verse numbers are turned into the Hebrew and Greek texts' own", () => {
  const place = (book: number, chapter: number, verse: number) => {
    const found = toOriginal(book, chapter, verse);
    return found ? `${found.chapter}:${found.verse}` : null;
  };
  assert.equal(place(1, 1, 1), "1:1");
  assert.equal(place(1, 31, 55), "32:1", "Genesis 31:55 opens the Hebrew's chapter 32");
  assert.equal(place(1, 32, 1), "32:2");
  assert.equal(place(29, 2, 28), "3:1", "Joel has four chapters in Hebrew");
  assert.equal(place(29, 3, 21), "4:21");
  assert.equal(place(39, 4, 6), "3:24", "and Malachi three");
  assert.equal(place(32, 1, 17), "2:1");
  assert.equal(place(27, 4, 1), "3:31");
  assert.equal(place(16, 7, 68), null, "the codex has no Nehemiah 7:68");
  assert.equal(place(16, 7, 69), "7:68");
  assert.equal(place(19, 23, 1), "23:1");
  assert.equal(place(19, 3, 1), "3:2", "a psalm's heading is the Hebrew's first verse");
  assert.equal(place(19, 51, 1), "51:3", "or its first two");
  assert.deepEqual([psalmTitleVerses(19, 51), psalmTitleVerses(19, 3), psalmTitleVerses(19, 23), psalmTitleVerses(1, 3)], [2, 1, 0, 0]);
  assert.equal(place(43, 3, 16), "3:16");
  assert.equal(place(45, 14, 24), "16:25", "the Greek text has Romans' closing praise at the end");
  assert.equal(place(47, 13, 14), "13:13");
});

test("the Greek and Hebrew files are read as published", () => {
  assert.deepEqual(parseGreek(GREEK_FILES.John!, 43).map((verse) => [verse.chapter, verse.verse, verse.text.slice(0, 12)]), [[3, 16, "Οὕτως γὰρ ἠγ"], [3, 17, "οὐ γὰρ ἀπέστ"]]);
  assert.doesNotMatch(parseGreek(GREEK_FILES.John!, 43)[1]!.text, /⸀/, "marks pointing to the apparatus are left out");
  assert.match(parseGreek(GREEK_FILES.John!, 43)[1]!.text, /τὸν υἱὸν εἰς/);

  const verses = parseHebrew(hebrewBook(`<c n="8"><v n="17">
    <w>כָּל־</w><w>הָאָ֖רֶץ</w><k>הוצא</k><q>הַיְצֵ֣א</q><w>בְּ<x>t</x>עֵ֖דֶן</w><w>אִתָּ֑ךְ</w><samekh/><reversednun/><w><s t="large">בְּ</s>רֵאשִׁ֖ית</w>
  </v><v n="18"><w></w></v></c><c n="9"><v n="1"><w>שָׁלוֹם׃</w><pe/></v></c>`), 1);
  assert.deepEqual(verses, [
    { book: 1, chapter: 8, verse: 17, text: "כָּל־הָאָ֖רֶץ [הוצא] הַיְצֵ֣א בְּעֵ֖דֶן אִתָּ֑ךְ ׆ בְּרֵאשִׁ֖ית" },
    { book: 1, chapter: 9, verse: 1, text: "שָׁלוֹם׃" },
  ], "words joined after a maqaf, the written form in brackets, notes and paragraph marks dropped");
  assert.equal(withoutCantillation("בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים"), "בְּרֵאשִׁית בָּרָא אֱלֹהִים", "vowels stay");
  assert.deepEqual(parseHebrew("<html>Checking your browser</html>", 1), []);
});

test("an admin adds the Greek and Hebrew; chapters show them, and Ask can answer with them", async () => {
  const site = await indexedSite();
  try {
    const { app, cookie } = site;
    const prompts = () => site.providers.calls.filter((call) => call.url.endsWith("/chat/completions")).map((call) => (call.body as { messages: { content: string }[] }).messages.map((message) => message.content));

    assert.match(await (await app.request("/admin/bible", { cookie })).text(), /<button type="submit" disabled>Add the Greek and Hebrew<\/button>[\s\S]*Add the English Bible first\./);
    await importBible(app.env, inlineStep);
    assert.doesNotMatch(await (await app.request("/bible/john/3", { cookie })).text(), /bible-views/, "no choice of text until they're added");
    assert.doesNotMatch(await (await app.request("/bible/john/3?text=both", { cookie })).text(), /lang="grc"/);
    assert.doesNotMatch(await (await app.request("/", { cookie })).text(), /with Greek and Hebrew/);
    await app.request("/research", { cookie, form: { question: "What does John 3:16 say?", scope_sources: "bible-original" } });
    assert.doesNotMatch(prompts().at(-1)![1]!, /in Greek/, "asked for before they're added, the answer comes from the English");

    assert.equal((await app.request("/admin/bible", { cookie, form: { texts: "originals" } })).status, 303);
    assert.match(app.bibleRuns.at(-1)!, /^originals-/);
    assert.equal(app.bibleRuns.length, 1, "the English Bible isn't added again");
    await importOriginals(app.env, inlineStep);
    const state = (await originalsState(app.env.DB))!;
    assert.deepEqual([state.status, state.hebrew, state.greek, state.error], ["done", 44, 29, null]);
    const fetched = site.providers.calls.filter((call) => /tanach\.us|SBLGNT/u.test(call.url));
    assert.equal(fetched.length, 66);
    assert.ok(fetched.every((call) => /sermon-research/u.test(call.userAgent ?? "")));
    assert.ok(fetched.some((call) => call.url === "https://tanach.us/Books/Song_of_Songs.xml") && fetched.some((call) => call.url.endsWith("/text/1Thess.txt")));
    assert.match(await (await app.request("/admin/bible", { cookie })).text(), /44 Hebrew verses and 29 Greek verses\.[\s\S]*Add them again/);

    const english = await (await app.request("/bible/john/3", { cookie })).text();
    assert.match(english, /<nav class="bible-views" aria-label="Text"><a href="\/bible\/john\/3" aria-current="true">English<\/a><a href="\/bible\/john\/3\?text=both">English and Greek<\/a><a href="\/bible\/john\/3\?text=original">Greek<\/a>/);
    const both = await (await app.request("/bible/john/3?text=both", { cookie })).text();
    assert.match(both, /<div class="pair verse" id="v16"><p><sup>16<\/sup>For God so loved the world[^<]*<\/p><p class="original" lang="grc" dir="ltr">Οὕτως γὰρ ἠγάπησεν/);
    assert.match(both, /SBL Greek New Testament, copyright 2010 Society of Biblical Literature and Logos Bible Software, used under CC BY 4\.0/);
    assert.match(both, /rel="next">John 4 →|rel="prev">← John 2/);
    assert.match(both, /href="\/bible\/john\/2\?text=both" rel="prev"/, "turning the page keeps the view");
    const hebrew = await (await app.request("/bible/genesis/1?text=original", { cookie })).text();
    assert.match(hebrew, /<div class="scripture chapter original" lang="he" dir="rtl"><span class="verse" id="v1"><sup>1<\/sup>בְּרֵאשִׁ֖ית בָּרָ֣א/);
    assert.match(hebrew, /Unicode\/XML Leningrad Codex \(UXLC\), Tanach\.us Inc\./);
    assert.match(hebrew, /English and Hebrew/);
    const missing = await (await app.request("/bible/jude/1?text=both", { cookie })).text();
    assert.match(missing, /<div class="pair verse" id="v5"><p><sup>5<\/sup>[^<]*&lt;i&gt;[^<]*<\/p><\/div>/, "a verse the text doesn't have just has no Greek under it");

    assert.deepEqual((await originalVerses(app.env.DB, 19, 51, 1, 1)).map((each) => [each.verse, each.original.verse]), [[0, 1], [0, 2], [1, 3]], "a psalm's heading comes first");
    assert.deepEqual((await originalVerses(app.env.DB, 19, 51, 2, 9)).map((each) => each.verse), []);

    const page = await (await app.request("/", { cookie })).text();
    assert.match(page, /<option value="both-original">Sermons and the Bible, with Greek and Hebrew<\/option><option value="bible-original">The Bible, with Greek and Hebrew<\/option><\/select>/);

    const asked = await app.request("/research", { cookie, form: { question: "What does John 3:16 say about love?", scope_sources: "bible-original" } });
    const [system, user] = prompts().at(-1)! as [string, string];
    assert.match(system, /Bible sources also give the same verses in Greek or Hebrew\..*don't make claims about manuscripts or variant readings/);
    assert.match(user, /\[1\] The Bible, John 3:16-17 \(World English Bible\):\nFor God so loved the world[^\n]*\nThe same verses in Greek \(SBL Greek New Testament\), numbered as that text numbers them:\n3:16 Οὕτως γὰρ ἠγάπησεν[^\n]* 3:17 οὐ γὰρ ἀπέστειλεν/);
    assert.match(user, /The Bible, Genesis 1:1-2 \(World English Bible\):\n[^\n]*\nThe same verses in Hebrew \(Unicode\/XML Leningrad Codex\), numbered as that text numbers them:\n1:1 בְּרֵאשִׁית בָּרָא אֱלֹהִים/, "Hebrew goes in without its cantillation");
    assert.doesNotMatch(user, /The Bible, Jude 1:5 \(World English Bible\):\n[^\n]*\nThe same verses/, "nothing is added where the text has no such verse");
    const conversation = await (await app.request(asked.headers.get("Location")!.split("#")[0]!, { cookie })).text();
    assert.match(conversation, /Scope: <strong>The Bible with its Greek and Hebrew<\/strong>/);
    assert.match(conversation, /<span class="hint">World English Bible · SBL Greek New Testament<\/span>/);
    assert.match(conversation, /<p class="quote original" dir="auto">3:16 Οὕτως/);
    assert.match(conversation, /name="scope_sources" value="bible-original"/);

    await app.request("/research", { cookie, form: { question: "What is grace?", scope_sources: "both-original" } });
    const [bothSystem, bothUser] = prompts().at(-1)! as [string, string];
    assert.match(bothSystem, /each marked "The Bible"\. Make clear which is which.*Bible sources also give the same verses in Greek or Hebrew/);
    assert.match(bothUser, /Welcome, church/);
    assert.match(bothUser, /The same verses in Hebrew/);

    await app.request("/research", { cookie, form: { question: "What is grace?", scope_sources: "bible" } });
    assert.doesNotMatch(prompts().at(-1)!.join("\n"), /The same verses in|Greek or Hebrew/, "the Bible alone stays English");

    await app.request("/admin/sources", { cookie, form: {
      defaultSources: "bible-original", sermons_hits: "8", sermons_before: "2", sermons_after: "2", sermons_maxChars: "60000", bible_hits: "12", bible_before: "1", bible_after: "1", bible_maxChars: "30000",
    } });
    assert.match(await (await app.request("/", { cookie })).text(), /<option value="bible-original" selected>/);
  } finally {
    site.restore();
  }
});

test("a source that doesn't answer is reported, and the texts already there stay", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  const providers = fakeProviders({ "https://tanach.us/": 503 });
  try {
    await app.request("/admin/bible", { cookie, form: { texts: "originals" } });
    await importOriginals(app.env, inlineStep);
    const state = (await originalsState(app.env.DB))!;
    assert.equal(state.status, "failed");
    assert.match(state.error!, /tanach\.us returned HTTP 503 for Genesis in the Unicode\/XML Leningrad Codex/);
    assert.match(await (await app.request("/admin/bible", { cookie })).text(), /Adding the Greek and Hebrew stopped: tanach\.us returned HTTP 503/);
    assert.equal((await app.request("/admin/bible", { form: { texts: "originals" } })).headers.get("Location"), "/login");
  } finally {
    providers.restore();
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { hourlyTick } from "../src/imports.ts";
import { getSetting } from "../src/settings.ts";
import { mentionedSpeaker, normalizeSpeaker, parseSpeakers } from "../src/speakers.ts";
import { indexedSite, type TestApp } from "./helpers.ts";

const isChat = (call: { url: string }) => call.url.endsWith("/chat/completions");

async function speakers(app: TestApp) {
  const { results } = await app.env.DB.prepare("SELECT id, speaker, speaker_source, description, author FROM episodes ORDER BY published_at DESC")
    .all<{ id: string; speaker: string | null; speaker_source: string | null; description: string | null; author: string | null }>();
  return results.map((row) => ({ ...row }));
}

test("each sermon's speaker is identified from the feed and the start of its transcript, and shown and filtered on", async () => {
  const site = await indexedSite();
  try {
    const [newer, older] = site.ids as [string, string];
    assert.deepEqual(await speakers(site.app), [
      { id: newer, speaker: "John Smith", speaker_source: "ai", description: "Sermon from John Smith on September 14, 2026", author: "Grace Church" },
      { id: older, speaker: "Jane Doe", speaker_source: "ai", description: null, author: null },
    ]);
    const asked = site.providers.calls.filter(isChat).map((call) => JSON.stringify(call.body)).find((body) => body.includes("who preached") && body.includes("Faith & Works"))!;
    assert.match(asked, /regular speakers are Jane Doe, John Smith/);
    assert.match(asked, /1\. \\"Faith & Works\\" \(2026-09-14\)\\nFeed author: Grace Church\\nFeed description: Sermon from John Smith on September 14, 2026\\nTranscript start: Welcome, church\. Today we read Ephesians 2:8\.…/);

    const all = await (await site.app.request("/episodes", { cookie: site.cookie })).text();
    assert.match(all, /<p class="hint">2026-09-14 · John Smith/);
    assert.match(all, /<select name="speaker" aria-label="Speaker"><option value="">All speakers<\/option><option value="Jane Doe">Jane Doe<\/option><option value="John Smith">John Smith<\/option><\/select>/);
    const johns = await (await site.app.request("/episodes?speaker=John+Smith", { cookie: site.cookie })).text();
    assert.match(johns, /Faith &amp; Works/);
    assert.doesNotMatch(johns, /Grace Alone/);
    assert.match(johns, /Speaker: John Smith · <a href="\/\?scope_speaker=John\+Smith">Ask about this speaker&#39;s sermons<\/a>/);
    const searched = await (await site.app.request("/episodes?q=smith", { cookie: site.cookie })).text();
    assert.match(searched.split("Related in meaning")[0]!, /Faith &amp; Works/, "keyword search matches the speaker");
    assert.doesNotMatch(searched.split("Related in meaning")[0]!, /Grace Alone/);

    const sermon = await (await site.app.request(`/episodes/${newer}`, { cookie: site.cookie })).text();
    assert.match(sermon, /· 2026-09-14 · <a href="\/episodes\?speaker=John%20Smith">John Smith<\/a> · Ephesians 2:1-10<\/p>/);
    assert.match(sermon, new RegExp(`<form class="row" method="post" action="/episodes/${newer}/speaker">`), "admins can correct it");
  } finally {
    site.restore();
  }
});

test("a question that names one speaker searches only their sermons", async () => {
  const site = await indexedSite();
  try {
    const [, older] = site.ids as [string, string];
    const asked = await site.app.request("/research", { form: { question: "What has Pastor Jane said about grace?" }, cookie: site.cookie });
    const thread = await (await site.app.request((asked.headers.get("Location") ?? "").split("#")[0]!, { cookie: site.cookie })).text();
    assert.match(thread, /Scope: <strong>Speaker: Jane Doe<\/strong>/);
    assert.deepEqual((site.app.vectors.queries.at(-1) as { filter?: unknown }).filter, { episodeId: { $in: [older] } });
    assert.match(JSON.stringify(site.providers.calls.filter(isChat).at(-1)!.body), /\[1\] \\"Grace Alone\\" \(2026-09-07, Jane Doe\), summary/, "the answers AI knows who said each passage");
    assert.match(thread, /<span class="hint">2026-09-07 · Jane Doe · summary<\/span>/);

    // Naming both speakers narrows to neither; a chosen scope is never overridden.
    await site.app.request("/research", { form: { question: "How do Jane Doe and John Smith describe grace?" }, cookie: site.cookie });
    assert.equal((site.app.vectors.queries.at(-1) as { filter?: unknown }).filter, undefined);
    await site.app.request("/research", { form: { question: "What did Pastor Jane say?", scope_speaker: "John Smith" }, cookie: site.cookie });
    assert.notDeepEqual((site.app.vectors.queries.at(-1) as { filter?: unknown }).filter, { episodeId: { $in: [older] } });

    const home = await (await site.app.request("/", { cookie: site.cookie })).text();
    assert.match(home, /<select id="f-scope-speaker" name="scope_speaker"><option value="">Any speaker<\/option><option value="Jane Doe">Jane Doe<\/option>/);
  } finally {
    site.restore();
  }
});

test("sermons recorded before speakers were kept are identified hourly, and an admin's correction stands", async () => {
  const site = await indexedSite();
  try {
    const [newer, older] = site.ids as [string, string];
    await site.app.env.DB.prepare("UPDATE episodes SET speaker = NULL, speaker_source = NULL, description = NULL, author = NULL").run();
    const before = await (await site.app.request("/admin/episodes", { cookie: site.cookie })).text();
    assert.match(before, /<dt>Speakers<\/dt><dd>0 named · 2 waiting for the AI, which checks hourly <form class="inline" method="post" action="\/admin\/episodes\/speakers"/);

    await hourlyTick(site.app.env, new Date());
    assert.deepEqual((await speakers(site.app)).map((row) => [row.speaker, row.speaker_source, row.description]), [
      ["John Smith", "ai", "Sermon from John Smith on September 14, 2026"],
      ["Jane Doe", "ai", null],
    ], "the feed is read once for descriptions, then the AI names each speaker");
    assert.ok(await getSetting(site.app.env.DB, "feed_details_at"));
    assert.match(await (await site.app.request("/admin/episodes", { cookie: site.cookie })).text(), /<dt>Speakers<\/dt><dd>2 named · fix one on its sermon page<\/dd>/);

    const saved = await site.app.request(`/episodes/${older}/speaker`, { form: { speaker: "  Guest   Preacher " }, cookie: site.cookie });
    assert.equal(saved.headers.get("Location"), `/episodes/${older}`);
    await site.app.env.DB.prepare("UPDATE episodes SET speaker_source = NULL WHERE speaker_source = 'ai'").run();
    const now = await site.app.request("/admin/episodes/speakers", { form: {}, cookie: site.cookie });
    assert.equal(decodeURIComponent(now.headers.get("Location") ?? ""), "/admin/episodes?notice=Checked 1 sermon for their speaker.");
    assert.deepEqual((await speakers(site.app)).map((row) => [row.id, row.speaker, row.speaker_source]), [[newer, "John Smith", "ai"], [older, "Guest Preacher", "admin"]]);

    await site.app.request(`/episodes/${older}/speaker`, { form: { speaker: "" }, cookie: site.cookie });
    assert.deepEqual((await speakers(site.app))[1]!.speaker, null, "a blank speaker means unknown, and the AI leaves it alone");
    assert.equal((await site.app.request(`/episodes/${older}/speaker`, { form: { speaker: "Someone" } })).headers.get("Location"), "/login");
    assert.equal((await speakers(site.app))[1]!.speaker, null);
  } finally {
    site.restore();
  }
});

test("speaker names are tidied, and a question names a speaker only when it's clear", () => {
  const known = ["Pastor Aaron Anderson", "Pastor Phil Friesen"];
  assert.equal(normalizeSpeaker("pastor phil   friesen", known), "Phil Friesen");
  assert.equal(normalizeSpeaker("Rev. Dr. Josh  Murphy", known), "Josh Murphy");
  assert.equal(normalizeSpeaker("Unknown", known), null);
  assert.equal(normalizeSpeaker(null, known), null);
  assert.equal(normalizeSpeaker(42, known), null);
  assert.deepEqual(parseSpeakers("```json\n{\"1\": \"Aaron Anderson\", \"3\": \"Pastor Phil Friesen\"}\n```", 3, known), ["Aaron Anderson", null, "Phil Friesen"]);
  assert.throws(() => parseSpeakers("I'm not sure", 1, known), /didn't return the speakers as JSON/);

  const named = (question: string) => mentionedSpeaker(question, ["Aaron Anderson", "Phil Friesen", "Mark Prater", "Grace Hopper"]);
  assert.equal(named("Search all of Pastor Phil's sermons and look for prayer"), "Phil Friesen");
  assert.equal(named("What did phil friesen say about anxiety?"), "Phil Friesen");
  assert.equal(named("Friesen on the church"), "Phil Friesen");
  assert.equal(named("What does Phil’s sermon on giving say?"), "Phil Friesen");
  assert.equal(named("What did Pastor Mark say about fear?"), "Mark Prater");
  assert.equal(named("What does Mark 4 teach about seeds?"), null, "a book of the Bible isn't a speaker");
  assert.equal(named("In Mark's gospel, who is Jesus?"), null);
  assert.equal(named("Is grace enough?"), null, "a first name that's also a word needs a title");
  assert.equal(named("Philippians 4 on anxiety"), null);
  assert.equal(named("Compare Pastor Aaron and Pastor Phil on prayer"), null, "several speakers aren't one scope");
});

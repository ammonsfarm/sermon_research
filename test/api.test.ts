import assert from "node:assert/strict";
import test from "node:test";

import { API_REQUESTS_PER_HOUR } from "../src/api-keys.ts";
import { createApp, indexedSite, ORIGIN, type TestApp } from "./helpers.ts";

/** Creates a key on Admin → API keys and returns it. */
async function createKey(app: TestApp, cookie: string, name = "Custom GPT"): Promise<string> {
  const response = await app.request("/admin/api", { form: { name }, cookie });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, new RegExp(`The key for ${name} is ready`));
  return /<pre>(sr_[A-Za-z0-9_-]+)<\/pre>/u.exec(body)![1]!;
}

const bearer = (key: string) => ({ headers: { Authorization: `Bearer ${key}` } });

test("admins create, list and revoke API keys; only a hash is stored", async () => {
  const site = await indexedSite();
  try {
    const page = await (await site.app.request("/admin/api", { cookie: site.cookie })).text();
    assert.match(page, /<li><a href="\/admin\/api" aria-current="page">API keys<\/a><\/li>/);
    assert.match(page, new RegExp(`${ORIGIN}/api/v1/openapi.json`), "the page says where a Custom GPT imports the API from");
    assert.equal((await site.app.request("/admin/api", { form: { name: " " }, cookie: site.cookie })).status, 400);

    const key = await createKey(site.app, site.cookie);
    const row = await site.app.env.DB.prepare("SELECT token_hash, prefix, last_used_at FROM api_keys").first<{ token_hash: string; prefix: string; last_used_at: string | null }>();
    assert.notEqual(row!.token_hash, key);
    assert.ok(key.startsWith(row!.prefix));
    assert.equal(row!.last_used_at, null);
    const listed = await (await site.app.request("/admin/api", { cookie: site.cookie })).text();
    assert.doesNotMatch(listed, new RegExp(key), "a key is shown only once");
    assert.match(listed, new RegExp(`${row!.prefix}…`));

    assert.equal((await site.app.request("/api/v1/filters", bearer(key))).status, 200);
    assert.ok((await site.app.env.DB.prepare("SELECT last_used_at FROM api_keys").first<{ last_used_at: string }>())!.last_used_at);

    const id = (await site.app.env.DB.prepare("SELECT id FROM api_keys").first<{ id: string }>())!.id;
    assert.equal((await site.app.request("/admin/api/revoke", { form: { id }, cookie: site.cookie })).headers.get("Location"), "/admin/api");
    assert.equal((await site.app.request("/api/v1/filters", bearer(key))).status, 401, "a revoked key stops working at once");
  } finally {
    site.restore();
  }
});

test("members can't manage API keys", async () => {
  const site = await indexedSite();
  try {
    const body = await (await site.app.request("/admin/members", { form: { name: "Sam Member", email: "sam@example.org" }, cookie: site.cookie })).text();
    const token = /invite\?token=([A-Za-z0-9_-]+)/u.exec(body)![1]!;
    const invited = await site.app.request("/invite", { form: { token, password: "a long enough password", confirm: "a long enough password" } });
    const member = (invited.headers.get("Set-Cookie") ?? "").split(";")[0]!;
    assert.equal((await site.app.request("/admin/api", { cookie: member })).status, 403);
    assert.equal((await site.app.request("/admin/api", { form: { name: "Sneaky" }, cookie: member })).status, 403);
    assert.equal((await site.app.request("/admin/api")).headers.get("Location"), "/login");
  } finally {
    site.restore();
  }
});

test("the API needs a valid key, except for its OpenAPI description", async () => {
  const site = await indexedSite();
  try {
    const missing = await site.app.request("/api/v1/search?q=grace");
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("WWW-Authenticate"), "Bearer");
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "unauthorized");
    assert.equal((await site.app.request("/api/v1/search?q=grace", bearer("sr_not-a-real-key"))).status, 401);
    assert.equal((await site.app.request("/api/v1/search?q=grace", { cookie: site.cookie })).status, 401, "a signed-in session isn't an API key");

    const spec = await site.app.request("/api/v1/openapi.json");
    assert.equal(spec.status, 200);
    assert.match(spec.headers.get("Content-Type") ?? "", /application\/json/);
    const doc = await spec.json() as { openapi: string; servers: { url: string }[]; info: { title: string; description: string }; paths: Record<string, { get: { operationId: string; description: string } }> };
    assert.equal(doc.openapi, "3.1.0");
    assert.deepEqual(doc.servers, [{ url: ORIGIN }]);
    assert.equal(doc.info.title, "Grace Sermons API");
    assert.match(doc.info.description, /Grace Church/);
    assert.deepEqual(Object.values(doc.paths).map((path) => path.get.operationId), ["searchSermons", "listSermons", "getSermon", "listFilters"]);
    for (const path of Object.values(doc.paths)) assert.ok(path.get.description.length <= 300, `${path.get.operationId}'s description fits GPT Actions' limit`);

    const key = await createKey(site.app, site.cookie);
    const posted = await site.app.request("/api/v1/search", { method: "POST", headers: { Authorization: `Bearer ${key}`, Origin: "https://chat.openai.com" } });
    assert.equal(posted.status, 405);
    assert.equal((await site.app.request("/api/v1/nothing", bearer(key))).status, 404);
  } finally {
    site.restore();
  }
});

test("the API isn't available before setup finishes", async () => {
  const app = createApp();
  const response = await app.request("/api/v1/filters", bearer("sr_whatever"));
  assert.equal(response.status, 503);
  assert.equal((await app.request("/api/v1/openapi.json")).status, 200);
});

test("search returns cited passages, filtered like a scoped question, without calling the answers AI", async () => {
  const site = await indexedSite();
  try {
    const [newer, older] = site.ids as [string, string];
    await site.app.env.DB.prepare("UPDATE episodes SET title = 'Grace Alone - Ephesians', speaker = 'Pastor Jane Doe' WHERE id = ?").bind(older).run();
    await site.app.env.DB.prepare("UPDATE episodes SET speaker = 'John Smith' WHERE id = ?").bind(newer).run();
    const key = await createKey(site.app, site.cookie);
    const chats = () => site.providers.calls.filter((call) => call.url.endsWith("/chat/completions")).length;
    const before = chats();

    const response = await site.app.request("/api/v1/search?q=What%20is%20grace%3F&limit=5", bearer(key));
    assert.equal(response.status, 200);
    const body = await response.json() as { query: string; results: { sermon_id: string; title: string; series: string | null; speaker: string | null; date: string; kind: string; timestamp: string | null; url: string; text: string }[] };
    assert.equal(body.query, "What is grace?");
    assert.ok(body.results.length > 0);
    const passage = body.results.find((result) => result.sermon_id === older && result.kind === "transcript")!;
    assert.equal(passage.title, "Grace Alone", "the series comes separately");
    assert.equal(passage.series, "Ephesians");
    assert.equal(passage.speaker, "Pastor Jane Doe");
    assert.equal(passage.date, "2026-09-07");
    assert.equal(passage.timestamp, "0:00");
    assert.match(passage.url, new RegExp(`^${ORIGIN}/episodes/${older}#t-\\d+$`));
    assert.match(passage.text, /Ephesians 2:8/);
    assert.equal(chats(), before, "the caller writes the answer; search makes no answers-AI calls");

    const bySpeaker = await (await site.app.request("/api/v1/search?q=grace&speaker=smith", bearer(key))).json() as typeof body;
    assert.ok(bySpeaker.results.length > 0);
    assert.ok(bySpeaker.results.every((result) => result.sermon_id === newer), "part of a speaker's name is enough, in any case");
    const bySeries = await (await site.app.request("/api/v1/search?q=grace&series=EPHESIANS", bearer(key))).json() as typeof body;
    assert.ok(bySeries.results.length > 0 && bySeries.results.every((result) => result.sermon_id === older));
    const byId = await (await site.app.request(`/api/v1/search?q=grace&sermon_id=${newer}`, bearer(key))).json() as typeof body;
    assert.ok(byId.results.length > 0 && byId.results.every((result) => result.sermon_id === newer));
    const none = await (await site.app.request("/api/v1/search?q=grace&from=2030-01-01", bearer(key))).json() as typeof body;
    assert.deepEqual(none.results, []);

    for (const bad of ["", "?q=", "?q=grace&limit=0", "?q=grace&limit=21", "?q=grace&from=last%20year", "?q=grace&sermon_id=nope", `?q=${"x".repeat(501)}`]) {
      assert.equal((await site.app.request(`/api/v1/search${bad}`, bearer(key))).status, 400, bad);
    }
  } finally {
    site.restore();
  }
});

test("search reports a broken embeddings key as unavailable instead of failing", async () => {
  const site = await indexedSite();
  try {
    const key = await createKey(site.app, site.cookie);
    await site.app.env.DB.prepare("DELETE FROM provider_keys WHERE slot = 'embeddings'").run();
    const response = await site.app.request("/api/v1/search?q=grace", bearer(key));
    assert.equal(response.status, 502);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "search_unavailable");
  } finally {
    site.restore();
  }
});

test("sermons, one sermon and filters", async () => {
  const site = await indexedSite();
  try {
    const [newer, older] = site.ids as [string, string];
    await site.app.env.DB.prepare("UPDATE episodes SET title = 'Grace Alone - Ephesians', speaker = 'Pastor Jane Doe' WHERE id = ?").bind(older).run();
    const key = await createKey(site.app, site.cookie);

    type Sermon = { id: string; title: string; series: string | null; speaker: string | null; date: string; main_scripture: string | null; topics: string[]; scriptures: string[]; summary: string; url: string; transcript?: string | null };
    const all = await (await site.app.request("/api/v1/sermons", bearer(key))).json() as { total: number; offset: number; sermons: Sermon[] };
    assert.equal(all.total, 2);
    assert.deepEqual(all.sermons.map((sermon) => sermon.id), [newer, older], "newest first");
    const grace = all.sermons[1]!;
    assert.equal(grace.title, "Grace Alone");
    assert.equal(grace.series, "Ephesians");
    assert.equal(grace.main_scripture, "Ephesians 2:1-10");
    assert.deepEqual(grace.topics, ["grace"]);
    assert.equal(grace.summary, "Grace is a gift.");
    assert.equal(grace.url, `${ORIGIN}/episodes/${older}`);
    assert.equal(grace.transcript, undefined, "the list leaves transcripts out");

    const oldest = await (await site.app.request("/api/v1/sermons?sort=oldest&limit=1", bearer(key))).json() as typeof all;
    assert.deepEqual([oldest.total, oldest.sermons.map((sermon) => sermon.id)], [2, [older]]);
    const paged = await (await site.app.request("/api/v1/sermons?limit=1&offset=1", bearer(key))).json() as typeof all;
    assert.deepEqual([paged.offset, paged.sermons.map((sermon) => sermon.id)], [1, [older]]);
    const series = await (await site.app.request("/api/v1/sermons?series=ephesians", bearer(key))).json() as typeof all;
    assert.deepEqual(series.sermons.map((sermon) => sermon.id), [older]);
    const words = await (await site.app.request("/api/v1/sermons?q=faith", bearer(key))).json() as typeof all;
    assert.deepEqual(words.sermons.map((sermon) => sermon.id), [newer], "q matches words in titles and summaries");
    const wildcard = await (await site.app.request("/api/v1/sermons?q=%25", bearer(key))).json() as typeof all;
    assert.equal(wildcard.total, 0, "LIKE wildcards are matched literally");
    assert.equal((await site.app.request("/api/v1/sermons?limit=500", bearer(key))).status, 400);

    const one = await (await site.app.request(`/api/v1/sermons/${older}`, bearer(key))).json() as Sermon;
    assert.equal(one.id, older);
    assert.equal(one.transcript, undefined);
    const full = await (await site.app.request(`/api/v1/sermons/${older}?transcript=true`, bearer(key))).json() as Sermon;
    assert.match(full.transcript!, /Welcome, church\. Today we read Ephesians 2:8\./);
    assert.equal((await site.app.request("/api/v1/sermons/00000000-0000-0000-0000-000000000000", bearer(key))).status, 404);

    const filters = await (await site.app.request("/api/v1/filters", bearer(key))).json() as { sermon_count: number; earliest: string; latest: string; series: { name: string; sermons: number }[]; speakers: { name: string; sermons: number }[] };
    assert.equal(filters.sermon_count, 2);
    assert.deepEqual([filters.earliest, filters.latest], ["2026-09-07", "2026-09-14"]);
    assert.deepEqual(filters.series, [{ name: "Ephesians", sermons: 1 }]);
    assert.ok(filters.speakers.some((speaker) => speaker.name === "Pastor Jane Doe" && speaker.sermons === 1));
  } finally {
    site.restore();
  }
});

test("each key is limited per hour", async () => {
  const site = await indexedSite();
  try {
    const key = await createKey(site.app, site.cookie);
    const other = await createKey(site.app, site.cookie, "Church website");
    const id = (await site.app.env.DB.prepare("SELECT id FROM api_keys WHERE name = 'Custom GPT'").first<{ id: string }>())!.id;
    const now = Date.now();
    await site.app.env.DB.batch(Array.from({ length: API_REQUESTS_PER_HOUR }, () => site.app.env.DB.prepare("INSERT INTO login_attempts (bucket, attempted_at) VALUES (?, ?)").bind(`api:${id}`, now)));
    const limited = await site.app.request("/api/v1/filters", bearer(key));
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("Retry-After"));
    assert.equal((await site.app.request("/api/v1/filters", bearer(other))).status, 200, "other keys aren't affected");
  } finally {
    site.restore();
  }
});

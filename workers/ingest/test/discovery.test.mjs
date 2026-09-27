import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { D1ProcessingStateStore } from "@aic/db";
import {
  createScheduledDiscoveryHandler,
  runEpisodeDiscovery,
} from "../src/discovery.ts";
import { D1DiscoveryRunStore } from "../src/discovery-store.ts";
import { createSoundCloudSource } from "../src/soundcloud.ts";

const migrationDirectory = new URL("../../../migrations/d1/", import.meta.url);
const now = "2026-09-05T12:00:00.000Z";

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) database.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
  return database;
}

class SqliteD1Statement {
  constructor(binding, sql, values = []) {
    this.binding = binding;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new SqliteD1Statement(this.binding, this.sql, values);
  }

  async first() {
    const row = this.binding.database.prepare(this.sql).get(...this.values) ?? null;
    await this.binding.afterFirst?.(this.sql, row);
    return row;
  }

  async all() {
    return { success: true, results: this.binding.database.prepare(this.sql).all(...this.values) };
  }

  async run() {
    const before = this.binding.database.prepare("SELECT total_changes() AS count").get().count;
    const result = this.binding.database.prepare(this.sql).run(...this.values);
    const after = this.binding.database.prepare("SELECT total_changes() AS count").get().count;
    return { success: true, meta: { changes: after - before, last_row_id: Number(result.lastInsertRowid) } };
  }
}

class SqliteD1Binding {
  constructor(database, { afterFirst, onPrepare } = {}) {
    this.database = database;
    this.afterFirst = afterFirst;
    this.onPrepare = onPrepare;
  }

  prepare(sql) {
    this.onPrepare?.(sql);
    return new SqliteD1Statement(this, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function rssItem({ id, title = `Episode ${id}`, pubDate = "Fri, 05 Sep 2026 10:00:00 GMT", guid, enclosure }) {
  const stableGuid = guid ?? `tag:soundcloud,2010:tracks/${id}`;
  const enclosureUrl = enclosure ?? `https://cf-media.sndcdn.com/tracks/${id}/stream/${id}-episode.mp3`;
  return `<item>
    <title>${title}</title>
    <pubDate>${pubDate}</pubDate>
    <guid isPermaLink="false">${stableGuid}</guid>
    <link>https://soundcloud.com/aic/${id}</link>
    <description>Description ${id}</description>
    <itunes:duration>12:34</itunes:duration>
    <itunes:summary>Summary ${id}</itunes:summary>
    <enclosure url="${enclosureUrl}" type="audio/mpeg" length="12345" />
  </item>`;
}

function rss(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0">
      <channel>${items.join("\n")}</channel>
    </rss>`;
}

test("SoundCloud source applies validators, stable IDs, cursor catch-up, and item bounds", async () => {
  const requests = [];
  let body = rss([rssItem({ id: "103" }), rssItem({ id: "102" }), rssItem({ id: "101" })]);
  let etag = '"feed-v1"';
  const source = createSoundCloudSource({
    feedUrl: "https://feeds.soundcloud.example.invalid/aic.rss",
    maxResponseBytes: 64_000,
    fetch: async (request) => {
      requests.push(request);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/rss+xml; charset=utf-8",
          etag,
          "last-modified": "Fri, 05 Sep 2026 10:01:00 GMT",
        },
      });
    },
  });

  const baseline = await source.discover({ sourceCursor: null, sourceValidator: null, maxItems: 2 });
  assert.deepEqual(
    baseline.records.map((record) => record.kind === "episode" ? record.episode.episodeId : "invalid"),
    ["102", "103"],
  );
  assert.match(baseline.sourceValidator, /^\{"etag":"\\"feed-v1\\"","lastModified":/u);
  assert.match(baseline.records[1].sourceCursor, /^sc:[0-9a-f]{64}$/u);
  assert.equal(baseline.hasMore, false);

  const baselineCursor = baseline.records.at(-1).sourceCursor;
  body = rss([rssItem({ id: "105" }), rssItem({ id: "104" }), rssItem({ id: "103", title: "Edited Episode 103" }), rssItem({ id: "102" })]);
  etag = '"feed-v2"';
  const catchupOne = await source.discover({
    sourceCursor: baselineCursor,
    sourceValidator: baseline.sourceValidator,
    maxItems: 1,
  });
  assert.deepEqual(catchupOne.records.map((record) => record.episode.episodeId), ["104"]);
  assert.equal(catchupOne.hasMore, true);
  assert.equal(requests[1].headers.get("if-none-match"), '"feed-v1"');
  assert.equal(requests[1].headers.get("if-modified-since"), "Fri, 05 Sep 2026 10:01:00 GMT");

  const catchupTwo = await source.discover({
    sourceCursor: catchupOne.records[0].sourceCursor,
    sourceValidator: catchupOne.sourceValidator,
    maxItems: 1,
  });
  assert.deepEqual(catchupTwo.records.map((record) => record.episode.episodeId), ["105"]);
});

test("SoundCloud source unwraps the feed's http Podtrac enclosures to the https SoundCloud stream", async () => {
  const source = createSoundCloudSource({
    feedUrl: "https://feeds.soundcloud.example.invalid/aic.rss",
    fetch: async () => new Response(rss([rssItem({
      id: "2407702221",
      title: "SAS Chapel: Q&amp;A, Part 6 &#8211; &lt;live&gt;",
      enclosure: "http://dts.podtrac.com/redirect.mp3/feeds.soundcloud.com/stream/2407702221-aic-episode.mp3",
    })]), { status: 200, headers: { "content-type": "application/rss+xml" } }),
  });
  const batch = await source.discover({ sourceCursor: null, sourceValidator: null, maxItems: 5 });
  assert.equal(batch.records.length, 1);
  assert.equal(batch.records[0].kind, "episode");
  assert.equal(batch.records[0].episode.episodeId, "2407702221");
  assert.equal(batch.records[0].episode.snapshot.title, "SAS Chapel: Q&A, Part 6 \u2013 <live>");
  assert.equal(
    batch.records[0].episode.snapshot.enclosureUrl,
    "https://feeds.soundcloud.com/stream/2407702221-aic-episode.mp3",
  );
});

test("SoundCloud source returns invalid item evidence and rejects unsafe or unbounded XML", async () => {
  const invalidSource = createSoundCloudSource({
    feedUrl: "https://feeds.soundcloud.example.invalid/aic.rss",
    maxResponseBytes: 64_000,
    fetch: async () => new Response(rss([
      rssItem({ id: "bad", guid: "not-a-soundcloud-track", enclosure: "https://example.invalid/no-track.mp3" }),
    ]), { headers: { "content-type": "application/xml" } }),
  });
  const invalid = await invalidSource.discover({ sourceCursor: null, sourceValidator: null, maxItems: 3 });
  assert.equal(invalid.records.length, 1);
  assert.deepEqual(
    { kind: invalid.records[0].kind, reason: invalid.records[0].reason },
    { kind: "invalid", reason: "stable_episode_identity_missing" },
  );
  assert.match(invalid.records[0].sourceCursor, /^sc:[0-9a-f]{64}$/u);

  const dtdSource = createSoundCloudSource({
    feedUrl: "https://feeds.soundcloud.example.invalid/aic.rss",
    maxResponseBytes: 64_000,
    fetch: async () => new Response(`<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel><title>&xxe;</title></channel></rss>`, {
      headers: { "content-type": "application/xml" },
    }),
  });
  await assert.rejects(
    dtdSource.discover({ sourceCursor: null, sourceValidator: null, maxItems: 3 }),
    (error) => error?.code === "unsafe_xml",
  );

  const oversizedSource = createSoundCloudSource({
    feedUrl: "https://feeds.soundcloud.example.invalid/aic.rss",
    maxResponseBytes: 16,
    fetch: async () => new Response(rss([]), { headers: { "content-type": "application/rss+xml" } }),
  });
  await assert.rejects(
    oversizedSource.discover({ sourceCursor: null, sourceValidator: null, maxItems: 3 }),
    (error) => error?.code === "response_too_large",
  );
});

test("unfinished catch-up clears the feed validator until every newer item is durable", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const discoveryStore = new D1DiscoveryRunStore({ db: binding, now: () => now });
    const requests = [];
    let currentEtag = '"feed-v1"';
    let currentBody = rss([rssItem({ id: "101" })]);
    const source = createSoundCloudSource({
      feedUrl: "https://feeds.soundcloud.example.invalid/aic.rss",
      maxResponseBytes: 64_000,
      fetch: async (request) => {
        requests.push(request);
        if (request.headers.get("if-none-match") === currentEtag) {
          return new Response(null, { status: 304, headers: { etag: currentEtag } });
        }
        return new Response(currentBody, {
          status: 200,
          headers: { "content-type": "application/rss+xml", etag: currentEtag },
        });
      },
    });
    const dispatch = async (requestId) => {
      database.prepare("UPDATE processing_executions SET status = 'running', started_at = ?, updated_at = ? WHERE request_id = ? AND status = 'starting'").run(now, now, requestId);
    };
    const run = (day) => runEpisodeDiscovery(runInput(binding, source, stateStore, discoveryStore, dispatch, {
      scheduledSlot: `scheduled:2026-09-0${day}T12:00:00.000Z`,
      scheduledUtcMinute: `2026-09-0${day}T12:00:00.000Z`,
      requestedAt: `2026-09-0${day}T12:00:00.000Z`,
      maxItems: 1,
    }));

    await run(5);
    currentEtag = '"feed-v2"';
    currentBody = rss([rssItem({ id: "103" }), rssItem({ id: "102" }), rssItem({ id: "101" })]);
    const firstCatchup = await run(6);
    const drained = await run(7);
    await run(8);

    assert.equal(firstCatchup.sourceValidator, null);
    assert.notEqual(drained.sourceValidator, null);
    assert.deepEqual(requests.map((request) => request.headers.get("if-none-match")), [null, '"feed-v1"', null, '"feed-v2"']);
    assert.deepEqual(
      database.prepare("SELECT entity_id FROM processing_requests ORDER BY entity_id").all().map((row) => row.entity_id),
      ["101", "102", "103"],
    );
  } finally {
    database.close();
  }
});

function episodeRecord(id, sourceCursor) {
  return {
    kind: "episode",
    sourceCursor,
    episode: {
      episodeId: id,
      snapshot: {
        source: "soundcloud-rss",
        episodeId: id,
        title: `Episode ${id}`,
        publishDate: "2026-09-05",
        pubDateRaw: "Fri, 05 Sep 2026 10:00:00 GMT",
        soundcloudUrl: `https://soundcloud.com/aic/${id}`,
        enclosureUrl: `https://cf-media.sndcdn.com/tracks/${id}/stream/${id}.mp3`,
        enclosureType: "audio/mpeg",
        enclosureLength: 12345,
        duration: "12:34",
        author: "AIC",
        explicit: "no",
        summary: `Summary ${id}`,
        subtitle: "",
        description: `Description ${id}`,
        imageUrl: "",
        category: "Episode",
        detail: id,
        guid: `tag:soundcloud,2010:tracks/${id}`,
      },
    },
  };
}

class CursorSource {
  constructor(records) {
    this.sourceAdapter = "soundcloud-rss";
    this.records = records;
    this.calls = [];
  }

  async discover(input) {
    this.calls.push(input);
    const cursorIndex = input.sourceCursor === null
      ? -1
      : this.records.findIndex((record) => record.sourceCursor === input.sourceCursor);
    const remaining = cursorIndex < 0 ? this.records : this.records.slice(cursorIndex + 1);
    return {
      records: remaining.slice(0, input.maxItems),
      sourceValidator: '{"etag":"synthetic-v1","lastModified":null}',
      hasMore: remaining.length > input.maxItems,
    };
  }
}

function runInput(binding, source, stateStore, discoveryStore, dispatch, overrides = {}) {
  return {
    source,
    stateStore,
    discoveryStore,
    dispatch,
    scheduledSlot: "scheduled:2026-09-05T12:00:00.000Z",
    scheduledUtcMinute: "2026-09-05T12:00:00.000Z",
    requestedAt: now,
    requestedBy: "cron:15 8 * * *",
    maxItems: 3,
    ...overrides,
  };
}

test("scheduled discovery persists bounded draft requests and repeated UTC slots are harmless", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const discoveryStore = new D1DiscoveryRunStore({ db: binding, now: () => now });
    const source = new CursorSource([
      { kind: "invalid", sourceCursor: "sc:invalid", reason: "stable_episode_identity_missing" },
      episodeRecord("2385860201", "sc:201"),
      episodeRecord("2385860202", "sc:202"),
    ]);
    const dispatched = [];
    const dispatch = async (requestId) => {
      dispatched.push(requestId);
      await stateStore.createOrGetInitialExecution(requestId);
      database.prepare("UPDATE processing_executions SET status = 'running', started_at = ?, updated_at = ? WHERE request_id = ?").run(now, now, requestId);
    };
    const options = runInput(binding, source, stateStore, discoveryStore, dispatch);
    const handler = createScheduledDiscoveryHandler(options);
    const controller = { scheduledTime: Date.parse("2026-09-05T12:00:45.000Z"), cron: "15 8 * * *", noRetry() {} };

    const first = await handler(controller);
    const replay = await handler(controller);
    assert.deepEqual(
      { seen: first.seenCount, fresh: first.newCount, duplicate: first.duplicateCount, invalid: first.invalidCount, dispatched: first.dispatchedCount },
      { seen: 3, fresh: 2, duplicate: 0, invalid: 1, dispatched: 2 },
    );
    assert.equal(first.status, "complete");
    assert.equal(replay.duplicateDelivery, true);
    assert.equal(source.calls.length, 1);
    assert.equal(source.calls[0].maxItems, 3);
    assert.equal(dispatched.length, 2);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_requests").get().count, 2);
    assert.deepEqual(
      database.prepare("SELECT desired_publication, input_snapshot_json FROM processing_requests ORDER BY entity_id").all().map((row) => ({
        desiredPublication: row.desired_publication,
        episodeId: JSON.parse(row.input_snapshot_json).episodeId,
      })),
      [
        { desiredPublication: "draft", episodeId: "2385860201" },
        { desiredPublication: "draft", episodeId: "2385860202" },
      ],
    );

    const duplicateSlot = await runEpisodeDiscovery(runInput(
      binding,
      new CursorSource([episodeRecord("2385860202", "sc:202-replay")]),
      stateStore,
      discoveryStore,
      dispatch,
      {
        scheduledSlot: "catch-up:2026-09-05T12:30:00.000Z:operator-1",
        scheduledUtcMinute: "2026-09-05T12:30:00.000Z",
        requestedBy: "operator-1",
      },
    ));
    assert.equal(duplicateSlot.newCount, 0);
    assert.equal(duplicateSlot.duplicateCount, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_requests WHERE entity_id = '2385860202'").get().count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_executions WHERE request_id IN (SELECT request_id FROM processing_requests WHERE entity_id = '2385860202')").get().count, 1);
  } finally {
    database.close();
  }
});

test("auto-publish discovery requests publication for every new episode", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const discoveryStore = new D1DiscoveryRunStore({ db: binding, now: () => now });
    const source = new CursorSource([episodeRecord("2385860301", "sc:301"), episodeRecord("2385860302", "sc:302")]);
    const dispatch = async (requestId) => { await stateStore.createOrGetInitialExecution(requestId); };
    const run = await runEpisodeDiscovery(runInput(binding, source, stateStore, discoveryStore, dispatch, { desiredPublication: "published" }));
    assert.equal(run.newCount, 2);
    assert.deepEqual(
      database.prepare("SELECT DISTINCT desired_publication FROM processing_requests").all().map((row) => row.desired_publication),
      ["published"],
    );
  } finally {
    database.close();
  }
});

test("concurrent delivery of one UTC slot has a single source reader", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const discoveryStore = new D1DiscoveryRunStore({ db: binding, now: () => now });
    const source = new CursorSource([episodeRecord("2385860250", "sc:250")]);
    const dispatch = async (requestId) => {
      database.prepare("UPDATE processing_executions SET status = 'running', started_at = ?, updated_at = ? WHERE request_id = ? AND status = 'starting'").run(now, now, requestId);
    };
    const options = runInput(binding, source, stateStore, discoveryStore, dispatch, { maxItems: 1 });

    const results = await Promise.all([
      runEpisodeDiscovery(options),
      runEpisodeDiscovery(options),
    ]);
    assert.equal(source.calls.length, 1);
    assert.equal(results.filter((result) => result.duplicateDelivery).length, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_requests").get().count, 1);
  } finally {
    database.close();
  }
});

test("durable cursor progress recovers an undispatched starting request without losing or duplicating it", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const discoveryStore = new D1DiscoveryRunStore({ db: binding, now: () => now });
    const source = new CursorSource([
      episodeRecord("2385860301", "sc:301"),
      episodeRecord("2385860302", "sc:302"),
    ]);
    let failSecond = true;
    const dispatchCalls = [];
    const dispatch = async (requestId) => {
      dispatchCalls.push(requestId);
      if (failSecond && database.prepare("SELECT entity_id FROM processing_requests WHERE request_id = ?").get(requestId).entity_id === "2385860302") {
        failSecond = false;
        throw new Error("synthetic dispatch interruption");
      }
      database.prepare("UPDATE processing_executions SET status = 'running', started_at = ?, updated_at = ? WHERE request_id = ? AND status = 'starting'").run(now, now, requestId);
    };
    const options = runInput(binding, source, stateStore, discoveryStore, dispatch, { maxItems: 2 });

    await assert.rejects(runEpisodeDiscovery(options), /synthetic dispatch interruption/u);
    const failed = database.prepare("SELECT * FROM processing_discovery_runs").get();
    assert.equal(failed.status, "failed");
    assert.equal(failed.source_cursor, "sc:302");
    assert.equal(failed.new_count, 2);
    assert.equal(failed.dispatched_count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_executions WHERE status = 'starting'").get().count, 1);

    const nextSource = new CursorSource([]);
    const recovered = await runEpisodeDiscovery(runInput(
      binding,
      nextSource,
      stateStore,
      discoveryStore,
      dispatch,
      {
        scheduledSlot: "scheduled:2026-09-06T12:00:00.000Z",
        scheduledUtcMinute: "2026-09-06T12:00:00.000Z",
        requestedAt: "2026-09-06T12:00:00.000Z",
      },
    ));
    assert.equal(recovered.status, "complete");
    assert.equal(recovered.newCount, 0);
    assert.equal(recovered.duplicateCount, 0);
    assert.equal(recovered.dispatchedCount, 0);
    assert.equal(database.prepare("SELECT dispatched_count FROM processing_discovery_runs WHERE scheduled_slot = ?").get(options.scheduledSlot).dispatched_count, 2);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_requests").get().count, 2);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_executions").get().count, 2);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_executions WHERE status = 'running'").get().count, 2);
    assert.equal(source.calls.length, 1);
    assert.equal(nextSource.calls.length, 1);
    assert.equal(dispatchCalls.length, 3);
  } finally {
    database.close();
  }
});

test("a crash after durable execution allocation but before cursor progress preserves new-request accounting", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const durableStateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const discoveryStore = new D1DiscoveryRunStore({ db: binding, now: () => now });
    const source = new CursorSource([episodeRecord("2385860401", "sc:401")]);
    let interruptAfterAllocation = true;
    const stateStore = {
      createOrGetRequest: (input) => durableStateStore.createOrGetRequest(input),
      async createOrGetInitialExecution(requestId) {
        const execution = await durableStateStore.createOrGetInitialExecution(requestId);
        if (interruptAfterAllocation) {
          interruptAfterAllocation = false;
          throw new Error("synthetic crash after allocation");
        }
        return execution;
      },
    };
    const dispatch = async (requestId) => {
      database.prepare("UPDATE processing_executions SET status = 'running', started_at = ?, updated_at = ? WHERE request_id = ? AND status = 'starting'").run(now, now, requestId);
    };
    const options = runInput(binding, source, stateStore, discoveryStore, dispatch, { maxItems: 1 });

    await assert.rejects(runEpisodeDiscovery(options), /synthetic crash after allocation/u);
    assert.deepEqual(
      { ...database.prepare("SELECT source_cursor, seen_count, new_count, dispatched_count, status FROM processing_discovery_runs").get() },
      { source_cursor: null, seen_count: 0, new_count: 0, dispatched_count: 0, status: "failed" },
    );
    const recovered = await runEpisodeDiscovery(options);
    assert.deepEqual(
      { seen: recovered.seenCount, fresh: recovered.newCount, duplicate: recovered.duplicateCount, dispatched: recovered.dispatchedCount },
      { seen: 1, fresh: 1, duplicate: 0, dispatched: 1 },
    );
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_requests").get().count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_executions").get().count, 1);
  } finally {
    database.close();
  }
});

test("same-slot recovery allocates a missing initial execution without replaying RSS", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const durableStateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const discoveryStore = new D1DiscoveryRunStore({ db: binding, now: () => now });
    const source = new CursorSource([episodeRecord("2385860501", "sc:501")]);
    let interruptBeforeAllocation = true;
    const stateStore = {
      createOrGetRequest: (input) => durableStateStore.createOrGetRequest(input),
      async createOrGetInitialExecution(requestId) {
        if (interruptBeforeAllocation) {
          interruptBeforeAllocation = false;
          throw new Error("synthetic crash before allocation");
        }
        return durableStateStore.createOrGetInitialExecution(requestId);
      },
    };
    const dispatch = async (requestId) => {
      database.prepare("UPDATE processing_executions SET status = 'running', started_at = ?, updated_at = ? WHERE request_id = ? AND status = 'starting'").run(now, now, requestId);
    };
    const options = runInput(binding, source, stateStore, discoveryStore, dispatch, { maxItems: 1 });

    await assert.rejects(runEpisodeDiscovery(options), /synthetic crash before allocation/u);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_requests").get().count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_executions").get().count, 0);
    source.records = [];
    const recovered = await runEpisodeDiscovery(options);

    assert.deepEqual(
      { seen: recovered.seenCount, fresh: recovered.newCount, dispatched: recovered.dispatchedCount },
      { seen: 1, fresh: 1, dispatched: 1 },
    );
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_executions WHERE status = 'running'").get().count, 1);
    assert.equal(source.calls.length, 1);
  } finally {
    database.close();
  }
});

test("pre-progress recovery does not double-count a run-owned request when RSS replays it", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const durableStateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const discoveryStore = new D1DiscoveryRunStore({ db: binding, now: () => now });
    const source = new CursorSource([
      episodeRecord("2385860551", "sc:551"),
      episodeRecord("2385860552", "sc:552"),
    ]);
    let interruptAfterAllocation = true;
    const stateStore = {
      createOrGetRequest: (input) => durableStateStore.createOrGetRequest(input),
      async createOrGetInitialExecution(requestId) {
        const execution = await durableStateStore.createOrGetInitialExecution(requestId);
        if (interruptAfterAllocation) {
          interruptAfterAllocation = false;
          throw new Error("synthetic crash after allocation");
        }
        return execution;
      },
    };
    const dispatch = async (requestId) => {
      database.prepare("UPDATE processing_executions SET status = 'running', started_at = ?, updated_at = ? WHERE request_id = ? AND status = 'starting'").run(now, now, requestId);
    };
    const options = runInput(binding, source, stateStore, discoveryStore, dispatch, { maxItems: 2 });

    await assert.rejects(runEpisodeDiscovery(options), /synthetic crash after allocation/u);
    const recovered = await runEpisodeDiscovery(options);

    assert.deepEqual(
      { seen: recovered.seenCount, fresh: recovered.newCount, duplicate: recovered.duplicateCount, dispatched: recovered.dispatchedCount },
      { seen: 2, fresh: 1, duplicate: 1, dispatched: 1 },
    );
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_requests").get().count, 1);
    assert.equal(source.calls.length, 2);
    assert.equal(source.calls[1].maxItems, 1);
  } finally {
    database.close();
  }
});

test("later-slot recovery allocates a missing execution even when newer RSS items exclude it", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const durableStateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const discoveryStore = new D1DiscoveryRunStore({ db: binding, now: () => now });
    const originalSource = new CursorSource([episodeRecord("2385860601", "sc:601")]);
    let interruptBeforeAllocation = true;
    const stateStore = {
      createOrGetRequest: (input) => durableStateStore.createOrGetRequest(input),
      async createOrGetInitialExecution(requestId) {
        if (interruptBeforeAllocation) {
          interruptBeforeAllocation = false;
          throw new Error("synthetic crash before allocation");
        }
        return durableStateStore.createOrGetInitialExecution(requestId);
      },
    };
    const dispatch = async (requestId) => {
      database.prepare("UPDATE processing_executions SET status = 'running', started_at = ?, updated_at = ? WHERE request_id = ? AND status = 'starting'").run(now, now, requestId);
    };
    const failedInput = runInput(binding, originalSource, stateStore, discoveryStore, dispatch, { maxItems: 1 });
    await assert.rejects(runEpisodeDiscovery(failedInput), /synthetic crash before allocation/u);

    const newerSource = new CursorSource([
      episodeRecord("2385860602", "sc:602"),
      episodeRecord("2385860603", "sc:603"),
    ]);
    await runEpisodeDiscovery(runInput(binding, newerSource, stateStore, discoveryStore, dispatch, {
      scheduledSlot: "scheduled:2026-09-06T12:00:00.000Z",
      scheduledUtcMinute: "2026-09-06T12:00:00.000Z",
      requestedAt: "2026-09-06T12:00:00.000Z",
      maxItems: 2,
    }));

    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_executions WHERE status = 'running'").get().count, 2);
    assert.deepEqual(
      database.prepare("SELECT entity_id FROM processing_requests ORDER BY entity_id").all().map((row) => row.entity_id),
      ["2385860601", "2385860602"],
    );
    assert.deepEqual(
      { ...database.prepare("SELECT seen_count, new_count, dispatched_count FROM processing_discovery_runs WHERE scheduled_slot = ?").get(failedInput.scheduledSlot) },
      { seen_count: 1, new_count: 1, dispatched_count: 1 },
    );
  } finally {
    database.close();
  }
});

test("later-slot recovery repairs pre-progress accounting without spending beyond maxItems", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const durableStateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const discoveryStore = new D1DiscoveryRunStore({ db: binding, now: () => now });
    const originalSource = new CursorSource([episodeRecord("2385860701", "sc:701")]);
    let interruptAfterAllocation = true;
    const stateStore = {
      createOrGetRequest: (input) => durableStateStore.createOrGetRequest(input),
      async createOrGetInitialExecution(requestId) {
        const execution = await durableStateStore.createOrGetInitialExecution(requestId);
        if (interruptAfterAllocation) {
          interruptAfterAllocation = false;
          throw new Error("synthetic crash after allocation");
        }
        return execution;
      },
    };
    const dispatch = async (requestId) => {
      database.prepare("UPDATE processing_executions SET status = 'running', started_at = ?, updated_at = ? WHERE request_id = ? AND status = 'starting'").run(now, now, requestId);
    };
    const failedInput = runInput(binding, originalSource, stateStore, discoveryStore, dispatch, { maxItems: 1 });
    await assert.rejects(runEpisodeDiscovery(failedInput), /synthetic crash after allocation/u);

    const nextSource = new CursorSource([episodeRecord("2385860702", "sc:702")]);
    await runEpisodeDiscovery(runInput(binding, nextSource, stateStore, discoveryStore, dispatch, {
      scheduledSlot: "scheduled:2026-09-06T12:00:00.000Z",
      scheduledUtcMinute: "2026-09-06T12:00:00.000Z",
      requestedAt: "2026-09-06T12:00:00.000Z",
      maxItems: 1,
    }));

    assert.deepEqual(
      { ...database.prepare("SELECT seen_count, new_count, duplicate_count, invalid_count, dispatched_count FROM processing_discovery_runs WHERE scheduled_slot = ?").get(failedInput.scheduledSlot) },
      { seen_count: 1, new_count: 1, duplicate_count: 0, invalid_count: 0, dispatched_count: 1 },
    );
    assert.equal(nextSource.calls.length, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_requests").get().count, 1);
  } finally {
    database.close();
  }
});

test("later accounting repair survives a lost dispatch response after execution reaches running", async () => {
  const database = await migratedDatabase();
  try {
    const binding = new SqliteD1Binding(database);
    const durableStateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const discoveryStore = new D1DiscoveryRunStore({ db: binding, now: () => now });
    const originalSource = new CursorSource([episodeRecord("2385860751", "sc:751")]);
    let interruptAfterAllocation = true;
    const stateStore = {
      createOrGetRequest: (input) => durableStateStore.createOrGetRequest(input),
      async createOrGetInitialExecution(requestId) {
        const execution = await durableStateStore.createOrGetInitialExecution(requestId);
        if (interruptAfterAllocation) {
          interruptAfterAllocation = false;
          throw new Error("synthetic crash after allocation");
        }
        return execution;
      },
    };
    let loseResponseOnce = false;
    const dispatchCalls = [];
    const dispatch = async (requestId) => {
      dispatchCalls.push(requestId);
      database.prepare("UPDATE processing_executions SET status = 'running', started_at = ?, updated_at = ? WHERE request_id = ? AND status = 'starting'").run(now, now, requestId);
      if (loseResponseOnce) {
        loseResponseOnce = false;
        throw new Error("lost dispatch response before accounting");
      }
    };
    const firstInput = runInput(binding, originalSource, stateStore, discoveryStore, dispatch, { maxItems: 1 });
    await assert.rejects(runEpisodeDiscovery(firstInput), /synthetic crash after allocation/u);

    const emptySource = new CursorSource([]);
    loseResponseOnce = true;
    await assert.rejects(runEpisodeDiscovery(runInput(binding, emptySource, stateStore, discoveryStore, dispatch, {
      scheduledSlot: "scheduled:2026-09-06T12:00:00.000Z",
      scheduledUtcMinute: "2026-09-06T12:00:00.000Z",
      requestedAt: "2026-09-06T12:00:00.000Z",
      maxItems: 1,
    })), /lost dispatch response before accounting/u);

    await runEpisodeDiscovery(runInput(binding, emptySource, stateStore, discoveryStore, dispatch, {
      scheduledSlot: "scheduled:2026-09-07T12:00:00.000Z",
      scheduledUtcMinute: "2026-09-07T12:00:00.000Z",
      requestedAt: "2026-09-07T12:00:00.000Z",
      maxItems: 1,
    }));
    assert.deepEqual(
      { ...database.prepare("SELECT seen_count, new_count, duplicate_count, invalid_count, dispatched_count, status FROM processing_discovery_runs WHERE scheduled_slot = ?").get(firstInput.scheduledSlot) },
      { seen_count: 1, new_count: 1, duplicate_count: 0, invalid_count: 0, dispatched_count: 1, status: "failed" },
    );

    await runEpisodeDiscovery(runInput(binding, emptySource, stateStore, discoveryStore, dispatch, {
      scheduledSlot: "scheduled:2026-09-08T12:00:00.000Z",
      scheduledUtcMinute: "2026-09-08T12:00:00.000Z",
      requestedAt: "2026-09-08T12:00:00.000Z",
      maxItems: 1,
    }));
    assert.equal(dispatchCalls.length, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_executions WHERE status = 'running'").get().count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_requests").get().count, 1);
    assert.equal(emptySource.calls.length, 2);
  } finally {
    database.close();
  }
});

test("accounting repair pages indexed owners before counting and reaches a later mismatch with a fixed clock", async () => {
  const database = await migratedDatabase();
  try {
    const seedBinding = new SqliteD1Binding(database);
    const stateStore = new D1ProcessingStateStore({ db: seedBinding, now: () => now });
    const seedStore = new D1DiscoveryRunStore({ db: seedBinding, now: () => now });
    const dispatch = async (requestId) => {
      database.prepare("UPDATE processing_executions SET status = 'running', started_at = ?, updated_at = ? WHERE request_id = ? AND status = 'starting'").run(now, now, requestId);
    };
    for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
      await runEpisodeDiscovery(runInput(
        seedBinding,
        new CursorSource([episodeRecord(`23858609${ordinal}`, `sc:90${ordinal}`)]),
        stateStore,
        seedStore,
        dispatch,
        {
          scheduledSlot: `scheduled:2026-09-0${ordinal}T11:00:00.000Z`,
          scheduledUtcMinute: `2026-09-0${ordinal}T11:00:00.000Z`,
          requestedAt: `2026-09-0${ordinal}T11:00:00.000Z`,
          maxItems: 1,
        },
      ));
    }

    database.prepare("UPDATE processing_discovery_runs SET status = 'failed', completed_at = NULL, updated_at = ?").run(now);
    const orderedIds = database.prepare("SELECT discovery_run_id FROM processing_discovery_runs ORDER BY discovery_run_id").all().map((row) => row.discovery_run_id);
    const laterMismatch = orderedIds.at(-1);
    database.prepare("UPDATE processing_discovery_runs SET seen_count = 0, new_count = 0, dispatched_count = 0 WHERE discovery_run_id = ?").run(laterMismatch);

    const preparedSql = [];
    const binding = new SqliteD1Binding(database, { onPrepare: (sql) => preparedSql.push(sql) });
    const discoveryStore = new D1DiscoveryRunStore({ db: binding, now: () => now });
    let foundAt = -1;
    for (let page = 0; page < orderedIds.length; page += 1) {
      const before = preparedSql.length;
      const mismatches = await discoveryStore.listPriorRunIdsNeedingAccounting("p6d-current-run", 1);
      const pageSql = preparedSql.slice(before);
      assert.ok(pageSql.filter((sql) => sql.includes("FROM processing_requests r")).length <= 2);
      assert.ok(pageSql.filter((sql) => sql.includes("FROM processing_discovery_runs") && sql.includes("ORDER BY updated_at")).length <= 3);
      if (mismatches.length > 0) {
        assert.deepEqual(mismatches, [laterMismatch]);
        foundAt = page;
      }
      for (const runId of mismatches) await discoveryStore.refreshDispatchedCount(runId);
      if (foundAt >= 0) break;
    }
    assert.ok(foundAt > 0 && foundAt < orderedIds.length, `later mismatch was found on page ${foundAt}`);
    assert.deepEqual(
      { ...database.prepare("SELECT seen_count, new_count, dispatched_count FROM processing_discovery_runs WHERE discovery_run_id = ?").get(laterMismatch) },
      { seen_count: 1, new_count: 1, dispatched_count: 1 },
    );

    const candidateSql = preparedSql.find((sql) => sql.includes("FROM processing_discovery_runs") && sql.includes("ORDER BY updated_at"));
    const ownerSql = preparedSql.find((sql) => sql.includes("FROM processing_requests r") && sql.includes("WHERE r.requested_by = ?"));
    assert.ok(candidateSql, "candidate-page SQL was captured");
    assert.ok(ownerSql, "per-owner accounting SQL was captured");
    const candidatePlan = database.prepare(`EXPLAIN QUERY PLAN ${candidateSql}`).all("failed", "p6d-current-run", 1).map((row) => row.detail);
    const ownerPlan = database.prepare(`EXPLAIN QUERY PLAN ${ownerSql}`).all(`discovery:${laterMismatch}`).map((row) => row.detail);
    assert.ok(candidatePlan.some((detail) => detail.includes("idx_processing_discovery_runs_accounting_order")), candidatePlan.join("\n"));
    assert.ok(ownerPlan.some((detail) => detail.includes("idx_processing_requests_discovery_owner")), ownerPlan.join("\n"));
    assert.equal(ownerSql.includes("GROUP BY"), false);
    assert.equal(ownerPlan.some((detail) => /^SCAN r(?:\s|$)/u.test(detail)), false, ownerPlan.join("\n"));
  } finally {
    database.close();
  }
});

test("concurrent retries of one failed slot elect one source reader with a winning claim", async () => {
  const database = await migratedDatabase();
  try {
    const seedBinding = new SqliteD1Binding(database);
    const seededStore = new D1DiscoveryRunStore({ db: seedBinding, now: () => now });
    const source = new CursorSource([episodeRecord("2385860801", "sc:801")]);
    const input = runInput(seedBinding, source, null, seededStore, async () => {}, { maxItems: 1 });
    const seeded = await seededStore.begin({
      sourceAdapter: source.sourceAdapter,
      scheduledSlot: input.scheduledSlot,
      scheduledUtcMinute: input.scheduledUtcMinute,
      requestedAt: input.requestedAt,
      requestedBy: input.requestedBy,
    });
    await seededStore.fail(seeded.discoveryRunId, "synthetic retry seed");

    let arrivals = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const binding = new SqliteD1Binding(database, {
      afterFirst: async (sql, row) => {
        if (!sql.includes("WHERE source_adapter = ? AND scheduled_slot = ?") || row?.status !== "failed") return;
        arrivals += 1;
        if (arrivals === 2) release();
        await gate;
      },
    });
    const stateStore = new D1ProcessingStateStore({ db: binding, now: () => now });
    const discoveryStore = new D1DiscoveryRunStore({ db: binding, now: () => now });
    const dispatch = async (requestId) => {
      database.prepare("UPDATE processing_executions SET status = 'running', started_at = ?, updated_at = ? WHERE request_id = ? AND status = 'starting'").run(now, now, requestId);
    };
    const options = runInput(binding, source, stateStore, discoveryStore, dispatch, { maxItems: 1 });

    const results = await Promise.all([
      runEpisodeDiscovery(options),
      runEpisodeDiscovery(options),
    ]);

    assert.equal(arrivals, 2);
    assert.equal(source.calls.length, 1);
    assert.equal(results.filter((result) => result.duplicateDelivery).length, 1);
    assert.deepEqual(
      { ...database.prepare("SELECT source_cursor, seen_count, new_count, dispatched_count, status FROM processing_discovery_runs").get() },
      { source_cursor: "sc:801", seen_count: 1, new_count: 1, dispatched_count: 1, status: "complete" },
    );
  } finally {
    database.close();
  }
});

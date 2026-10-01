import assert from "node:assert/strict";
import test from "node:test";

import { FeedError, parseDuration, parseFeed } from "../src/feed.ts";
import { FEED_XML } from "./helpers.ts";

test("parses podcast title, episodes, CDATA and entities", () => {
  const feed = parseFeed(FEED_XML);
  assert.equal(feed.title, "Grace Church Sermons");
  assert.deepEqual(feed.episodes[0], {
    guid: "ep-2",
    title: "Faith & Works",
    publishedAt: "2026-09-14T15:00:00.000Z",
    audioUrl: "https://cdn.example.org/ep2.mp3?a=1&b=2",
    durationSeconds: 2730,
    description: "Sermon from John Smith on September 14, 2026",
    author: "Grace Church",
  });
  assert.equal(feed.episodes[1]?.durationSeconds, 2700);
  assert.equal(feed.episodes[1]?.description, null);
});

test("falls back to the audio URL when an item has no guid", () => {
  const feed = parseFeed(`<rss><channel><title>T</title><item><title>A</title><enclosure url='https://x.example/a.mp3'/></item><item><title>No id</title></item></channel></rss>`);
  assert.equal(feed.episodes.length, 1);
  assert.equal(feed.episodes[0]?.guid, "https://x.example/a.mp3");
  assert.equal(feed.episodes[0]?.publishedAt, null);
});

test("rejects pages that are not RSS", () => {
  assert.throws(() => parseFeed("<html><body>Hello</body></html>"), FeedError);
});

test("reads every duration shape podcasts use", () => {
  assert.equal(parseDuration("3600"), 3600);
  assert.equal(parseDuration("59:30"), 3570);
  assert.equal(parseDuration("1:02:03"), 3723);
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("abc"), null);
});

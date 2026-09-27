import assert from "node:assert/strict";
import test from "node:test";

import { editorialTimestamp, episodeSlug } from "../src/repository.ts";

test("editorial rows get six-digit fractional timestamps", () => {
  assert.equal(editorialTimestamp("2026-09-27T00:33:17.346Z"), "2026-09-27T00:33:17.346000Z");
  assert.equal(editorialTimestamp("2026-09-27T00:33:17.346000Z"), "2026-09-27T00:33:17.346000Z");
});

test("episode slugs are readable and unique by track ID", () => {
  assert.equal(episodeSlug("Clayton Wood: Salt and Light in Politics", "2407702221"), "clayton-wood-salt-and-light-in-politics-2407702221");
  assert.equal(episodeSlug("SAS Chapel: Q&A, Part 6", "2405342310"), "sas-chapel-q-and-a-part-6-2405342310");
  assert.equal(episodeSlug("   ", "1"), "episode-1");
});

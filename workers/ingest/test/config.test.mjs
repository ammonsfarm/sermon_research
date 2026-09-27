import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { scheduleDailyDiscovery, shouldRunDailyDiscovery } from "../src/discovery.ts";

const workerDirectory = new URL("../", import.meta.url);

test("aic-ingest is an unrouted Scheduled Trigger and episode Workflow host with frozen bindings", async () => {
  const config = JSON.parse(await readFile(new URL("wrangler.jsonc", workerDirectory), "utf8"));
  assert.equal(config.name, "aic-ingest");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal("routes" in config, false);
  assert.deepEqual(config.triggers.crons, ["15 8 * * *", "15 9 * * *"]);
  assert.equal(config.vars.SILO_INTELLIGENCE_BACKEND_MODE, "codex-direct");
  assert.equal(config.vars.SILO_INTELLIGENCE_REASONING, "medium");
  assert.equal(config.vars.SILO_INTELLIGENCE_MAX_TOKENS, "4096");
  assert.deepEqual(config.d1_databases.map(({ binding }) => binding), ["AIC_DB"]);
  assert.equal(config.d1_databases[0].database_name, "aic-p4-local");
  assert.equal(config.d1_databases[0].database_id, "00000000-0000-0000-0000-000000000004");
  assert.deepEqual(config.r2_buckets.map(({ binding }) => binding), ["AIC_PODCAST_AUDIO"]);
  assert.deepEqual(config.vectorize.map(({ binding }) => binding), ["AIC_CONTENT_INDEX"]);
  assert.deepEqual(config.workflows.map(({ binding, name, class_name }) => ({ binding, name, class_name })), [{
    binding: "AIC_EPISODE_INGEST_WORKFLOW",
    name: "aic-episode-ingest",
    class_name: "EpisodeIngestWorkflow",
  }]);
  assert.equal(JSON.stringify(config).includes("API_KEY"), false);
  await assert.rejects(access(new URL("../../placeholders/wrangler.ingest.jsonc", import.meta.url)));
});

test("dual UTC triggers select only 04:15 America/New_York across DST", () => {
  assert.equal(shouldRunDailyDiscovery({ cron: "15 8 * * *", scheduledTime: Date.parse("2026-07-15T08:15:00Z") }), true);
  assert.equal(shouldRunDailyDiscovery({ cron: "15 9 * * *", scheduledTime: Date.parse("2026-07-15T09:15:00Z") }), false);
  assert.equal(shouldRunDailyDiscovery({ cron: "15 8 * * *", scheduledTime: Date.parse("2026-01-15T08:15:00Z") }), false);
  assert.equal(shouldRunDailyDiscovery({ cron: "15 9 * * *", scheduledTime: Date.parse("2026-01-15T09:15:00Z") }), true);
  assert.equal(shouldRunDailyDiscovery({ cron: "15 10 * * *", scheduledTime: Date.parse("2026-01-15T09:15:00Z") }), false);
});

test("the off-hour trigger exits before discovery or dispatch", async () => {
  let noRetryCalls = 0;
  let discoveryCalls = 0;
  const scheduled = scheduleDailyDiscovery({
    cron: "15 9 * * *",
    scheduledTime: Date.parse("2026-07-15T09:15:00Z"),
    noRetry() { noRetryCalls += 1; },
  }, () => { discoveryCalls += 1; });
  assert.equal(scheduled, false);
  assert.equal(noRetryCalls, 1);
  assert.equal(discoveryCalls, 0);
});

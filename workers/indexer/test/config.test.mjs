import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("aic-indexer is an unrouted Workflow host with only the frozen Task 4 bindings", async () => {
  const config = JSON.parse(await readFile(new URL("wrangler.jsonc", root), "utf8"));
  assert.equal(config.name, "aic-indexer");
  assert.equal(config.main, "src/index.ts");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal("routes" in config, false);
  assert.equal("route" in config, false);
  assert.equal("triggers" in config, false);
  assert.deepEqual(config.d1_databases.map((binding) => binding.binding), ["AIC_DB"]);
  assert.equal(config.d1_databases[0].database_name, "aic-p4-local");
  assert.equal(config.d1_databases[0].database_id, "00000000-0000-0000-0000-000000000004");
  assert.deepEqual(config.vectorize.map((binding) => binding.binding), ["AIC_CONTENT_INDEX"]);
  assert.deepEqual(config.workflows, [{ binding: "AIC_CONTENT_INDEX_WORKFLOW", name: "aic-content-index", class_name: "ContentIndexWorkflow" }]);
  assert.doesNotMatch(JSON.stringify(config), /OPENAI_API_KEY|token|password/u);
});

test("the host stays fail-closed when reached outside a service binding", async () => {
  const source = await readFile(new URL("src/index.ts", root), "utf8");
  assert.match(source, /Service Unavailable/u);
  assert.match(source, /status:\s*503/u);
  assert.match(source, /Cache-Control.*no-store/su);
});

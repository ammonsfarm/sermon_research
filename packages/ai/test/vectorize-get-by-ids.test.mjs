import assert from "node:assert/strict";
import test from "node:test";

import { getVectorsByIds, VECTORIZE_GET_BY_IDS_LIMIT } from "../src/vectorize-writer.ts";

test("getVectorsByIds never sends more than 20 ids per Vectorize call", async () => {
  const calls = [];
  const binding = { async getByIds(ids) { calls.push(ids.length); if (ids.length > 20) throw new Error("too many ids"); return ids.map((id) => ({ id, values: [] })); } };
  const ids = Array.from({ length: 45 }, (_, index) => `v${index}`);
  const result = await getVectorsByIds(binding, ids);
  assert.equal(VECTORIZE_GET_BY_IDS_LIMIT, 20);
  assert.deepEqual(calls, [20, 20, 5]);
  assert.deepEqual(result.map((record) => record.id), ids);
});

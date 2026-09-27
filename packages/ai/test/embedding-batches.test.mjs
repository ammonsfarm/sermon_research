import assert from 'node:assert/strict';
import test from 'node:test';
import { executeEmbeddingBatch, partitionEmbeddingBatches } from '../src/embedding-batches.ts';

const hash = 'a'.repeat(64);
const context = { boundary: 'background', correlation: { correlationId: 'synthetic-indexing' }, signal: new AbortController().signal, job: { id: 'job-1', kind: 'semantic_index_replace', attempt: 1, idempotencyKey: 'key' } };
const vector = () => Array.from({ length: 1536 }, (_, index) => index === 0 ? 0.1 : 0);
const inputs = [{ id: 't/sa_42:speech:0000', text: 'Grace', contentHash: hash, estimatedTokens: 2 }];

test('rejects an oversized embedding batch before provider invocation', async () => {
  assert.throws(() => partitionEmbeddingBatches([{ ...inputs[0], estimatedTokens: 8001 }]));
  assert.deepEqual(partitionEmbeddingBatches(Array.from({ length: 97 }, (_, index) => ({ ...inputs[0], id: `t/sa_42:speech:${index}` }))).map((batch) => batch.inputs.length), [96, 1]);
  let calls = 0;
  await assert.rejects(executeEmbeddingBatch(context, {
    embedQuery: async () => { throw new Error('not used'); }, embedBatch: async () => { calls++; return []; },
  }, { inputs: Array.from({ length: 97 }, (_, index) => ({ ...inputs[0], id: `t/sa_42:speech:${index}` })), estimatedTokens: 194 }));
  assert.equal(calls, 0);
});

test('validates a complete provider response and records Float32 digests', async () => {
  const [batch] = partitionEmbeddingBatches(inputs);
  const result = await executeEmbeddingBatch(context, {
    embedQuery: async () => { throw new Error('not used'); },
    embedBatch: async () => [{ customId: inputs[0].id, values: vector(), dimensions: 1536, model: 'text-embedding-3-small' }],
  }, batch);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].values.constructor, Float32Array);
  assert.match(result.records[0].vectorDigest, /^[0-9a-f]{64}$/);
});

test('rejects a partial provider response as a whole batch', async () => {
  const [batch] = partitionEmbeddingBatches(inputs);
  await assert.rejects(executeEmbeddingBatch(context, {
    embedQuery: async () => { throw new Error('not used'); }, embedBatch: async () => [],
  }, batch));
});

test('rejects forged aggregate totals and duplicate IDs before provider invocation', async () => {
  let calls = 0;
  const provider = { embedQuery: async () => { throw new Error('not used'); }, embedBatch: async () => { calls++; return []; } };
  const oversized = Array.from({ length: 31 }, (_, index) => ({ ...inputs[0], id: `t/sa_42:speech:${index}`, estimatedTokens: 8000 }));
  await assert.rejects(executeEmbeddingBatch(context, provider, { inputs: oversized, estimatedTokens: 0 }));
  await assert.rejects(executeEmbeddingBatch(context, provider, { inputs: [inputs[0], inputs[0]], estimatedTokens: 4 }));
  assert.equal(calls, 0);
});

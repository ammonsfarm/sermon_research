import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndexingManifest } from '../src/indexing.ts';

const hash = 'a'.repeat(64);

test('creates a sorted complete manifest with a deterministic ID digest', async () => {
  const manifest = await createIndexingManifest([
    { id: 't/sa_42:speech:0001', text: 'second', contentHash: hash, metadata: { source_type: 'episode_transcript', source_id: 'sa_42', content_subtype: 'speech', published_day: 20260905, content_hash: hash, chunk_index: 1 } },
    { id: 't/sa_42:speech:0000', text: 'first', contentHash: hash, metadata: { source_type: 'episode_transcript', source_id: 'sa_42', content_subtype: 'speech', published_day: 20260905, content_hash: hash, chunk_index: 0 } },
  ]);
  assert.deepEqual(manifest.ids, ['t/sa_42:speech:0000', 't/sa_42:speech:0001']);
  assert.equal(manifest.complete, true);
  assert.match(manifest.idDigest, /^[0-9a-f]{64}$/);
  assert.equal(manifest.idDigest, (await createIndexingManifest([...manifest.chunks].reverse())).idDigest);
});

test('rejects a manifest with malformed frozen metadata', async () => {
  await assert.rejects(createIndexingManifest([{
    id: 't/sa_42:speech:0000', text: 'first', contentHash: hash,
    metadata: { source_type: 'episode_transcript', source_id: 'sa_42', content_subtype: 'speech', published_day: '20260905', content_hash: hash, chunk_index: 0 },
  }]));
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  acceptUpsert,
  createArticleManifest,
  createIntelligenceManifest,
  createTranscriptManifest,
  createVectorizeReader,
  probeUpsertVisibility,
} from '../src/index.ts';
import { createProcessingRevisionHash } from '../../contracts/src/processing.ts';

test('exported indexing output passes visibility proof and search hydration without replacing chunk hashes', async () => {
  const text = 'Synthetic grace and peace.';
  const textHash = createHash('sha256').update(text).digest('hex');
  const revision = await createProcessingRevisionHash({ text, desiredPublication: 'draft' });
  const manifests = await Promise.all([
    createArticleManifest({ sourceType: 'pastorwood_devotional', postId: 42,
      contentSubtype: 'pastorwood_devotional', publishedDay: 20260905, text, maxCharacters: 800 }),
    createTranscriptManifest({ episodeId: 'sa_42', contentSubtype: 'speech', publishedDay: 20260905,
      chunks: [{ customId: 'sa_42:speech:0007', text, contentHash: textHash }] }),
    createIntelligenceManifest({ episodeId: 'sa_42', contentSubtype: 'episode_executive_summary',
      publishedDay: 20260905, chunks: [{ customId: 'intel:episode:sa_42:executive_summary',
        text, contentHash: textHash, chunkIndex: 3 }] }),
  ]);
  const chunks = manifests.flatMap((manifest) => manifest.chunks);
  const values = Float32Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0);
  let retained = [];
  let visible = false;
  const binding = {
    async upsert(records) { retained = records; return { mutationId: 'synthetic-mutation' }; },
    async getByIds(ids) { return visible ? retained.filter((record) => ids.includes(record.id)) : []; },
    async queryById(id) { return { matches: retained.filter((record) => record.id === id) }; },
    async query() { return { matches: retained.map((record) => ({ ...record, score: 0.9 })) }; },
  };
  const receipt = await acceptUpsert(binding, chunks.map((chunk) => ({
    id: chunk.id, metadata: chunk.metadata, values, vectorDigest: '',
  })));
  assert.equal(receipt.state, 'accepted');
  assert.equal((await probeUpsertVisibility(binding, receipt)).state, 'pending');
  visible = true;
  assert.equal((await probeUpsertVisibility(binding, receipt)).state, 'visible');
  const reader = createVectorizeReader(binding);
  const matches = await reader.query({ boundary: 'request',
    request: { method: 'POST', path: '/api/rag/chat' },
    correlation: { correlationId: 'synthetic-integration' }, signal: new AbortController().signal,
  }, { embedding: { values: Array.from(values), dimensions: 1536, model: 'text-embedding-3-small' }, topK: 3 });
  assert.equal(matches.length, 3);
  for (const match of matches) {
    const chunk = chunks.find((candidate) => candidate.id === match.vectorId);
    assert.equal(match.contentHash, chunk.contentHash);
    assert.equal(match.chunkIndex, chunk.metadata.chunk_index);
    assert.match(match.contentHash, /^[0-9a-f]{64}$/u);
    assert.notEqual(match.contentHash, revision);
    assert.deepEqual(Object.keys(chunk.metadata).sort(),
      ['chunk_index', 'content_hash', 'content_subtype', 'published_day', 'source_id', 'source_type']);
  }
  assert.match(revision, /^sha256:[0-9a-f]{64}$/u);
});

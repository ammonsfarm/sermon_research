import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createArticleManifest,
  createIntelligenceManifest,
  materializeSpeechChunks,
  createTranscriptManifest,
  selectStaleVectorIds,
} from '../src/chunks.ts';

const articleHash = '7c23bf3ed0b8c2d3af434c14574704f347b1180b8927181a1a351e084a62d92f';
const transcriptHash = '604632ee1b3c341999f6ba77bb74568bcd95352459335339e9560e80032e1590';
const intelligenceHash = '3543e89d4d9f602a5cfe82e89d675bf822e96b79350e5a372a4440be96eb1b00';

test('materializes source-compatible article chunks with NUL-delimited hashes', async () => {
  const manifest = await createArticleManifest({
    sourceType: 'pastorwood_devotional', postId: 42, contentSubtype: 'pastorwood_devotional', publishedDay: 20260905,
    text: 'Grace is sufficient.', maxCharacters: 800,
  });
  assert.deepEqual(manifest.chunks.map(({ id, text, contentHash, metadata }) => ({ id, text, contentHash, metadata })), [{
    id: 'a/pastorwood_devotional:42:0000', text: 'Grace is sufficient.', contentHash: articleHash,
    metadata: {
      source_type: 'article', source_id: 'pastorwood:42', content_subtype: 'pastorwood_devotional',
      published_day: 20260905, content_hash: articleHash, chunk_index: 0,
    },
  }]);
  assert.equal(manifest.complete, true);
});

test('preserves exact transcript and intelligence chunks without rechunking or rehashing', async () => {
  const transcript = await createTranscriptManifest({
    episodeId: 'sa_42', contentSubtype: 'speech', publishedDay: 20260905,
    chunks: [{ customId: 'sa_42:speech:0000', text: 'Speaker: Gràce is sufficient.', contentHash: transcriptHash }],
  });
  const intelligence = await createIntelligenceManifest({
    episodeId: 'sa_42', contentSubtype: 'episode_executive_summary', publishedDay: 20260905,
    chunks: [{
      customId: 'intel:episode:sa_42:executive_summary',
      text: 'Vector Type: episode_executive_summary\nEpisode: Grace\nTrack ID: sa_42\nPublish Date: 2026-09-05\nEpisode Type: sermon\nSource Model: silo-v1\n\nGrace is sufficient.',
      contentHash: intelligenceHash,
    }],
  });
  assert.equal(transcript.chunks[0].id, 't/sa_42:speech:0000');
  assert.equal(transcript.chunks[0].contentHash, transcriptHash);
  assert.equal(intelligence.chunks[0].id, 'i/intel:episode:sa_42:executive_summary');
  assert.equal(intelligence.chunks[0].contentHash, intelligenceHash);
});

test('preserves source chunk ordinals independently of manifest input order', async () => {
  const transcript = await createTranscriptManifest({
    episodeId: 'sa_42', contentSubtype: 'speech', publishedDay: 20260905,
    chunks: [
      { customId: 'sa_42:speech:0007', text: 'later', contentHash: transcriptHash },
      { customId: 'sa_42:speech:0002', text: 'earlier', contentHash: transcriptHash },
    ],
  });
  const intelligence = await createIntelligenceManifest({
    episodeId: 'sa_42', contentSubtype: 'episode_executive_summary', publishedDay: 20260905,
    chunks: [
      { customId: 'intel:item:9', text: 'item', contentHash: intelligenceHash, chunkIndex: 9 },
      { customId: 'intel:episode:sa_42:executive_summary', text: 'episode', contentHash: intelligenceHash, chunkIndex: 0 },
    ],
  });
  assert.deepEqual(transcript.chunks.map((chunk) => [chunk.id, chunk.metadata.chunk_index]), [['t/sa_42:speech:0002', 2], ['t/sa_42:speech:0007', 7]]);
  assert.deepEqual(intelligence.chunks.map((chunk) => [chunk.id, chunk.metadata.chunk_index]), [['i/intel:episode:sa_42:executive_summary', 0], ['i/intel:item:9', 9]]);
});

test('derives the source-compatible exact-text hash for a new transcript chunk', async () => {
  const transcript = await createTranscriptManifest({
    episodeId: 'sa_42', contentSubtype: 'speech', publishedDay: 20260905,
    chunks: [{ customId: 'sa_42:speech:0000', text: 'Speaker: Gràce is sufficient.' }],
  });
  assert.equal(transcript.chunks[0].contentHash, transcriptHash);
});

test('builds the source-compatible speech payload with terminology canonicalization and Unicode text', async () => {
  const chunks = materializeSpeechChunks({
    episode: { trackId: 'sa_42', title: 'Gràce at Wears Valley', publishedDate: '2026-09-05' }, maxCharacters: 6000,
    segments: [
      { speakerName: 'Jim Wood', text: 'Welcome to where valley ranch.', segmentType: 'speech', startTime: '00:00:01', endTime: '00:00:02' },
      { speakerName: 'Jim Wood', text: 'Gràce.', segmentType: 'speech', startTime: '00:00:03', endTime: '00:00:04' },
    ],
  });
  assert.deepEqual(chunks, [{
    customId: 'sa_42:speech:0000',
    text: 'Episode: Gràce at Wears Valley\nTrack ID: sa_42\nPublish Date: 2026-09-05\nTime Range: 00:00:01-00:00:04\nSpeakers: Jim Wood\n\nJim Wood: Welcome to Wears Valley Ranch.\nJim Wood: Gràce.',
  }]);
});

test('rejects malformed vector IDs and chunk hashes before a manifest exists', async () => {
  await assert.rejects(createTranscriptManifest({
    episodeId: 'sa_42', contentSubtype: 'speech', publishedDay: 20260905,
    chunks: [{ customId: 'x'.repeat(63), text: 'text', contentHash: transcriptHash }],
  }));
  await assert.rejects(createIntelligenceManifest({
    episodeId: 'sa_42', contentSubtype: 'episode_executive_summary', publishedDay: 20260905,
    chunks: [{ customId: 'intel:episode:sa_42:executive_summary', text: 'text', contentHash: `sha256:${intelligenceHash}` }],
  }));
  await assert.rejects(createArticleManifest({
    sourceType: 'pastorwood_devotional', postId: 42, contentSubtype: 'x'.repeat(65), publishedDay: 20260905,
    text: 'Grace is sufficient.', maxCharacters: 800,
  }));
  await assert.rejects(createArticleManifest({
    sourceType: 'pastorwood_devotional', postId: 42, contentSubtype: 'pastorwood_devotional', publishedDay: 20260230,
    text: 'Grace is sufficient.', maxCharacters: 800,
  }));
});

test('selects stale IDs only from two complete manifests after a reduced revision', async () => {
  const previous = await createArticleManifest({
    sourceType: 'pastorwood_devotional', postId: 42, contentSubtype: 'pastorwood_devotional', publishedDay: 20260905,
    text: `${'A'.repeat(799)}\n\nB`, maxCharacters: 800,
  });
  const next = await createArticleManifest({
    sourceType: 'pastorwood_devotional', postId: 42, contentSubtype: 'pastorwood_devotional', publishedDay: 20260905,
    text: 'A', maxCharacters: 800,
  });
  assert.deepEqual(selectStaleVectorIds(previous, next), ['a/pastorwood_devotional:42:0001']);
  assert.throws(() => selectStaleVectorIds({ ...previous, complete: false }, next));
});

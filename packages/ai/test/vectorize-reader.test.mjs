import test from 'node:test';
import assert from 'node:assert/strict';
import { createVectorizeReader } from '../src/vectorize-reader.ts';
import { canonicalProcessingAggregate } from '../../contracts/src/processing.ts';

const operation = {
  boundary: 'request', request: { method: 'POST', path: '/api/rag/chat' },
  correlation: { correlationId: 'synthetic-vector-test' },
  signal: new AbortController().signal,
};

const hash = 'a'.repeat(64);
const embedding = () => ({
  values: Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0),
  dimensions: 1536,
  model: 'text-embedding-3-small',
});
const query = (overrides = {}) => ({ embedding: embedding(), topK: 8, ...overrides });
const metadata = (overrides = {}) => ({
  source_type: 'episode_transcript', source_id: '123', content_hash: hash, chunk_index: 0, ...overrides,
});
const match = (overrides = {}) => ({ id: 't/segment-1', score: 0.8, metadata: metadata(), ...overrides });

function recordingBinding(result = { matches: [] }) {
  const calls = [];
  return {
    calls,
    binding: { query: async (values, options) => { calls.push({ values, options }); return result; } },
  };
}

async function rejectsInvalid(queryInput) {
  const recording = recordingBinding();
  await assert.rejects(createVectorizeReader(recording.binding).query(operation, queryInput), { code: 'invalid_argument' });
  assert.equal(recording.calls.length, 0);
}

test('wrong dimensions reject before provider call', async () => {
  let calls = 0;
  const reader = createVectorizeReader({ query: async () => { calls++; return { matches: [] }; } });
  await assert.rejects(reader.query(operation, {
    embedding: { values: [1, 2], dimensions: 2, model: 'text-embedding-3-small' }, topK: 8,
  }), { code: 'invalid_argument' });
  assert.equal(calls, 0);
});

test('rejects malformed vector requests before calling Vectorize', async () => {
  await rejectsInvalid(query({ embedding: { ...embedding(), model: 'text-embedding-3-large' } }));
  await rejectsInvalid(query({ embedding: { ...embedding(), values: [NaN, ...embedding().values.slice(1)] } }));
  await rejectsInvalid(query({ embedding: { ...embedding(), values: Array(1536).fill(0) } }));
  await rejectsInvalid(query({ topK: 0 }));
  await rejectsInvalid(query({ topK: 101 }));
  await rejectsInvalid(query({ topK: 1.5 }));
});

test('rejects unsupported or inconsistent metadata filters before calling Vectorize', async () => {
  await rejectsInvalid(query({ filter: { publishedFrom: '2026-02-30' } }));
  await rejectsInvalid(query({ filter: { publishedFrom: '2026-08-06', publishedTo: '2026-08-05' } }));
  await rejectsInvalid(query({ filter: { episodeId: 'e'.repeat(65) } }));
  await rejectsInvalid(query({ filter: { sourceTypes: [] } }));
  await rejectsInvalid(query({ filter: { episodeId: '123', articleId: 'pastorwood:42' } }));
  await rejectsInvalid(query({ filter: { sourceTypes: ['article'], extra: { $ne: 'anything' } } }));
  await rejectsInvalid(query({ filter: { contentSubtypes: [] } }));
  await rejectsInvalid(query({ filter: { contentSubtypes: ['caller_defined'] } }));
  await rejectsInvalid(query({ filter: { sourceTypes: ['article'], contentSubtypes: ['notable_quotes'] } }));
  await rejectsInvalid(query({ filter: { sourceTypes: ['episode_intelligence'], contentSubtypes: ['pastorwood_resource'] } }));
  await rejectsInvalid(query({ filter: { contentSubtypes: ['pastorwood_devotional', 'notable_quotes'] } }));
  await rejectsInvalid(query({ filter: { articleId: 'pastorwood:42', contentSubtypes: ['stories'] } }));
  await rejectsInvalid(query({ filter: { episodeId: '123', contentSubtypes: ['pastorwood_devotional'] } }));
});

test('translates deduplicated fixed content subtypes without accepting provider expressions', async () => {
  const recording = recordingBinding();
  await createVectorizeReader(recording.binding).query(operation, query({
    filter: {
      sourceTypes: ['episode_intelligence'],
      episodeId: '123',
      contentSubtypes: ['notable_quotes', 'stories', 'notable_quotes'],
    },
  }));
  assert.deepEqual(recording.calls[0].options.filter, {
    source_type: { $in: ['episode_intelligence'] },
    source_id: { $eq: '123' },
    content_subtype: { $in: ['notable_quotes', 'stories'] },
  });
});

test('translates only frozen metadata filters and maps transcript result', async () => {
  const recording = recordingBinding({ matches: [match()] });
  const reader = createVectorizeReader(recording.binding);
  const result = await reader.query(operation, query({
    filter: {
      sourceTypes: ['episode_transcript', 'episode_transcript'],
      episodeId: '123',
      publishedFrom: '2026-08-05',
      publishedTo: '2026-08-05',
      contentHash: hash.toUpperCase(),
    },
  }));
  assert.deepEqual(recording.calls, [{
    values: embedding().values,
    options: {
      topK: 8, returnMetadata: 'indexed', returnValues: false,
      filter: {
        source_type: { $in: ['episode_transcript'] },
        source_id: { $eq: '123' },
        published_day: { $gte: 20260805, $lte: 20260805 },
        content_hash: { $eq: hash },
      },
    },
  }]);
  assert.deepEqual(result, [{
    vectorId: 't/segment-1', score: 0.8, sourceType: 'episode_transcript', sourceId: '123', contentHash: hash, chunkIndex: 0,
  }]);
});

test('omits an empty metadata filter and maps intelligence and article families', async () => {
  const recording = recordingBinding({ matches: [
    match({ id: 'i/intel-1', score: 0.9, metadata: metadata({ source_type: 'episode_intelligence', source_id: 'sa_42', chunk_index: 2 }) }),
    match({ id: 'a/article-1', score: 0.7, metadata: metadata({ source_type: 'article', source_id: 'pastorwood:42', chunk_index: 3 }) }),
  ] });
  const result = await createVectorizeReader(recording.binding).query(operation, query({ filter: {} }));
  assert.deepEqual(recording.calls[0].options, { topK: 8, returnMetadata: 'indexed', returnValues: false });
  assert.deepEqual(result.map(({ vectorId, sourceType, sourceId, chunkIndex }) => ({ vectorId, sourceType, sourceId, chunkIndex })), [
    { vectorId: 'i/intel-1', sourceType: 'episode_intelligence', sourceId: 'sa_42', chunkIndex: 2 },
    { vectorId: 'a/article-1', sourceType: 'article', sourceId: 'pastorwood:42', chunkIndex: 3 },
  ]);
});

test('accepts a canonical CMS article ID with a dot in filters and result metadata', async () => {
  const articleId = canonicalProcessingAggregate('article_replace', 'article', 'cms:doc.v1').id;
  const recording = recordingBinding({ matches: [
    match({ id: 'a/cms-doc-v1', metadata: metadata({ source_type: 'article', source_id: articleId }) }),
  ] });
  const result = await createVectorizeReader(recording.binding).query(operation, query({ filter: { articleId } }));
  assert.deepEqual(recording.calls[0].options, {
    topK: 8,
    returnMetadata: 'indexed',
    returnValues: false,
    filter: { source_id: { $eq: 'cms:doc.v1' } },
  });
  assert.equal(result[0].sourceId, 'cms:doc.v1');
});

test('rejects malformed Vectorize results without returning upstream details', async () => {
  const malformed = [
    { matches: [match({ metadata: { source_type: 'episode_transcript', source_id: '123', chunk_index: 0 } })] },
    { matches: [match({ metadata: { ...metadata(), source_type: 'article' } })] },
    { matches: [match({ id: 't/' + 'x'.repeat(63) })] },
    { matches: [match({ score: Number.NaN })] },
    { matches: [match({ score: 1.1 })] },
    { matches: [match({ metadata: metadata({ chunk_index: -1 }) })] },
    { matches: [match(), match()] },
    { matches: Array.from({ length: 9 }, () => match()) },
  ];
  for (const result of malformed) {
    await assert.rejects(createVectorizeReader(recordingBinding(result).binding).query(operation, query()), { code: 'dependency_unavailable' });
  }
  const reader = createVectorizeReader({ query: async () => { throw new Error('synthetic upstream secret'); } });
  await assert.rejects(reader.query(operation, query()), (error) => error.code === 'dependency_unavailable' && !error.message.includes('synthetic upstream secret'));
});

test('rejects IDs and metadata that contradict their vector family', async () => {
  const cases = [
    match({ id: 'x/unknown' }),
    match({ id: 't/segment-1', metadata: metadata({ source_type: 'episode_intelligence' }) }),
    match({ id: 'a/article-1', metadata: metadata({ source_type: 'article', source_id: 'not-an-article' }) }),
  ];
  for (const upstreamMatch of cases) {
    await assert.rejects(createVectorizeReader(recordingBinding({ matches: [upstreamMatch] }).binding).query(operation, query()), { code: 'dependency_unavailable' });
  }
});

test('excludes weak matches and sorts score ties by vector ID', async () => {
  const recording = recordingBinding({ matches: [
    match({ id: 't/z', score: 0.7 }),
    match({ id: 't/a', score: 0.7, metadata: metadata({ chunk_index: 1 }) }),
    match({ id: 't/weak', score: 0.2, metadata: metadata({ chunk_index: 2 }) }),
  ] });
  const result = await createVectorizeReader(recording.binding).query(operation, query());
  assert.deepEqual(result.map((item) => item.vectorId), ['t/a', 't/z']);
});

test('does not call an already-aborted parent operation', async () => {
  const controller = new AbortController();
  controller.abort();
  const recording = recordingBinding({ matches: [] });
  await assert.rejects(createVectorizeReader(recording.binding).query({ ...operation, signal: controller.signal }, query()), { code: 'cancelled' });
  assert.equal(recording.calls.length, 0);
});

test('does not call the binding when the parent aborts immediately after query starts', async () => {
  const controller = new AbortController();
  const recording = recordingBinding({ matches: [] });
  const pending = createVectorizeReader(recording.binding).query({ ...operation, signal: controller.signal }, query());
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recording.calls.length, 0);
});

test('times out a pending binding at the request deadline', async () => {
  const reader = createVectorizeReader({ query: () => new Promise(() => {}) });
  await assert.rejects(reader.query({ ...operation, deadline: new Date(Date.now() + 20).toISOString() }, query()), { code: 'timeout' });
});

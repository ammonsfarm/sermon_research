import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceError } from '../../contracts/src/errors.ts';
import { readBoundedResponse, withDeadline } from '../src/deadline.ts';
import { createOpenAiEmbeddingProvider } from '../src/embeddings.ts';
import { createTextGenerationProvider } from '../src/generation.ts';

const vector = () => Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0);
const requestContext = (overrides = {}) => ({
  boundary: 'request', correlation: { correlationId: 'synthetic' }, signal: new AbortController().signal,
  request: { method: 'POST', path: '/api/rag/chat' }, ...overrides,
});
const backgroundContext = () => ({
  boundary: 'background', correlation: { correlationId: 'synthetic' }, signal: new AbortController().signal,
  job: { id: 'job', kind: 'semantic_index_replace', attempt: 1, idempotencyKey: 'key' },
});
const model = { provider: 'openai', model: 'text-embedding-3-small' };

test('does not invoke fetch when the embedding operation is already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const provider = createOpenAiEmbeddingProvider({ apiKey: 'synthetic', fetch: async () => { calls++; throw Error('unused'); } });
  await assert.rejects(provider.embedQuery(requestContext({ signal: controller.signal }), {
    text: 'Synthetic question', model, expectedDimensions: 1536,
  }), { code: 'cancelled' });
  assert.equal(calls, 0);
});

test('maps exact query and background batch embeddings through injected fetch', async () => {
  const calls = [];
  const provider = createOpenAiEmbeddingProvider({
    apiKey: 'synthetic',
    fetch: async (url, init) => {
      calls.push({ url, init });
      const body = JSON.parse(init.body);
      const data = body.input.map((_, index) => ({ index, embedding: vector() }));
      return new Response(JSON.stringify({
        model: 'text-embedding-3-small',
        data: body.input.length === 2 ? data.reverse() : data,
      }));
    },
  });
  const query = await provider.embedQuery(requestContext(), { text: 'Grace', model, expectedDimensions: 1536 });
  assert.deepEqual(query, { values: vector(), dimensions: 1536, model: 'text-embedding-3-small' });
  const batch = await provider.embedBatch(backgroundContext(), {
    model, expectedDimensions: 1536,
    inputs: [
      { customId: 't/2', text: 'Second', contentHash: 'a'.repeat(64) },
      { customId: 't/1', text: 'First', contentHash: 'b'.repeat(64) },
    ],
  });
  assert.deepEqual(batch.map(({ customId }) => customId), ['t/2', 't/1']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/embeddings');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.deepEqual(JSON.parse(calls[0].init.body), { input: ['Grace'], model: 'text-embedding-3-small', dimensions: 1536 });
});

test('rejects invalid embedding requests and malformed/oversize provider responses without leaking bodies', async () => {
  let calls = 0;
  const provider = createOpenAiEmbeddingProvider({ apiKey: 'synthetic', fetch: async () => { calls++; return new Response('unused'); } });
  await assert.rejects(provider.embedQuery(requestContext(), { text: '', model, expectedDimensions: 1536 }), { code: 'invalid_argument' });
  await assert.rejects(provider.embedQuery(requestContext(), { text: 'x'.repeat(8001), model, expectedDimensions: 1536 }), { code: 'invalid_argument' });
  await assert.rejects(provider.embedQuery(requestContext(), { text: 'é'.repeat(4001), model, expectedDimensions: 1536 }), { code: 'invalid_argument' });
  await assert.rejects(provider.embedQuery(requestContext(), { text: 'Grace', model: { ...model, model: 'wrong' }, expectedDimensions: 1536 }), { code: 'invalid_argument' });
  await assert.rejects(provider.embedBatch(backgroundContext(), {
    model, expectedDimensions: 1536,
    inputs: Array.from({ length: 97 }, (_, index) => ({ customId: `t/${index}`, text: 'Grace', contentHash: 'a'.repeat(64) })),
  }), { code: 'invalid_argument' });
  await assert.rejects(provider.embedBatch(backgroundContext(), {
    model, expectedDimensions: 1536,
    inputs: Array.from({ length: 31 }, (_, index) => ({ customId: `t/${index}`, text: 'x'.repeat(8000), contentHash: 'a'.repeat(64) })),
  }), { code: 'invalid_argument' });
  await assert.rejects(provider.embedBatch(backgroundContext(), {
    model, expectedDimensions: 1536,
    inputs: [{ customId: `${'x'.repeat(63)}é`, text: 'Grace', contentHash: 'a'.repeat(64) }],
  }), { code: 'invalid_argument' });
  await assert.rejects(provider.embedBatch(backgroundContext(), {
    model, expectedDimensions: 1536,
    inputs: [{ customId: ' t/1', text: 'Grace', contentHash: 'a'.repeat(64) }],
  }), { code: 'invalid_argument' });
  await assert.rejects(provider.embedBatch(requestContext(), {
    model, expectedDimensions: 1536,
    inputs: [{ customId: 't/1', text: 'Grace', contentHash: 'a'.repeat(64) }],
  }), { code: 'invalid_argument' });
  assert.equal(calls, 0);

  const malformed = createOpenAiEmbeddingProvider({
    apiKey: 'synthetic', fetch: async () => new Response('<html>synthetic-secret</html>', { status: 502 }),
  });
  await assert.rejects(malformed.embedQuery(requestContext(), { text: 'Grace', model, expectedDimensions: 1536 }),
    (error) => error.code === 'dependency_unavailable' && !error.message.includes('synthetic-secret'));
  const oversized = createOpenAiEmbeddingProvider({
    apiKey: 'synthetic', fetch: async () => new Response('x'.repeat(128 * 1024 + 1)),
  });
  await assert.rejects(oversized.embedQuery(requestContext(), { text: 'Grace', model, expectedDimensions: 1536 }), { code: 'dependency_unavailable' });
  const wrongVector = createOpenAiEmbeddingProvider({
    apiKey: 'synthetic', fetch: async () => new Response(JSON.stringify({ model: 'text-embedding-3-small', data: [{ index: 0, embedding: vector().slice(1) }] })),
  });
  await assert.rejects(wrongVector.embedQuery(requestContext(), { text: 'Grace', model, expectedDimensions: 1536 }), { code: 'dependency_unavailable' });
  for (const embedding of [vector().concat(0), vector().map((value, index) => index === 10 ? Number.NaN : value)]) {
    const bad = createOpenAiEmbeddingProvider({
      apiKey: 'synthetic', fetch: async () => new Response(JSON.stringify({ model: 'text-embedding-3-small', data: [{ index: 0, embedding }] })),
    });
    await assert.rejects(bad.embedQuery(requestContext(), { text: 'Grace', model, expectedDimensions: 1536 }), { code: 'dependency_unavailable' });
  }
  const duplicate = createOpenAiEmbeddingProvider({
    apiKey: 'synthetic', fetch: async () => new Response(JSON.stringify({ model: 'text-embedding-3-small', data: [{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }] })),
  });
  await assert.rejects(duplicate.embedBatch(backgroundContext(), {
    model, expectedDimensions: 1536,
    inputs: [{ customId: 't/1', text: 'One', contentHash: 'a'.repeat(64) }, { customId: 't/2', text: 'Two', contentHash: 'b'.repeat(64) }],
  }), { code: 'dependency_unavailable' });
  for (const data of [
    [{ index: 0, embedding: vector() }],
    [{ index: 0, embedding: vector() }, { index: 2, embedding: vector() }],
  ]) {
    const invalidIndices = createOpenAiEmbeddingProvider({
      apiKey: 'synthetic', fetch: async () => new Response(JSON.stringify({ model: 'text-embedding-3-small', data })),
    });
    await assert.rejects(invalidIndices.embedBatch(backgroundContext(), {
      model, expectedDimensions: 1536,
      inputs: [{ customId: 't/1', text: 'One', contentHash: 'a'.repeat(64) }, { customId: 't/2', text: 'Two', contentHash: 'b'.repeat(64) }],
    }), { code: 'dependency_unavailable' });
  }
});

test('maps safe upstream embedding status classes', async () => {
  for (const [status, code] of [[401, 'dependency_unavailable'], [429, 'rate_limited'], [503, 'dependency_unavailable']]) {
    const provider = createOpenAiEmbeddingProvider({ apiKey: 'synthetic', fetch: async () => new Response('secret', { status }) });
    await assert.rejects(provider.embedQuery(requestContext(), { text: 'Grace', model, expectedDimensions: 1536 }), { code });
  }
});

test('bounds response-body reads by the operation deadline', async () => {
  let timer;
  const slowBody = new ReadableStream({
    start(controller) { timer = setTimeout(() => controller.enqueue(new TextEncoder().encode('{}')), 30); },
    cancel() { clearTimeout(timer); },
  });
  const provider = createOpenAiEmbeddingProvider({ apiKey: 'synthetic', fetch: async () => new Response(slowBody) });
  await assert.rejects(provider.embedQuery(requestContext({ deadline: new Date(Date.now() + 5).toISOString() }), {
    text: 'Grace', model, expectedDimensions: 1536,
  }), { code: 'timeout' });
});

test('rejects malformed and non-UTC operation deadlines before invoking work', async () => {
  let calls = 0;
  for (const deadline of [
    'January 1, 2099', '2099-01-01T00:00:00', '2099-01-01T00:00:00-05:00',
    '2099-02-30T00:00:00.000Z', '2099-01-01T00:00:00.Z', '2099-01-01T24:00:00Z',
    '2099-02-29T00:00:00.1Z', '2099-04-31T00:00:00.123456789Z', '2099-01-01T00:00:00+00:00',
  ]) assert.throws(() => withDeadline(requestContext({ deadline }), 10, () => { calls++; }), { code: 'invalid_argument' });
  assert.equal(calls, 0);
  for (const fraction of ['', '.1', '.12', '.123', '.123456', '.123456789', `.${'1'.repeat(100)}`]) {
    assert.equal(await withDeadline(requestContext({ deadline: `2099-01-01T00:00:00${fraction}Z` }), 10, () => 'ok'), 'ok');
  }
});

test('cancels a reader on response overflow', async () => {
  let cancelled = 0;
  const response = { body: { getReader: () => ({
    read: async () => ({ done: false, value: new Uint8Array(5) }),
    cancel: async () => { cancelled++; },
  }) } };
  await assert.rejects(readBoundedResponse(response, new AbortController().signal, 4), { code: 'dependency_unavailable' });
  assert.equal(cancelled, 1);
});

test('cancels an in-flight embedding fetch without accepting a late completion', async () => {
  const controller = new AbortController();
  let resolveFetch;
  const provider = createOpenAiEmbeddingProvider({
    apiKey: 'synthetic', fetch: () => new Promise((resolve) => { resolveFetch = resolve; }),
  });
  const pending = provider.embedQuery(requestContext({ signal: controller.signal }), { text: 'Grace', model, expectedDimensions: 1536 });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  resolveFetch(new Response(JSON.stringify({ model: 'text-embedding-3-small', data: [{ index: 0, embedding: vector() }] })));
});

test('generates only through configured public HTTPS allowlisted transports and derives citations', async () => {
  const calls = [];
  const provider = createTextGenerationProvider({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Grace is sufficient [S2] and [S1]. [S2]' } }] }));
    },
    siloUrl: 'https://silo.example.test/v1/chat/completions', siloKey: 'synthetic', openAiKey: 'synthetic',
    allowedModels: [{ provider: 'silo', model: 'silo-model' }, { provider: 'openai', model: 'openai-model' }],
  });
  const result = await provider.generate(requestContext(), {
    model: { provider: 'silo', model: 'silo-model' }, system: 'Use the sources.', prompt: 'Where is grace?', maxOutputTokens: 128,
    context: [
      { sourceId: 'S1', title: 'One', canonicalUrl: 'https://aic.example.test/one', text: 'Grace.' },
      { sourceId: 'S2', title: 'Two', canonicalUrl: 'https://aic.example.test/two', text: 'Sufficient.' },
    ],
  });
  assert.deepEqual(result.citedSourceIds, ['S2', 'S1']);
  assert.deepEqual(result.model, { provider: 'silo', model: 'silo-model' });
  assert.equal(calls[0].url, 'https://silo.example.test/v1/chat/completions');
  assert.equal(calls[0].init.redirect, 'manual');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.backend_mode, 'codex-direct');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 128);
});

test('generates with gemini provider without codex-direct and uses correct endpoint', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({
      choices: [{ message: { content: 'Grace [S1] is found in [S2].' } }],
    });
  };
  const provider = createTextGenerationProvider({
    fetch,
    geminiKey: 'gemini-secret-key',
    allowedModels: [{ provider: 'gemini', model: 'gemini-3.8-flash' }],
  });
  const result = await provider.generate(requestContext(), {
    model: { provider: 'gemini', model: 'gemini-3.8-flash' },
    system: 'Use the sources.',
    prompt: 'Where is grace?',
    maxOutputTokens: 256,
    context: [
      { sourceId: 'S1', title: 'One', canonicalUrl: 'https://aic.example.test/one', text: 'Grace.' },
      { sourceId: 'S2', title: 'Two', canonicalUrl: 'https://aic.example.test/two', text: 'Sufficient.' },
    ],
  });
  assert.deepEqual(result.citedSourceIds, ['S1', 'S2']);
  assert.deepEqual(result.model, { provider: 'gemini', model: 'gemini-3.8-flash' });
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer gemini-secret-key');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.backend_mode, undefined);
  assert.equal(body.model, 'gemini-3.8-flash');
  assert.equal(body.max_tokens, 256);
});

test('rejects unsafe generation configuration, invalid requests, bad upstream bodies, and unknown citations', async () => {
  for (const siloUrl of [
    'http://192.168.0.10/v1/chat/completions', 'https://silo.local/v1/chat/completions',
    'https://silo.local./v1/chat/completions', 'https://localhost./v1/chat/completions',
    'https://[::ffff:127.0.0.1]/v1/chat/completions', 'https://[::ffff:10.0.0.1]/v1/chat/completions',
  ]) assert.throws(() => createTextGenerationProvider({ fetch, siloUrl, siloKey: 'x', allowedModels: [] }), { code: 'invalid_argument' });
  assert.throws(() => createTextGenerationProvider({
    fetch, siloUrl: 'https://silo.example.test/v1/chat/completions', siloKey: 'x', allowedModels: [{ provider: 'silo', model: 'silo-model', revision: 'unmapped' }],
  }), { code: 'invalid_argument' });
  const provider = createTextGenerationProvider({
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Unsupported [S9]' } }] })),
    siloUrl: 'https://silo.example.test/v1/chat/completions', siloKey: 'synthetic', allowedModels: [{ provider: 'silo', model: 'silo-model' }],
  });
  const input = { model: { provider: 'silo', model: 'silo-model' }, system: 'System', prompt: 'Prompt', maxOutputTokens: 1, context: [{ sourceId: 'S1', title: 'One', canonicalUrl: 'https://aic.example.test/one', text: 'Grace.' }] };
  await assert.rejects(provider.generate(requestContext(), { ...input, prompt: '' }), { code: 'invalid_argument' });
  await assert.rejects(provider.generate(requestContext(), { ...input, context: [] }), { code: 'invalid_argument' });
  await assert.rejects(provider.generate(requestContext(), { ...input, maxOutputTokens: 2049 }), { code: 'invalid_argument' });
  await assert.rejects(provider.generate(requestContext(), { ...input, model: { provider: 'silo', model: 'other' } }), { code: 'invalid_argument' });
  await assert.rejects(provider.generate(requestContext(), input), { code: 'dependency_unavailable' });
  const badBody = createTextGenerationProvider({
    fetch: async () => new Response('<html>synthetic-secret</html>', { status: 500 }),
    siloUrl: 'https://silo.example.test/v1/chat/completions', siloKey: 'synthetic', allowedModels: [{ provider: 'silo', model: 'silo-model' }],
  });
  await assert.rejects(badBody.generate(requestContext(), input), (error) => error.code === 'dependency_unavailable' && !error.message.includes('synthetic-secret'));
  const oversized = createTextGenerationProvider({
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(16_385) } }] })),
    siloUrl: 'https://silo.example.test/v1/chat/completions', siloKey: 'synthetic', allowedModels: [{ provider: 'silo', model: 'silo-model' }],
  });
  await assert.rejects(oversized.generate(requestContext(), input), { code: 'dependency_unavailable' });
  for (const answer of [
    'ftp://example.invalid', 'data:text/plain,secret', 'javascript:alert(1)', '//private.invalid/path',
    '[source](//private.invalid/path)', '(//private.invalid/path)', '[source](/unverified)', '[source](../unverified)',
    '[source](\n/unverified\n)', '[source](\r\n/unverified\r\n)', `[source](/${'x'.repeat(2048)})`,
    '[source] [S1]\n\n[source]:\n /unverified', '[source] [S1]\n\n[source]:\r\n /unverified',
    `[${'label'.repeat(200)}]:\n /unverified`, '[multi\nline]:\n /unverified',
    String.raw`[escaped\]label]: /unverified`, String.raw`[escaped\[label]: /unverified`,
    `[${'label'.repeat(200)}](/unverified)`, '[multi\nline](/unverified)', '[source][multi\nline]',
    '![source](\n/unverified.png\n)', `<img src="/unverified.png">`,
    '![source](/unverified.png)', '[source][unverified]', '[unverified]: /source', '<a href="/unverified">source</a>',
  ]) {
    const unsafeUrl = createTextGenerationProvider({
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: `${answer} [S1]` } }] })),
      siloUrl: 'https://silo.example.test/v1/chat/completions', siloKey: 'synthetic', allowedModels: [{ provider: 'silo', model: 'silo-model' }],
    });
    await assert.rejects(unsafeUrl.generate(requestContext(), input), { code: 'dependency_unavailable', retryable: false });
  }
  const ordinary = createTextGenerationProvider({
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Answer: grounded evidence [S1] (with context).' } }] })),
    siloUrl: 'https://silo.example.test/v1/chat/completions', siloKey: 'synthetic', allowedModels: [{ provider: 'silo', model: 'silo-model' }],
  });
  assert.equal((await ordinary.generate(requestContext(), input)).text, 'Answer: grounded evidence [S1] (with context).');
});

test('redacts hostile ServiceErrors from injected fetch and response streams', async () => {
  const hostile = () => new ServiceError({
    code: 'forbidden', message: 'synthetic-key https://private.example.invalid', safeDetails: { secret: 'synthetic-key' }, cause: Error('synthetic-key'),
  });
  const assertRedacted = async (pending) => assert.rejects(pending, (error) => error.code === 'dependency_unavailable'
    && !error.message.includes('synthetic-key') && error.safeDetails === undefined && error.cause === undefined);
  const responseStream = () => new Response(new ReadableStream({ pull() { throw hostile(); } }));
  const input = {
    model: { provider: 'silo', model: 'silo-model' }, system: 'System', prompt: 'Prompt', maxOutputTokens: 1,
    context: [{ sourceId: 'S1', title: 'One', canonicalUrl: 'https://aic.example.test/one', text: 'Grace.' }],
  };
  const cases = [
    createOpenAiEmbeddingProvider({ apiKey: 'synthetic', fetch: async () => { throw hostile(); } }).embedQuery(requestContext(), { text: 'Grace', model, expectedDimensions: 1536 }),
    createOpenAiEmbeddingProvider({ apiKey: 'synthetic', fetch: async () => responseStream() }).embedQuery(requestContext(), { text: 'Grace', model, expectedDimensions: 1536 }),
    createTextGenerationProvider({ fetch: async () => { throw hostile(); }, siloUrl: 'https://silo.example.test/v1/chat/completions', siloKey: 'synthetic', allowedModels: [{ provider: 'silo', model: 'silo-model' }] }).generate(requestContext(), input),
    createTextGenerationProvider({ fetch: async () => responseStream(), siloUrl: 'https://silo.example.test/v1/chat/completions', siloKey: 'synthetic', allowedModels: [{ provider: 'silo', model: 'silo-model' }] }).generate(requestContext(), input),
  ];
  for (const pending of cases) await assertRedacted(pending);
});

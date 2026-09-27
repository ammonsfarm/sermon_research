import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import ts from 'typescript';
import { acceptDelete, acceptUpsert, probeDeleteAbsence, probeUpsertVisibility, VECTORIZE_VISIBILITY_DELAYS_SECONDS } from '../src/vectorize-writer.ts';

const hash = 'a'.repeat(64);
const record = {
  id: 't/sa_42:speech:0000', values: new Float32Array(Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0)), vectorDigest: '0'.repeat(64),
  metadata: { source_type: 'episode_transcript', source_id: 'sa_42', content_subtype: 'speech', published_day: 20260905, content_hash: hash, chunk_index: 0 },
};

test('accepts the actual generated Worker Vectorize binding without semantic assignment diagnostics', () => {
  const repository = path.resolve(import.meta.dirname, '../../..');
  const consumer = path.join(repository, '__indexing_binding_test__.ts');
  const source = `import type { VectorizeWriteBinding } from './packages/ai/src/vectorize-writer.ts';
declare const actual: Vectorize;
const compatible: VectorizeWriteBinding = actual;
void compatible;`;
  const options = {
    strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true,
    allowImportingTsExtensions: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2023, lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  const exists = host.fileExists;
  host.readFile = (file) => file === consumer ? source : read(file);
  host.fileExists = (file) => file === consumer || exists(file);
  const program = ts.createProgram([consumer, path.join(repository, 'workers/ingest/cloudflare-env.d.ts')], options, host);
  const virtual = program.getSourceFile(consumer);
  assert.ok(virtual);
  assert.equal(ts.resolveModuleName('./packages/ai/src/vectorize-writer.ts', consumer, options, host).resolvedModule?.resolvedFileName, path.join(repository, 'packages/ai/src/vectorize-writer.ts'));
  const diagnostics = program.getSemanticDiagnostics(virtual);
  assert.equal(diagnostics.length, 0, diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
});

test('records asynchronous mutation acceptance without claiming visibility', async () => {
  const calls = [];
  const receipt = await acceptUpsert({
    upsert: async (records) => { calls.push(records); return { mutationId: 'm-1' }; }, deleteByIds: async () => ({ mutationId: 'unused' }),
    getByIds: async () => [], queryById: async () => ({ matches: [] }),
  }, [record]);
  assert.equal(receipt.state, 'accepted');
  assert.equal(receipt.mutationId, 'm-1');
  assert.equal(calls[0].length, 1);
  assert.equal('namespace' in calls[0][0], false);
  assert.deepEqual(VECTORIZE_VISIBILITY_DELAYS_SECONDS, [5, 10, 20, 40, 60, 60, 60, 60, 60, 60]);
});

test('requires all metadata, Float32 values, and a deterministic queryById sample for visibility', async () => {
  const binding = {
    upsert: async () => ({ mutationId: 'm-1' }), deleteByIds: async () => ({ mutationId: 'm-2' }),
    getByIds: async () => [{ id: record.id, values: record.values, metadata: record.metadata }],
    queryById: async (id, options) => ({ matches: [{ id, metadata: record.metadata }], options }),
  };
  const receipt = await acceptUpsert(binding, [record]);
  assert.equal((await probeUpsertVisibility(binding, receipt)).state, 'visible');
});

test('proves deletion by absence and does not treat an accepted delete as complete', async () => {
  const binding = {
    upsert: async () => ({ mutationId: 'm-1' }), deleteByIds: async () => ({ mutationId: 'm-2' }),
    getByIds: async () => [], queryById: async () => ({ matches: [] }),
  };
  const receipt = await acceptDelete(binding, [record.id]);
  assert.equal(receipt.state, 'delete_accepted');
  assert.equal((await probeDeleteAbsence(binding, receipt)).state, 'deleted');
});

test('rejects malformed frozen metadata before an upsert mutation', async () => {
  let calls = 0;
  await assert.rejects(acceptUpsert({
    upsert: async () => { calls++; return { mutationId: 'm-1' }; }, deleteByIds: async () => ({ mutationId: 'm-2' }),
    getByIds: async () => [], queryById: async () => ({ matches: [] }),
  }, [{ ...record, metadata: { ...record.metadata, published_day: '20260905' } }]));
  assert.equal(calls, 0);
});

test('rejects contradictory and malformed vector IDs before any mutation', async () => {
  let upserts = 0;
  let deletes = 0;
  const binding = {
    upsert: async () => { upserts++; return { mutationId: 'm-1' }; }, deleteByIds: async () => { deletes++; return { mutationId: 'm-2' }; },
    getByIds: async () => [], queryById: async () => ({ matches: [] }),
  };
  await assert.rejects(acceptUpsert(binding, [{ ...record, id: 'a/wrong-family' }]));
  await assert.rejects(acceptDelete(binding, ['t/', `t/${'x'.repeat(63)}`]));
  assert.equal(upserts, 0);
  assert.equal(deletes, 0);
});

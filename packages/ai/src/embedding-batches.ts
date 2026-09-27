import type { EmbeddingProvider } from "../../contracts/src/ai.ts";
import type { BackgroundOperationContext } from "../../contracts/src/execution.ts";

export const EMBEDDING_MODEL = "text-embedding-3-small" as const;
export const EMBEDDING_DIMENSIONS = 1536 as const;
export const MAX_EMBEDDING_INPUTS = 96 as const;
export const MAX_EMBEDDING_TOKENS_PER_INPUT = 8_000 as const;
export const MAX_EMBEDDING_BATCH_TOKENS = 240_000 as const;

export interface EstimatedEmbeddingInput {
  readonly id: string;
  readonly text: string;
  readonly contentHash: string;
  readonly estimatedTokens: number;
}

export interface EmbeddingBatch {
  readonly inputs: readonly EstimatedEmbeddingInput[];
  readonly estimatedTokens: number;
}

export interface Float32EmbeddingRecord {
  readonly id: string;
  readonly values: Float32Array;
  readonly vectorDigest: string;
}

function invalid(message: string): never {
  throw new Error(message);
}

function assertInput(input: EstimatedEmbeddingInput): void {
  if (typeof input.id !== "string" || input.id.length === 0 || typeof input.text !== "string" || input.text.length === 0) {
    invalid("Embedding inputs require a non-empty ID and text.");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.contentHash)) invalid("Embedding inputs require an unprefixed content hash.");
  if (!Number.isSafeInteger(input.estimatedTokens) || input.estimatedTokens < 0 || input.estimatedTokens > MAX_EMBEDDING_TOKENS_PER_INPUT) {
    invalid("Embedding input token estimates exceed the configured limit.");
  }
}

export function partitionEmbeddingBatches(inputs: readonly EstimatedEmbeddingInput[]): readonly EmbeddingBatch[] {
  const ordered = [...inputs].sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(ordered.map((input) => input.id)).size !== ordered.length) invalid("Embedding batches cannot contain duplicate IDs.");
  const batches: EmbeddingBatch[] = [];
  let batch: EstimatedEmbeddingInput[] = [];
  let total = 0;
  for (const input of ordered) {
    assertInput(input);
    if (batch.length === MAX_EMBEDDING_INPUTS || total + input.estimatedTokens > MAX_EMBEDDING_BATCH_TOKENS) {
      batches.push({ inputs: batch, estimatedTokens: total });
      batch = [];
      total = 0;
    }
    batch.push(input);
    total += input.estimatedTokens;
  }
  if (batch.length > 0) batches.push({ inputs: batch, estimatedTokens: total });
  return batches;
}

async function digest(values: Float32Array): Promise<string> {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index += 1) view.setFloat32(index * 4, values[index]!, true);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeVector(values: readonly number[], dimensions: number, model: string): Float32Array {
  if (model !== EMBEDDING_MODEL || dimensions !== EMBEDDING_DIMENSIONS || values.length !== EMBEDDING_DIMENSIONS) {
    invalid("Embedding responses must use text-embedding-3-small with 1536 dimensions.");
  }
  const normalized = new Float32Array(EMBEDDING_DIMENSIONS);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "number" || !Number.isFinite(value)) invalid("Embedding responses must contain finite numbers.");
    const float32 = Math.fround(value);
    if (!Number.isFinite(float32)) invalid("Embedding responses must remain finite after Float32 normalization.");
    normalized[index] = float32;
  }
  return normalized;
}

export async function executeEmbeddingBatch(
  context: BackgroundOperationContext,
  provider: EmbeddingProvider,
  batch: EmbeddingBatch,
): Promise<{ readonly records: readonly Float32EmbeddingRecord[] }> {
  if (context.signal.aborted) invalid("Embedding operation was cancelled before provider invocation.");
  if (batch.inputs.length === 0 || batch.inputs.length > MAX_EMBEDDING_INPUTS || batch.estimatedTokens > MAX_EMBEDDING_BATCH_TOKENS) {
    invalid("Embedding batch exceeds the configured bounds.");
  }
  for (const input of batch.inputs) assertInput(input);
  if (new Set(batch.inputs.map((input) => input.id)).size !== batch.inputs.length) invalid("Embedding batches cannot contain duplicate IDs.");
  const estimatedTokens = batch.inputs.reduce((total, input) => total + input.estimatedTokens, 0);
  if (!Number.isSafeInteger(batch.estimatedTokens) || batch.estimatedTokens < 0 || batch.estimatedTokens !== estimatedTokens || estimatedTokens > MAX_EMBEDDING_BATCH_TOKENS) {
    invalid("Embedding batch token totals are inconsistent or exceed the configured limit.");
  }
  const results = await provider.embedBatch(context, {
    model: { provider: "openai", model: EMBEDDING_MODEL },
    expectedDimensions: EMBEDDING_DIMENSIONS,
    inputs: batch.inputs.map(({ id, text, contentHash }) => ({ customId: id, text, contentHash: contentHash as never })),
  });
  if (results.length !== batch.inputs.length) invalid("Embedding responses must map exactly once to every submitted ID.");
  const expected = new Map(batch.inputs.map((input) => [input.id, input]));
  const records: Float32EmbeddingRecord[] = [];
  for (const result of results) {
    if (!expected.delete(result.customId)) invalid("Embedding response contains a duplicate or unexpected ID.");
    const values = normalizeVector(result.values, result.dimensions, result.model);
    records.push({ id: result.customId, values, vectorDigest: await digest(values) });
  }
  if (expected.size !== 0) invalid("Embedding response omitted a submitted ID.");
  return { records: records.sort((left, right) => left.id.localeCompare(right.id)) };
}

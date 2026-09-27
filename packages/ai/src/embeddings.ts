import { ServiceError, isServiceError } from "../../contracts/src/errors.ts";
import type { AiModelRef, EmbeddingProvider } from "../../contracts/src/ai.ts";
import type { OperationContext } from "../../contracts/src/execution.ts";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  MAX_EMBEDDING_BATCH_TOKENS,
  MAX_EMBEDDING_INPUTS,
  MAX_EMBEDDING_TOKENS_PER_INPUT,
} from "./embedding-batches.ts";
import { readBoundedResponse, withDeadline } from "./deadline.ts";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const EMBEDDING_TIMEOUT_MS = 8_000;
const MAX_QUERY_RESPONSE_BYTES = 128 * 1024;
// The frozen adapter input has no token count, so these are conservative UTF-8 byte ceilings.
const MAX_EMBEDDING_INPUT_BYTES = MAX_EMBEDDING_TOKENS_PER_INPUT;
const MAX_EMBEDDING_BATCH_BYTES = MAX_EMBEDDING_BATCH_TOKENS;
const HASH = /^[0-9a-f]{64}$/u;

function invalid(message: string): never {
  throw new ServiceError({ code: "invalid_argument", message });
}

function unavailable(retryable = true): ServiceError {
  return new ServiceError({ code: "dependency_unavailable", message: "Embedding is temporarily unavailable.", retryable });
}

function rateLimited(): ServiceError {
  return new ServiceError({ code: "rate_limited", message: "Embedding is temporarily rate limited.", retryable: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || utf8Bytes(value) > MAX_EMBEDDING_INPUT_BYTES) {
    invalid(`${label} exceeds the ${MAX_EMBEDDING_INPUT_BYTES}-byte limit.`);
  }
}

function assertModel(model: AiModelRef, expectedDimensions: number): void {
  if (model.provider !== "openai" || model.model !== EMBEDDING_MODEL || model.revision !== undefined || expectedDimensions !== EMBEDDING_DIMENSIONS) {
    invalid("Embeddings require text-embedding-3-small with 1536 dimensions.");
  }
}

function assertBatchInput(input: unknown): asserts input is { readonly customId: string; readonly text: string; readonly contentHash: string } {
  if (!isRecord(input) || typeof input.customId !== "string" || input.customId !== input.customId.trim() || input.customId.length === 0 || utf8Bytes(input.customId) > 64 || typeof input.contentHash !== "string" || !HASH.test(input.contentHash)) {
    invalid("Embedding batch input is invalid.");
  }
  assertText(input.text, "Embedding text");
}

function validateRequest(
  request: { readonly model: AiModelRef; readonly expectedDimensions: number; readonly inputs: readonly { readonly customId: string; readonly text: string; readonly contentHash: string }[] },
): void {
  assertModel(request.model, request.expectedDimensions);
  if (!Array.isArray(request.inputs) || request.inputs.length < 1 || request.inputs.length > MAX_EMBEDDING_INPUTS) {
    invalid(`Embedding batches require one through ${MAX_EMBEDDING_INPUTS} inputs.`);
  }
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const input of request.inputs) {
    assertBatchInput(input);
    if (ids.has(input.customId)) invalid("Embedding batches cannot contain duplicate IDs.");
    ids.add(input.customId);
    totalBytes += utf8Bytes(input.text);
    if (totalBytes > MAX_EMBEDDING_BATCH_BYTES) invalid(`Embedding batches exceed the ${MAX_EMBEDDING_BATCH_BYTES}-byte limit.`);
  }
}

function validateVector(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw unavailable(false);
  }
  return value;
}

function parseEmbeddingResponse(body: string, inputs: readonly { readonly customId: string }[]): readonly (ReturnType<typeof vectorResult>)[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw unavailable(false);
  }
  if (!isRecord(payload) || payload.model !== EMBEDDING_MODEL || !Array.isArray(payload.data) || payload.data.length !== inputs.length) {
    throw unavailable(false);
  }
  const vectors = new Map<number, readonly number[]>();
  for (const entry of payload.data) {
    const index = isRecord(entry) ? entry.index : undefined;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= inputs.length || vectors.has(index)) {
      throw unavailable(false);
    }
    vectors.set(index, validateVector(entry.embedding));
  }
  return inputs.map((input, index) => {
    const values = vectors.get(index);
    if (values === undefined) throw unavailable(false);
    return vectorResult(input.customId, values);
  });
}

function vectorResult(customId: string, values: readonly number[]) {
  return { customId, values, dimensions: EMBEDDING_DIMENSIONS, model: EMBEDDING_MODEL };
}

function upstreamError(status: number): ServiceError {
  if (status === 429) return rateLimited();
  return unavailable(status >= 500);
}

async function submit(
  context: OperationContext,
  fetcher: Fetch,
  apiKey: string,
  inputs: readonly { readonly customId: string; readonly text: string }[],
): Promise<readonly ReturnType<typeof vectorResult>[]> {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) throw unavailable(false);
  try {
    return await withDeadline(context, EMBEDDING_TIMEOUT_MS, async (signal) => {
      let response: Response;
      try {
        response = await fetcher("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ input: inputs.map((input) => input.text), model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS }),
          redirect: "manual",
          signal,
        });
      } catch {
        throw unavailable();
      }
      if (response.redirected) throw unavailable(false);
      if (!response.ok) throw upstreamError(response.status);
      const maximumBytes = MAX_QUERY_RESPONSE_BYTES * inputs.length;
      return parseEmbeddingResponse(await readBoundedResponse(response, signal, maximumBytes), inputs);
    });
  } catch (error) {
    if (isServiceError(error)) throw error;
    throw unavailable();
  }
}

export function createOpenAiEmbeddingProvider({ fetch, apiKey }: { readonly fetch: Fetch; readonly apiKey: string }): EmbeddingProvider {
  return {
    async embedQuery(context, request) {
      assertText(request.text, "Embedding text");
      assertModel(request.model, request.expectedDimensions);
      const [result] = await submit(context, fetch, apiKey, [{ customId: "query", text: request.text }]);
      return { values: result!.values, dimensions: result!.dimensions, model: result!.model };
    },
    async embedBatch(context, request) {
      if ((context as OperationContext).boundary !== "background") invalid("Embedding batches are background-only.");
      validateRequest(request);
      const results = await submit(context, fetch, apiKey, request.inputs);
      return results;
    },
  };
}

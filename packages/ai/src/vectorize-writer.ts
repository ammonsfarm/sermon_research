import { assertFrozenVectorizeMetadata, VECTORIZE_METADATA_KEYS, type FrozenVectorizeMetadata } from "./chunks.ts";
import { EMBEDDING_DIMENSIONS } from "./embedding-batches.ts";

export const MAX_VECTORIZE_UPSERT_RECORDS = 1_000 as const;
export const VECTORIZE_VISIBILITY_DELAYS_SECONDS = [5, 10, 20, 40, 60, 60, 60, 60, 60, 60] as const;

export interface VectorizeWriteRecord {
  readonly id: string;
  readonly values: Float32Array;
  readonly vectorDigest: string;
  readonly metadata: FrozenVectorizeMetadata;
}

type ProviderScalarMetadataValue = string | number | boolean | string[];
// Vectorize permits either a scalar metadata value or one object level whose
// fields are scalar metadata values. AIC's validator below remains stricter.
type ProviderMetadataValue = ProviderScalarMetadataValue | Record<string, ProviderScalarMetadataValue>;
type ProviderVector = { id: string; values: Float32Array | Float64Array | number[]; namespace?: string; metadata?: Record<string, ProviderMetadataValue> };
type ProviderMatch = { id: string; values?: Float32Array | Float64Array | number[]; namespace?: string; metadata?: Record<string, ProviderMetadataValue>; score: number };

export interface VectorizeWriteBinding {
  upsert(records: ProviderVector[]): Promise<{ mutationId: string }>;
  deleteByIds(ids: string[]): Promise<{ mutationId: string }>;
  getByIds(ids: string[]): Promise<ProviderVector[]>;
  queryById(id: string, options?: { topK?: number; returnValues?: boolean; returnMetadata?: boolean | "all" | "indexed" | "none" }): Promise<{ matches: ProviderMatch[]; count: number }>;
}

export interface VectorizeMutationReceipt {
  readonly mutationId: string;
  readonly state: "accepted" | "delete_accepted";
  readonly records: readonly VectorizeWriteRecord[];
  readonly ids: readonly string[];
  readonly idDigest: string;
}

function invalid(message: string): never {
  throw new Error(message);
}

async function sha256(bytes: Uint8Array | string): Promise<string> {
  const value = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", value as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function vectorDigest(values: Float32Array): Promise<string> {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index += 1) view.setFloat32(index * 4, values[index]!, true);
  return sha256(bytes);
}

export function vectorizeMetadataEquals(actual: Record<string, ProviderMetadataValue> | undefined, expected: FrozenVectorizeMetadata): boolean {
  if (!actual || Object.keys(actual).length !== VECTORIZE_METADATA_KEYS.length) return false;
  return VECTORIZE_METADATA_KEYS.every((key) => actual[key] === expected[key]);
}

async function normalizeRecord(record: VectorizeWriteRecord): Promise<VectorizeWriteRecord> {
  const family = record.metadata.source_type === "episode_transcript" ? "t/" : record.metadata.source_type === "episode_intelligence" ? "i/" : "a/";
  assertVectorIdentity(record.id, family);
  if (record.values.length !== EMBEDDING_DIMENSIONS) invalid("Vectorize records must have 1536 Float32 values.");
  const values = new Float32Array(record.values);
  if (values.some((value) => !Number.isFinite(value))) invalid("Vectorize records must contain finite Float32 values.");
  assertFrozenVectorizeMetadata(record.metadata);
  return { ...record, values, vectorDigest: await vectorDigest(values) };
}

function assertVectorIdentity(id: string, family?: "t/" | "i/" | "a/"): void {
  if (typeof id !== "string" || id.length <= 2 || new TextEncoder().encode(id).byteLength > 64) invalid("Vector IDs are invalid.");
  const actualFamily = id.slice(0, 2);
  if (actualFamily !== "t/" && actualFamily !== "i/" && actualFamily !== "a/" || family !== undefined && actualFamily !== family) invalid("Vector IDs must match a frozen vector family.");
}

async function receipt(
  mutationId: string,
  state: "accepted" | "delete_accepted",
  records: readonly VectorizeWriteRecord[],
  ids: readonly string[],
): Promise<VectorizeMutationReceipt> {
  if (typeof mutationId !== "string" || mutationId.length === 0) invalid("Vectorize mutation receipts must include a mutation ID.");
  const sortedIds = [...ids].sort((left, right) => left.localeCompare(right));
  return { mutationId, state, records, ids: sortedIds, idDigest: await sha256(sortedIds.join("\0")) };
}

export async function acceptUpsert(binding: VectorizeWriteBinding, records: readonly VectorizeWriteRecord[]): Promise<VectorizeMutationReceipt> {
  if (records.length === 0 || records.length > MAX_VECTORIZE_UPSERT_RECORDS) invalid("Vectorize upserts must contain one through 1000 records.");
  const normalized = await Promise.all(records.map(normalizeRecord));
  normalized.sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(normalized.map((record) => record.id)).size !== normalized.length) invalid("Vectorize upserts cannot contain duplicate IDs.");
  const mutation = await binding.upsert(normalized.map(({ id, values, metadata }) => ({ id, values, metadata: { ...metadata } })));
  return receipt(mutation.mutationId, "accepted", normalized, normalized.map((record) => record.id));
}

export async function acceptDelete(binding: VectorizeWriteBinding, ids: readonly string[]): Promise<VectorizeMutationReceipt> {
  if (ids.length === 0 || ids.length > MAX_VECTORIZE_UPSERT_RECORDS || new Set(ids).size !== ids.length) invalid("Vectorize deletes must contain one through 1000 unique IDs.");
  for (const id of ids) assertVectorIdentity(id);
  const mutation = await binding.deleteByIds([...ids].sort((left, right) => left.localeCompare(right)));
  return receipt(mutation.mutationId, "delete_accepted", [], ids);
}

/** Vectorize rejects getByIds calls with more than 20 ids. */
export const VECTORIZE_GET_BY_IDS_LIMIT = 20;

/** getByIds in batches of at most 20 ids, preserving the combined result. */
export async function getVectorsByIds(
  binding: Pick<VectorizeWriteBinding, "getByIds">,
  ids: readonly string[],
): Promise<ProviderVector[]> {
  const results: ProviderVector[] = [];
  for (let index = 0; index < ids.length; index += VECTORIZE_GET_BY_IDS_LIMIT) {
    results.push(...await binding.getByIds(ids.slice(index, index + VECTORIZE_GET_BY_IDS_LIMIT)));
  }
  return results;
}

export async function probeUpsertVisibility(
  binding: VectorizeWriteBinding,
  receiptValue: VectorizeMutationReceipt,
): Promise<{ readonly state: "visible" | "pending"; readonly receipt: VectorizeMutationReceipt }> {
  if (receiptValue.state !== "accepted") invalid("Only accepted upserts may be checked for visibility.");
  const returned = await getVectorsByIds(binding, receiptValue.ids);
  const actual = new Map(returned.map((record) => [record.id, record]));
  for (const expected of receiptValue.records) {
    const record = actual.get(expected.id);
    if (!record || !vectorizeMetadataEquals(record.metadata, expected.metadata)) return { state: "pending", receipt: receiptValue };
    const values = new Float32Array(record.values);
    if (values.length !== EMBEDDING_DIMENSIONS || values.some((value) => !Number.isFinite(value)) || await vectorDigest(values) !== expected.vectorDigest) {
      return { state: "pending", receipt: receiptValue };
    }
  }
  const sampleId = receiptValue.ids[0];
  if (!sampleId) return { state: "pending", receipt: receiptValue };
  const sample = await binding.queryById(sampleId, { topK: 1, returnValues: false, returnMetadata: "indexed" });
  if (!sample.matches.some((match) => match.id === sampleId && vectorizeMetadataEquals(match.metadata, receiptValue.records[0]!.metadata))) {
    return { state: "pending", receipt: receiptValue };
  }
  return { state: "visible", receipt: receiptValue };
}

export async function probeDeleteAbsence(
  binding: VectorizeWriteBinding,
  receiptValue: VectorizeMutationReceipt,
): Promise<{ readonly state: "deleted" | "pending"; readonly receipt: VectorizeMutationReceipt }> {
  if (receiptValue.state !== "delete_accepted") invalid("Only accepted deletes may be checked for absence.");
  const returned = await getVectorsByIds(binding, receiptValue.ids);
  return { state: returned.some((record) => receiptValue.ids.includes(record.id)) ? "pending" : "deleted", receipt: receiptValue };
}

import {
  acceptDelete,
  acceptUpsert,
  executeEmbeddingBatch,
  probeDeleteAbsence,
  vectorizeMetadataEquals,
  VECTORIZE_VISIBILITY_DELAYS_SECONDS,
  type EmbeddingBatch,
  type Float32EmbeddingRecord,
  type FrozenVectorizeMetadata,
  type IndexingChunk,
  type VectorizeMutationReceipt,
  type VectorizeWriteBinding,
  getVectorsByIds,
} from "@aic/ai";
import {
  ProcessingStateError,
  type BackgroundOperationContext,
  type EmbeddingProvider,
  type JsonValue,
  type ProcessingDesiredPublication,
  type ProcessingRevisionHash,
  type ProcessingState,
  type ProcessingStateStore,
} from "@aic/contracts";
import {
  AudioTransportError,
  classifyAudioForTranscription,
  type AudioObjectDescriptor,
  type AudioTransport,
  type MistralTranscriptionReceipt,
  type NormalizedTranscriptionArtifact,
  type TranscriptionAttemptContext,
} from "./audio-transport.ts";
import { PROVIDER_ATTEMPT_CONFIG, runProviderAttempts } from "./provider-attempts.ts";
import { AudioStorageError } from "./audio-storage.ts";
import {
  IntelligenceProviderError,
  type EpisodeIntelligenceArtifact,
  type EpisodeIntelligenceInput,
  type EpisodeIntelligenceProvider,
} from "./intelligence.ts";

export interface EpisodeWorkflowEvent {
  readonly requestId: string;
  readonly revisionHash: ProcessingRevisionHash;
}

export interface EpisodeWorkflowRequest {
  readonly requestId: string;
  readonly episodeId: string;
  readonly revisionId: string;
  readonly revisionHash: ProcessingRevisionHash;
  readonly generation: number;
  readonly desiredPublication: ProcessingDesiredPublication;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly snapshot: Readonly<Record<string, JsonValue>>;
}

export type EpisodeVectorFamily = "transcript" | "intelligence";

export interface EpisodeManifestDescriptor {
  readonly family: EpisodeVectorFamily;
  readonly ids: readonly string[];
  readonly idDigest: string;
  readonly embeddingBatchCount: number;
}

export interface PreparedEpisodeEmbeddingBatch {
  readonly batch: EmbeddingBatch;
  readonly chunks: readonly IndexingChunk[];
}

export interface EpisodeVectorProofRecord {
  readonly id: string;
  readonly vectorDigest: string;
  readonly metadata: FrozenVectorizeMetadata;
}

export interface CompactVectorMutationReceipt {
  readonly mutationId: string;
  readonly state: "accepted" | "delete_accepted";
  readonly ids: readonly string[];
  readonly idDigest: string;
}

export interface IntelligenceArtifactReceipt {
  readonly artifactKey: string;
  readonly artifactDigest: string;
  readonly itemCount: number;
  readonly model: string;
}

export interface EpisodeIngestRepository {
  loadRequest(event: EpisodeWorkflowEvent): Promise<EpisodeWorkflowRequest>;
  loadAudioDescriptor(request: EpisodeWorkflowRequest): Promise<AudioObjectDescriptor | null>;
  storeAudio(request: EpisodeWorkflowRequest): Promise<AudioObjectDescriptor>;
  persistAudioDescriptor(request: EpisodeWorkflowRequest, descriptor: AudioObjectDescriptor): Promise<void>;
  persistTranscriptArtifact(
    context: TranscriptionAttemptContext,
    descriptor: AudioObjectDescriptor,
    artifact: NormalizedTranscriptionArtifact,
  ): Promise<{ readonly artifactKey: string }>;
  loadTranscriptReceipt(request: EpisodeWorkflowRequest, requireComplete?: boolean): Promise<MistralTranscriptionReceipt | null>;
  commitTranscript(request: EpisodeWorkflowRequest, receipt: MistralTranscriptionReceipt): Promise<void>;
  materializeManifest(request: EpisodeWorkflowRequest, family: EpisodeVectorFamily): Promise<EpisodeManifestDescriptor>;
  loadEmbeddingBatch(request: EpisodeWorkflowRequest, family: EpisodeVectorFamily, ordinal: number): Promise<PreparedEpisodeEmbeddingBatch>;
  recordPreparedVectors(
    request: EpisodeWorkflowRequest,
    manifest: EpisodeManifestDescriptor,
    chunks: readonly IndexingChunk[],
    records: readonly Float32EmbeddingRecord[],
  ): Promise<void>;
  loadVectorProofRecords(request: EpisodeWorkflowRequest, ids: readonly string[]): Promise<readonly EpisodeVectorProofRecord[]>;
  loadAcceptedMutation(
    request: EpisodeWorkflowRequest,
    batchOrdinal: number,
    operation: "upsert" | "delete",
    ids: readonly string[],
  ): Promise<CompactVectorMutationReceipt | null>;
  markVectorsAccepted(request: EpisodeWorkflowRequest, ids: readonly string[], mutationId: string): Promise<void>;
  markVectorsVisible(request: EpisodeWorkflowRequest, ids: readonly string[], mutationId: string): Promise<void>;
  listStaleVectorIds(request: EpisodeWorkflowRequest, family: EpisodeVectorFamily, targetIds: readonly string[]): Promise<readonly string[]>;
  markVectorsDeleted(request: EpisodeWorkflowRequest, ids: readonly string[], mutationId: string): Promise<void>;
  loadIntelligenceInput(request: EpisodeWorkflowRequest): Promise<EpisodeIntelligenceInput>;
  loadIntelligenceReceipt(request: EpisodeWorkflowRequest): Promise<IntelligenceArtifactReceipt | null>;
  persistIntelligenceArtifact(request: EpisodeWorkflowRequest, artifact: EpisodeIntelligenceArtifact): Promise<IntelligenceArtifactReceipt>;
  finalizeEpisode(request: EpisodeWorkflowRequest, expectedVectorBatchCount: number): Promise<void>;
}

export interface EpisodeWorkflowStepPort {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: Readonly<Record<string, unknown>>, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
}

export interface EpisodeWorkflowDependencies {
  readonly repository: EpisodeIngestRepository;
  readonly stateStore: ProcessingStateStore;
  readonly audioTransport: AudioTransport;
  readonly intelligence: EpisodeIntelligenceProvider;
  readonly embeddings: EmbeddingProvider;
  readonly vectorize: VectorizeWriteBinding;
  readonly now?: () => Date;
}

const PROVIDER_STEP_CONFIG = {
  retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const;
const INTELLIGENCE_STEP_CONFIG = {
  retries: { limit: 8, delay: "15 seconds", backoff: "exponential" },
  timeout: "30 minutes",
} as const;
const VECTOR_BATCH_SIZE = 1_000;
const TRANSCRIPT_UPSERT_OFFSET = 0;
const TRANSCRIPT_DELETE_OFFSET = 10_000;
const INTELLIGENCE_UPSERT_OFFSET = 20_000;
const INTELLIGENCE_DELETE_OFFSET = 30_000;

function digest(value: string): ProcessingRevisionHash {
  return `sha256:${value}` as ProcessingRevisionHash;
}

function compact(receipt: VectorizeMutationReceipt): CompactVectorMutationReceipt {
  return {
    mutationId: receipt.mutationId,
    state: receipt.state,
    ids: receipt.ids,
    idDigest: receipt.idDigest,
  };
}

function batches<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}

function backgroundContext(request: EpisodeWorkflowRequest, attempt: number): BackgroundOperationContext {
  return {
    boundary: "background",
    job: {
      id: `p6-job:${request.requestId}` as never,
      kind: "episode_ingest",
      attempt,
      idempotencyKey: request.idempotencyKey as never,
    },
    correlation: {
      correlationId: request.correlationId as never,
      requestId: request.requestId as never,
    },
    signal: new AbortController().signal,
  };
}

async function transition(
  store: ProcessingStateStore,
  request: EpisodeWorkflowRequest,
  stageName: string,
  from: ProcessingState,
  to: ProcessingState,
  options: {
    readonly leaseToken?: string;
    readonly outputHash?: ProcessingRevisionHash;
    readonly sideEffectKey?: string;
    readonly errorCode?: string;
    readonly errorClass?: string;
    readonly errorMessage?: string;
    readonly retryClass?: string;
    readonly stageStatus?: "side_effect_unknown";
  } = {},
): Promise<void> {
  await store.transition({
    requestId: request.requestId,
    workflow: "episode",
    generation: request.generation,
    stageName,
    from,
    to,
    ...(options.leaseToken === undefined ? {} : { mutationLeaseToken: options.leaseToken }),
    ...(options.outputHash === undefined ? {} : { outputHash: options.outputHash }),
    ...(options.sideEffectKey === undefined ? {} : { sideEffectKey: options.sideEffectKey }),
    ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
    ...(options.errorClass === undefined ? {} : { errorClass: options.errorClass }),
    ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
    ...(options.retryClass === undefined ? {} : { retryClass: options.retryClass }),
    ...(options.stageStatus === undefined ? {} : { stageStatus: options.stageStatus }),
  });
}

interface FailureDisposition {
  readonly to: "failed" | "retry_required";
  readonly code: string;
  readonly errorClass: string;
  readonly message: string;
  readonly stageStatus?: "side_effect_unknown";
}

function failure(error: unknown): FailureDisposition {
  if (error instanceof AudioStorageError) {
    return error.code === "invalid_input" || error.code === "audio_identity_conflict"
      ? { to: "failed", code: error.code, errorClass: error.code === "invalid_input" ? "invalid_input" : "identity_conflict", message: error.message }
      : { to: "retry_required", code: error.code, errorClass: "transient_dependency", message: "Audio storage is temporarily unavailable." };
  }
  if (error instanceof AudioTransportError) {
    if (error.code === "invalid_input") return { to: "failed", code: error.code, errorClass: "invalid_input", message: error.message };
    return {
      to: "retry_required",
      code: error.code,
      errorClass: error.code,
      message: error.message,
      ...(error.code === "provider_timeout_unknown" ? { stageStatus: "side_effect_unknown" as const } : {}),
    };
  }
  if (error instanceof IntelligenceProviderError) {
    return {
      to: "retry_required",
      code: error.code,
      errorClass: error.code,
      message: error.message,
      ...(error.code === "provider_timeout_unknown" ? { stageStatus: "side_effect_unknown" as const } : {}),
    };
  }
  if (error instanceof ProcessingStateError) {
    if (error.code === "visibility_pending") {
      return { to: "retry_required", code: error.code, errorClass: "visibility_pending", message: error.message };
    }
    throw error;
  }
  return {
    to: "retry_required",
    code: "transient_dependency",
    errorClass: "transient_dependency",
    message: "Episode processing dependency is temporarily unavailable.",
  };
}

async function recordFailure(
  deps: EpisodeWorkflowDependencies,
  request: EpisodeWorkflowRequest,
  stageName: string,
  from: ProcessingState,
  error: unknown,
  leaseToken?: string,
): Promise<void> {
  const disposition = failure(error);
  await transition(deps.stateStore, request, stageName, from, disposition.to, {
    ...(leaseToken === undefined ? {} : { leaseToken }),
    errorCode: disposition.code,
    errorClass: disposition.errorClass,
    errorMessage: disposition.message,
    retryClass: disposition.errorClass,
    ...(disposition.stageStatus === undefined ? {} : { stageStatus: disposition.stageStatus }),
  });
}

function leaseExpiry(deps: EpisodeWorkflowDependencies): string {
  const now = deps.now?.() ?? new Date();
  return new Date(now.getTime() + 3 * 60 * 60_000).toISOString();
}

async function claimLease(deps: EpisodeWorkflowDependencies, request: EpisodeWorkflowRequest, leaseToken: string): Promise<void> {
  await deps.stateStore.claimMutationLease({
    requestId: request.requestId,
    generation: request.generation,
    leaseToken,
    expiresAt: leaseExpiry(deps),
  });
}

async function waitForUpsertVisibility(
  step: EpisodeWorkflowStepPort,
  deps: EpisodeWorkflowDependencies,
  request: EpisodeWorkflowRequest,
  receipt: CompactVectorMutationReceipt,
  batchOrdinal: number,
  leaseToken: string,
): Promise<void> {
  for (const [attempt, delay] of VECTORIZE_VISIBILITY_DELAYS_SECONDS.entries()) {
    await step.sleep(`wait-vector-visibility-${batchOrdinal}-sleep-${attempt}`, `${delay} seconds`);
    const result = await step.do(`wait-vector-visibility-${batchOrdinal}-poll-${attempt}`, async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      await claimLease(deps, request, leaseToken);
      const records = await deps.repository.loadVectorProofRecords(request, receipt.ids);
      const returned = await getVectorsByIds(deps.vectorize, receipt.ids);
      const actual = new Map(returned.map((record) => [record.id, record]));
      let visible = records.length === receipt.ids.length;
      for (const expected of records) {
        const record = actual.get(expected.id);
        if (!record || !vectorizeMetadataEquals(record.metadata, expected.metadata)) { visible = false; break; }
        const values = new Float32Array(record.values);
        const bytes = new Uint8Array(values.length * 4);
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < values.length; index += 1) view.setFloat32(index * 4, values[index]!, true);
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        const digestValue = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
        if (values.length !== 1_536 || digestValue !== expected.vectorDigest) { visible = false; break; }
      }
      const sample = records[0];
      if (visible && sample) {
        const query = await deps.vectorize.queryById(sample.id, { topK: 1, returnValues: false, returnMetadata: "indexed" });
        visible = query.matches.some((match) => match.id === sample.id && vectorizeMetadataEquals(match.metadata, sample.metadata));
      }
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      return visible ? "visible" : "pending";
    });
    if (result === "visible") {
      await claimLease(deps, request, leaseToken);
      await deps.stateStore.recordVectorVisibility({
        requestId: request.requestId,
        generation: request.generation,
        batchOrdinal,
        operation: "upsert",
        leaseToken,
      });
      await deps.repository.markVectorsVisible(request, receipt.ids, receipt.mutationId);
      return;
    }
  }
  throw new ProcessingStateError("visibility_pending", "Vector upsert visibility was not proven within the bounded polling budget.");
}

async function waitForDeleteVisibility(
  step: EpisodeWorkflowStepPort,
  deps: EpisodeWorkflowDependencies,
  request: EpisodeWorkflowRequest,
  receipt: CompactVectorMutationReceipt,
  batchOrdinal: number,
  leaseToken: string,
): Promise<void> {
  for (const [attempt, delay] of VECTORIZE_VISIBILITY_DELAYS_SECONDS.entries()) {
    await step.sleep(`wait-vector-delete-${batchOrdinal}-sleep-${attempt}`, `${delay} seconds`);
    const result = await step.do(`wait-vector-delete-${batchOrdinal}-poll-${attempt}`, async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      await claimLease(deps, request, leaseToken);
      return (await probeDeleteAbsence(deps.vectorize, { ...receipt, records: [] })).state;
    });
    if (result === "deleted") {
      await claimLease(deps, request, leaseToken);
      await deps.stateStore.recordVectorVisibility({
        requestId: request.requestId,
        generation: request.generation,
        batchOrdinal,
        operation: "delete",
        leaseToken,
      });
      await deps.repository.markVectorsDeleted(request, receipt.ids, receipt.mutationId);
      return;
    }
  }
  throw new ProcessingStateError("visibility_pending", "Vector deletion was not proven within the bounded polling budget.");
}

async function upsertManifest(
  step: EpisodeWorkflowStepPort,
  deps: EpisodeWorkflowDependencies,
  request: EpisodeWorkflowRequest,
  manifest: EpisodeManifestDescriptor,
  offset: number,
  leaseToken: string,
): Promise<readonly CompactVectorMutationReceipt[]> {
  const receipts: CompactVectorMutationReceipt[] = [];
  for (let ordinal = 0; ordinal < manifest.embeddingBatchCount; ordinal += 1) {
    const batchOrdinal = offset + ordinal;
    const receipt = await step.do(`upsert-provider-${manifest.family}-${ordinal}`, PROVIDER_STEP_CONFIG, async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      await claimLease(deps, request, leaseToken);
      const prepared = await deps.repository.loadEmbeddingBatch(request, manifest.family, ordinal);
      const ids = prepared.batch.inputs.map((input) => input.id);
      const accepted = await deps.repository.loadAcceptedMutation(request, batchOrdinal, "upsert", ids);
      if (accepted !== null) return accepted;
      const embedded = await executeEmbeddingBatch(backgroundContext(request, ordinal + 1), deps.embeddings, prepared.batch);
      const chunksById = new Map(prepared.chunks.map((chunk) => [chunk.id, chunk]));
      const records = embedded.records.map((record) => ({ ...record, metadata: chunksById.get(record.id)!.metadata }));
      await deps.repository.recordPreparedVectors(request, manifest, prepared.chunks, embedded.records);
      return compact(await acceptUpsert(deps.vectorize, records));
    });
    receipts.push(await step.do(`upsert-acceptance-${manifest.family}-${ordinal}`, async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      await deps.stateStore.recordVectorAcceptance({
        requestId: request.requestId,
        generation: request.generation,
        batchOrdinal,
        operation: "upsert",
        expectedIdsDigest: digest(receipt.idDigest),
        expectedCount: receipt.ids.length,
        targetRevisionHash: request.revisionHash,
        providerMutationId: receipt.mutationId,
        leaseToken,
      });
      await deps.repository.markVectorsAccepted(request, receipt.ids, receipt.mutationId);
      return receipt;
    }));
  }
  return receipts;
}

async function deleteStaleManifest(
  step: EpisodeWorkflowStepPort,
  deps: EpisodeWorkflowDependencies,
  request: EpisodeWorkflowRequest,
  manifest: EpisodeManifestDescriptor,
  offset: number,
  leaseToken: string,
): Promise<readonly { readonly batchOrdinal: number; readonly receipt: CompactVectorMutationReceipt }[]> {
  const stale = await step.do(`select-stale-${manifest.family}-vectors`, async () => {
    await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
    return deps.repository.listStaleVectorIds(request, manifest.family, manifest.ids);
  });
  const receipts: { batchOrdinal: number; receipt: CompactVectorMutationReceipt }[] = [];
  for (const [ordinal, ids] of batches(stale, VECTOR_BATCH_SIZE).entries()) {
    const batchOrdinal = offset + ordinal;
    const receipt = await step.do(`delete-stale-provider-${manifest.family}-${ordinal}`, PROVIDER_STEP_CONFIG, async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      await claimLease(deps, request, leaseToken);
      const accepted = await deps.repository.loadAcceptedMutation(request, batchOrdinal, "delete", ids);
      if (accepted !== null) return accepted;
      return compact(await acceptDelete(deps.vectorize, ids));
    });
    receipts.push({ batchOrdinal, receipt: await step.do(`delete-stale-acceptance-${manifest.family}-${ordinal}`, async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      await deps.stateStore.recordVectorAcceptance({
        requestId: request.requestId,
        generation: request.generation,
        batchOrdinal,
        operation: "delete",
        expectedIdsDigest: digest(receipt.idDigest),
        expectedCount: receipt.ids.length,
        targetRevisionHash: request.revisionHash,
        providerMutationId: receipt.mutationId,
        leaseToken,
      });
      return receipt;
    }) });
  }
  return receipts;
}

async function prepareEmbeddingBatches(
  step: EpisodeWorkflowStepPort,
  deps: EpisodeWorkflowDependencies,
  request: EpisodeWorkflowRequest,
  manifest: EpisodeManifestDescriptor,
): Promise<void> {
  for (let ordinal = 0; ordinal < manifest.embeddingBatchCount; ordinal += 1) {
    await step.do(`embed-${manifest.family}-${ordinal}`, async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      const prepared = await deps.repository.loadEmbeddingBatch(request, manifest.family, ordinal);
      return { ids: prepared.batch.inputs.map((input) => input.id), estimatedTokens: prepared.batch.estimatedTokens };
    });
  }
}

/** Executes all 17 frozen episode stages without placing audio, text, URLs, or vectors in Workflow results. */
export async function runEpisodeIngestWorkflow(
  step: EpisodeWorkflowStepPort,
  event: EpisodeWorkflowEvent,
  deps: EpisodeWorkflowDependencies,
): Promise<void> {
  // 1. load-and-validate-input
  const request = await step.do("load-and-validate-input", async () => deps.repository.loadRequest(event));
  const audioLease = `p6-audio:${request.requestId}:${request.generation}`;
  let audioLeaseOwned = false;
  let descriptor: AudioObjectDescriptor;
  try {
    // 2. claim-audio-mutation
    await step.do("claim-audio-mutation", async () => {
      await claimLease(deps, request, audioLease);
      await transition(deps.stateStore, request, "claim-audio-mutation", "discovered", "audio_storing", { leaseToken: audioLease });
      return true;
    });
    audioLeaseOwned = true;

    // 3. stream-audio-to-r2
    try {
      descriptor = await step.do("stream-audio-to-r2", PROVIDER_STEP_CONFIG, async () => {
        await claimLease(deps, request, audioLease);
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        const replay = typeof deps.repository.loadAudioDescriptor === "function"
          ? await deps.repository.loadAudioDescriptor(request)
          : null;
        if (replay !== null) return replay;
        const result = await deps.repository.storeAudio(request);
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        return result;
      });
    } catch (error) {
      await recordFailure(deps, request, "stream-audio-to-r2", "audio_storing", error, audioLease);
      return;
    }

    // 4. verify-audio and persist metadata/provenance
    try {
      await step.do("verify-audio", async () => {
        await claimLease(deps, request, audioLease);
        await deps.repository.persistAudioDescriptor(request, descriptor);
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        await transition(deps.stateStore, request, "verify-audio", "audio_storing", "audio_stored", {
          leaseToken: audioLease,
          outputHash: descriptor.sha256,
          sideEffectKey: `r2:${descriptor.key}:${descriptor.sizeBytes}`,
        });
      });
    } catch (error) {
      await recordFailure(deps, request, "verify-audio", "audio_storing", error, audioLease);
      return;
    }
  } finally {
    if (audioLeaseOwned) {
      await deps.stateStore.releaseMutationLease({ requestId: request.requestId, generation: request.generation, leaseToken: audioLease }).catch(() => undefined);
    }
  }

  // 5. prepare-transcription-input
  const preparation = classifyAudioForTranscription(descriptor);
  if (preparation.decision !== "transcribe") {
    await transition(deps.stateStore, request, "prepare-transcription-input", "audio_stored", preparation.decision === "failed" ? "failed" : "retry_required", {
      errorCode: preparation.code,
      errorClass: preparation.code,
      errorMessage: preparation.reason,
    });
    return;
  }
  const stableDescriptor = await step.do("prepare-transcription-input", async () => {
    await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
    await transition(deps.stateStore, request, "prepare-transcription-input", "audio_stored", "transcribing");
    return descriptor;
  });

  // 6. transcribe-audio — the adapter mints and consumes the URL internally.
  let transcript: MistralTranscriptionReceipt;
  const transcriptionLease = `p6-transcription:${request.requestId}:${request.generation}`;
  try {
    const outcome = await runProviderAttempts(step, {
      name: "transcribe-audio",
      submit: async (attempt) => {
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        await claimLease(deps, request, transcriptionLease);
        // Retain ordinary replay compatibility with pre-repair receipts. Unknown recovery below is stricter.
        const replay = await deps.repository.loadTranscriptReceipt(request);
        if (replay !== null) return replay;
        return deps.audioTransport.transcribeAttempt(stableDescriptor, attempt, {
          requestId: request.requestId, revisionHash: request.revisionHash, generation: request.generation,
        });
      },
      classify: (error) => error instanceof AudioTransportError ? {
        code: error.code,
        ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
      } : null,
      reconcile: async () => {
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        await claimLease(deps, request, transcriptionLease);
        return deps.repository.loadTranscriptReceipt(request, true);
      },
    });
    if (!outcome.ok) {
      await step.do("record-transcription-failure", PROVIDER_ATTEMPT_CONFIG, async () => {
        const code = outcome.failure.code;
        await claimLease(deps, request, transcriptionLease);
        await transition(deps.stateStore, request, "transcribe-audio", "transcribing", code === "invalid_input" ? "failed" : "retry_required", {
          leaseToken: transcriptionLease, errorCode: code, errorClass: code, retryClass: code,
          errorMessage: `Transcription requires operator attention (${code}).`,
          ...(code === "provider_timeout_unknown" ? { stageStatus: "side_effect_unknown" as const } : {}),
        });
        // Unknown outcomes keep their lease and durable quarantine until proven reconciliation.
        if (code !== "provider_timeout_unknown") await deps.stateStore.releaseMutationLease({ requestId: request.requestId, generation: request.generation, leaseToken: transcriptionLease });
      });
      return;
    }
    transcript = outcome.receipt;
    await step.do("release-transcription-mutation", async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      await claimLease(deps, request, transcriptionLease);
      await deps.stateStore.releaseMutationLease({ requestId: request.requestId, generation: request.generation, leaseToken: transcriptionLease });
    });
  } catch (error) {
    // A native failure without a classified result cannot prove that submission failed.
    await step.do("record-transcription-unknown", PROVIDER_ATTEMPT_CONFIG, () =>
      recordFailure(deps, request, "transcribe-audio", "transcribing",
        error instanceof ProcessingStateError ? error
          : new AudioTransportError("provider_timeout_unknown", "Transcription outcome could not be proven.", false)));
    return;
  }

  // 7. commit-transcript
  try {
    await step.do("commit-transcript", async () => {
      await deps.repository.commitTranscript(request, transcript);
      await transition(deps.stateStore, request, "commit-transcript", "transcribing", "transcript_ready", {
        outputHash: digest(transcript.artifactDigest),
        sideEffectKey: transcript.artifactKey,
      });
    });
  } catch (error) {
    await recordFailure(deps, request, "commit-transcript", "transcribing", error);
    return;
  }

  // 8. chunk-transcript
  const transcriptManifest = await step.do("chunk-transcript", async () => {
    await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
    const manifest = await deps.repository.materializeManifest(request, "transcript");
    await transition(deps.stateStore, request, "chunk-transcript", "transcript_ready", "chunking");
    return manifest;
  });

  // 9. embed-transcript-{batch} (bounded persisted inputs; vectors never become step output)
  try {
    await prepareEmbeddingBatches(step, deps, request, transcriptManifest);
    await transition(deps.stateStore, request, "embed-transcript-complete", "chunking", "embedding");
  } catch (error) {
    await recordFailure(deps, request, "embed-transcript", "chunking", error);
    return;
  }

  const vectorLease = `p6-vectors:${request.requestId}:${request.generation}`;
  let vectorLeaseOwned = false;
  let expectedVectorBatchCount = 0;
  try {
    // 10. claim-transcript-vector-mutation
    await step.do("claim-transcript-vector-mutation", async () => {
      await claimLease(deps, request, vectorLease);
      await transition(deps.stateStore, request, "claim-transcript-vector-mutation", "embedding", "indexing", { leaseToken: vectorLease });
      return true;
    });
    vectorLeaseOwned = true;

    // 11. upsert-transcript-{batch}
    let transcriptUpserts: readonly CompactVectorMutationReceipt[];
    try {
      transcriptUpserts = await upsertManifest(step, deps, request, transcriptManifest, TRANSCRIPT_UPSERT_OFFSET, vectorLease);
      expectedVectorBatchCount += transcriptUpserts.length;
      await transition(deps.stateStore, request, "upsert-transcript-accepted", "indexing", "index_visibility_pending", { leaseToken: vectorLease });
    } catch (error) {
      await recordFailure(deps, request, "upsert-transcript", "indexing", error, vectorLease);
      return;
    }

    // 12. wait-transcript-visibility-{batch}
    try {
      for (const [ordinal, receipt] of transcriptUpserts.entries()) {
        await waitForUpsertVisibility(step, deps, request, receipt, TRANSCRIPT_UPSERT_OFFSET + ordinal, vectorLease);
      }
    } catch (error) {
      await recordFailure(deps, request, "wait-transcript-visibility", "index_visibility_pending", error, vectorLease);
      return;
    }

    // 13. delete/wait stale transcript vectors
    try {
      const transcriptDeletes = await deleteStaleManifest(step, deps, request, transcriptManifest, TRANSCRIPT_DELETE_OFFSET, vectorLease);
      expectedVectorBatchCount += transcriptDeletes.length;
      for (const { batchOrdinal, receipt } of transcriptDeletes) {
        await waitForDeleteVisibility(step, deps, request, receipt, batchOrdinal, vectorLease);
      }
      await transition(deps.stateStore, request, "transcript-index-visible", "index_visibility_pending", "indexed", { leaseToken: vectorLease });
    } catch (error) {
      await recordFailure(deps, request, "delete-stale-transcript", "index_visibility_pending", error, vectorLease);
      return;
    }

    // 14. generate-intelligence and persist the structured artifact before returning its descriptor.
    await transition(deps.stateStore, request, "generate-intelligence-start", "indexed", "intelligence_generating", { leaseToken: vectorLease });
    let intelligenceReceipt: IntelligenceArtifactReceipt;
    try {
      intelligenceReceipt = await step.do("generate-intelligence", INTELLIGENCE_STEP_CONFIG, async () => {
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        const replay = typeof deps.repository.loadIntelligenceReceipt === "function"
          ? await deps.repository.loadIntelligenceReceipt(request)
          : null;
        if (replay !== null) return replay;
        const generated = await deps.intelligence.generate(await deps.repository.loadIntelligenceInput(request));
        const persisted = await deps.repository.persistIntelligenceArtifact(request, generated);
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        return persisted;
      });
      await transition(deps.stateStore, request, "generate-intelligence", "intelligence_generating", "intelligence_ready", {
        leaseToken: vectorLease,
        outputHash: digest(intelligenceReceipt.artifactDigest),
        sideEffectKey: intelligenceReceipt.artifactKey,
      });
    } catch (error) {
      await recordFailure(deps, request, "generate-intelligence", "intelligence_generating", error, vectorLease);
      return;
    }

    // 15. chunk-and-embed-intelligence-{batch}
    let intelligenceManifest: EpisodeManifestDescriptor;
    try {
      intelligenceManifest = await step.do("chunk-intelligence", async () => {
        const manifest = await deps.repository.materializeManifest(request, "intelligence");
        await transition(deps.stateStore, request, "chunk-intelligence", "intelligence_ready", "intelligence_embedding", { leaseToken: vectorLease });
        return manifest;
      });
    } catch (error) {
      await recordFailure(deps, request, "chunk-and-embed-intelligence", "intelligence_ready", error, vectorLease);
      return;
    }
    try {
      await prepareEmbeddingBatches(step, deps, request, intelligenceManifest);
      await transition(deps.stateStore, request, "embed-intelligence-complete", "intelligence_embedding", "intelligence_indexing", { leaseToken: vectorLease });
    } catch (error) {
      await recordFailure(deps, request, "embed-intelligence", "intelligence_embedding", error, vectorLease);
      return;
    }

    // 16. upsert/wait intelligence vectors, then remove only obsolete intelligence IDs.
    let intelligenceUpserts: readonly CompactVectorMutationReceipt[];
    try {
      await claimLease(deps, request, vectorLease);
      intelligenceUpserts = await upsertManifest(step, deps, request, intelligenceManifest, INTELLIGENCE_UPSERT_OFFSET, vectorLease);
      expectedVectorBatchCount += intelligenceUpserts.length;
      await transition(deps.stateStore, request, "upsert-intelligence-accepted", "intelligence_indexing", "intelligence_visibility_pending", { leaseToken: vectorLease });
    } catch (error) {
      await recordFailure(deps, request, "upsert-intelligence", "intelligence_indexing", error, vectorLease);
      return;
    }
    try {
      for (const [ordinal, receipt] of intelligenceUpserts.entries()) {
        await waitForUpsertVisibility(step, deps, request, receipt, INTELLIGENCE_UPSERT_OFFSET + ordinal, vectorLease);
      }
      const intelligenceDeletes = await deleteStaleManifest(step, deps, request, intelligenceManifest, INTELLIGENCE_DELETE_OFFSET, vectorLease);
      expectedVectorBatchCount += intelligenceDeletes.length;
      for (const { batchOrdinal, receipt } of intelligenceDeletes) {
        await waitForDeleteVisibility(step, deps, request, receipt, batchOrdinal, vectorLease);
      }
    } catch (error) {
      await recordFailure(deps, request, "wait-intelligence-visibility", "intelligence_visibility_pending", error, vectorLease);
      return;
    }

    // 17. finalize-episode. Draft discovery stops at publish_ready.
    await step.do("finalize-episode", async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      await transition(deps.stateStore, request, "finalize-episode-ready", "intelligence_visibility_pending", "publish_ready", { leaseToken: vectorLease });
      if (request.desiredPublication === "published") {
        await deps.repository.finalizeEpisode(request, expectedVectorBatchCount);
      }
    });
  } finally {
    if (vectorLeaseOwned) {
      await deps.stateStore.releaseMutationLease({ requestId: request.requestId, generation: request.generation, leaseToken: vectorLease }).catch(() => undefined);
    }
  }
}

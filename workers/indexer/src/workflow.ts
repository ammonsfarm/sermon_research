import {
  acceptDelete,
  acceptUpsert,
  executeEmbeddingBatch,
  probeDeleteAbsence,
  probeUpsertVisibility,
  VECTORIZE_VISIBILITY_DELAYS_SECONDS,
  type EmbeddingBatch,
  type Float32EmbeddingRecord,
  type FrozenVectorizeMetadata,
  type IndexingChunk,
  type VectorizeMutationReceipt,
  type VectorizeWriteBinding,
} from "@aic/ai";
import {
  ProcessingStateError,
  isServiceError,
  type BackgroundOperationContext,
  type EmbeddingProvider,
  type ProcessingDesiredPublication,
  type JsonValue,
  type ProcessingOperation,
  type ProcessingRevisionHash,
  type ProcessingState,
  type ProcessingStateStore,
} from "@aic/contracts";

export interface ContentWorkflowEvent {
  readonly requestId: string;
  readonly revisionHash: ProcessingRevisionHash;
}

export interface ContentWorkflowRequest {
  readonly requestId: string;
  readonly entityId: string;
  readonly revisionId: string;
  readonly revisionHash: ProcessingRevisionHash;
  readonly generation: number;
  readonly operation: Exclude<ProcessingOperation, "episode_ingest">;
  readonly desiredPublication: ProcessingDesiredPublication;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly state: ProcessingState;
  readonly snapshot: Readonly<Record<string, JsonValue>>;
}

export interface ContentManifestDescriptor {
  readonly ids: readonly string[];
  readonly idDigest: string;
  readonly embeddingBatchCount: number;
}

export interface PreparedEmbeddingBatch {
  readonly batch: EmbeddingBatch;
  readonly chunks: readonly IndexingChunk[];
}

export interface VectorProofRecord {
  readonly id: string;
  readonly vectorDigest: string;
  readonly metadata: FrozenVectorizeMetadata;
}

interface CompactMutationReceipt {
  readonly mutationId: string;
  readonly state: "accepted" | "delete_accepted";
  readonly ids: readonly string[];
  readonly idDigest: string;
}

export interface ContentIndexRepository {
  loadRequest(event: ContentWorkflowEvent): Promise<ContentWorkflowRequest>;
  invalidateObsoleteHydration(request: ContentWorkflowRequest): Promise<void>;
  materializeManifest(request: ContentWorkflowRequest): Promise<ContentManifestDescriptor>;
  loadEmbeddingBatch(request: ContentWorkflowRequest, ordinal: number): Promise<PreparedEmbeddingBatch>;
  loadVectorProofRecords(request: ContentWorkflowRequest, ids: readonly string[]): Promise<readonly VectorProofRecord[]>;
  recordPreparedVectors(request: ContentWorkflowRequest, manifest: ContentManifestDescriptor, chunks: readonly IndexingChunk[], records: readonly Float32EmbeddingRecord[]): Promise<void>;
  loadAcceptedMutation(request: ContentWorkflowRequest, batchOrdinal: number, operation: "upsert" | "delete", ids: readonly string[]): Promise<CompactMutationReceipt | null>;
  markVectorsVisible(request: ContentWorkflowRequest, ids: readonly string[], mutationId: string): Promise<void>;
  listStaleVectorIds(request: ContentWorkflowRequest, targetIds: readonly string[]): Promise<readonly string[]>;
  markVectorsDeleted(request: ContentWorkflowRequest, ids: readonly string[], mutationId: string): Promise<void>;
  finalizeReplacement(request: ContentWorkflowRequest, expectedVectorBatchCount: number): Promise<void>;
}

export interface WorkflowStepPort {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: Readonly<Record<string, unknown>>, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
}

export interface ContentWorkflowDependencies {
  readonly repository: ContentIndexRepository;
  readonly stateStore: ProcessingStateStore;
  readonly embeddings: EmbeddingProvider;
  readonly vectorize: VectorizeWriteBinding;
  readonly now?: () => Date;
}

const PROVIDER_STEP_CONFIG = {
  retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const;
const VECTOR_BATCH_SIZE = 1_000;

function digest(value: string): ProcessingRevisionHash {
  return `sha256:${value}` as ProcessingRevisionHash;
}

function compact(receipt: VectorizeMutationReceipt): CompactMutationReceipt {
  return {
    mutationId: receipt.mutationId,
    state: receipt.state,
    ids: receipt.ids,
    idDigest: receipt.idDigest,
  };
}

function backgroundContext(request: ContentWorkflowRequest, attempt: number): BackgroundOperationContext {
  return {
    boundary: "background",
    job: {
      id: `p6-job:${request.requestId}` as never,
      kind: request.operation === "transcript_replace" ? "semantic_index_replace" : "article_index_replace",
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

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}

async function transition(
  store: ProcessingStateStore,
  request: ContentWorkflowRequest,
  stageName: string,
  from: ProcessingState,
  to: ProcessingState,
  leaseToken?: string,
): Promise<void> {
  await store.transition({
    requestId: request.requestId,
    workflow: "content",
    generation: request.generation,
    stageName,
    from,
    to,
    ...(leaseToken === undefined ? {} : { mutationLeaseToken: leaseToken }),
  });
}

interface FailureDisposition {
  readonly to: "failed" | "retry_required";
  readonly code: string;
  readonly retryClass: string;
  readonly message: string;
  readonly stageStatus?: "side_effect_unknown";
}

function failureDisposition(cause: unknown): FailureDisposition {
  if (cause instanceof ProcessingStateError) {
    if (cause.code === "visibility_pending") return { to: "retry_required", code: cause.code, retryClass: "visibility_pending", message: cause.message };
    if (cause.code === "invalid_input" || cause.code === "identity_conflict") return { to: "failed", code: cause.code, retryClass: cause.code, message: cause.message };
    throw cause;
  }
  if (isServiceError(cause)) {
    if (cause.code === "invalid_argument") return { to: "failed", code: cause.code, retryClass: "invalid_input", message: cause.message };
    if (cause.code === "rate_limited") return { to: "retry_required", code: cause.code, retryClass: "throttled", message: cause.message };
    if (cause.code === "unauthenticated" || cause.code === "forbidden") return { to: "retry_required", code: cause.code, retryClass: "authentication", message: cause.message };
    if (cause.code === "timeout") return { to: "retry_required", code: cause.code, retryClass: "provider_timeout_unknown", message: "Provider outcome is unknown after timeout.", stageStatus: "side_effect_unknown" };
    if (cause.code === "dependency_unavailable" && !cause.retryable) return { to: "retry_required", code: cause.code, retryClass: "configuration", message: cause.message };
    return { to: "retry_required", code: cause.code, retryClass: "transient_dependency", message: cause.message };
  }
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "transient_dependency";
  if (code === "provider_timeout_unknown") return { to: "retry_required", code, retryClass: code, message: "Provider outcome is unknown after timeout.", stageStatus: "side_effect_unknown" };
  if (code === "throttled" || code === "authentication" || code === "configuration") return { to: "retry_required", code, retryClass: code, message: `Content processing requires operator attention (${code}).` };
  return { to: "retry_required", code: "transient_dependency", retryClass: "transient_dependency", message: "Content processing dependency is temporarily unavailable." };
}

async function recordFailure(
  store: ProcessingStateStore,
  request: ContentWorkflowRequest,
  stageName: string,
  from: ProcessingState,
  cause: unknown,
  leaseToken?: string,
): Promise<void> {
  const disposition = failureDisposition(cause);
  await store.transition({
    requestId: request.requestId,
    workflow: "content",
    generation: request.generation,
    stageName,
    from,
    to: disposition.to,
    errorCode: disposition.code,
    errorClass: disposition.retryClass,
    errorMessage: disposition.message,
    retryClass: disposition.retryClass,
    ...(disposition.stageStatus === undefined ? {} : { stageStatus: disposition.stageStatus }),
    ...(leaseToken === undefined ? {} : { mutationLeaseToken: leaseToken }),
  });
}

// A cached claim step proves past ownership only. Renew the same token at each live boundary.
async function claimLease(deps: ContentWorkflowDependencies, request: ContentWorkflowRequest, leaseToken: string): Promise<void> {
  await deps.stateStore.claimMutationLease({
    requestId: request.requestId,
    generation: request.generation,
    leaseToken,
    expiresAt: new Date((deps.now?.() ?? new Date()).getTime() + 32 * 60_000).toISOString(),
  });
}

async function leasedTransition(
  step: WorkflowStepPort, deps: ContentWorkflowDependencies, request: ContentWorkflowRequest,
  stageName: string, from: ProcessingState, to: ProcessingState, leaseToken: string,
): Promise<void> {
  await step.do(stageName, async () => {
    await claimLease(deps, request, leaseToken);
    await transition(deps.stateStore, request, stageName, from, to, leaseToken);
  });
}

async function waitForUpsertVisibility(
  step: WorkflowStepPort,
  deps: ContentWorkflowDependencies,
  request: ContentWorkflowRequest,
  receipt: CompactMutationReceipt,
  ordinal: number,
  leaseToken: string,
): Promise<void> {
  for (const [attempt, delay] of VECTORIZE_VISIBILITY_DELAYS_SECONDS.entries()) {
    await step.sleep(`wait-upsert-visibility-${ordinal}-sleep-${attempt}`, `${delay} seconds`);
    const result = await step.do(`wait-upsert-visibility-${ordinal}-poll-${attempt}`, async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      await claimLease(deps, request, leaseToken);
      const records = await deps.repository.loadVectorProofRecords(request, receipt.ids);
      const proof = await probeUpsertVisibility(deps.vectorize, {
        ...receipt,
        records: records.map((record) => ({ ...record, values: new Float32Array(1536) })),
      });
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      return proof.state;
    });
    if (result === "visible") {
      await step.do(`record-upsert-visibility-${ordinal}`, async () => {
        await claimLease(deps, request, leaseToken);
        await deps.stateStore.recordVectorVisibility({
          requestId: request.requestId,
          generation: request.generation,
          batchOrdinal: ordinal,
          operation: "upsert",
          leaseToken,
        });
        await claimLease(deps, request, leaseToken);
        await deps.repository.markVectorsVisible(request, receipt.ids, receipt.mutationId);
      });
      return;
    }
  }
  throw new ProcessingStateError("visibility_pending", "Vector upsert visibility was not proven within the bounded polling budget.");
}

async function waitForDeleteVisibility(
  step: WorkflowStepPort,
  deps: ContentWorkflowDependencies,
  request: ContentWorkflowRequest,
  receipt: CompactMutationReceipt,
  ordinal: number,
  leaseToken: string,
): Promise<void> {
  for (const [attempt, delay] of VECTORIZE_VISIBILITY_DELAYS_SECONDS.entries()) {
    await step.sleep(`wait-delete-visibility-${ordinal}-sleep-${attempt}`, `${delay} seconds`);
    const result = await step.do(`wait-delete-visibility-${ordinal}-poll-${attempt}`, async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      await claimLease(deps, request, leaseToken);
      const proof = await probeDeleteAbsence(deps.vectorize, { ...receipt, records: [] });
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      return proof.state;
    });
    if (result === "deleted") {
      await step.do(`record-delete-visibility-${ordinal}`, async () => {
        await claimLease(deps, request, leaseToken);
        await deps.stateStore.recordVectorVisibility({
          requestId: request.requestId,
          generation: request.generation,
          batchOrdinal: ordinal,
          operation: "delete",
          leaseToken,
        });
        await claimLease(deps, request, leaseToken);
        await deps.repository.markVectorsDeleted(request, receipt.ids, receipt.mutationId);
      });
      return;
    }
  }
  throw new ProcessingStateError("visibility_pending", "Vector deletion was not proven within the bounded polling budget.");
}

async function runPublicLifecycle(
  step: WorkflowStepPort,
  deps: ContentWorkflowDependencies,
  request: ContentWorkflowRequest,
): Promise<void> {
  const from = request.operation === "public_unpublish" ? "public_unpublish_requested" : "public_archive_requested";
  try {
    await step.do("hide-public-content", async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      await transition(deps.stateStore, request, "hide-public-content", from, "public_hidden");
    });
  } catch (cause) {
    await recordFailure(deps.stateStore, request, "workflow-hide-public-content", from, cause);
    throw cause;
  }
  try {
    await step.do(`finalize-${request.operation.replaceAll("_", "-")}`, async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      await deps.stateStore.finalizePublication({
        requestId: request.requestId,
        generation: request.generation,
        to: request.operation === "public_unpublish" ? "unpublished" : "archived",
        expectedVectorBatchCount: 0,
      });
    });
  } catch (cause) {
    await recordFailure(deps.stateStore, request, "workflow-finalize-public-lifecycle", "public_hidden", cause);
    throw cause;
  }
}

/** Runs the frozen P6 content replacement/public-lifecycle state machine. */
export async function runContentIndexWorkflow(
  step: WorkflowStepPort,
  event: ContentWorkflowEvent,
  deps: ContentWorkflowDependencies,
): Promise<void> {
  const request = await step.do("load-and-validate-input", async () => deps.repository.loadRequest(event));
  if (request.operation === "corpus_erase") {
    throw new ProcessingStateError("forbidden", "Corpus erasure is disabled until a frozen authorization policy exists.");
  }
  if (request.operation === "public_unpublish" || request.operation === "public_archive") {
    await runPublicLifecycle(step, deps, request);
    return;
  }

  const stateRank = ["revision_recorded", "chunking", "embedding", "indexing", "index_visibility_pending", "stale_vector_deleting", "delete_visibility_pending", "indexed", "publish_ready"] as const;
  let failureState: ProcessingState = request.state;
  const advanceFailureState = (candidate: ProcessingState) => {
    const currentRank = stateRank.indexOf(failureState as (typeof stateRank)[number]);
    const candidateRank = stateRank.indexOf(candidate as (typeof stateRank)[number]);
    if (candidateRank > currentRank) failureState = candidate;
  };
  let manifest: ContentManifestDescriptor;
  try {
    await step.do("invalidate-obsolete-semantic-hydration", async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      await deps.repository.invalidateObsoleteHydration(request);
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
    });
    manifest = await step.do("materialize-complete-manifest", async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      const result = await deps.repository.materializeManifest(request);
      await transition(deps.stateStore, request, "materialize-complete-manifest", "revision_recorded", "chunking");
      return result;
    });
    advanceFailureState("chunking");
    for (let ordinal = 0; ordinal < manifest.embeddingBatchCount; ordinal += 1) {
      await step.do(`embed-${ordinal}`, async () => {
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        const prepared = await deps.repository.loadEmbeddingBatch(request, ordinal);
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        return { ids: prepared.batch.inputs.map((input) => input.id), estimatedTokens: prepared.batch.estimatedTokens };
      });
    }
    await step.do("embed-complete", () => transition(deps.stateStore, request, "embed-complete", "chunking", "embedding"));
    advanceFailureState("embedding");
  } catch (cause) {
    if (!(cause instanceof ProcessingStateError && (cause.code === "superseded" || cause.code === "cancelled"))) {
      await recordFailure(deps.stateStore, request, `workflow-${failureState}`, failureState, cause);
    }
    throw cause;
  }

  const leaseToken = `p6-lease:${request.requestId}:${request.generation}`;
  let leaseAcquired = false;
  let workflowError: unknown;
  let expectedVectorBatchCount = 0;
  try {
    await step.do("claim-vector-mutation", async () => {
      await claimLease(deps, request, leaseToken);
      leaseAcquired = true;
      await transition(deps.stateStore, request, "claim-vector-mutation", "embedding", "indexing", leaseToken);
      failureState = "indexing";
      return true;
    });
    // A replayed completed step returns without invoking its callback.
    leaseAcquired = true;
    failureState = "indexing";
    const upsertReceipts: CompactMutationReceipt[] = [];
    for (let ordinal = 0; ordinal < manifest.embeddingBatchCount; ordinal += 1) {
      const receipt = await step.do(`upsert-provider-${ordinal}`, PROVIDER_STEP_CONFIG, async () => {
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        await claimLease(deps, request, leaseToken);
        const prepared = await deps.repository.loadEmbeddingBatch(request, ordinal);
        const ids = prepared.batch.inputs.map((input) => input.id);
        const accepted = typeof deps.repository.loadAcceptedMutation === "function"
          ? await deps.repository.loadAcceptedMutation(request, ordinal, "upsert", ids)
          : null;
        if (accepted !== null) return accepted;
        const embedded = await executeEmbeddingBatch(backgroundContext(request, ordinal + 1), deps.embeddings, prepared.batch);
        const byId = new Map(prepared.chunks.map((chunk) => [chunk.id, chunk]));
        const records = embedded.records.map((record) => ({
          ...record,
          metadata: byId.get(record.id)!.metadata,
        }));
        await deps.repository.recordPreparedVectors(request, manifest, prepared.chunks, embedded.records);
        await claimLease(deps, request, leaseToken);
        return compact(await acceptUpsert(deps.vectorize, records));
      });
      upsertReceipts.push(await step.do(`upsert-acceptance-${ordinal}`, async () => {
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        await claimLease(deps, request, leaseToken);
        await deps.stateStore.recordVectorAcceptance({
          requestId: request.requestId,
          generation: request.generation,
          batchOrdinal: ordinal,
          operation: "upsert",
          expectedIdsDigest: digest(receipt.idDigest),
          expectedCount: receipt.ids.length,
          targetRevisionHash: request.revisionHash,
          providerMutationId: receipt.mutationId,
          leaseToken,
        });
        return receipt;
      }));
      expectedVectorBatchCount += 1;
    }
    await leasedTransition(step, deps, request, "upsert-accepted", "indexing", "index_visibility_pending", leaseToken);
    failureState = "index_visibility_pending";
    for (const [ordinal, receipt] of upsertReceipts.entries()) {
      await waitForUpsertVisibility(step, deps, request, receipt, ordinal, leaseToken);
    }
    await leasedTransition(step, deps, request, "upsert-visible", "index_visibility_pending", "stale_vector_deleting", leaseToken);
    failureState = "stale_vector_deleting";

    const staleIds = await step.do("select-stale-vectors", async () => {
      await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
      return deps.repository.listStaleVectorIds(request, manifest.ids);
    });
    const deleteReceipts: CompactMutationReceipt[] = [];
    for (const [ordinal, ids] of chunks(staleIds, VECTOR_BATCH_SIZE).entries()) {
      const receipt = await step.do(`delete-stale-provider-${ordinal}`, PROVIDER_STEP_CONFIG, async () => {
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        await claimLease(deps, request, leaseToken);
        const accepted = typeof deps.repository.loadAcceptedMutation === "function"
          ? await deps.repository.loadAcceptedMutation(request, ordinal, "delete", ids)
          : null;
        if (accepted !== null) return accepted;
        await claimLease(deps, request, leaseToken);
        return compact(await acceptDelete(deps.vectorize, ids));
      });
      deleteReceipts.push(await step.do(`delete-stale-acceptance-${ordinal}`, async () => {
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        await claimLease(deps, request, leaseToken);
        await deps.stateStore.recordVectorAcceptance({
          requestId: request.requestId,
          generation: request.generation,
          batchOrdinal: ordinal,
          operation: "delete",
          expectedIdsDigest: digest(receipt.idDigest),
          expectedCount: receipt.ids.length,
          targetRevisionHash: request.revisionHash,
          providerMutationId: receipt.mutationId,
          leaseToken,
        });
        return receipt;
      }));
      expectedVectorBatchCount += 1;
    }
    await leasedTransition(step, deps, request, "delete-stale-accepted", "stale_vector_deleting", "delete_visibility_pending", leaseToken);
    failureState = "delete_visibility_pending";
    for (const [ordinal, receipt] of deleteReceipts.entries()) {
      await waitForDeleteVisibility(step, deps, request, receipt, ordinal, leaseToken);
    }
    await leasedTransition(step, deps, request, "stale-vectors-absent", "delete_visibility_pending", "indexed", leaseToken);
    failureState = "indexed";
    await leasedTransition(step, deps, request, "replacement-indexed", "indexed", "publish_ready", leaseToken);
    failureState = "publish_ready";
    if (request.desiredPublication === "published") {
      await step.do("finalize-replacement", async () => {
        await deps.stateStore.assertCurrentHead(request.requestId, request.generation);
        await claimLease(deps, request, leaseToken);
        await deps.repository.finalizeReplacement(request, expectedVectorBatchCount);
      });
    }
  } catch (error) {
    workflowError = error;
    if (!(error instanceof ProcessingStateError && (error.code === "superseded" || error.code === "cancelled"))) {
      if (leaseAcquired) await claimLease(deps, request, leaseToken);
      await recordFailure(deps.stateStore, request, `workflow-${failureState}`, failureState, error, leaseAcquired ? leaseToken : undefined);
    }
    throw error;
  } finally {
    if (leaseAcquired) {
      try {
        await deps.stateStore.releaseMutationLease({ requestId: request.requestId, generation: request.generation, leaseToken });
      } catch (releaseError) {
        const alreadyReleased = releaseError instanceof ProcessingStateError && releaseError.code === "lease_conflict";
        if (workflowError === undefined && !alreadyReleased) throw releaseError;
      }
    }
  }
}

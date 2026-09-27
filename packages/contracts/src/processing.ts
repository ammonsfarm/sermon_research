import { ServiceError, type JsonValue } from "./errors.ts";
import type { IdempotencyKey } from "./ids.ts";

export const PROCESSING_INPUT_SNAPSHOT_MAX_BYTES = 262_144 as const;
export const PROCESSING_ERROR_MESSAGE_MAX_LENGTH = 2_000 as const;

export const PROCESSING_WORKFLOWS = ["episode", "content"] as const;
export type ProcessingWorkflow = (typeof PROCESSING_WORKFLOWS)[number];

export const PROCESSING_ENTITY_TYPES = ["episode", "article", "transcript"] as const;
export type ProcessingEntityType = (typeof PROCESSING_ENTITY_TYPES)[number];

export const PROCESSING_AGGREGATE_TYPES = ["episode", "article"] as const;
export type ProcessingAggregateType = (typeof PROCESSING_AGGREGATE_TYPES)[number];

export interface ProcessingAggregateKey {
  readonly type: ProcessingAggregateType;
  readonly id: string;
}

export const PROCESSING_OPERATIONS = [
  "episode_ingest",
  "article_replace",
  "transcript_replace",
  "public_unpublish",
  "public_archive",
  "corpus_erase",
] as const;
export type ProcessingOperation = (typeof PROCESSING_OPERATIONS)[number];

export const PROCESSING_TERMINAL_STATES = [
  "published",
  "unpublished",
  "archived",
  "corpus_erased",
  "failed",
  "retry_required",
  "superseded",
  "cancelled",
] as const;
export type ProcessingTerminalState = (typeof PROCESSING_TERMINAL_STATES)[number];

export const PROCESSING_STATES = [
  "discovered",
  "audio_storing",
  "audio_stored",
  "transcribing",
  "transcript_ready",
  "revision_recorded",
  "chunking",
  "embedding",
  "indexing",
  "index_visibility_pending",
  "stale_vector_deleting",
  "delete_visibility_pending",
  "indexed",
  "intelligence_generating",
  "intelligence_ready",
  "intelligence_embedding",
  "intelligence_indexing",
  "intelligence_visibility_pending",
  "publish_ready",
  "public_unpublish_requested",
  "public_archive_requested",
  "public_hidden",
  "corpus_erase_requested",
  "corpus_hidden",
  "vector_deleting",
  ...PROCESSING_TERMINAL_STATES,
] as const;
export type ProcessingState = (typeof PROCESSING_STATES)[number];

export type ProcessingRevisionHash = `sha256:${string}`;
export type ProcessingChunkContentHash = string;
export type ProcessingDesiredPublication = "draft" | "published" | "unpublished" | "archived";
export type ProcessingCorpusVisibility = "inherited" | "visible" | "hidden" | "erased";
export type ProcessingPublicVisibility = "hidden" | "visible";

export const PROCESSING_EXECUTION_STATES = [
  "starting",
  "running",
  "waiting",
  "complete",
  "errored",
  "terminated",
] as const;
export type ProcessingExecutionState = (typeof PROCESSING_EXECUTION_STATES)[number];

export const PROCESSING_STAGE_STATES = [
  "pending",
  "running",
  "side_effect_unknown",
  "accepted",
  "visible",
  "complete",
  "failed",
  "skipped",
  "superseded",
  "cancelled",
] as const;
export type ProcessingStageState = (typeof PROCESSING_STAGE_STATES)[number];

export const PROCESSING_VECTOR_BATCH_STATES = [
  "prepared",
  "accepted",
  "visible",
  "delete_accepted",
  "deleted",
  "failed",
  "superseded",
] as const;
export type ProcessingVectorBatchState = (typeof PROCESSING_VECTOR_BATCH_STATES)[number];

export type ProcessingStateErrorCode =
  | "cancelled"
  | "forbidden"
  | "identity_conflict"
  | "invalid_input"
  | "invalid_state_transition"
  | "lease_conflict"
  | "not_found"
  | "publication_conflict"
  | "stale_generation"
  | "superseded"
  | "visibility_pending";

export class ProcessingStateError extends Error {
  readonly code: ProcessingStateErrorCode;
  readonly safeDetails: Readonly<Record<string, JsonValue>> | undefined;

  constructor(
    code: ProcessingStateErrorCode,
    message: string,
    safeDetails?: Readonly<Record<string, JsonValue>>,
  ) {
    super(message);
    this.name = "ProcessingStateError";
    this.code = code;
    this.safeDetails = safeDetails;
  }
}

const REVISION_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CHUNK_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const EPISODE_ID_PATTERN = /^(?:\d+|sa_\d+|wp-sermon:\d+|cms_[A-Za-z0-9_-]+)$/u;
const ARTICLE_ID_PATTERN = /^(?:pastorwood:[1-9]\d*|cms:[A-Za-z0-9._-]+)$/u;

function invalid(message: string): never {
  throw new ServiceError({ code: "invalid_argument", message });
}

function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    invalid(`${name} must be a non-empty normalized string.`);
  }
  return value;
}

export function processingRevisionHash(value: string): ProcessingRevisionHash {
  if (!REVISION_HASH_PATTERN.test(value)) invalid("Processing revision hashes must use sha256: followed by 64 lowercase hexadecimal characters.");
  return value as ProcessingRevisionHash;
}

export function processingChunkContentHash(value: string): ProcessingChunkContentHash {
  if (!CHUNK_HASH_PATTERN.test(value)) invalid("Processing content_hash values must be exactly 64 unprefixed lowercase hexadecimal characters.");
  return value;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("Processing snapshots may contain only finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, JsonValue>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
  }
  invalid("Processing snapshots must contain JSON values only.");
}

export function canonicalProcessingSnapshot(snapshot: Readonly<Record<string, JsonValue>>): string {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) invalid("Processing snapshot must be a JSON object.");
  const canonical = canonicalJson(snapshot);
  if (new TextEncoder().encode(canonical).byteLength > PROCESSING_INPUT_SNAPSHOT_MAX_BYTES) {
    invalid(`Processing snapshot must be at most ${PROCESSING_INPUT_SNAPSHOT_MAX_BYTES} UTF-8 bytes.`);
  }
  return canonical;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createProcessingRevisionHash(
  snapshot: Readonly<Record<string, JsonValue>>,
): Promise<ProcessingRevisionHash> {
  return processingRevisionHash(`sha256:${await sha256(canonicalProcessingSnapshot(snapshot))}`);
}

export function canonicalProcessingAggregate(
  operation: ProcessingOperation,
  entityType: ProcessingEntityType,
  entityId: string,
): ProcessingAggregateKey {
  requireNonEmpty(entityId, "Processing entity ID");
  if (operation === "episode_ingest" && entityType === "episode" && EPISODE_ID_PATTERN.test(entityId)) {
    return { type: "episode", id: entityId };
  }
  if (operation === "transcript_replace" && entityType === "transcript" && EPISODE_ID_PATTERN.test(entityId)) {
    return { type: "episode", id: entityId };
  }
  if (
    (operation === "article_replace" || operation === "public_unpublish" || operation === "public_archive" || operation === "corpus_erase")
    && entityType === "article"
    && ARTICLE_ID_PATTERN.test(entityId)
  ) {
    return { type: "article", id: entityId };
  }
  invalid("Processing operation, entity type, and entity ID are contradictory.");
}

export async function createProcessingIdempotencyKey(input: {
  readonly operation: ProcessingOperation;
  readonly entityType: ProcessingEntityType;
  readonly entityId: string;
  readonly revisionHash: ProcessingRevisionHash;
}): Promise<IdempotencyKey> {
  const aggregate = canonicalProcessingAggregate(input.operation, input.entityType, input.entityId);
  const revisionHash = processingRevisionHash(input.revisionHash);
  const prefix = input.operation === "episode_ingest"
    ? "p6:episode-ingest:v1:"
    : input.operation === "transcript_replace"
      ? "p6:transcript-index:v1:"
      : "p6:article-index:v1:";
  const operation = input.operation === "transcript_replace" ? "transcript_replace" : input.operation;
  return `${prefix}${await sha256(`${operation}\0${aggregate.type}\0${aggregate.id}\0${revisionHash}`)}` as IdempotencyKey;
}

export function createProcessingWorkflowInstanceId(
  workflow: ProcessingWorkflow,
  idempotencyKey: IdempotencyKey,
  resumeSequence: number,
): string {
  if (!Number.isSafeInteger(resumeSequence) || resumeSequence < 0) invalid("Processing resume sequence must be a non-negative safe integer.");
  const match = /:([0-9a-f]{64})$/u.exec(idempotencyKey);
  if (!match) invalid("Processing idempotency key must end with a lowercase SHA-256 digest.");
  const instanceId = `${workflow === "episode" ? "p6e" : "p6a"}-${match[1]}-${resumeSequence.toString(36)}`;
  if (instanceId.length >= 100) invalid("Processing Workflow instance ID must be shorter than 100 characters.");
  return instanceId;
}

const EPISODE_TRANSITIONS: Readonly<Record<string, readonly ProcessingState[]>> = {
  discovered: ["audio_storing", "publish_ready"],
  audio_storing: ["audio_stored"],
  audio_stored: ["transcribing"],
  transcribing: ["transcript_ready"],
  transcript_ready: ["chunking"],
  chunking: ["embedding"],
  embedding: ["indexing"],
  indexing: ["index_visibility_pending"],
  index_visibility_pending: ["indexed"],
  indexed: ["intelligence_generating"],
  intelligence_generating: ["intelligence_ready"],
  intelligence_ready: ["intelligence_embedding"],
  intelligence_embedding: ["intelligence_indexing"],
  intelligence_indexing: ["intelligence_visibility_pending"],
  intelligence_visibility_pending: ["publish_ready"],
  publish_ready: ["published"],
};

const REPLACEMENT_TRANSITIONS: Readonly<Record<string, readonly ProcessingState[]>> = {
  revision_recorded: ["chunking"],
  chunking: ["embedding"],
  embedding: ["indexing"],
  indexing: ["index_visibility_pending"],
  index_visibility_pending: ["stale_vector_deleting"],
  stale_vector_deleting: ["delete_visibility_pending"],
  delete_visibility_pending: ["indexed"],
  indexed: ["publish_ready"],
  publish_ready: ["published"],
};

const PUBLIC_UNPUBLISH_TRANSITIONS: Readonly<Record<string, readonly ProcessingState[]>> = {
  public_unpublish_requested: ["public_hidden"],
  public_hidden: ["unpublished"],
};

const PUBLIC_ARCHIVE_TRANSITIONS: Readonly<Record<string, readonly ProcessingState[]>> = {
  public_archive_requested: ["public_hidden"],
  public_hidden: ["archived"],
};

const CORPUS_ERASE_TRANSITIONS: Readonly<Record<string, readonly ProcessingState[]>> = {
  corpus_erase_requested: ["corpus_hidden"],
  corpus_hidden: ["vector_deleting"],
  vector_deleting: ["delete_visibility_pending"],
  delete_visibility_pending: ["corpus_erased"],
};

const CONTROL_TERMINALS = new Set<ProcessingState>(["retry_required", "failed", "superseded", "cancelled"]);
const ALL_TERMINALS = new Set<ProcessingState>(PROCESSING_TERMINAL_STATES);

export function assertProcessingTransition(
  workflow: ProcessingWorkflow,
  operation: ProcessingOperation,
  from: ProcessingState,
  to: ProcessingState,
): void {
  let transitions: Readonly<Record<string, readonly ProcessingState[]>>;
  if (workflow === "episode" && operation === "episode_ingest") transitions = EPISODE_TRANSITIONS;
  else if (workflow === "content" && (operation === "article_replace" || operation === "transcript_replace")) transitions = REPLACEMENT_TRANSITIONS;
  else if (workflow === "content" && operation === "public_unpublish") transitions = PUBLIC_UNPUBLISH_TRANSITIONS;
  else if (workflow === "content" && operation === "public_archive") transitions = PUBLIC_ARCHIVE_TRANSITIONS;
  else if (workflow === "content" && operation === "corpus_erase") transitions = CORPUS_ERASE_TRANSITIONS;
  else throw new ProcessingStateError("invalid_state_transition", `Processing workflow ${workflow} cannot run ${operation}.`);
  const legal = transitions[from]?.includes(to) === true || (!ALL_TERMINALS.has(from) && CONTROL_TERMINALS.has(to));
  if (!legal) throw new ProcessingStateError("invalid_state_transition", `Processing transition ${workflow}:${operation}:${from}->${to} is not allowed.`);
}

export interface ProcessingCorpusHead {
  readonly visibility: ProcessingCorpusVisibility;
  readonly revisionHash: ProcessingRevisionHash | null;
}

export function isAuthenticatedCorpusVisible(
  head: ProcessingCorpusHead | null,
  processingRevision: ProcessingRevisionHash | null,
): boolean {
  if (head?.visibility === "hidden" || head?.visibility === "erased") return false;
  if (processingRevision === null) return head === null || head.visibility === "inherited";
  return head?.visibility === "visible" && head.revisionHash === processingRevision;
}

export interface ProcessingRequestInput {
  readonly requestId: string;
  readonly workflow: ProcessingWorkflow;
  readonly entityType: ProcessingEntityType;
  readonly entityId: string;
  readonly documentId?: string;
  readonly revisionId: string;
  readonly revisionHash: ProcessingRevisionHash;
  readonly operation: ProcessingOperation;
  readonly idempotencyKey: IdempotencyKey;
  readonly snapshot: Readonly<Record<string, JsonValue>>;
  readonly desiredPublication: ProcessingDesiredPublication;
  readonly requestedBy?: string;
  readonly correlationId?: string;
  readonly corpusEraseApproved?: boolean;
  /** Atomically allocate only from this current completed draft; duplicate requests still converge. */
  readonly expectedPredecessor?: {
    readonly requestId: string;
    readonly revisionHash: ProcessingRevisionHash;
    readonly generation: number;
  };
}

export interface ProcessingRequestReceipt {
  readonly requestId: string;
  readonly workflow: ProcessingWorkflow;
  readonly aggregate: ProcessingAggregateKey;
  readonly revisionHash: ProcessingRevisionHash;
  readonly generation: number;
  readonly state: ProcessingState;
  readonly duplicate: boolean;
}

export interface ProcessingExecutionReceipt {
  readonly executionId: string;
  readonly requestId: string;
  readonly workflowInstanceId: string;
  readonly resumeSequence: number;
  readonly status: ProcessingExecutionState;
}

export interface ProcessingTransitionCommand {
  readonly requestId: string;
  readonly workflow: ProcessingWorkflow;
  readonly generation: number;
  readonly from: ProcessingState;
  readonly to: ProcessingState;
  readonly stageName: string;
  readonly batchOrdinal?: number;
  readonly inputHash?: ProcessingRevisionHash;
  readonly outputHash?: ProcessingRevisionHash;
  readonly sideEffectKey?: string;
  readonly mutationLeaseToken?: string;
  readonly errorCode?: string;
  readonly errorClass?: string;
  readonly errorMessage?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly providerMutationId?: string;
  readonly retryClass?: string;
  readonly stageStatus?: ProcessingStageState;
}

export interface ProcessingStageReceipt {
  readonly requestId: string;
  readonly stageName: string;
  readonly batchOrdinal: number;
  readonly state: ProcessingState;
  readonly status: ProcessingStageState;
  readonly replayed: boolean;
}

export interface ProcessingMutationLeaseCommand {
  readonly requestId: string;
  readonly generation: number;
  readonly leaseToken: string;
  readonly expiresAt: string;
}

export interface VectorAcceptanceCommand {
  readonly requestId: string;
  readonly generation: number;
  readonly leaseToken: string;
  readonly batchOrdinal: number;
  readonly operation: "upsert" | "delete";
  readonly expectedIdsDigest: ProcessingRevisionHash;
  readonly expectedCount: number;
  readonly targetRevisionHash: ProcessingRevisionHash;
  readonly providerMutationId: string;
}

export interface VectorVisibilityCommand {
  readonly requestId: string;
  readonly generation: number;
  readonly leaseToken: string;
  readonly batchOrdinal: number;
  readonly operation: "upsert" | "delete";
  readonly processedUpToMutation?: string;
}

export interface PublicationFinalizeCommand {
  readonly requestId: string;
  readonly generation: number;
  readonly to: "published" | "unpublished" | "archived" | "corpus_erased";
  readonly expectedVectorBatchCount: number;
}

export interface ProcessingStateStore {
  createOrGetRequest(input: ProcessingRequestInput): Promise<ProcessingRequestReceipt>;
  createOrGetInitialExecution(requestId: string): Promise<ProcessingExecutionReceipt>;
  resume(requestId: string, actor: string, reason: string): Promise<ProcessingExecutionReceipt>;
  assertCurrentHead(requestId: string, generation: number): Promise<void>;
  claimMutationLease(command: ProcessingMutationLeaseCommand): Promise<void>;
  releaseMutationLease(command: Omit<ProcessingMutationLeaseCommand, "expiresAt">): Promise<void>;
  transition(command: ProcessingTransitionCommand): Promise<ProcessingStageReceipt>;
  recordVectorAcceptance(command: VectorAcceptanceCommand): Promise<void>;
  recordVectorVisibility(command: VectorVisibilityCommand): Promise<void>;
  finalizePublication(command: PublicationFinalizeCommand): Promise<void>;
}

export const PROCESSING_OPERATOR_ACTIONS = ["cancel", "resume", "reconcile"] as const;
export type ProcessingOperatorAction = (typeof PROCESSING_OPERATOR_ACTIONS)[number];

export interface ProcessingOperatorActionInput {
  readonly requestId: string;
  readonly actor: string;
  readonly reason: string;
  /** Stable for one submitted operator action so transport retries are idempotent. */
  readonly actionId: string;
}

export interface ProcessingOperatorRequestEvidence {
  readonly requestId: string;
  readonly workflow: ProcessingWorkflow;
  readonly entityType: ProcessingEntityType;
  readonly entityId: string;
  readonly aggregate: ProcessingAggregateKey;
  readonly documentId: string | null;
  readonly revisionId: string;
  readonly revisionHash: ProcessingRevisionHash;
  readonly operation: ProcessingOperation;
  readonly idempotencyKey: string;
  readonly generation: number;
  readonly desiredPublication: ProcessingDesiredPublication;
  readonly state: ProcessingState;
  readonly resumeSequence: number;
  readonly currentExecutionId: string | null;
  readonly supersededByRequestId: string | null;
  readonly cancelRequestedAt: string | null;
  readonly lastError: {
    readonly code: string | null;
    readonly class: string | null;
    readonly message: string;
  };
  readonly requestedBy: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface ProcessingOperatorHeadEvidence {
  readonly generation: number;
  readonly headRequestId: string;
  readonly headRevisionHash: ProcessingRevisionHash;
  readonly publishedRequestId: string | null;
  readonly publishedRevisionHash: ProcessingRevisionHash | null;
  readonly authenticatedCorpusRequestId: string | null;
  readonly authenticatedCorpusRevisionHash: ProcessingRevisionHash | null;
  readonly publicVisibility: ProcessingPublicVisibility;
  readonly authenticatedCorpusVisibility: ProcessingCorpusVisibility;
  readonly desiredPublication: ProcessingDesiredPublication;
  readonly mutationOwnerRequestId: string | null;
  readonly mutationLeaseExpiresAt: string | null;
  readonly updatedAt: string;
}

export interface ProcessingOperatorExecutionEvidence extends ProcessingExecutionReceipt {
  readonly initiatedBy: string;
  readonly resumeReason: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

export interface ProcessingOperatorStageEvidence {
  readonly stageName: string;
  readonly batchOrdinal: number;
  readonly status: ProcessingStageState;
  readonly fromState: ProcessingState;
  readonly toState: ProcessingState;
  readonly generation: number;
  readonly attemptCount: number;
  readonly inputHash: ProcessingRevisionHash | null;
  readonly outputHash: ProcessingRevisionHash | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly providerMutationId: string | null;
  readonly retryClass: string | null;
  readonly errorCode: string | null;
  readonly errorClass: string | null;
  readonly errorMessage: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

export interface ProcessingOperatorVectorBatchEvidence {
  readonly batchOrdinal: number;
  readonly operation: "upsert" | "delete";
  readonly generation: number;
  readonly expectedIdsDigest: ProcessingRevisionHash;
  readonly expectedCount: number;
  readonly targetRevisionHash: ProcessingRevisionHash;
  readonly providerMutationId: string;
  readonly visibilityState: ProcessingVectorBatchState;
  readonly pollCount: number;
  readonly processedUpToMutation: string | null;
  readonly acceptedAt: string | null;
  readonly visibleAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProcessingOperatorAuditEvidence {
  readonly auditId: string;
  readonly action: string;
  readonly actor: string;
  readonly reason: string;
  readonly actionId: string | null;
  readonly outcome: string | null;
  readonly createdAt: string;
}

export interface ProcessingOperatorEvidence {
  readonly request: ProcessingOperatorRequestEvidence;
  readonly head: ProcessingOperatorHeadEvidence;
  readonly executions: readonly ProcessingOperatorExecutionEvidence[];
  readonly stages: readonly ProcessingOperatorStageEvidence[];
  readonly vectorBatches: readonly ProcessingOperatorVectorBatchEvidence[];
  readonly audit: readonly ProcessingOperatorAuditEvidence[];
  readonly truncated: {
    readonly executions: boolean;
    readonly stages: boolean;
    readonly vectorBatches: boolean;
    readonly audit: boolean;
  };
}

export type ProcessingOperatorOutcome =
  | "cancelled"
  | "resume_started"
  | "starting_reconciled"
  | "lease_released"
  | "visibility_pending"
  | "resume_required"
  | "quarantined"
  | "no_action";

export interface ProcessingOperatorActionReceipt {
  readonly action: ProcessingOperatorAction;
  readonly requestId: string;
  readonly workflow: ProcessingWorkflow;
  readonly state: ProcessingState;
  readonly outcome: ProcessingOperatorOutcome;
  readonly duplicate: boolean;
  readonly execution?: ProcessingExecutionReceipt;
  readonly releasedExpiredLease?: boolean;
  readonly resolvedUnknownStages?: number;
  readonly unresolvedUnknownStages?: number;
  readonly termination?: "terminated" | "not_running" | "best_effort_failed";
}

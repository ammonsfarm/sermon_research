import {
  ProcessingStateError,
  type BackgroundJobCommand,
  type BackgroundJobDispatcher,
  type BackgroundJobReceipt,
  type OperationContext,
  type ProcessingExecutionReceipt,
  type ProcessingStateStore,
} from "@aic/contracts";
import type { D1Database } from "@aic/db";

export const WORKFLOW_INSTANCE_STATUSES = [
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
  "waitingForPause",
  "unknown",
] as const;

export type WorkflowInstanceStatus = (typeof WORKFLOW_INSTANCE_STATUSES)[number];

export interface WorkflowInstancePort {
  readonly id: string;
  status(): Promise<{ readonly status: WorkflowInstanceStatus }>;
}

export interface EpisodeWorkflowParams {
  readonly requestId: string;
  readonly revisionHash: `sha256:${string}`;
}

export interface EpisodeWorkflowBindingPort {
  get(id: string): Promise<WorkflowInstancePort>;
  createBatch(
    batch: Array<{ readonly id: string; readonly params: EpisodeWorkflowParams }>,
  ): Promise<readonly WorkflowInstancePort[]>;
}

export type InitialExecutionStateStore = Pick<
  ProcessingStateStore,
  "createOrGetInitialExecution" | "assertCurrentHead"
>;

export type WorkflowDispatchErrorCode =
  | "workflow_identity_conflict"
  | "workflow_instance_vanished"
  | "workflow_start_outcome_unknown"
  | "workflow_start_unavailable"
  | "workflow_status_invalid";

export class WorkflowDispatchError extends Error {
  readonly code: WorkflowDispatchErrorCode;

  constructor(code: WorkflowDispatchErrorCode, message: string) {
    super(message);
    this.name = "WorkflowDispatchError";
    this.code = code;
  }
}

export interface InitialExecutionReconciliationInput {
  readonly db: D1Database;
  readonly stateStore: InitialExecutionStateStore;
  readonly workflow: EpisodeWorkflowBindingPort;
  readonly requestId: string;
  readonly isMissingInstanceError: (error: unknown) => boolean;
  readonly now?: () => string;
}

export interface InitialExecutionReconciliationResult extends ProcessingExecutionReceipt {
  readonly workflowStatus: Exclude<WorkflowInstanceStatus, "unknown">;
  readonly created: boolean;
}

interface ExecutionMetadata extends Record<string, unknown> {
  readonly execution_id: string;
  readonly request_id: string;
  readonly workflow_instance_id: string;
  readonly resume_sequence: number;
  readonly status: ProcessingExecutionReceipt["status"];
  readonly workflow_name: "episode" | "content";
  readonly generation: number;
  readonly current_execution_id: string | null;
  readonly revision_hash: `sha256:${string}`;
}

const EXECUTION_STATUS = new Set<ProcessingExecutionReceipt["status"]>([
  "starting",
  "running",
  "waiting",
  "complete",
  "errored",
  "terminated",
]);

const WORKFLOW_STATUS = new Set<WorkflowInstanceStatus>(WORKFLOW_INSTANCE_STATUSES);

function externalFailure(code: WorkflowDispatchErrorCode, message: string): WorkflowDispatchError {
  return new WorkflowDispatchError(code, message);
}

async function loadExecutionMetadata(
  db: D1Database,
  execution: ProcessingExecutionReceipt,
): Promise<ExecutionMetadata> {
  const row = await db.prepare(`
    SELECT e.execution_id, e.request_id, e.workflow_instance_id,
           e.resume_sequence, e.status, r.workflow_name, r.generation,
           r.revision_hash,
           r.current_execution_id
      FROM processing_executions e
      JOIN processing_requests r ON r.request_id = e.request_id
     WHERE e.execution_id = ? AND e.request_id = ?
  `).bind(execution.executionId, execution.requestId).first<ExecutionMetadata>();
  if (
    !row
    || row.execution_id !== execution.executionId
    || row.request_id !== execution.requestId
    || row.workflow_instance_id !== execution.workflowInstanceId
    || row.resume_sequence !== 0
    || row.resume_sequence !== execution.resumeSequence
    || row.workflow_name !== "episode"
    || row.current_execution_id !== execution.executionId
    || !Number.isSafeInteger(row.generation)
    || row.generation < 1
    || !EXECUTION_STATUS.has(row.status)
  ) {
    throw externalFailure("workflow_identity_conflict", "The initial Workflow execution metadata is inconsistent.");
  }
  return row;
}

function validateInstance(
  instance: WorkflowInstancePort,
  expectedId: string,
): void {
  if (!instance || instance.id !== expectedId || typeof instance.status !== "function") {
    throw externalFailure("workflow_identity_conflict", "The retained Workflow instance identity is inconsistent.");
  }
}

async function readWorkflowStatus(
  instance: WorkflowInstancePort,
): Promise<Exclude<WorkflowInstanceStatus, "unknown">> {
  let result: { readonly status: WorkflowInstanceStatus };
  try {
    result = await instance.status();
  } catch {
    throw externalFailure("workflow_start_outcome_unknown", "The retained Workflow instance status is temporarily unavailable.");
  }
  if (!result || !WORKFLOW_STATUS.has(result.status) || result.status === "unknown") {
    throw externalFailure("workflow_status_invalid", "The retained Workflow instance returned an unusable status.");
  }
  return result.status;
}

function executionStatus(workflowStatus: Exclude<WorkflowInstanceStatus, "unknown">): ProcessingExecutionReceipt["status"] {
  if (workflowStatus === "queued" || workflowStatus === "running") return "running";
  if (workflowStatus === "paused" || workflowStatus === "waiting" || workflowStatus === "waitingForPause") return "waiting";
  return workflowStatus;
}

async function persistExecutionStatus(
  input: InitialExecutionReconciliationInput,
  metadata: ExecutionMetadata,
  status: ProcessingExecutionReceipt["status"],
): Promise<void> {
  if (metadata.status === status) return;
  const at = input.now?.() ?? new Date().toISOString();
  const terminal = status === "complete" || status === "errored" || status === "terminated";
  const result = await input.db.prepare(`
    UPDATE processing_executions
       SET status = ?,
           started_at = CASE WHEN ? IN ('running', 'waiting') THEN COALESCE(started_at, ?) ELSE started_at END,
           completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, ?) ELSE completed_at END,
           updated_at = ?
     WHERE execution_id = ? AND request_id = ? AND workflow_instance_id = ?
       AND status = ?
       AND EXISTS (
         SELECT 1
           FROM processing_requests r
           JOIN processing_heads h
             ON h.aggregate_type = r.aggregate_type
            AND h.aggregate_id = r.aggregate_id
            AND h.head_request_id = r.request_id
            AND h.generation = r.generation
          WHERE r.request_id = processing_executions.request_id
            AND r.generation = ?
            AND r.superseded_by_request_id IS NULL
            AND r.cancel_requested_at IS NULL
            AND r.state NOT IN ('superseded', 'cancelled')
       )
  `).bind(
    status,
    status,
    at,
    terminal ? 1 : 0,
    at,
    at,
    metadata.execution_id,
    metadata.request_id,
    metadata.workflow_instance_id,
    metadata.status,
    metadata.generation,
  ).run();
  const changes = result.meta?.changes;
  if (result.success !== true || changes !== 1) {
    await input.stateStore.assertCurrentHead(metadata.request_id, metadata.generation);
    throw externalFailure("workflow_identity_conflict", "The Workflow execution status changed during reconciliation.");
  }
}

async function getInstance(
  workflow: EpisodeWorkflowBindingPort,
  id: string,
): Promise<WorkflowInstancePort> {
  const instance = await workflow.get(id);
  validateInstance(instance, id);
  return instance;
}

/**
 * Reconciles the non-atomic D1 execution allocation and Workflow instance start.
 * Only a D1 `starting` row may create a missing retained instance.
 */
export async function reconcileInitialExecutionStart(
  input: InitialExecutionReconciliationInput,
): Promise<InitialExecutionReconciliationResult> {
  const execution = await input.stateStore.createOrGetInitialExecution(input.requestId);
  const metadata = await loadExecutionMetadata(input.db, execution);
  await input.stateStore.assertCurrentHead(input.requestId, metadata.generation);

  let instance: WorkflowInstancePort;
  let created = false;
  try {
    instance = await getInstance(input.workflow, metadata.workflow_instance_id);
  } catch (error) {
    if (!input.isMissingInstanceError(error)) {
      if (error instanceof WorkflowDispatchError) throw error;
      throw externalFailure("workflow_start_outcome_unknown", "The Workflow instance lookup outcome is unknown.");
    }
    if (metadata.status !== "starting") {
      throw externalFailure("workflow_instance_vanished", "A previously started Workflow instance is no longer retained.");
    }

    await input.stateStore.assertCurrentHead(input.requestId, metadata.generation);
    try {
      const createdInstances = await input.workflow.createBatch([{
        id: metadata.workflow_instance_id,
        params: {
          requestId: metadata.request_id,
          revisionHash: metadata.revision_hash,
        },
      }]);
      const returned = createdInstances.find((candidate) => candidate.id === metadata.workflow_instance_id);
      if (returned) {
        validateInstance(returned, metadata.workflow_instance_id);
        created = true;
      }
    } catch {
      // Creation can have succeeded even when its response was lost. The
      // deterministic instance ID is reconciled through `get` below.
    }

    try {
      instance = await getInstance(input.workflow, metadata.workflow_instance_id);
    } catch (error) {
      if (input.isMissingInstanceError(error)) {
        throw externalFailure("workflow_start_unavailable", "The Workflow instance was not created.");
      }
      if (error instanceof WorkflowDispatchError) throw error;
      throw externalFailure("workflow_start_outcome_unknown", "The Workflow create outcome is unknown.");
    }
  }

  const workflowStatus = await readWorkflowStatus(instance);
  const status = executionStatus(workflowStatus);
  await persistExecutionStatus(input, metadata, status);
  return {
    ...execution,
    status,
    workflowStatus,
    created,
  };
}

interface EpisodeRequestRow extends Record<string, unknown> {
  readonly request_id: string;
  readonly revision_hash: `sha256:${string}`;
  readonly idempotency_key: string;
  readonly generation: number;
}

interface ExistingExecutionRow extends Record<string, unknown> {
  readonly execution_id: string;
  readonly status: ProcessingExecutionReceipt["status"];
}

function acceptedAt(now: () => Date): string {
  return now().toISOString();
}

function jobId(value: string): BackgroundJobReceipt["jobId"] {
  return value as BackgroundJobReceipt["jobId"];
}

/** The sole `episode_ingest` command boundary for Scheduled Trigger and service-binding callers. */
export class EpisodeWorkflowDispatcher implements BackgroundJobDispatcher {
  readonly #db: D1Database;
  readonly #stateStore: ProcessingStateStore;
  readonly #workflow: EpisodeWorkflowBindingPort;
  readonly #isMissingInstanceError: (error: unknown) => boolean;
  readonly #now: () => Date;

  constructor(options: {
    readonly db: D1Database;
    readonly stateStore: ProcessingStateStore;
    readonly workflow: EpisodeWorkflowBindingPort;
    readonly isMissingInstanceError?: (error: unknown) => boolean;
    readonly now?: () => Date;
  }) {
    this.#db = options.db;
    this.#stateStore = options.stateStore;
    this.#workflow = options.workflow;
    this.#isMissingInstanceError = options.isMissingInstanceError ?? (() => true);
    this.#now = options.now ?? (() => new Date());
  }

  async #request(requestId: string): Promise<EpisodeRequestRow> {
    const request = await this.#db.prepare(`SELECT request_id,revision_hash,idempotency_key,generation
      FROM processing_requests WHERE request_id=? AND workflow_name='episode'
       AND operation='episode_ingest' AND contract_version='p6-v1'`).bind(requestId).first<EpisodeRequestRow>();
    if (!request) throw new ProcessingStateError("not_found", "Episode processing request was not found.");
    return request;
  }

  async dispatch(context: OperationContext, command: BackgroundJobCommand): Promise<BackgroundJobReceipt> {
    if (command.kind !== "episode_ingest" || command.payload.target !== "episode") {
      throw new ProcessingStateError("invalid_input", "The episode Workflow dispatcher accepts only episode ingestion commands.");
    }
    const request = await this.#request(command.payload.requestId);
    if (request.revision_hash !== command.payload.revisionHash || request.idempotency_key !== command.idempotencyKey) {
      throw new ProcessingStateError("identity_conflict", "Episode dispatch identity does not match its immutable request.");
    }
    await this.#stateStore.assertCurrentHead(request.request_id, request.generation);
    const before = await this.#db.prepare(`SELECT execution_id,status FROM processing_executions
      WHERE request_id=? AND resume_sequence=0`).bind(request.request_id).first<ExistingExecutionRow>();
    const result = await reconcileInitialExecutionStart({
      db: this.#db,
      stateStore: this.#stateStore,
      workflow: this.#workflow,
      requestId: request.request_id,
      isMissingInstanceError: this.#isMissingInstanceError,
      now: () => acceptedAt(this.#now),
    });
    return {
      jobId: jobId(result.executionId),
      acceptedAt: acceptedAt(this.#now),
      ...(before === null ? {} : { duplicateOf: jobId(before.execution_id) }),
    };
  }

  async dispatchRequestId(requestId: string): Promise<BackgroundJobReceipt> {
    const request = await this.#request(requestId);
    const context: OperationContext = {
      boundary: "background",
      correlation: { correlationId: `scheduled:${requestId}` as never, requestId: requestId as never },
      job: {
        id: `scheduled:${requestId}` as never,
        kind: "episode_ingest",
        attempt: 1,
        idempotencyKey: request.idempotency_key as never,
      },
      signal: new AbortController().signal,
    };
    return this.dispatch(context, {
      kind: "episode_ingest",
      idempotencyKey: request.idempotency_key as never,
      correlation: context.correlation,
      payload: { target: "episode", requestId: request.request_id, revisionHash: request.revision_hash },
    });
  }
}

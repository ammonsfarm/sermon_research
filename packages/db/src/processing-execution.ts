import {
  ProcessingStateError,
  type ProcessingExecutionReceipt,
  type ProcessingStateStore,
  type ProcessingWorkflow,
} from "@aic/contracts";
import type { D1Database } from "./index.ts";

export const PROCESSING_WORKFLOW_INSTANCE_STATUSES = [
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
export type ProcessingWorkflowInstanceStatus = (typeof PROCESSING_WORKFLOW_INSTANCE_STATUSES)[number];

export interface ProcessingWorkflowInstancePort {
  readonly id: string;
  status(): Promise<{ readonly status: ProcessingWorkflowInstanceStatus }>;
  terminate?(options?: { readonly rollback?: boolean }): Promise<void>;
}

export interface ProcessingWorkflowBindingPort {
  get(id: string): Promise<ProcessingWorkflowInstancePort>;
  createBatch(batch: Array<{
    readonly id: string;
    readonly params: { readonly requestId: string; readonly revisionHash: `sha256:${string}` };
  }>): Promise<readonly ProcessingWorkflowInstancePort[]>;
}

interface Metadata extends Record<string, unknown> {
  readonly execution_id: string;
  readonly request_id: string;
  readonly workflow_instance_id: string;
  readonly resume_sequence: number;
  readonly status: ProcessingExecutionReceipt["status"];
  readonly workflow_name: ProcessingWorkflow;
  readonly generation: number;
  readonly current_execution_id: string | null;
  readonly revision_hash: `sha256:${string}`;
}

export interface ProcessingExecutionStartResult extends ProcessingExecutionReceipt {
  readonly workflowStatus: Exclude<ProcessingWorkflowInstanceStatus, "unknown">;
  readonly created: boolean;
}

function failure(message: string): ProcessingStateError {
  return new ProcessingStateError("publication_conflict", message);
}

function validateInstance(instance: ProcessingWorkflowInstancePort, expectedId: string): void {
  if (!instance || instance.id !== expectedId || typeof instance.status !== "function") {
    throw failure("The retained Workflow instance identity is inconsistent.");
  }
}

function executionStatus(status: Exclude<ProcessingWorkflowInstanceStatus, "unknown">): ProcessingExecutionReceipt["status"] {
  if (status === "queued" || status === "running") return "running";
  if (status === "paused" || status === "waiting" || status === "waitingForPause") return "waiting";
  return status;
}

/** Reconciles one already-allocated initial or resume execution by deterministic Workflow ID. */
export async function reconcileProcessingExecutionStart(input: {
  readonly db: D1Database;
  readonly stateStore: Pick<ProcessingStateStore, "assertCurrentHead">;
  readonly workflow: ProcessingWorkflowBindingPort;
  readonly execution: ProcessingExecutionReceipt;
  readonly expectedWorkflow: ProcessingWorkflow;
  readonly isMissingInstanceError: (error: unknown) => boolean;
  readonly now?: () => string;
}): Promise<ProcessingExecutionStartResult> {
  const metadata = await input.db.prepare(`
    SELECT e.execution_id, e.request_id, e.workflow_instance_id,
           e.resume_sequence, e.status, r.workflow_name, r.generation,
           r.current_execution_id, r.revision_hash
      FROM processing_executions e
      JOIN processing_requests r ON r.request_id = e.request_id
     WHERE e.execution_id = ? AND e.request_id = ?
  `).bind(input.execution.executionId, input.execution.requestId).first<Metadata>();
  if (
    !metadata
    || metadata.execution_id !== input.execution.executionId
    || metadata.request_id !== input.execution.requestId
    || metadata.workflow_instance_id !== input.execution.workflowInstanceId
    || metadata.resume_sequence !== input.execution.resumeSequence
    || metadata.workflow_name !== input.expectedWorkflow
    || metadata.current_execution_id !== metadata.execution_id
    || !Number.isSafeInteger(metadata.generation)
    || metadata.generation < 1
  ) {
    throw failure("The processing execution metadata is inconsistent.");
  }
  await input.stateStore.assertCurrentHead(metadata.request_id, metadata.generation);
  let instance: ProcessingWorkflowInstancePort;
  let created = false;
  try {
    instance = await input.workflow.get(metadata.workflow_instance_id);
    validateInstance(instance, metadata.workflow_instance_id);
  } catch (cause) {
    if (!input.isMissingInstanceError(cause)) throw failure("The Workflow instance lookup outcome is unknown.");
    if (metadata.status !== "starting") throw failure("A previously started Workflow instance is no longer retained.");
    await input.stateStore.assertCurrentHead(metadata.request_id, metadata.generation);
    try {
      const instances = await input.workflow.createBatch([{
        id: metadata.workflow_instance_id,
        params: { requestId: metadata.request_id, revisionHash: metadata.revision_hash },
      }]);
      const returned = instances.find((candidate) => candidate.id === metadata.workflow_instance_id);
      if (returned) {
        validateInstance(returned, metadata.workflow_instance_id);
        created = true;
      }
    } catch {
      // A lost create response is reconciled by the deterministic instance ID.
    }
    try {
      instance = await input.workflow.get(metadata.workflow_instance_id);
      validateInstance(instance, metadata.workflow_instance_id);
    } catch (cause) {
      if (input.isMissingInstanceError(cause)) throw failure("The Workflow instance was not created.");
      throw failure("The Workflow create outcome is unknown.");
    }
  }
  let statusResult: { readonly status: ProcessingWorkflowInstanceStatus };
  try {
    statusResult = await instance.status();
  } catch {
    throw failure("The retained Workflow instance status is temporarily unavailable.");
  }
  if (!PROCESSING_WORKFLOW_INSTANCE_STATUSES.includes(statusResult.status) || statusResult.status === "unknown") {
    throw failure("The retained Workflow instance returned an unusable status.");
  }
  const status = executionStatus(statusResult.status);
  const at = input.now?.() ?? new Date().toISOString();
  const terminal = status === "complete" || status === "errored" || status === "terminated";
  const result = await input.db.prepare(`
    UPDATE processing_executions
       SET status = ?,
           started_at = CASE WHEN ? IN ('running', 'waiting') THEN COALESCE(started_at, ?) ELSE started_at END,
           completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, ?) ELSE completed_at END,
           updated_at = ?
     WHERE execution_id = ? AND request_id = ? AND workflow_instance_id = ?
       AND status IN ('starting', 'running', 'waiting', ?)
       AND EXISTS (
         SELECT 1 FROM processing_requests r
         JOIN processing_heads h ON h.aggregate_type = r.aggregate_type
          AND h.aggregate_id = r.aggregate_id AND h.head_request_id = r.request_id
          AND h.generation = r.generation
        WHERE r.request_id = processing_executions.request_id
          AND r.generation = ? AND r.current_execution_id = processing_executions.execution_id
          AND r.superseded_by_request_id IS NULL AND r.cancel_requested_at IS NULL
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
  if (result.success !== true || result.meta?.changes !== 1) {
    await input.stateStore.assertCurrentHead(metadata.request_id, metadata.generation);
    throw failure("The Workflow execution status changed during reconciliation.");
  }
  return {
    executionId: metadata.execution_id,
    requestId: metadata.request_id,
    workflowInstanceId: metadata.workflow_instance_id,
    resumeSequence: metadata.resume_sequence,
    status,
    workflowStatus: statusResult.status,
    created,
  };
}

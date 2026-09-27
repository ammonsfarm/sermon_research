import {
  ProcessingStateError,
  type BackgroundJobCommand,
  type BackgroundJobDispatcher,
  type BackgroundJobReceipt,
  type OperationContext,
  type ProcessingRequestInput,
  type ProcessingRequestReceipt,
  type ProcessingStateStore,
} from "@aic/contracts";
import type { D1Database } from "@aic/db";
import type { ContentWorkflowEvent } from "./workflow.ts";

interface WorkflowInstancePort {
  readonly id: string;
  status(): Promise<{ readonly status: string }>;
}

export interface ContentWorkflowBindingPort {
  get(id: string): Promise<WorkflowInstancePort>;
  createBatch(batch: Array<{ readonly id: string; readonly params: ContentWorkflowEvent }>): Promise<readonly WorkflowInstancePort[]>;
}

interface RequestRow extends Record<string, unknown> {
  readonly request_id: string;
  readonly revision_hash: `sha256:${string}`;
  readonly idempotency_key: string;
  readonly operation: string;
  readonly generation: number;
}

interface ExecutionRow extends Record<string, unknown> {
  readonly execution_id: string;
  readonly workflow_instance_id: string;
  readonly status: string;
}

function defaultIsMissingInstanceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:404|not found|does not exist)\b/iu.test(message);
}

function acceptedAt(now: () => Date): string {
  return now().toISOString();
}

function jobId(value: string): BackgroundJobReceipt["jobId"] {
  return value as BackgroundJobReceipt["jobId"];
}

export class ContentWorkflowDispatcher implements BackgroundJobDispatcher {
  readonly #db: D1Database;
  readonly #stateStore: ProcessingStateStore;
  readonly #workflow: ContentWorkflowBindingPort;
  readonly #isMissingInstanceError: (error: unknown) => boolean;
  readonly #now: () => Date;

  constructor(options: {
    readonly db: D1Database;
    readonly stateStore: ProcessingStateStore;
    readonly workflow: ContentWorkflowBindingPort;
    readonly isMissingInstanceError?: (error: unknown) => boolean;
    readonly now?: () => Date;
  }) {
    this.#db = options.db;
    this.#stateStore = options.stateStore;
    this.#workflow = options.workflow;
    this.#isMissingInstanceError = options.isMissingInstanceError ?? defaultIsMissingInstanceError;
    this.#now = options.now ?? (() => new Date());
  }

  async dispatch(_context: OperationContext, command: BackgroundJobCommand): Promise<BackgroundJobReceipt> {
    if (command.kind !== "article_index_replace" && command.kind !== "semantic_index_replace" || command.payload.target !== "content") {
      throw new ProcessingStateError("invalid_input", "The content Workflow dispatcher accepts only article and transcript replacement commands.");
    }
    const request = await this.#db.prepare(`
      SELECT request_id, revision_hash, idempotency_key, operation, generation
        FROM processing_requests
       WHERE request_id=? AND workflow_name='content' AND contract_version='p6-v1'
    `).bind(command.payload.requestId).first<RequestRow>();
    if (!request) throw new ProcessingStateError("not_found", "Content processing request was not found.");
    if (request.revision_hash !== command.payload.revisionHash || request.idempotency_key !== command.idempotencyKey) {
      throw new ProcessingStateError("identity_conflict", "Content dispatch identity does not match its immutable request.");
    }
    const expectsTranscript = request.operation === "transcript_replace";
    if (expectsTranscript !== (command.kind === "semantic_index_replace")) {
      throw new ProcessingStateError("identity_conflict", "Content dispatch kind does not match its immutable operation.");
    }
    if (request.operation === "corpus_erase") {
      throw new ProcessingStateError("forbidden", "Corpus erasure is disabled until a frozen authorization policy exists.");
    }
    await this.#stateStore.assertCurrentHead(request.request_id, request.generation);
    const before = await this.#db.prepare(`
      SELECT execution_id, workflow_instance_id, status
        FROM processing_executions WHERE request_id=? AND resume_sequence=0
    `).bind(request.request_id).first<ExecutionRow>();
    const execution = await this.#stateStore.createOrGetInitialExecution(request.request_id);
    if (before !== null && before.status !== "starting" && before.status !== "running") {
      return {
        jobId: jobId(before.execution_id),
        acceptedAt: acceptedAt(this.#now),
        duplicateOf: jobId(before.execution_id),
      };
    }
    let instance: WorkflowInstancePort | undefined;
    try {
      instance = await this.#workflow.get(execution.workflowInstanceId);
    } catch (error) {
      if (!this.#isMissingInstanceError(error)) {
        throw new ProcessingStateError("publication_conflict", "The content Workflow instance lookup outcome is unavailable.");
      }
      if (execution.status !== "starting") {
        throw new ProcessingStateError("publication_conflict", "A previously started content Workflow instance is unavailable.");
      }
      try {
        const created = await this.#workflow.createBatch([{
          id: execution.workflowInstanceId,
          params: { requestId: request.request_id, revisionHash: request.revision_hash },
        }]);
        instance = created.find((candidate) => candidate.id === execution.workflowInstanceId);
      } catch {
        // A lost create response is reconciled through the deterministic ID.
      }
      if (!instance) {
        try { instance = await this.#workflow.get(execution.workflowInstanceId); } catch { /* handled below */ }
      }
      if (!instance || instance.id !== execution.workflowInstanceId) {
        throw new ProcessingStateError("publication_conflict", "Content Workflow start outcome could not be reconciled.");
      }
    }
    try {
      await instance.status();
    } catch {
      throw new ProcessingStateError("publication_conflict", "The content Workflow instance status is unavailable.");
    }
    await this.#stateStore.assertCurrentHead(request.request_id, request.generation);
    const update = await this.#db.prepare(`
      UPDATE processing_executions SET status='running', started_at=COALESCE(started_at,?), updated_at=?
       WHERE execution_id=? AND request_id=? AND workflow_instance_id=?
         AND status IN ('starting','running')
         AND EXISTS (
           SELECT 1 FROM processing_requests r
           JOIN processing_heads h ON h.aggregate_type=r.aggregate_type
            AND h.aggregate_id=r.aggregate_id AND h.head_request_id=r.request_id
            AND h.generation=r.generation
           WHERE r.request_id=processing_executions.request_id
            AND r.generation=? AND r.superseded_by_request_id IS NULL
            AND r.cancel_requested_at IS NULL
         )
    `).bind(acceptedAt(this.#now), acceptedAt(this.#now), execution.executionId, request.request_id, execution.workflowInstanceId, request.generation).run();
    if (update.success !== true || update.meta?.changes !== 1) {
      throw new ProcessingStateError("publication_conflict", "Content Workflow execution reconciliation lost its generation fence.");
    }
    return {
      jobId: jobId(execution.executionId),
      acceptedAt: acceptedAt(this.#now),
      ...(before === null ? {} : { duplicateOf: jobId(before.execution_id) }),
    };
  }
}

/** Creates/deduplicates the immutable request, then crosses the sole dispatch boundary. */
export async function dispatchContentProcessingRequest(input: {
  readonly context: OperationContext;
  readonly stateStore: ProcessingStateStore;
  readonly dispatcher: BackgroundJobDispatcher;
  readonly request: ProcessingRequestInput;
}): Promise<{ readonly request: ProcessingRequestReceipt; readonly job: BackgroundJobReceipt }> {
  if (input.request.operation === "episode_ingest") {
    throw new ProcessingStateError("invalid_input", "Episode ingestion does not belong to the content Workflow.");
  }
  if (input.request.operation === "corpus_erase") {
    throw new ProcessingStateError("forbidden", "Corpus erasure is disabled until a frozen authorization policy exists.");
  }
  const request = await input.stateStore.createOrGetRequest(input.request);
  const command: BackgroundJobCommand = {
    kind: input.request.operation === "transcript_replace" ? "semantic_index_replace" : "article_index_replace",
    idempotencyKey: input.request.idempotencyKey,
    correlation: input.context.correlation,
    payload: { target: "content", requestId: request.requestId, revisionHash: request.revisionHash },
  };
  return { request, job: await input.dispatcher.dispatch(input.context, command) };
}

import {
  PROCESSING_TERMINAL_STATES,
  ProcessingStateError,
  processingRevisionHash,
  type ProcessingExecutionReceipt,
  type ProcessingOperatorActionInput,
  type ProcessingOperatorActionReceipt,
  type ProcessingOperatorAuditEvidence,
  type ProcessingOperatorEvidence,
  type ProcessingOperatorExecutionEvidence,
  type ProcessingOperatorHeadEvidence,
  type ProcessingOperatorRequestEvidence,
  type ProcessingOperatorStageEvidence,
  type ProcessingOperatorVectorBatchEvidence,
  type ProcessingState,
  type ProcessingWorkflow,
} from "@aic/contracts";
import type { D1Database, D1PreparedStatement, D1Result } from "./index.ts";
import { D1ProcessingStateStore } from "./processing.ts";
import {
  reconcileProcessingExecutionStart,
  type ProcessingWorkflowBindingPort,
} from "./processing-execution.ts";

const EVIDENCE_LIMIT = 1_024;
const TERMINAL_PUBLICATION_STATES = new Set<ProcessingState>([
  "published",
  "unpublished",
  "archived",
  "corpus_erased",
]);

interface RequestRow extends Record<string, unknown> {
  readonly request_id: string;
  readonly workflow_name: ProcessingWorkflow;
  readonly entity_type: ProcessingOperatorRequestEvidence["entityType"];
  readonly entity_id: string;
  readonly aggregate_type: ProcessingOperatorRequestEvidence["aggregate"]["type"];
  readonly aggregate_id: string;
  readonly document_id: string | null;
  readonly revision_id: string;
  readonly revision_hash: `sha256:${string}`;
  readonly operation: ProcessingOperatorRequestEvidence["operation"];
  readonly idempotency_key: string;
  readonly generation: number;
  readonly desired_publication: ProcessingOperatorRequestEvidence["desiredPublication"];
  readonly state: ProcessingState;
  readonly resume_sequence: number;
  readonly current_execution_id: string | null;
  readonly superseded_by_request_id: string | null;
  readonly cancel_requested_at: string | null;
  readonly last_error_code: string | null;
  readonly last_error_class: string | null;
  readonly last_error_message: string;
  readonly requested_by: string;
  readonly correlation_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

interface HeadRow extends Record<string, unknown> {
  readonly generation: number;
  readonly head_request_id: string;
  readonly head_revision_hash: `sha256:${string}`;
  readonly published_request_id: string | null;
  readonly published_revision_hash: `sha256:${string}` | null;
  readonly authenticated_corpus_request_id: string | null;
  readonly authenticated_corpus_revision_hash: `sha256:${string}` | null;
  readonly public_visibility: ProcessingOperatorHeadEvidence["publicVisibility"];
  readonly authenticated_corpus_visibility: ProcessingOperatorHeadEvidence["authenticatedCorpusVisibility"];
  readonly desired_publication: ProcessingOperatorHeadEvidence["desiredPublication"];
  readonly mutation_owner_request_id: string | null;
  readonly mutation_lease_token: string | null;
  readonly mutation_lease_expires_at: string | null;
  readonly updated_at: string;
}

interface ExecutionRow extends Record<string, unknown> {
  readonly execution_id: string;
  readonly request_id: string;
  readonly workflow_instance_id: string;
  readonly resume_sequence: number;
  readonly status: ProcessingExecutionReceipt["status"];
  readonly initiated_by: string;
  readonly resume_reason: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly updated_at: string;
}

interface StageRow extends Record<string, unknown> {
  readonly stage_key: string;
  readonly stage_name: string;
  readonly batch_ordinal: number;
  readonly status: ProcessingOperatorStageEvidence["status"];
  readonly from_state: ProcessingState;
  readonly to_state: ProcessingState;
  readonly generation: number;
  readonly attempt_count: number;
  readonly input_hash: `sha256:${string}` | null;
  readonly output_hash: `sha256:${string}` | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly provider_mutation_id: string | null;
  readonly retry_class: string | null;
  readonly error_code: string | null;
  readonly error_class: string | null;
  readonly error_message: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly updated_at: string;
}

interface VectorRow extends Record<string, unknown> {
  readonly batch_ordinal: number;
  readonly operation: "upsert" | "delete";
  readonly generation: number;
  readonly expected_ids_digest: `sha256:${string}`;
  readonly expected_count: number;
  readonly target_revision_hash: `sha256:${string}`;
  readonly provider_mutation_id: string;
  readonly visibility_state: ProcessingOperatorVectorBatchEvidence["visibilityState"];
  readonly poll_count: number;
  readonly processed_up_to_mutation: string | null;
  readonly accepted_at: string | null;
  readonly visible_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AuditRow extends Record<string, unknown> {
  readonly audit_id: string;
  readonly action: string;
  readonly actor_email: string;
  readonly detail_json: string;
  readonly created_at: string;
}

function error(code: ConstructorParameters<typeof ProcessingStateError>[0], message: string): ProcessingStateError {
  return new ProcessingStateError(code, message);
}

function safeText(value: unknown, max = 500): string {
  if (typeof value !== "string") return "";
  const redacted = value
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(/\bauthorization\s*[:=]\s*(?:bearer|basic)\s+[^\s,;]+/giu, "Authorization=[redacted]")
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/\b(authorization|cookie|password|secret|api[_-]?key|token)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
  return Array.from(redacted).slice(0, max).join("").trim();
}

function requiredText(value: string, name: string, max: number): string {
  const normalized = safeText(value, max);
  if (!normalized) throw error("invalid_input", `${name} is required.`);
  return normalized;
}

function actionId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) throw error("invalid_input", "Operator action ID is invalid.");
  return value;
}

async function first<Row extends Record<string, unknown>>(
  db: D1Database,
  sql: string,
  values: readonly unknown[] = [],
): Promise<Row | null> {
  return db.prepare(sql).bind(...values).first<Row>();
}

async function rows<Row extends Record<string, unknown>>(
  db: D1Database,
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly Row[]> {
  return (await db.prepare(sql).bind(...values).all<Row>()).results;
}

async function batch(db: D1Database, statements: readonly D1PreparedStatement[]): Promise<readonly D1Result[]> {
  if (typeof db.batch !== "function") throw error("invalid_input", "D1 transactional batch support is required.");
  const results = await db.batch([...statements]);
  if (
    results.length !== statements.length
    || results.some((result) => result.success !== true || !Number.isSafeInteger(result.meta?.changes) || (result.meta?.changes ?? 0) < 1)
  ) {
    throw error("publication_conflict", "Processing operator transaction did not complete.");
  }
  return results;
}

function executionReceipt(row: ExecutionRow): ProcessingExecutionReceipt {
  return {
    executionId: row.execution_id,
    requestId: row.request_id,
    workflowInstanceId: row.workflow_instance_id,
    resumeSequence: row.resume_sequence,
    status: row.status,
  };
}

function auditDetail(row: AuditRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.detail_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export interface D1ProcessingOperatorStoreOptions {
  readonly db: D1Database;
  readonly now?: () => string;
}

/** D1-only correctness and evidence boundary for authorized P6 operator actions. */
export class D1ProcessingOperatorStore {
  readonly #db: D1Database;
  readonly #now: () => string;
  readonly #state: D1ProcessingStateStore;

  constructor(options: D1ProcessingOperatorStoreOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#state = new D1ProcessingStateStore(options);
  }

  async #request(requestId: string): Promise<RequestRow> {
    const request = await first<RequestRow>(this.#db, `
      SELECT request_id, workflow_name, entity_type, entity_id, aggregate_type,
             aggregate_id, document_id, revision_id, revision_hash, operation,
             idempotency_key, generation, desired_publication, state,
             resume_sequence, current_execution_id, superseded_by_request_id,
             cancel_requested_at, last_error_code, last_error_class,
             last_error_message, requested_by, correlation_id, created_at,
             updated_at, completed_at
        FROM processing_requests
       WHERE request_id = ? AND contract_version = 'p6-v1'
    `, [requestId]);
    if (!request) throw error("not_found", "Processing request was not found.");
    return request;
  }

  async #head(request: RequestRow): Promise<HeadRow> {
    const head = await first<HeadRow>(this.#db, `
      SELECT generation, head_request_id, head_revision_hash,
             published_request_id, published_revision_hash,
             authenticated_corpus_request_id, authenticated_corpus_revision_hash,
             public_visibility, authenticated_corpus_visibility,
             desired_publication, mutation_owner_request_id,
             mutation_lease_token, mutation_lease_expires_at, updated_at
        FROM processing_heads
       WHERE aggregate_type = ? AND aggregate_id = ?
    `, [request.aggregate_type, request.aggregate_id]);
    if (!head) throw error("not_found", "Processing head was not found.");
    return head;
  }

  async #execution(executionId: string | null): Promise<ExecutionRow | null> {
    if (!executionId) return null;
    return first<ExecutionRow>(this.#db, `
      SELECT execution_id, request_id, workflow_instance_id, resume_sequence,
             status, initiated_by, resume_reason, created_at, started_at,
             completed_at, updated_at
        FROM processing_executions WHERE execution_id = ?
    `, [executionId]);
  }

  async getEvidence(requestId: string): Promise<ProcessingOperatorEvidence> {
    const request = await this.#request(requiredText(requestId, "Processing request ID", 512));
    const [head, executionRows, stageRows, vectorRows, auditRows] = await Promise.all([
      this.#head(request),
      rows<ExecutionRow>(this.#db, `
        SELECT execution_id, request_id, workflow_instance_id, resume_sequence,
               status, initiated_by, resume_reason, created_at, started_at,
               completed_at, updated_at
          FROM processing_executions WHERE request_id = ?
         ORDER BY resume_sequence LIMIT ?
      `, [requestId, EVIDENCE_LIMIT + 1]),
      rows<StageRow>(this.#db, `
        SELECT stage_key, stage_name, batch_ordinal, status, from_state, to_state,
               generation, attempt_count, input_hash, output_hash, provider, model,
               provider_mutation_id, retry_class, error_code, error_class,
               error_message, created_at, started_at, completed_at, updated_at
          FROM processing_stage_runs WHERE request_id = ?
         ORDER BY created_at, stage_key LIMIT ?
      `, [requestId, EVIDENCE_LIMIT + 1]),
      rows<VectorRow>(this.#db, `
        SELECT batch_ordinal, operation, generation, expected_ids_digest,
               expected_count, target_revision_hash, provider_mutation_id,
               visibility_state, poll_count, processed_up_to_mutation,
               accepted_at, visible_at, created_at, updated_at
          FROM processing_vector_batches WHERE request_id = ?
         ORDER BY operation, batch_ordinal LIMIT ?
      `, [requestId, EVIDENCE_LIMIT + 1]),
      rows<AuditRow>(this.#db, `
        SELECT audit_id, action, actor_email, detail_json, created_at
          FROM admin_operation_audit
         WHERE entity_type = 'processing_request' AND entity_id = ?
           AND action IN ('processing_cancel', 'processing_resume', 'processing_reconcile')
         ORDER BY created_at, audit_id LIMIT ?
      `, [requestId, EVIDENCE_LIMIT + 1]),
    ]);
    const executions: ProcessingOperatorExecutionEvidence[] = executionRows.slice(0, EVIDENCE_LIMIT).map((row) => ({
      ...executionReceipt(row),
      initiatedBy: safeText(row.initiated_by, 512),
      resumeReason: safeText(row.resume_reason, 1_000),
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
    }));
    const stages: ProcessingOperatorStageEvidence[] = stageRows.slice(0, EVIDENCE_LIMIT).map((row) => ({
      stageName: safeText(row.stage_name, 160),
      batchOrdinal: row.batch_ordinal,
      status: row.status,
      fromState: row.from_state,
      toState: row.to_state,
      generation: row.generation,
      attemptCount: row.attempt_count,
      inputHash: row.input_hash === null ? null : processingRevisionHash(row.input_hash),
      outputHash: row.output_hash === null ? null : processingRevisionHash(row.output_hash),
      provider: row.provider === null ? null : safeText(row.provider, 120),
      model: row.model === null ? null : safeText(row.model, 160),
      providerMutationId: row.provider_mutation_id === null ? null : safeText(row.provider_mutation_id, 240),
      retryClass: row.retry_class === null ? null : safeText(row.retry_class, 120),
      errorCode: row.error_code === null ? null : safeText(row.error_code, 120),
      errorClass: row.error_class === null ? null : safeText(row.error_class, 120),
      errorMessage: safeText(row.error_message),
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
    }));
    const vectorBatches: ProcessingOperatorVectorBatchEvidence[] = vectorRows.slice(0, EVIDENCE_LIMIT).map((row) => ({
      batchOrdinal: row.batch_ordinal,
      operation: row.operation,
      generation: row.generation,
      expectedIdsDigest: processingRevisionHash(row.expected_ids_digest),
      expectedCount: row.expected_count,
      targetRevisionHash: processingRevisionHash(row.target_revision_hash),
      providerMutationId: safeText(row.provider_mutation_id, 240),
      visibilityState: row.visibility_state,
      pollCount: row.poll_count,
      processedUpToMutation: row.processed_up_to_mutation === null ? null : safeText(row.processed_up_to_mutation, 240),
      acceptedAt: row.accepted_at,
      visibleAt: row.visible_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const audit: ProcessingOperatorAuditEvidence[] = auditRows.slice(0, EVIDENCE_LIMIT).map((row) => {
      const detail = auditDetail(row);
      return {
        auditId: safeText(row.audit_id, 512),
        action: safeText(row.action, 120),
        actor: safeText(row.actor_email, 512),
        reason: safeText(detail.reason, 1_000),
        actionId: typeof detail.actionId === "string" ? safeText(detail.actionId, 128) : null,
        outcome: typeof detail.outcome === "string" ? safeText(detail.outcome, 120) : null,
        createdAt: row.created_at,
      };
    });
    return {
      request: {
        requestId: request.request_id,
        workflow: request.workflow_name,
        entityType: request.entity_type,
        entityId: request.entity_id,
        aggregate: { type: request.aggregate_type, id: request.aggregate_id },
        documentId: request.document_id,
        revisionId: request.revision_id,
        revisionHash: processingRevisionHash(request.revision_hash),
        operation: request.operation,
        idempotencyKey: request.idempotency_key,
        generation: request.generation,
        desiredPublication: request.desired_publication,
        state: request.state,
        resumeSequence: request.resume_sequence,
        currentExecutionId: request.current_execution_id,
        supersededByRequestId: request.superseded_by_request_id,
        cancelRequestedAt: request.cancel_requested_at,
        lastError: {
          code: request.last_error_code === null ? null : safeText(request.last_error_code, 120),
          class: request.last_error_class === null ? null : safeText(request.last_error_class, 120),
          message: safeText(request.last_error_message),
        },
        requestedBy: safeText(request.requested_by, 512),
        correlationId: safeText(request.correlation_id, 512),
        createdAt: request.created_at,
        updatedAt: request.updated_at,
        completedAt: request.completed_at,
      },
      head: {
        generation: head.generation,
        headRequestId: head.head_request_id,
        headRevisionHash: processingRevisionHash(head.head_revision_hash),
        publishedRequestId: head.published_request_id,
        publishedRevisionHash: head.published_revision_hash === null ? null : processingRevisionHash(head.published_revision_hash),
        authenticatedCorpusRequestId: head.authenticated_corpus_request_id,
        authenticatedCorpusRevisionHash: head.authenticated_corpus_revision_hash === null ? null : processingRevisionHash(head.authenticated_corpus_revision_hash),
        publicVisibility: head.public_visibility,
        authenticatedCorpusVisibility: head.authenticated_corpus_visibility,
        desiredPublication: head.desired_publication,
        mutationOwnerRequestId: head.mutation_owner_request_id,
        mutationLeaseExpiresAt: head.mutation_lease_expires_at,
        updatedAt: head.updated_at,
      },
      executions,
      stages,
      vectorBatches,
      audit,
      truncated: {
        executions: executionRows.length > EVIDENCE_LIMIT,
        stages: stageRows.length > EVIDENCE_LIMIT,
        vectorBatches: vectorRows.length > EVIDENCE_LIMIT,
        audit: auditRows.length > EVIDENCE_LIMIT,
      },
    };
  }

  async cancel(input: ProcessingOperatorActionInput): Promise<ProcessingOperatorActionReceipt> {
    const requestId = requiredText(input.requestId, "Processing request ID", 512);
    const actor = requiredText(input.actor, "Cancellation actor", 512);
    const reason = requiredText(input.reason, "Cancellation reason", 1_000);
    const normalizedActionId = actionId(input.actionId);
    const request = await this.#request(requestId);
    const head = await this.#head(request);
    const currentExecution = await this.#execution(request.current_execution_id);
    if (request.state === "cancelled" || request.cancel_requested_at !== null) {
      return { action: "cancel", requestId, workflow: request.workflow_name, state: "cancelled", outcome: "cancelled", duplicate: true, ...(currentExecution ? { execution: executionReceipt(currentExecution) } : {}) };
    }
    if (head.head_request_id !== requestId || head.generation !== request.generation || request.superseded_by_request_id !== null) {
      throw error("superseded", "Only the current processing request can be cancelled.");
    }
    if (TERMINAL_PUBLICATION_STATES.has(request.state) || head.published_request_id === requestId) {
      throw error("publication_conflict", "Published processing cannot be cancelled; use an explicit lifecycle operation.");
    }
    if (request.state === "superseded") throw error("superseded", "Superseded processing cannot be cancelled.");
    const at = this.#now();
    const auditId = `p6op:${requestId}:cancel:${normalizedActionId}`;
    try {
      await batch(this.#db, [
        this.#db.prepare(`
          INSERT INTO processing_stage_runs (
            stage_key, request_id, stage_name, batch_ordinal, status,
            from_state, to_state, generation, attempt_count, retry_class,
            error_code, error_class, error_message, created_at, completed_at, updated_at
          ) VALUES (?, ?, 'operator-cancel', 0, 'cancelled', ?, 'cancelled', ?, 1,
                    'cancelled', 'cancelled', 'cancelled',
                    'Cancelled by an authorized operator.', ?, ?, ?)
        `).bind(`p6s:${requestId}:operator-cancel:0`, requestId, request.state, request.generation, at, at, at),
        this.#db.prepare(`
          UPDATE processing_requests
             SET cancel_requested_at = ?, state = 'cancelled', completed_at = ?,
                 last_error_code = 'cancelled', last_error_class = 'cancelled',
                 last_error_message = 'Cancelled by an authorized operator.', updated_at = ?
           WHERE request_id = ? AND generation = ? AND state = 'cancelled'
             AND cancel_requested_at IS NULL AND superseded_by_request_id IS NULL
        `).bind(at, at, at, requestId, request.generation),
        this.#db.prepare(`
          INSERT INTO admin_operation_audit (
            audit_id, action, entity_type, entity_id, actor_email, detail_json, created_at
          ) VALUES (?, 'processing_cancel', 'processing_request', ?, ?, ?, ?)
        `).bind(auditId, requestId, actor, JSON.stringify({ actionId: normalizedActionId, reason, outcome: "cancelled" }), at),
      ]);
    } catch (cause) {
      const replay = await this.#request(requestId);
      if (replay.state === "cancelled" || replay.cancel_requested_at !== null) {
        return { action: "cancel", requestId, workflow: request.workflow_name, state: "cancelled", outcome: "cancelled", duplicate: true, ...(currentExecution ? { execution: executionReceipt(currentExecution) } : {}) };
      }
      throw cause;
    }
    return { action: "cancel", requestId, workflow: request.workflow_name, state: "cancelled", outcome: "cancelled", duplicate: false, ...(currentExecution ? { execution: executionReceipt(currentExecution) } : {}) };
  }

  async resume(input: ProcessingOperatorActionInput): Promise<ProcessingOperatorActionReceipt> {
    const requestId = requiredText(input.requestId, "Processing request ID", 512);
    const actor = requiredText(input.actor, "Resume actor", 512);
    const reason = requiredText(input.reason, "Resume reason", 1_000);
    const normalizedActionId = actionId(input.actionId);
    const auditId = `p6op:${requestId}:resume:${normalizedActionId}`;
    const wasDuplicate = await first<{ readonly audit_id: string }>(this.#db, "SELECT audit_id FROM admin_operation_audit WHERE audit_id = ?", [auditId]) !== null;
    const execution = await this.#state.resumeAttributed(requestId, actor, reason, normalizedActionId);
    const request = await this.#request(requestId);
    return {
      action: "resume",
      requestId,
      workflow: request.workflow_name,
      state: request.state,
      outcome: "resume_started",
      duplicate: wasDuplicate,
      execution,
    };
  }

  async reconcile(input: ProcessingOperatorActionInput): Promise<ProcessingOperatorActionReceipt> {
    const requestId = requiredText(input.requestId, "Processing request ID", 512);
    const actor = requiredText(input.actor, "Reconciliation actor", 512);
    const reason = requiredText(input.reason, "Reconciliation reason", 1_000);
    const normalizedActionId = actionId(input.actionId);
    const auditId = `p6op:${requestId}:reconcile:${normalizedActionId}`;
    const prior = await first<AuditRow>(this.#db, "SELECT audit_id, action, actor_email, detail_json, created_at FROM admin_operation_audit WHERE audit_id = ?", [auditId]);
    const request = await this.#request(requestId);
    const head = await this.#head(request);
    const execution = await this.#execution(request.current_execution_id);
    if (prior) {
      const detail = auditDetail(prior);
      return {
        action: "reconcile",
        requestId,
        workflow: request.workflow_name,
        state: request.state,
        outcome: typeof detail.outcome === "string" ? detail.outcome as ProcessingOperatorActionReceipt["outcome"] : "no_action",
        duplicate: true,
        ...(execution ? { execution: executionReceipt(execution) } : {}),
        releasedExpiredLease: detail.releasedExpiredLease === true,
        resolvedUnknownStages: Number(detail.resolvedUnknownStages) || 0,
        unresolvedUnknownStages: Number(detail.unresolvedUnknownStages) || 0,
      };
    }
    const currentHead = head.head_request_id === requestId
      && head.generation === request.generation && request.superseded_by_request_id === null;
    if (!currentHead && head.mutation_owner_request_id !== requestId) {
      throw error("superseded", "Only the current request or retained mutation lease owner can be reconciled.");
    }
    const unknown = await rows<StageRow>(this.#db, `
      SELECT stage_key, stage_name, batch_ordinal, status, from_state, to_state,
             generation, attempt_count, input_hash, output_hash, provider, model,
             provider_mutation_id, retry_class, error_code, error_class,
             error_message, created_at, started_at, completed_at, updated_at
        FROM processing_stage_runs
       WHERE request_id = ? AND status = 'side_effect_unknown'
       ORDER BY created_at, stage_key LIMIT ?
    `, [requestId, EVIDENCE_LIMIT]);
    const resolved: StageRow[] = [];
    for (const stage of unknown) {
      const vectorReceipt = stage.provider_mutation_id === null ? null : await first<{ readonly matched: number }>(this.#db, `
        SELECT 1 AS matched FROM processing_vector_batches
         WHERE request_id = ? AND provider_mutation_id = ?
           AND visibility_state IN ('accepted', 'visible', 'delete_accepted', 'deleted')
      `, [requestId, stage.provider_mutation_id]);
      const transcriptReceipt = !stage.stage_name.includes("transcrib") ? null : await first<{ readonly matched: number }>(this.#db, `
        SELECT 1 AS matched FROM transcript_segments
         WHERE json_extract(raw_segment_json, '$.requestId') = ? LIMIT 1
      `, [requestId]);
      const intelligenceReceipt = !stage.stage_name.includes("intelligence") ? null : await first<{ readonly matched: number }>(this.#db, `
        SELECT 1 AS matched FROM episode_intelligence
         WHERE json_extract(raw_json, '$.requestId') = ? LIMIT 1
      `, [requestId]);
      if (vectorReceipt || transcriptReceipt || intelligenceReceipt) resolved.push(stage);
    }
    const unresolvedUnknownStages = unknown.length - resolved.length;
    const at = this.#now();
    const expiredLease = head.mutation_owner_request_id === requestId
      && head.mutation_lease_expires_at !== null
      && Date.parse(head.mutation_lease_expires_at) <= Date.parse(at);
    const releasedExpiredLease = expiredLease && unresolvedUnknownStages === 0;
    const visibilityPending = await first<{ readonly count: number }>(this.#db, `
      SELECT count(*) AS count FROM processing_vector_batches
       WHERE request_id = ? AND visibility_state IN ('accepted', 'delete_accepted')
    `, [requestId]);
    const outcome: ProcessingOperatorActionReceipt["outcome"] = unresolvedUnknownStages > 0
      ? "quarantined"
      : currentHead && execution?.status === "starting"
        ? "starting_reconciled"
        : (visibilityPending?.count ?? 0) > 0
          ? "visibility_pending"
          : releasedExpiredLease
            ? "lease_released"
            : currentHead && request.state === "retry_required"
              ? "resume_required"
              : "no_action";
    const statements: D1PreparedStatement[] = resolved.map((stage) => this.#db.prepare(`
      UPDATE processing_stage_runs
         SET status = 'failed', retry_class = 'reconciled',
             error_code = 'deterministic_receipt_found',
             error_class = 'reconciled',
             error_message = 'A durable receipt proved the side effect outcome.',
             updated_at = ?
       WHERE stage_key = ? AND request_id = ? AND status = 'side_effect_unknown'
    `).bind(at, stage.stage_key, requestId));
    if (releasedExpiredLease) {
      statements.push(this.#db.prepare(`
        UPDATE processing_heads
           SET mutation_owner_request_id = NULL, mutation_lease_token = NULL,
               mutation_lease_expires_at = NULL, updated_at = ?
         WHERE head_request_id = ? AND generation = ?
           AND mutation_owner_request_id = ? AND mutation_lease_token = ?
           AND mutation_lease_expires_at = ? AND mutation_lease_expires_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM processing_stage_runs s
              WHERE s.request_id = processing_heads.mutation_owner_request_id
                AND s.status = 'side_effect_unknown'
           )
      `).bind(at, head.head_request_id, head.generation, requestId, head.mutation_lease_token, head.mutation_lease_expires_at, at));
    }
    statements.push(this.#db.prepare(`
      INSERT INTO admin_operation_audit (
        audit_id, action, entity_type, entity_id, actor_email, detail_json, created_at
      ) VALUES (?, 'processing_reconcile', 'processing_request', ?, ?, ?, ?)
    `).bind(auditId, requestId, actor, JSON.stringify({
      actionId: normalizedActionId,
      reason,
      outcome,
      releasedExpiredLease,
      resolvedUnknownStages: resolved.length,
      unresolvedUnknownStages,
    }), at));
    await batch(this.#db, statements);
    return {
      action: "reconcile",
      requestId,
      workflow: request.workflow_name,
      state: request.state,
      outcome,
      duplicate: false,
      ...(execution ? { execution: executionReceipt(execution) } : {}),
      releasedExpiredLease,
      resolvedUnknownStages: resolved.length,
      unresolvedUnknownStages,
    };
  }

  async markExecutionStatus(
    requestId: string,
    executionId: string,
    status: "complete" | "errored" | "terminated",
  ): Promise<void> {
    const at = this.#now();
    const statement = status === "terminated" ? this.#db.prepare(`
      UPDATE processing_executions
         SET status = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
       WHERE execution_id = ? AND request_id = ?
         AND status IN ('starting', 'running', 'waiting', ?)
    `).bind(status, at, at, executionId, requestId, status) : this.#db.prepare(`
      UPDATE processing_executions
         SET status = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
       WHERE execution_id = ? AND request_id = ?
         AND status IN ('starting', 'running', 'waiting', ?)
         AND EXISTS (
           SELECT 1 FROM processing_requests r
           JOIN processing_heads h ON h.aggregate_type = r.aggregate_type
            AND h.aggregate_id = r.aggregate_id AND h.head_request_id = r.request_id
            AND h.generation = r.generation
            WHERE r.request_id = processing_executions.request_id
              AND r.current_execution_id = processing_executions.execution_id
              AND r.superseded_by_request_id IS NULL AND r.cancel_requested_at IS NULL
         )
    `).bind(status, at, at, executionId, requestId, status);
    await statement.run();
  }

  async markCurrentExecutionStatus(
    requestId: string,
    status: "complete" | "errored",
  ): Promise<void> {
    const request = await this.#request(requestId);
    if (request.current_execution_id) await this.markExecutionStatus(requestId, request.current_execution_id, status);
  }
}

/** Owning-Worker adapter: verify D1 ownership, commit, then best-effort Workflow control. */
export class ProcessingOperatorController {
  readonly #store: D1ProcessingOperatorStore;
  readonly #state: D1ProcessingStateStore;
  readonly #db: D1Database;
  readonly #workflow: ProcessingWorkflowBindingPort;
  readonly #expectedWorkflow: ProcessingWorkflow;
  readonly #isMissingInstanceError: (error: unknown) => boolean;
  readonly #now: (() => string) | undefined;

  constructor(options: D1ProcessingOperatorStoreOptions & {
    readonly workflow: ProcessingWorkflowBindingPort;
    readonly expectedWorkflow: ProcessingWorkflow;
    readonly isMissingInstanceError?: (error: unknown) => boolean;
  }) {
    this.#db = options.db;
    this.#store = new D1ProcessingOperatorStore(options);
    this.#state = new D1ProcessingStateStore(options);
    this.#workflow = options.workflow;
    this.#expectedWorkflow = options.expectedWorkflow;
    this.#isMissingInstanceError = options.isMissingInstanceError ?? ((cause) => cause instanceof Error && /not found|does not exist|404/iu.test(cause.message));
    this.#now = options.now;
  }

  async #assertWorkflowOwner(requestId: string): Promise<void> {
    // Read immutable request identity before any operator write; never use caller identity.
    const request = await first<{ readonly workflow_name: ProcessingWorkflow }>(this.#db, `
      SELECT workflow_name FROM processing_requests
       WHERE request_id = ? AND contract_version = 'p6-v1'
    `, [requiredText(requestId, "Processing request ID", 512)]);
    if (!request) throw error("not_found", "Processing request was not found.");
    if (request.workflow_name !== this.#expectedWorkflow) {
      throw error("identity_conflict", "Operator action reached the wrong Workflow owner.");
    }
  }

  async cancel(input: ProcessingOperatorActionInput): Promise<ProcessingOperatorActionReceipt> {
    await this.#assertWorkflowOwner(input.requestId);
    const receipt = await this.#store.cancel(input);
    if (receipt.workflow !== this.#expectedWorkflow) throw error("identity_conflict", "Operator action reached the wrong Workflow owner.");
    if (!receipt.execution) return { ...receipt, termination: "not_running" };
    try {
      const instance = await this.#workflow.get(receipt.execution.workflowInstanceId);
      const status = await instance.status();
      if (status.status === "complete" || status.status === "errored" || status.status === "terminated") {
        return { ...receipt, termination: "not_running" };
      }
      if (typeof instance.terminate !== "function") return { ...receipt, termination: "best_effort_failed" };
      await instance.terminate({ rollback: false });
      await this.#store.markExecutionStatus(receipt.requestId, receipt.execution.executionId, "terminated");
      return { ...receipt, termination: "terminated" };
    } catch (cause) {
      return { ...receipt, termination: this.#isMissingInstanceError(cause) ? "not_running" : "best_effort_failed" };
    }
  }

  async resume(input: ProcessingOperatorActionInput): Promise<ProcessingOperatorActionReceipt> {
    await this.#assertWorkflowOwner(input.requestId);
    const receipt = await this.#store.resume(input);
    if (receipt.workflow !== this.#expectedWorkflow || !receipt.execution) {
      throw error("identity_conflict", "Operator resume reached the wrong Workflow owner.");
    }
    const started = await reconcileProcessingExecutionStart({
      db: this.#db,
      stateStore: this.#state,
      workflow: this.#workflow,
      execution: receipt.execution,
      expectedWorkflow: this.#expectedWorkflow,
      isMissingInstanceError: this.#isMissingInstanceError,
      ...(this.#now === undefined ? {} : { now: this.#now }),
    });
    return { ...receipt, execution: started };
  }

  async reconcile(input: ProcessingOperatorActionInput): Promise<ProcessingOperatorActionReceipt> {
    await this.#assertWorkflowOwner(input.requestId);
    const receipt = await this.#store.reconcile(input);
    if (receipt.workflow !== this.#expectedWorkflow) throw error("identity_conflict", "Operator reconciliation reached the wrong Workflow owner.");
    if (receipt.execution?.status !== "starting" || receipt.outcome !== "starting_reconciled") return this.#recoverStoppedExecution(receipt);
    const started = await reconcileProcessingExecutionStart({
      db: this.#db,
      stateStore: this.#state,
      workflow: this.#workflow,
      execution: receipt.execution,
      expectedWorkflow: this.#expectedWorkflow,
      isMissingInstanceError: this.#isMissingInstanceError,
      ...(this.#now === undefined ? {} : { now: this.#now }),
    });
    return { ...receipt, execution: started };
  }

  /**
   * A Workflow instance can stop (errored or terminated) without recording a terminal
   * processing state, e.g. when a step fails after its retries on a fence check. Such a
   * request is otherwise stranded: resume requires retry_required. When the instance has
   * stopped and the request is still non-terminal, record retry_required so it can resume.
   */
  async #recoverStoppedExecution(receipt: ProcessingOperatorActionReceipt): Promise<ProcessingOperatorActionReceipt> {
    const execution = receipt.execution;
    if (!execution || (PROCESSING_TERMINAL_STATES as readonly ProcessingState[]).includes(receipt.state)) return receipt;
    let status: string;
    try {
      status = (await (await this.#workflow.get(execution.workflowInstanceId)).status()).status;
    } catch (cause) {
      if (!this.#isMissingInstanceError(cause)) return receipt;
      status = "terminated";
    }
    if (status !== "errored" && status !== "terminated") return receipt;
    const request = await this.#db.prepare("SELECT generation FROM processing_requests WHERE request_id = ?")
      .bind(receipt.requestId).first<{ readonly generation: number }>();
    if (!request) return receipt;
    await this.#store.markExecutionStatus(receipt.requestId, execution.executionId, status);
    await this.#state.transition({
      requestId: receipt.requestId,
      workflow: receipt.workflow,
      generation: Number(request.generation),
      from: receipt.state,
      to: "retry_required",
      stageName: `operator-workflow-${status}:${execution.executionId}`,
      errorCode: "workflow_stopped",
      errorClass: "transient_dependency",
      errorMessage: "The processing Workflow stopped before finishing. Retry to continue.",
      retryClass: "transient",
    });
    return { ...receipt, state: "retry_required", outcome: "resume_required", execution: { ...execution, status } };
  }
}

import {
  ProcessingStateError,
  assertProcessingTransition,
  canonicalProcessingAggregate,
  canonicalProcessingSnapshot,
  createProcessingIdempotencyKey,
  createProcessingRevisionHash,
  createProcessingWorkflowInstanceId,
  processingRevisionHash,
  type ProcessingAggregateKey,
  type ProcessingExecutionReceipt,
  type ProcessingMutationLeaseCommand,
  type ProcessingOperation,
  type ProcessingRequestInput,
  type ProcessingRequestReceipt,
  type ProcessingStageReceipt,
  type ProcessingState,
  type ProcessingStateErrorCode,
  type ProcessingStateStore,
  type ProcessingTransitionCommand,
  type PublicationFinalizeCommand,
  type VectorAcceptanceCommand,
  type VectorVisibilityCommand,
} from "@aic/contracts";
import type { D1Database, D1PreparedStatement, D1Result } from "./index.ts";

export interface D1ProcessingStateStoreOptions {
  readonly db: D1Database;
  readonly now?: () => string;
}

interface RequestRow extends Record<string, unknown> {
  readonly request_id: string;
  readonly workflow_name: "episode" | "content";
  readonly entity_type: string;
  readonly entity_id: string;
  readonly aggregate_type: "episode" | "article";
  readonly aggregate_id: string;
  readonly revision_id: string;
  readonly revision_hash: `sha256:${string}`;
  readonly operation: ProcessingOperation;
  readonly idempotency_key: string;
  readonly input_snapshot_json: string;
  readonly generation: number;
  readonly desired_publication: string;
  readonly state: ProcessingState;
  readonly resume_sequence: number;
  readonly current_execution_id: string | null;
  readonly superseded_by_request_id: string | null;
  readonly cancel_requested_at: string | null;
}

interface ExecutionRow extends Record<string, unknown> {
  readonly execution_id: string;
  readonly request_id: string;
  readonly workflow_instance_id: string;
  readonly resume_sequence: number;
  readonly status: "starting" | "running" | "waiting" | "complete" | "errored" | "terminated";
  readonly initiated_by?: string;
  readonly resume_reason?: string;
}

interface StageRow extends Record<string, unknown> {
  readonly request_id: string;
  readonly stage_name: string;
  readonly batch_ordinal: number;
  readonly status: "pending" | "running" | "side_effect_unknown" | "accepted" | "visible" | "complete" | "failed" | "skipped" | "superseded" | "cancelled";
  readonly from_state: ProcessingState;
  readonly to_state: ProcessingState;
  readonly generation: number;
}

interface VectorBatchRow extends Record<string, unknown> {
  readonly request_id: string;
  readonly batch_ordinal: number;
  readonly operation: "upsert" | "delete";
  readonly generation: number;
  readonly expected_ids_digest: string;
  readonly expected_count: number;
  readonly target_revision_hash: string;
  readonly provider_mutation_id: string;
  readonly visibility_state: string;
}

const FINALIZATION_ONLY_STATES = new Set<ProcessingState>([
  "published",
  "unpublished",
  "archived",
  "corpus_erased",
]);

const REQUEST_COLUMNS = `
  request_id, workflow_name, entity_type, entity_id, aggregate_type,
  aggregate_id, revision_id, revision_hash, operation, idempotency_key,
  input_snapshot_json, generation, desired_publication, state,
  resume_sequence, current_execution_id, superseded_by_request_id,
  cancel_requested_at`;

function processingError(code: ProcessingStateErrorCode, message: string): ProcessingStateError {
  return new ProcessingStateError(code, message);
}

function requireText(value: string, name: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > max || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw processingError("invalid_input", `${name} is invalid.`);
  }
  return value;
}

function sanitizeError(value: string | undefined): string {
  if (value === undefined) return "";
  const withoutControls = value.replace(/[\u0000-\u001F\u007F]/gu, " ");
  const redacted = withoutControls
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(/\bauthorization\s*[:=]\s*(?:bearer|basic)\s+[^\s,;]+/giu, "Authorization=[redacted]")
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/\b(authorization|cookie|password|secret|api[_-]?key|token)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
  return Array.from(redacted).slice(0, 2_000).join("");
}

function operatorText(value: string, name: string, max = 1_000): string {
  const normalized = sanitizeError(value).trim();
  if (!normalized) throw processingError("invalid_input", `${name} is required.`);
  return Array.from(normalized).slice(0, max).join("");
}

function operatorActionId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) throw processingError("invalid_input", "Operator action ID is invalid.");
  return value;
}

function initialState(operation: ProcessingRequestInput["operation"]): ProcessingState {
  if (operation === "episode_ingest") return "discovered";
  if (operation === "article_replace" || operation === "transcript_replace") return "revision_recorded";
  if (operation === "public_unpublish") return "public_unpublish_requested";
  if (operation === "public_archive") return "public_archive_requested";
  return "corpus_erase_requested";
}

function assertDesiredPublication(input: ProcessingRequestInput): void {
  if (input.operation === "public_unpublish" && input.desiredPublication !== "unpublished") {
    throw processingError("invalid_input", "Public unpublish requires an unpublished intent.");
  }
  if (input.operation === "public_archive" && input.desiredPublication !== "archived") {
    throw processingError("invalid_input", "Public archive requires an archived intent.");
  }
  if ((input.operation === "article_replace" || input.operation === "transcript_replace") && input.workflow !== "content") {
    throw processingError("invalid_input", "Content processing requests require the content workflow.");
  }
  if (input.operation === "episode_ingest" && input.workflow !== "episode") {
    throw processingError("invalid_input", "Episode ingestion requires the episode workflow.");
  }
}

function receipt(row: RequestRow, duplicate: boolean): ProcessingRequestReceipt {
  return {
    requestId: row.request_id,
    workflow: row.workflow_name,
    aggregate: { type: row.aggregate_type, id: row.aggregate_id },
    revisionHash: processingRevisionHash(row.revision_hash),
    generation: row.generation,
    state: row.state,
    duplicate,
  };
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

async function first<Row extends Record<string, unknown>>(
  db: D1Database,
  sql: string,
  values: readonly unknown[] = [],
): Promise<Row | null> {
  const row = await db.prepare(sql).bind(...values).first<Row>();
  if (row === null) return null;
  if (!row || typeof row !== "object" || Array.isArray(row)) throw processingError("invalid_input", "D1 returned an invalid processing row.");
  return row;
}

async function batchOne(
  db: D1Database,
  statement: D1PreparedStatement,
  zeroCode: ProcessingStateErrorCode,
  zeroMessage: string,
): Promise<void> {
  if (typeof db.batch !== "function") throw processingError("invalid_input", "D1 transactional batch support is required.");
  let results: readonly D1Result[];
  try {
    results = await db.batch([statement]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("p6_stale_generation")) throw processingError("stale_generation", "Processing generation changed.");
    if (message.includes("p6_execution_conflict")) throw processingError("publication_conflict", "Processing execution could not be created.");
    if (message.includes("p6_transition_conflict") || message.includes("p6_public_hide_conflict") || message.includes("p6_corpus_hide_conflict")) {
      throw processingError(zeroCode, zeroMessage);
    }
    if (message.includes("p6_publication_conflict") || message.includes("p6_corpus_erase_conflict")) {
      throw processingError("publication_conflict", "Processing publication compare-and-set failed.");
    }
    throw error;
  }
  const changes = results[0]?.meta?.changes;
  if (results.length !== 1 || results[0]?.success !== true || !Number.isSafeInteger(changes) || (changes as number) < 1) {
    throw processingError(zeroCode, zeroMessage);
  }
}

async function batchMany(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
  zeroCode: ProcessingStateErrorCode = "publication_conflict",
  zeroMessage = "Processing operator transaction did not commit every required record.",
): Promise<void> {
  if (typeof db.batch !== "function") throw processingError("invalid_input", "D1 transactional batch support is required.");
  let results: readonly D1Result[];
  try {
    results = await db.batch([...statements]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("p6_stale_generation")) {
      throw processingError("stale_generation", "Processing request head changed during allocation.");
    }
    throw error;
  }
  if (
    results.length !== statements.length
    || results.some((result) => result.success !== true || !Number.isSafeInteger(result.meta?.changes) || (result.meta?.changes ?? 0) < 1)
  ) {
    throw processingError(zeroCode, zeroMessage);
  }
}

function sameRequest(row: RequestRow, input: ProcessingRequestInput, aggregate: ProcessingAggregateKey, snapshot: string): boolean {
  return row.workflow_name === input.workflow
    && row.entity_type === input.entityType
    && row.entity_id === input.entityId
    && row.aggregate_type === aggregate.type
    && row.aggregate_id === aggregate.id
    && row.revision_id === input.revisionId
    && row.revision_hash === input.revisionHash
    && row.operation === input.operation
    && row.idempotency_key === input.idempotencyKey
    && row.input_snapshot_json === snapshot
    && row.desired_publication === input.desiredPublication;
}

export class D1ProcessingStateStore implements ProcessingStateStore {
  readonly #db: D1Database;
  readonly #now: () => string;

  constructor(options: D1ProcessingStateStoreOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async #request(requestId: string): Promise<RequestRow> {
    const row = await first<RequestRow>(this.#db, `SELECT ${REQUEST_COLUMNS} FROM processing_requests WHERE request_id = ? AND contract_version = 'p6-v1'`, [requestId]);
    if (!row) throw processingError("not_found", "Processing request was not found.");
    return row;
  }

  async #headError(requestId: string, generation: number, fallback: ProcessingStateErrorCode = "stale_generation"): Promise<ProcessingStateError> {
    const row = await this.#request(requestId);
    if (row.superseded_by_request_id !== null || row.state === "superseded") return processingError("superseded", "Processing request was superseded.");
    if (row.cancel_requested_at !== null || row.state === "cancelled") return processingError("cancelled", "Processing request was cancelled.");
    if (row.generation !== generation) return processingError("stale_generation", "Processing generation changed.");
    return processingError(fallback, "Processing compare-and-set failed.");
  }

  async createOrGetRequest(input: ProcessingRequestInput): Promise<ProcessingRequestReceipt> {
    requireText(input.requestId, "Processing request ID");
    const aggregate = canonicalProcessingAggregate(input.operation, input.entityType, input.entityId);
    if (input.operation === "corpus_erase" && input.corpusEraseApproved !== true) {
      throw processingError("forbidden", "Corpus erasure requires an approved capability and policy.");
    }
    assertDesiredPublication(input);
    const snapshot = canonicalProcessingSnapshot(input.snapshot);
    const existing = await first<RequestRow>(this.#db, `SELECT ${REQUEST_COLUMNS} FROM processing_requests WHERE idempotency_key = ?`, [input.idempotencyKey]);
    if (existing) {
      if (!sameRequest(existing, input, aggregate, snapshot)) throw processingError("identity_conflict", "The processing idempotency key identifies a different immutable request.");
      return receipt(existing, true);
    }
    if (await createProcessingRevisionHash(input.snapshot) !== input.revisionHash) {
      throw processingError("invalid_input", "Processing revision hash does not match the canonical snapshot.");
    }
    if (await createProcessingIdempotencyKey(input) !== input.idempotencyKey) {
      throw processingError("invalid_input", "Processing idempotency key does not match the canonical aggregate and revision.");
    }
    requireText(input.revisionId, "Processing revision ID");
    const requestedBy = requireText(input.requestedBy ?? "system", "Processing requester");
    const correlationId = requireText(input.correlationId ?? input.requestId, "Processing correlation ID");
    const current = await first<{ readonly generation: number }>(this.#db, "SELECT generation FROM processing_heads WHERE aggregate_type = ? AND aggregate_id = ?", [aggregate.type, aggregate.id]);
    const generation = (current?.generation ?? 0) + 1;
    const at = this.#now();
    const predecessor = input.expectedPredecessor;
    if (predecessor && (input.operation !== "episode_ingest" || input.desiredPublication !== "published"
      || !predecessor.requestId || !/^sha256:[0-9a-f]{64}$/u.test(predecessor.revisionHash)
      || !Number.isSafeInteger(predecessor.generation) || predecessor.generation < 1)) {
      throw processingError("invalid_input", "Episode publication predecessor is invalid.");
    }
    const predecessorGuard = predecessor ? ` WHERE EXISTS (
      SELECT 1 FROM processing_requests p JOIN processing_heads h
        ON h.aggregate_type=p.aggregate_type AND h.aggregate_id=p.aggregate_id
       AND h.head_request_id=p.request_id AND h.generation=p.generation
      WHERE p.request_id=? AND p.revision_hash=? AND p.generation=?
        AND p.aggregate_type=? AND p.aggregate_id=? AND p.operation='episode_ingest'
        AND p.desired_publication='draft' AND p.state='publish_ready'
        AND p.superseded_by_request_id IS NULL AND p.cancel_requested_at IS NULL
        AND (h.mutation_lease_expires_at IS NULL OR h.mutation_lease_expires_at<=?)
        AND NOT EXISTS (SELECT 1 FROM processing_stage_runs s
          WHERE s.request_id=p.request_id AND s.status='side_effect_unknown')
    )` : "";
    const statement = this.#db.prepare(`
      INSERT INTO processing_requests (
        request_id, contract_version, workflow_name, entity_type, entity_id,
        aggregate_type, aggregate_id, document_id, revision_id, revision_hash,
        operation, idempotency_key, input_snapshot_json, input_size_bytes,
        generation, desired_publication, state, resume_sequence, status,
        last_error_message, requested_by, correlation_id, created_at, updated_at
      ) SELECT ?, 'p6-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
                NULL, '', ?, ?, ?, ? ${predecessorGuard}
    `).bind(
      input.requestId,
      input.workflow,
      input.entityType,
      input.entityId,
      aggregate.type,
      aggregate.id,
      input.documentId ?? null,
      input.revisionId,
      input.revisionHash,
      input.operation,
      input.idempotencyKey,
      snapshot,
      new TextEncoder().encode(snapshot).byteLength,
      generation,
      input.desiredPublication,
      initialState(input.operation),
      requestedBy,
      correlationId,
      at,
      at,
      ...(predecessor ? [predecessor.requestId, predecessor.revisionHash, predecessor.generation, aggregate.type, aggregate.id, at] : []),
    );
    try {
      await batchOne(this.#db, statement, "stale_generation", "Processing request head changed during allocation.");
    } catch (error) {
      const replay = await first<RequestRow>(this.#db, `SELECT ${REQUEST_COLUMNS} FROM processing_requests WHERE idempotency_key = ?`, [input.idempotencyKey]);
      if (replay && sameRequest(replay, input, aggregate, snapshot)) return receipt(replay, true);
      if (replay) throw processingError("identity_conflict", "The processing idempotency key identifies a different immutable request.");
      if (error instanceof ProcessingStateError) throw error;
      throw error;
    }
    return receipt(await this.#request(input.requestId), false);
  }

  async createOrGetInitialExecution(requestId: string): Promise<ProcessingExecutionReceipt> {
    const request = await this.#request(requestId);
    const existing = await first<ExecutionRow>(this.#db, "SELECT execution_id, request_id, workflow_instance_id, resume_sequence, status FROM processing_executions WHERE request_id = ? AND resume_sequence = 0", [requestId]);
    if (existing) return executionReceipt(existing);
    await this.assertCurrentHead(requestId, request.generation);
    const workflowInstanceId = createProcessingWorkflowInstanceId(request.workflow_name, request.idempotency_key as never, 0);
    const executionId = `p6x-${workflowInstanceId.slice(4)}`;
    const at = this.#now();
    try {
      await batchOne(this.#db, this.#db.prepare(`
        INSERT INTO processing_executions (
          execution_id, request_id, workflow_instance_id, resume_sequence,
          status, initiated_by, resume_reason, created_at, updated_at
        ) VALUES (?, ?, ?, 0, 'starting', ?, '', ?, ?)
      `).bind(executionId, requestId, workflowInstanceId, request.request_id, at, at), "publication_conflict", "Initial processing execution already exists.");
    } catch (error) {
      const replay = await first<ExecutionRow>(this.#db, "SELECT execution_id, request_id, workflow_instance_id, resume_sequence, status FROM processing_executions WHERE request_id = ? AND resume_sequence = 0", [requestId]);
      if (replay?.workflow_instance_id === workflowInstanceId) return executionReceipt(replay);
      throw error;
    }
    return executionReceipt((await first<ExecutionRow>(this.#db, "SELECT execution_id, request_id, workflow_instance_id, resume_sequence, status FROM processing_executions WHERE execution_id = ?", [executionId]))!);
  }

  async resume(requestId: string, actor: string, reason: string): Promise<ProcessingExecutionReceipt> {
    const request = await this.#request(requestId);
    return this.resumeAttributed(requestId, actor, reason, `direct-${request.resume_sequence + 1}`);
  }

  async resumeAttributed(requestId: string, actor: string, reason: string, actionId: string): Promise<ProcessingExecutionReceipt> {
    const request = await this.#request(requestId);
    const normalizedActionId = operatorActionId(actionId);
    const auditId = `p6op:${requestId}:resume:${normalizedActionId}`;
    const duplicate = await first<ExecutionRow>(this.#db, `
      SELECT e.execution_id, e.request_id, e.workflow_instance_id, e.resume_sequence,
             e.status, e.initiated_by, e.resume_reason
        FROM admin_operation_audit a
        JOIN processing_executions e
          ON e.execution_id = json_extract(a.detail_json, '$.executionId')
       WHERE a.audit_id = ? AND a.action = 'processing_resume'
         AND a.entity_type = 'processing_request' AND a.entity_id = ?
    `, [auditId, requestId]);
    if (duplicate) return executionReceipt(duplicate);
    await this.assertCurrentHead(requestId, request.generation);
    if (request.state !== "retry_required") throw processingError("invalid_state_transition", "Only retry-required processing can be resumed.");
    const unknown = await first<{ readonly count: number }>(this.#db, `
      SELECT count(*) AS count FROM processing_stage_runs
       WHERE request_id = ? AND status = 'side_effect_unknown'
    `, [requestId]);
    if ((unknown?.count ?? 0) > 0) {
      throw processingError("visibility_pending", "Unknown provider outcomes require explicit reconciliation before resume.");
    }
    const initiatedBy = operatorText(actor, "Resume actor", 512);
    const resumeReason = operatorText(reason, "Resume reason");
    const sequence = request.resume_sequence + 1;
    const workflowInstanceId = createProcessingWorkflowInstanceId(request.workflow_name, request.idempotency_key as never, sequence);
    const executionId = `p6x-${workflowInstanceId.slice(4)}`;
    const at = this.#now();
    try {
      await batchMany(this.#db, [
        this.#db.prepare(`
          INSERT INTO processing_executions (
            execution_id, request_id, workflow_instance_id, resume_sequence,
            status, initiated_by, resume_reason, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'starting', ?, ?, ?, ?)
        `).bind(executionId, requestId, workflowInstanceId, sequence, initiatedBy, resumeReason, at, at),
        this.#db.prepare(`
          INSERT INTO admin_operation_audit (
            audit_id, action, entity_type, entity_id, actor_email, detail_json, created_at
          ) VALUES (?, 'processing_resume', 'processing_request', ?, ?, ?, ?)
        `).bind(auditId, requestId, initiatedBy, JSON.stringify({
          actionId: normalizedActionId,
          reason: resumeReason,
          executionId,
          resumeSequence: sequence,
          workflowInstanceId,
          outcome: "resume_started",
        }), at),
      ]);
    } catch (error) {
      const replay = await first<ExecutionRow>(this.#db, `
        SELECT e.execution_id, e.request_id, e.workflow_instance_id, e.resume_sequence,
               e.status, e.initiated_by, e.resume_reason
          FROM admin_operation_audit a
          JOIN processing_executions e
            ON e.execution_id = json_extract(a.detail_json, '$.executionId')
         WHERE a.audit_id = ? AND a.entity_id = ?
      `, [auditId, requestId]);
      if (replay) return executionReceipt(replay);
      const message = error instanceof Error ? error.message : "";
      if (message.includes("p6_execution_conflict") || message.includes("UNIQUE constraint failed")) {
        throw processingError("publication_conflict", "Processing resume compare-and-set failed.");
      }
      throw error;
    }
    return executionReceipt((await first<ExecutionRow>(this.#db, "SELECT execution_id, request_id, workflow_instance_id, resume_sequence, status FROM processing_executions WHERE execution_id = ?", [executionId]))!);
  }

  async assertCurrentHead(requestId: string, generation: number): Promise<void> {
    const match = await first<{ readonly matched: number }>(this.#db, `
      SELECT 1 AS matched
        FROM processing_requests r
        JOIN processing_heads h
          ON h.aggregate_type = r.aggregate_type AND h.aggregate_id = r.aggregate_id
         AND h.head_request_id = r.request_id AND h.generation = r.generation
       WHERE r.request_id = ? AND r.generation = ? AND r.contract_version = 'p6-v1'
         AND r.superseded_by_request_id IS NULL AND r.cancel_requested_at IS NULL
         AND r.state NOT IN ('superseded', 'cancelled')
    `, [requestId, generation]);
    if (!match) throw await this.#headError(requestId, generation);
  }

  async claimMutationLease(command: ProcessingMutationLeaseCommand): Promise<void> {
    requireText(command.leaseToken, "Mutation lease token");
    const now = this.#now();
    const expiresAt = Date.parse(command.expiresAt);
    const startsAt = Date.parse(now);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(startsAt) || expiresAt - startsAt < 1_860_000) {
      throw processingError("invalid_input", "Mutation lease must cover the maximum operation timeout plus 60 seconds.");
    }
    const statement = this.#db.prepare(`
      UPDATE processing_heads
         SET mutation_owner_request_id = ?, mutation_lease_token = ?,
             mutation_lease_expires_at = ?, updated_at = ?
       WHERE head_request_id = ? AND generation = ?
         AND (mutation_lease_token IS NULL OR mutation_lease_expires_at <= ? OR
              (mutation_owner_request_id = ? AND mutation_lease_token = ?))
         AND NOT EXISTS (
           SELECT 1 FROM processing_stage_runs s
            WHERE s.request_id = processing_heads.mutation_owner_request_id
              AND s.status = 'side_effect_unknown'
         )
         AND EXISTS (
           SELECT 1 FROM processing_requests r
            WHERE r.request_id = processing_heads.head_request_id
              AND r.generation = processing_heads.generation
              AND r.superseded_by_request_id IS NULL AND r.cancel_requested_at IS NULL
              AND r.state NOT IN ('published', 'unpublished', 'archived', 'corpus_erased',
                                  'failed', 'retry_required', 'superseded', 'cancelled')
              AND NOT EXISTS (
                SELECT 1 FROM processing_stage_runs s
                 WHERE s.request_id = r.request_id AND s.status = 'side_effect_unknown'
              )
         )
    `).bind(command.requestId, command.leaseToken, command.expiresAt, now, command.requestId, command.generation, now, command.requestId, command.leaseToken);
    try {
      await batchOne(this.#db, statement, "lease_conflict", "Mutation lease compare-and-set failed.");
    } catch (error) {
      if (error instanceof ProcessingStateError && error.code === "lease_conflict") throw await this.#headError(command.requestId, command.generation, "lease_conflict");
      throw error;
    }
  }

  async releaseMutationLease(command: Omit<ProcessingMutationLeaseCommand, "expiresAt">): Promise<void> {
    const statement = this.#db.prepare(`
      UPDATE processing_heads
         SET mutation_owner_request_id = NULL, mutation_lease_token = NULL,
             mutation_lease_expires_at = NULL, updated_at = ?
       WHERE mutation_owner_request_id = ? AND mutation_lease_token = ?
         AND EXISTS (
           SELECT 1 FROM processing_requests r
            WHERE r.request_id = processing_heads.mutation_owner_request_id
              AND r.generation = ? AND r.contract_version = 'p6-v1'
              AND r.aggregate_type = processing_heads.aggregate_type
              AND r.aggregate_id = processing_heads.aggregate_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM processing_stage_runs s
            WHERE s.request_id = processing_heads.mutation_owner_request_id
              AND s.status = 'side_effect_unknown'
         )
    `).bind(this.#now(), command.requestId, command.leaseToken, command.generation);
    await batchOne(this.#db, statement, "lease_conflict", "Mutation lease release compare-and-set failed.");
  }

  async transition(command: ProcessingTransitionCommand): Promise<ProcessingStageReceipt> {
    const request = await this.#request(command.requestId);
    if (request.workflow_name !== command.workflow) throw processingError("identity_conflict", "Processing transition workflow does not match the immutable request.");
    assertProcessingTransition(command.workflow, request.operation, command.from, command.to);
    if (FINALIZATION_ONLY_STATES.has(command.to)) {
      throw processingError("invalid_state_transition", "Processing terminal publication and erasure states require guarded finalization.");
    }
    requireText(command.stageName, "Processing stage name");
    const batchOrdinal = command.batchOrdinal ?? 0;
    if (!Number.isSafeInteger(batchOrdinal) || batchOrdinal < 0) throw processingError("invalid_input", "Processing batch ordinal is invalid.");
    const existing = await first<StageRow>(this.#db, "SELECT request_id, stage_name, batch_ordinal, status, from_state, to_state, generation FROM processing_stage_runs WHERE request_id = ? AND stage_name = ? AND batch_ordinal = ?", [command.requestId, command.stageName, batchOrdinal]);
    const retryingFailedStage = existing?.status === "failed"
      && existing.to_state === "retry_required"
      && existing.generation === command.generation
      && existing.from_state === command.from
      && request.state === command.from;
    if (existing) {
      if (!retryingFailedStage) {
        if (existing.generation !== command.generation || existing.from_state !== command.from || existing.to_state !== command.to) throw processingError("identity_conflict", "Processing stage key identifies a different transition.");
        return { requestId: existing.request_id, stageName: existing.stage_name, batchOrdinal: existing.batch_ordinal, state: existing.to_state, status: existing.status, replayed: true };
      }
    }
    const at = this.#now();
    const errorMessage = sanitizeError(command.errorMessage);
    const defaultStatus = command.to === "failed" || command.to === "retry_required" ? "failed"
      : command.to === "superseded" ? "superseded"
        : command.to === "cancelled" ? "cancelled"
          : "complete";
    const status = command.stageStatus ?? defaultStatus;
    if (status === "side_effect_unknown" && command.to !== "retry_required") {
      throw processingError("invalid_input", "Unknown side effects must remain retry-required.");
    }
    const stageKey = `p6s:${command.requestId}:${command.stageName}:${batchOrdinal}`;
    const currentHeadPredicate = `
      SELECT 1 FROM processing_requests r
       JOIN processing_heads h
         ON h.aggregate_type = r.aggregate_type AND h.aggregate_id = r.aggregate_id
        AND h.head_request_id = r.request_id AND h.generation = r.generation
       WHERE r.request_id = ? AND r.generation = ? AND r.state = ?
         AND r.workflow_name = ? AND r.superseded_by_request_id IS NULL
         AND r.cancel_requested_at IS NULL
         AND (? IS NULL OR (h.mutation_owner_request_id = r.request_id AND
              h.mutation_lease_token = ? AND h.mutation_lease_expires_at > ?))
    `;
    const guardValues = [
      command.requestId,
      command.generation,
      command.from,
      command.workflow,
      command.mutationLeaseToken ?? null,
      command.mutationLeaseToken ?? null,
      at,
    ];
    const statement = retryingFailedStage
      ? this.#db.prepare(`
          UPDATE processing_stage_runs
             SET status = ?, to_state = ?, mutation_lease_token = ?,
                 attempt_count = attempt_count + 1, input_hash = ?, output_hash = ?,
                 side_effect_key = ?, provider = ?, model = ?, provider_mutation_id = ?,
                 retry_class = ?, error_code = ?, error_class = ?,
                 error_message = ?, completed_at = ?, updated_at = ?
           WHERE request_id = ? AND stage_name = ? AND batch_ordinal = ?
             AND generation = ? AND from_state = ?
             AND status = 'failed' AND to_state = 'retry_required'
             AND EXISTS (${currentHeadPredicate})
        `).bind(
          status, command.to, command.mutationLeaseToken ?? null,
          command.inputHash ?? null, command.outputHash ?? null,
          command.sideEffectKey ?? null, command.provider ?? null, command.model ?? null,
          command.providerMutationId ?? null, command.retryClass ?? null, command.errorCode ?? null,
          command.errorClass ?? null, errorMessage, at, at,
          command.requestId, command.stageName, batchOrdinal,
          command.generation, command.from, ...guardValues,
        )
      : this.#db.prepare(`
      INSERT INTO processing_stage_runs (
        stage_key, request_id, stage_name, batch_ordinal, status, from_state,
        to_state, generation, mutation_lease_token, attempt_count, input_hash,
        output_hash, side_effect_key, error_code, error_class, error_message,
        provider, model, provider_mutation_id, retry_class,
        created_at, completed_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         ${currentHeadPredicate}
       )
    `).bind(
      stageKey, command.requestId, command.stageName, batchOrdinal, status,
      command.from, command.to, command.generation, command.mutationLeaseToken ?? null,
      command.inputHash ?? null, command.outputHash ?? null, command.sideEffectKey ?? null,
      command.errorCode ?? null, command.errorClass ?? null, errorMessage,
      command.provider ?? null, command.model ?? null, command.providerMutationId ?? null,
      command.retryClass ?? null,
      at, at, at, ...guardValues,
    );
    try {
      await batchOne(this.#db, statement, "invalid_state_transition", "Processing transition compare-and-set failed.");
    } catch (error) {
      if (error instanceof ProcessingStateError && error.code === "invalid_state_transition") throw await this.#headError(command.requestId, command.generation, "invalid_state_transition");
      throw error;
    }
    return { requestId: command.requestId, stageName: command.stageName, batchOrdinal, state: command.to, status, replayed: false };
  }

  async recordVectorAcceptance(command: VectorAcceptanceCommand): Promise<void> {
    processingRevisionHash(command.expectedIdsDigest);
    processingRevisionHash(command.targetRevisionHash);
    requireText(command.providerMutationId, "Vector mutation ID");
    requireText(command.leaseToken, "Mutation lease token");
    if (!Number.isSafeInteger(command.batchOrdinal) || command.batchOrdinal < 0 || !Number.isSafeInteger(command.expectedCount) || command.expectedCount < 0 || command.expectedCount > 1_000) {
      throw processingError("invalid_input", "Vector batch bounds are invalid.");
    }
    const existing = await first<VectorBatchRow>(this.#db, "SELECT request_id, batch_ordinal, operation, generation, expected_ids_digest, expected_count, target_revision_hash, provider_mutation_id, visibility_state FROM processing_vector_batches WHERE request_id = ? AND batch_ordinal = ? AND operation = ?", [command.requestId, command.batchOrdinal, command.operation]);
    if (existing) {
      if (existing.generation === command.generation && existing.expected_ids_digest === command.expectedIdsDigest && existing.expected_count === command.expectedCount && existing.target_revision_hash === command.targetRevisionHash && existing.provider_mutation_id === command.providerMutationId) return;
      throw processingError("identity_conflict", "Vector batch identity conflicts with the stored acceptance.");
    }
    const at = this.#now();
    const visibility = command.operation === "upsert" ? "accepted" : "delete_accepted";
    const statement = this.#db.prepare(`
      INSERT INTO processing_vector_batches (
        request_id, batch_ordinal, operation, generation, expected_ids_digest,
        expected_count, target_revision_hash, provider_mutation_id,
        visibility_state, accepted_at, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM processing_requests r
          JOIN processing_heads h
            ON h.aggregate_type = r.aggregate_type AND h.aggregate_id = r.aggregate_id
           AND h.head_request_id = r.request_id AND h.generation = r.generation
          WHERE r.request_id = ? AND r.generation = ?
            AND r.revision_hash = ? AND r.superseded_by_request_id IS NULL
            AND r.cancel_requested_at IS NULL
            AND r.state NOT IN ('published', 'unpublished', 'archived', 'corpus_erased',
                                'failed', 'retry_required', 'superseded', 'cancelled')
            AND h.mutation_owner_request_id = r.request_id
            AND h.mutation_lease_token = ? AND h.mutation_lease_expires_at > ?
       )
    `).bind(command.requestId, command.batchOrdinal, command.operation, command.generation, command.expectedIdsDigest, command.expectedCount, command.targetRevisionHash, command.providerMutationId, visibility, at, at, at, command.requestId, command.generation, command.targetRevisionHash, command.leaseToken, at);
    try {
      await batchOne(this.#db, statement, "lease_conflict", "Vector acceptance compare-and-set failed.");
    } catch (error) {
      if (error instanceof ProcessingStateError && error.code === "lease_conflict") throw await this.#headError(command.requestId, command.generation, "lease_conflict");
      throw error;
    }
  }

  async recordVectorVisibility(command: VectorVisibilityCommand): Promise<void> {
    const target = command.operation === "upsert" ? "visible" : "deleted";
    const accepted = command.operation === "upsert" ? "accepted" : "delete_accepted";
    const current = await first<{ readonly visibility_state: string }>(this.#db, "SELECT visibility_state FROM processing_vector_batches WHERE request_id = ? AND batch_ordinal = ? AND operation = ?", [command.requestId, command.batchOrdinal, command.operation]);
    if (current?.visibility_state === target) return;
    const at = this.#now();
    const statement = this.#db.prepare(`
      UPDATE processing_vector_batches
         SET visibility_state = ?, poll_count = poll_count + 1,
             processed_up_to_mutation = ?, visible_at = ?, updated_at = ?
       WHERE request_id = ? AND batch_ordinal = ? AND operation = ?
         AND generation = ? AND visibility_state = ?
         AND EXISTS (
           SELECT 1 FROM processing_requests r
           JOIN processing_heads h
             ON h.aggregate_type = r.aggregate_type AND h.aggregate_id = r.aggregate_id
            AND h.head_request_id = r.request_id AND h.generation = r.generation
          WHERE r.request_id = processing_vector_batches.request_id
            AND r.generation = processing_vector_batches.generation
            AND r.superseded_by_request_id IS NULL AND r.cancel_requested_at IS NULL
            AND r.state NOT IN ('published', 'unpublished', 'archived', 'corpus_erased',
                                'failed', 'retry_required', 'superseded', 'cancelled')
            AND h.mutation_owner_request_id = r.request_id
            AND h.mutation_lease_token = ? AND h.mutation_lease_expires_at > ?
         )
    `).bind(target, command.processedUpToMutation ?? null, at, at, command.requestId, command.batchOrdinal, command.operation, command.generation, accepted, command.leaseToken, at);
    try {
      await batchOne(this.#db, statement, "lease_conflict", "Vector visibility compare-and-set failed.");
    } catch (error) {
      if (error instanceof ProcessingStateError && error.code === "lease_conflict") throw await this.#headError(command.requestId, command.generation, "lease_conflict");
      throw error;
    }
  }

  async finalizePublication(command: PublicationFinalizeCommand): Promise<void> {
    if (!Number.isSafeInteger(command.expectedVectorBatchCount) || command.expectedVectorBatchCount < 0) throw processingError("invalid_input", "Expected vector batch count is invalid.");
    const request = await this.#request(command.requestId);
    await this.assertCurrentHead(command.requestId, command.generation);
    if (command.to === "published" || command.to === "corpus_erased") {
      const batches = await first<{ readonly total: number; readonly incomplete: number }>(this.#db, `
        SELECT count(*) AS total,
               sum(CASE
                 WHEN ? = 'published' AND visibility_state IN ('visible', 'deleted') THEN 0
                 WHEN ? = 'corpus_erased' AND operation = 'delete' AND visibility_state = 'deleted' THEN 0
                 ELSE 1 END) AS incomplete
          FROM processing_vector_batches WHERE request_id = ?
      `, [command.to, command.to, command.requestId]);
      if (batches?.total !== command.expectedVectorBatchCount || (batches.incomplete ?? 0) !== 0) {
        throw processingError("visibility_pending", "Every required vector batch must be visible before publication.");
      }
      if (command.to === "published" && (request.state !== "publish_ready" || request.desired_publication !== "published")) {
        throw processingError("publication_conflict", "Processing request is not publish-ready.");
      }
      if (command.to === "corpus_erased" && (request.state !== "delete_visibility_pending" || request.operation !== "corpus_erase")) {
        throw processingError("publication_conflict", "Corpus erasure is not ready to finalize.");
      }
    } else {
      const expectedOperation = command.to === "unpublished" ? "public_unpublish" : "public_archive";
      if (request.state !== "public_hidden" || request.operation !== expectedOperation || command.expectedVectorBatchCount !== 0) {
        throw processingError("publication_conflict", "Public lifecycle request is not ready to finalize.");
      }
    }
    const at = this.#now();
    const statement = command.to === "published"
      ? this.#db.prepare(`
          UPDATE processing_heads
             SET published_request_id = ?, published_revision_hash = ?,
                 authenticated_corpus_request_id = ?, authenticated_corpus_revision_hash = ?,
                 public_visibility = 'visible', authenticated_corpus_visibility = 'visible',
                 desired_publication = 'published', updated_at = ?
           WHERE head_request_id = ? AND generation = ?
             AND (SELECT count(*) FROM processing_vector_batches b
                   WHERE b.request_id = processing_heads.head_request_id) = ?
             AND NOT EXISTS (
               SELECT 1 FROM processing_vector_batches b
                WHERE b.request_id = processing_heads.head_request_id
                  AND b.visibility_state NOT IN ('visible', 'deleted')
             )
             AND EXISTS (
               SELECT 1 FROM processing_requests r
                WHERE r.request_id = processing_heads.head_request_id
                  AND r.generation = processing_heads.generation
                  AND r.state = 'publish_ready' AND r.desired_publication = 'published'
                  AND r.cancel_requested_at IS NULL AND r.superseded_by_request_id IS NULL
             )
        `).bind(command.requestId, request.revision_hash, command.requestId, request.revision_hash, at, command.requestId, command.generation, command.expectedVectorBatchCount)
      : command.to === "corpus_erased"
        ? this.#db.prepare(`
          UPDATE processing_heads
             SET authenticated_corpus_request_id = NULL,
                 authenticated_corpus_revision_hash = NULL,
                 authenticated_corpus_visibility = 'erased', updated_at = ?
           WHERE head_request_id = ? AND generation = ?
             AND authenticated_corpus_visibility = 'hidden'
             AND (SELECT count(*) FROM processing_vector_batches b
                   WHERE b.request_id = processing_heads.head_request_id) = ?
             AND NOT EXISTS (
               SELECT 1 FROM processing_vector_batches b
                WHERE b.request_id = processing_heads.head_request_id
                  AND (b.operation != 'delete' OR b.visibility_state != 'deleted')
             )
             AND EXISTS (
               SELECT 1 FROM processing_requests r
                WHERE r.request_id = processing_heads.head_request_id
                  AND r.generation = processing_heads.generation
                  AND r.state = 'delete_visibility_pending' AND r.operation = 'corpus_erase'
                  AND r.cancel_requested_at IS NULL AND r.superseded_by_request_id IS NULL
             )
        `).bind(at, command.requestId, command.generation, command.expectedVectorBatchCount)
        : this.#db.prepare(`
          UPDATE processing_heads
             SET published_request_id = published_request_id,
                 published_revision_hash = published_revision_hash,
                 public_visibility = 'hidden', desired_publication = ?, updated_at = ?
           WHERE head_request_id = ? AND generation = ?
             AND EXISTS (
               SELECT 1 FROM processing_requests r
                WHERE r.request_id = processing_heads.head_request_id
                  AND r.generation = processing_heads.generation
                  AND r.state = 'public_hidden' AND r.operation = ?
                  AND r.cancel_requested_at IS NULL AND r.superseded_by_request_id IS NULL
             )
        `).bind(command.to, at, command.requestId, command.generation, command.to === "unpublished" ? "public_unpublish" : "public_archive");
    try {
      await batchOne(this.#db, statement, "publication_conflict", "Processing publication compare-and-set failed.");
    } catch (error) {
      if (error instanceof ProcessingStateError) throw error;
      throw processingError("publication_conflict", "Processing publication compare-and-set failed.");
    }
  }
}

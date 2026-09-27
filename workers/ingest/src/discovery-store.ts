import type { D1Database } from "@aic/db";

export type DiscoveryRunStatus = "starting" | "running" | "complete" | "failed";

export interface DiscoveryRunCounts {
  readonly seenCount: number;
  readonly newCount: number;
  readonly duplicateCount: number;
  readonly invalidCount: number;
  readonly dispatchedCount: number;
}

export interface DiscoveryRunReceipt extends DiscoveryRunCounts {
  readonly discoveryRunId: string;
  readonly sourceAdapter: string;
  readonly scheduledSlot: string;
  readonly scheduledUtcMinute: string;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly sourceValidator: string | null;
  readonly sourceCursor: string | null;
  readonly status: DiscoveryRunStatus;
  readonly errorMessage: string;
  readonly duplicateDelivery: boolean;
}

export interface BeginDiscoveryRunInput {
  readonly sourceAdapter: string;
  readonly scheduledSlot: string;
  readonly scheduledUtcMinute: string;
  readonly requestedAt: string;
  readonly requestedBy: string;
}

export interface DiscoveryProgressInput extends DiscoveryRunCounts {
  readonly discoveryRunId: string;
  readonly sourceCursor: string | null;
}

export interface PendingDiscoveryDispatch {
  readonly discoveryRunId: string;
  readonly requestId: string;
}

export interface DiscoveryRunStore {
  begin(input: BeginDiscoveryRunInput): Promise<DiscoveryRunReceipt>;
  recordProgress(input: DiscoveryProgressInput): Promise<DiscoveryRunReceipt>;
  listPriorRunIdsNeedingAccounting(discoveryRunId: string, limit: number): Promise<readonly string[]>;
  listPriorStartingDispatches(discoveryRunId: string, limit: number): Promise<readonly PendingDiscoveryDispatch[]>;
  listStartingRequestIds(discoveryRunId: string, limit: number): Promise<readonly string[]>;
  refreshDispatchedCount(discoveryRunId: string): Promise<DiscoveryRunReceipt>;
  complete(discoveryRunId: string, sourceValidator: string | null): Promise<DiscoveryRunReceipt>;
  fail(discoveryRunId: string, safeErrorMessage: string): Promise<void>;
}

export interface D1DiscoveryRunStoreOptions {
  readonly db: D1Database;
  readonly now?: () => string;
}

interface DiscoveryRunRow extends Record<string, unknown> {
  readonly discovery_run_id: string;
  readonly source_adapter: string;
  readonly scheduled_slot: string;
  readonly scheduled_utc_minute: string;
  readonly requested_at: string;
  readonly requested_by: string;
  readonly source_validator: string | null;
  readonly source_cursor: string | null;
  readonly seen_count: number;
  readonly new_count: number;
  readonly duplicate_count: number;
  readonly invalid_count: number;
  readonly dispatched_count: number;
  readonly status: DiscoveryRunStatus;
  readonly error_message: string;
}

interface AccountingCandidateRow extends Record<string, unknown> {
  readonly discovery_run_id: string;
  readonly status: "running" | "failed";
  readonly updated_at: string;
  readonly seen_count: number;
  readonly new_count: number;
  readonly duplicate_count: number;
  readonly invalid_count: number;
  readonly dispatched_count: number;
}

interface DurableDiscoveryCounts extends Record<string, unknown> {
  readonly request_count: number;
  readonly dispatched_count: number;
}

const RUN_COLUMNS = `
  discovery_run_id, source_adapter, scheduled_slot, scheduled_utc_minute,
  requested_at, requested_by, source_validator, source_cursor, seen_count,
  new_count, duplicate_count, invalid_count, dispatched_count, status,
  error_message`;

function requireText(value: string, name: string, max = 512): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.length > max
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) throw new TypeError(`${name} is invalid.`);
  return value;
}

function requireCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid.`);
  return value;
}

function monotonicTimestamp(current: string, candidate: string): string {
  const currentMs = Date.parse(current);
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(currentMs) || !Number.isFinite(candidateMs)) {
    throw new Error("Discovery accounting timestamp is invalid.");
  }
  return new Date(Math.max(currentMs + 1, candidateMs)).toISOString();
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function receipt(row: DiscoveryRunRow, duplicateDelivery: boolean): DiscoveryRunReceipt {
  return {
    discoveryRunId: row.discovery_run_id,
    sourceAdapter: row.source_adapter,
    scheduledSlot: row.scheduled_slot,
    scheduledUtcMinute: row.scheduled_utc_minute,
    requestedAt: row.requested_at,
    requestedBy: row.requested_by,
    sourceValidator: row.source_validator,
    sourceCursor: row.source_cursor,
    seenCount: row.seen_count,
    newCount: row.new_count,
    duplicateCount: row.duplicate_count,
    invalidCount: row.invalid_count,
    dispatchedCount: row.dispatched_count,
    status: row.status,
    errorMessage: row.error_message,
    duplicateDelivery,
  };
}

export class D1DiscoveryRunStore implements DiscoveryRunStore {
  readonly #db: D1Database;
  readonly #now: () => string;

  constructor(options: D1DiscoveryRunStoreOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async #get(discoveryRunId: string): Promise<DiscoveryRunRow> {
    const row = await this.#db.prepare(`
      SELECT ${RUN_COLUMNS}
        FROM processing_discovery_runs
       WHERE discovery_run_id = ?
    `).bind(discoveryRunId).first<DiscoveryRunRow>();
    if (!row) throw new Error("Discovery run was not found.");
    return row;
  }

  async #durableCounts(discoveryRunId: string): Promise<DurableDiscoveryCounts> {
    const counts = await this.#db.prepare(`
      SELECT count(*) AS request_count,
             coalesce(sum(CASE WHEN e.execution_id IS NOT NULL AND e.status <> 'starting' THEN 1 ELSE 0 END), 0) AS dispatched_count
        FROM processing_requests r
        LEFT JOIN processing_executions e
          ON e.request_id = r.request_id
         AND e.resume_sequence = 0
       WHERE r.requested_by = ?
    `).bind(`discovery:${discoveryRunId}`).first<DurableDiscoveryCounts>();
    if (
      !counts
      || !Number.isSafeInteger(counts.request_count)
      || counts.request_count < 0
      || !Number.isSafeInteger(counts.dispatched_count)
      || counts.dispatched_count < 0
      || counts.dispatched_count > counts.request_count
    ) throw new Error("Discovery durable count query failed.");
    return counts;
  }

  async #accountingCandidates(
    status: AccountingCandidateRow["status"],
    excludedRunId: string,
    limit: number,
  ): Promise<readonly AccountingCandidateRow[]> {
    const result = await this.#db.prepare(`
      SELECT discovery_run_id, status, updated_at, seen_count, new_count,
             duplicate_count, invalid_count, dispatched_count
        FROM processing_discovery_runs
       WHERE status = ? AND discovery_run_id <> ?
       ORDER BY updated_at ASC, discovery_run_id ASC
       LIMIT ?
    `).bind(status, excludedRunId, limit).all<AccountingCandidateRow>();
    if (result.success === false) throw new Error("Discovery accounting candidate query failed.");
    return result.results;
  }

  async #accountingCandidatesAfter(
    status: AccountingCandidateRow["status"],
    excludedRunId: string,
    after: AccountingCandidateRow,
    limit: number,
  ): Promise<readonly AccountingCandidateRow[]> {
    const result = await this.#db.prepare(`
      SELECT discovery_run_id, status, updated_at, seen_count, new_count,
             duplicate_count, invalid_count, dispatched_count
        FROM processing_discovery_runs
       WHERE status = ? AND discovery_run_id <> ?
         AND (updated_at > ? OR (updated_at = ? AND discovery_run_id > ?))
       ORDER BY updated_at ASC, discovery_run_id ASC
       LIMIT ?
    `).bind(
      status,
      excludedRunId,
      after.updated_at,
      after.updated_at,
      after.discovery_run_id,
      limit,
    ).all<AccountingCandidateRow>();
    if (result.success === false) throw new Error("Discovery accounting continuation query failed.");
    return result.results;
  }

  async #advanceAccountingCandidate(candidate: AccountingCandidateRow): Promise<void> {
    const result = await this.#db.prepare(`
      UPDATE processing_discovery_runs
         SET updated_at = ?
       WHERE discovery_run_id = ? AND status = ? AND updated_at = ?
    `).bind(
      monotonicTimestamp(candidate.updated_at, this.#now()),
      candidate.discovery_run_id,
      candidate.status,
      candidate.updated_at,
    ).run();
    const changes = result.meta?.changes;
    if (result.success !== true || !Number.isSafeInteger(changes) || (changes !== 0 && changes !== 1)) {
      throw new Error("Discovery accounting candidate advance failed.");
    }
  }

  async begin(input: BeginDiscoveryRunInput): Promise<DiscoveryRunReceipt> {
    const sourceAdapter = requireText(input.sourceAdapter, "Discovery source adapter", 128);
    const scheduledSlot = requireText(input.scheduledSlot, "Discovery scheduled slot");
    const scheduledUtcMinute = requireText(input.scheduledUtcMinute, "Discovery scheduled UTC minute", 64);
    const requestedAt = requireText(input.requestedAt, "Discovery requested time", 64);
    const requestedBy = requireText(input.requestedBy, "Discovery requester", 256);
    const discoveryRunId = `p6d-${await digest(`${sourceAdapter}\0${scheduledSlot}`)}`;

    const existing = await this.#db.prepare(`
      SELECT ${RUN_COLUMNS}
        FROM processing_discovery_runs
       WHERE source_adapter = ? AND scheduled_slot = ?
    `).bind(sourceAdapter, scheduledSlot).first<DiscoveryRunRow>();
    if (existing) {
      if (existing.status === "complete" || existing.status === "running") return receipt(existing, true);
      const at = this.#now();
      const claim = await this.#db.prepare(`
        UPDATE processing_discovery_runs
           SET status = 'running', error_message = '', updated_at = ?
         WHERE discovery_run_id = ? AND status = ?
      `).bind(at, existing.discovery_run_id, existing.status).run();
      if (claim.success !== true) throw new Error("Discovery run reclaim failed.");
      if (claim.meta?.changes === 1) return receipt(await this.#get(existing.discovery_run_id), false);
      return receipt(await this.#get(existing.discovery_run_id), true);
    }

    const previous = await this.#db.prepare(`
      SELECT source_validator, source_cursor
        FROM processing_discovery_runs
       WHERE source_adapter = ? AND status = 'complete'
       ORDER BY scheduled_utc_minute DESC, discovery_run_id DESC
       LIMIT 1
    `).bind(sourceAdapter).first<{ readonly source_validator: string | null; readonly source_cursor: string | null }>();
    const at = this.#now();
    try {
      const result = await this.#db.prepare(`
        INSERT INTO processing_discovery_runs (
          discovery_run_id, source_adapter, scheduled_slot,
          scheduled_utc_minute, requested_at, requested_by, source_validator,
          source_cursor, seen_count, new_count, duplicate_count, invalid_count,
          dispatched_count, status, error_message, created_at, completed_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 'running', '', ?, NULL, ?)
      `).bind(
        discoveryRunId,
        sourceAdapter,
        scheduledSlot,
        scheduledUtcMinute,
        requestedAt,
        requestedBy,
        previous?.source_validator ?? null,
        previous?.source_cursor ?? null,
        at,
        at,
      ).run();
      if (result.success !== true || result.meta?.changes !== 1) throw new Error("Discovery run allocation failed.");
    } catch (error) {
      const replay = await this.#db.prepare(`
        SELECT ${RUN_COLUMNS}
          FROM processing_discovery_runs
         WHERE source_adapter = ? AND scheduled_slot = ?
      `).bind(sourceAdapter, scheduledSlot).first<DiscoveryRunRow>();
      if (replay) return receipt(replay, replay.status === "complete" || replay.status === "running");
      throw error;
    }
    return receipt(await this.#get(discoveryRunId), false);
  }

  async recordProgress(input: DiscoveryProgressInput): Promise<DiscoveryRunReceipt> {
    const discoveryRunId = requireText(input.discoveryRunId, "Discovery run ID");
    const seenCount = requireCount(input.seenCount, "Discovery seen count");
    const newCount = requireCount(input.newCount, "Discovery new count");
    const duplicateCount = requireCount(input.duplicateCount, "Discovery duplicate count");
    const invalidCount = requireCount(input.invalidCount, "Discovery invalid count");
    const dispatchedCount = requireCount(input.dispatchedCount, "Discovery dispatched count");
    if (seenCount !== newCount + duplicateCount + invalidCount || dispatchedCount > newCount) {
      throw new TypeError("Discovery progress counts are inconsistent.");
    }
    if (input.sourceCursor !== null) requireText(input.sourceCursor, "Discovery source cursor", 1_024);
    const result = await this.#db.prepare(`
      UPDATE processing_discovery_runs
         SET source_cursor = ?, seen_count = ?, new_count = ?,
             duplicate_count = ?, invalid_count = ?, dispatched_count = ?,
             updated_at = ?
       WHERE discovery_run_id = ? AND status = 'running'
    `).bind(
      input.sourceCursor,
      seenCount,
      newCount,
      duplicateCount,
      invalidCount,
      dispatchedCount,
      this.#now(),
      discoveryRunId,
    ).run();
    if (result.success !== true || result.meta?.changes !== 1) throw new Error("Discovery progress compare-and-set failed.");
    return receipt(await this.#get(discoveryRunId), false);
  }

  async listStartingRequestIds(discoveryRunId: string, limit: number): Promise<readonly string[]> {
    requireText(discoveryRunId, "Discovery run ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Discovery reconciliation limit is invalid.");
    const owner = `discovery:${discoveryRunId}`;
    const result = await this.#db.prepare(`
      SELECT r.request_id
        FROM processing_requests r
        LEFT JOIN processing_executions e
          ON e.request_id = r.request_id
         AND e.resume_sequence = 0
        JOIN processing_heads h
          ON h.aggregate_type = r.aggregate_type
         AND h.aggregate_id = r.aggregate_id
         AND h.head_request_id = r.request_id
         AND h.generation = r.generation
       WHERE r.requested_by = ?
         AND ((r.current_execution_id IS NULL AND e.execution_id IS NULL)
           OR (r.current_execution_id = e.execution_id AND e.status = 'starting'))
         AND r.superseded_by_request_id IS NULL
         AND r.cancel_requested_at IS NULL
         AND r.state NOT IN ('superseded', 'cancelled')
       ORDER BY r.created_at ASC, r.request_id ASC
       LIMIT ?
    `).bind(owner, limit).all<{ readonly request_id: string }>();
    if (result.success === false) throw new Error("Discovery starting execution query failed.");
    return result.results.map((row) => row.request_id);
  }

  async listPriorRunIdsNeedingAccounting(discoveryRunId: string, limit: number): Promise<readonly string[]> {
    requireText(discoveryRunId, "Discovery run ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Discovery accounting limit is invalid.");
    const failed = await this.#accountingCandidates("failed", discoveryRunId, limit);
    const running = await this.#accountingCandidates("running", discoveryRunId, limit);
    const candidates = [...failed, ...running];
    const capacity = limit * 2 - candidates.length;
    if (capacity > 0 && failed.length === limit && running.length < limit) {
      candidates.push(...await this.#accountingCandidatesAfter(
        "failed",
        discoveryRunId,
        failed[failed.length - 1]!,
        capacity,
      ));
    } else if (capacity > 0 && running.length === limit && failed.length < limit) {
      candidates.push(...await this.#accountingCandidatesAfter(
        "running",
        discoveryRunId,
        running[running.length - 1]!,
        capacity,
      ));
    }
    candidates.sort((left, right) => left.updated_at.localeCompare(right.updated_at)
      || left.discovery_run_id.localeCompare(right.discovery_run_id));
    const mismatches: string[] = [];
    for (const candidate of candidates) {
      const durable = await this.#durableCounts(candidate.discovery_run_id);
      const expectedNew = Math.max(candidate.new_count, durable.request_count);
      const expectedSeen = candidate.duplicate_count + candidate.invalid_count + expectedNew;
      if (
        candidate.new_count < durable.request_count
        || candidate.seen_count !== expectedSeen
        || candidate.dispatched_count !== durable.dispatched_count
      ) {
        if (mismatches.length < limit) mismatches.push(candidate.discovery_run_id);
      } else {
        await this.#advanceAccountingCandidate(candidate);
      }
    }
    return mismatches;
  }

  async listPriorStartingDispatches(discoveryRunId: string, limit: number): Promise<readonly PendingDiscoveryDispatch[]> {
    requireText(discoveryRunId, "Discovery run ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Discovery reconciliation limit is invalid.");
    const excludedOwner = `discovery:${discoveryRunId}`;
    const result = await this.#db.prepare(`
      SELECT r.requested_by, r.request_id
        FROM processing_requests r
        LEFT JOIN processing_executions e
          ON e.request_id = r.request_id
         AND e.resume_sequence = 0
        JOIN processing_heads h
          ON h.aggregate_type = r.aggregate_type
         AND h.aggregate_id = r.aggregate_id
         AND h.head_request_id = r.request_id
         AND h.generation = r.generation
       WHERE r.requested_by LIKE 'discovery:p6d-%'
         AND r.requested_by <> ?
         AND ((r.current_execution_id IS NULL AND e.execution_id IS NULL)
           OR (r.current_execution_id = e.execution_id AND e.status = 'starting'))
         AND r.superseded_by_request_id IS NULL
         AND r.cancel_requested_at IS NULL
         AND r.state NOT IN ('superseded', 'cancelled')
       ORDER BY r.created_at ASC, r.request_id ASC
       LIMIT ?
    `).bind(excludedOwner, limit).all<{ readonly requested_by: string; readonly request_id: string }>();
    if (result.success === false) throw new Error("Prior discovery execution query failed.");
    return result.results.map((row) => {
      const ownerPrefix = "discovery:";
      if (!row.requested_by.startsWith(ownerPrefix)) throw new Error("Prior discovery execution owner is invalid.");
      return {
        discoveryRunId: row.requested_by.slice(ownerPrefix.length),
        requestId: row.request_id,
      };
    });
  }

  async refreshDispatchedCount(discoveryRunId: string): Promise<DiscoveryRunReceipt> {
    requireText(discoveryRunId, "Discovery run ID");
    const counts = await this.#durableCounts(discoveryRunId);
    const result = await this.#db.prepare(`
      UPDATE processing_discovery_runs
         SET new_count = max(new_count, ?),
             seen_count = duplicate_count + invalid_count + max(new_count, ?),
             dispatched_count = ?, updated_at = ?
       WHERE discovery_run_id = ? AND status IN ('running', 'failed')
    `).bind(
      counts.request_count,
      counts.request_count,
      counts.dispatched_count,
      this.#now(),
      discoveryRunId,
    ).run();
    if (result.success !== true || result.meta?.changes !== 1) throw new Error("Discovery durable count update failed.");
    return receipt(await this.#get(discoveryRunId), false);
  }

  async complete(discoveryRunId: string, sourceValidator: string | null): Promise<DiscoveryRunReceipt> {
    requireText(discoveryRunId, "Discovery run ID");
    if (sourceValidator !== null) requireText(sourceValidator, "Discovery source validator", 2_000);
    const at = this.#now();
    const result = await this.#db.prepare(`
      UPDATE processing_discovery_runs
         SET source_validator = ?, status = 'complete', error_message = '',
             completed_at = ?, updated_at = ?
       WHERE discovery_run_id = ? AND status = 'running'
    `).bind(sourceValidator, at, at, discoveryRunId).run();
    if (result.success !== true || result.meta?.changes !== 1) throw new Error("Discovery completion compare-and-set failed.");
    return receipt(await this.#get(discoveryRunId), false);
  }

  async fail(discoveryRunId: string, safeErrorMessage: string): Promise<void> {
    requireText(discoveryRunId, "Discovery run ID");
    const sanitized = Array.from(safeErrorMessage.replace(/[\u0000-\u001F\u007F]/gu, " ")).slice(0, 2_000).join("");
    const result = await this.#db.prepare(`
      UPDATE processing_discovery_runs
         SET status = 'failed', error_message = ?, updated_at = ?
       WHERE discovery_run_id = ? AND status IN ('starting', 'running', 'failed')
    `).bind(sanitized, this.#now(), discoveryRunId).run();
    if (result.success !== true || result.meta?.changes !== 1) throw new Error("Discovery failure recording failed.");
  }
}

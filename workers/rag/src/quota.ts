import type { D1Database } from "../../../packages/db/src/index.ts";
import type { RequestOperationContext } from "../../../packages/contracts/src/index.ts";
import type { RagQuota } from "./worker.ts";

const WINDOW_MS = 60_000;
const WINDOW_LIMIT = 60;

export interface D1RagQuotaOptions {
  readonly db: D1Database;
  readonly now?: () => number;
}

function active(context: RequestOperationContext): void {
  if (context.signal.aborted) throw context.signal.reason ?? new Error("cancelled");
}

function userId(value: string): string {
  if (!value || value !== value.trim() || value.includes("\0") || new TextEncoder().encode(value).byteLength > 512) {
    throw new Error("invalid quota user");
  }
  return value;
}

export class D1RagQuota implements RagQuota {
  readonly #db: D1Database;
  readonly #now: () => number;

  constructor(options: D1RagQuotaOptions) {
    this.#db = options.db;
    this.#now = options.now ?? Date.now;
  }

  async consume(context: RequestOperationContext, rawUserId: string): Promise<{ readonly allowed: boolean; readonly retryAfterSeconds: number }> {
    active(context);
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid quota clock");
    const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const row = await this.#db.prepare(`
      INSERT INTO rag_rate_windows (user_id, window_start_ms, count)
      VALUES (?, ?, 1)
      ON CONFLICT(user_id, window_start_ms) DO UPDATE
        SET count = count + 1
        WHERE count < 60
      RETURNING count`).bind(userId(rawUserId), windowStart).first<{ readonly count: unknown }>();
    active(context);
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1_000));
    if (row === null) return { allowed: false, retryAfterSeconds };
    if (!Number.isSafeInteger(row.count) || (row.count as number) < 1 || (row.count as number) > WINDOW_LIMIT) {
      throw new Error("invalid quota result");
    }
    return { allowed: true, retryAfterSeconds };
  }

  async pruneExpired(
    context: RequestOperationContext,
    options: { readonly retentionMs: number; readonly limit: number },
  ): Promise<number> {
    active(context);
    if (!Number.isSafeInteger(options.retentionMs) || options.retentionMs < WINDOW_MS) throw new Error("invalid quota retention");
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_000) throw new Error("invalid quota prune limit");
    const threshold = this.#now() - options.retentionMs;
    const result = await this.#db.prepare(`
      DELETE FROM rag_rate_windows
       WHERE (user_id, window_start_ms) IN (
         SELECT user_id, window_start_ms
           FROM rag_rate_windows
          WHERE window_start_ms < ?
          ORDER BY window_start_ms, user_id
          LIMIT ?
       )`).bind(threshold, options.limit).run();
    active(context);
    if (!result || result.success !== true || !Number.isSafeInteger(result.meta?.changes)) throw new Error("invalid quota prune result");
    return result.meta!.changes!;
  }
}

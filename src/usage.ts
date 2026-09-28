/**
 * Counts metered actions (questions, semantic searches) in the login_attempts
 * table, which is already a generic bucket-and-timestamp log.
 */
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export async function usedSince(db: D1Database, bucket: string, since: number): Promise<number> {
  const row = await db.prepare("SELECT count(*) AS n FROM login_attempts WHERE bucket = ? AND attempted_at > ?").bind(bucket, since).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function recordUse(db: D1Database, buckets: readonly string[], now = Date.now()): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM login_attempts WHERE attempted_at < ?").bind(now - DAY_MS),
    ...buckets.map((bucket) => db.prepare("INSERT INTO login_attempts (bucket, attempted_at) VALUES (?, ?)").bind(bucket, now)),
  ]);
}

/** Midnight UTC today, so the daily cap resets at a predictable time. */
export function startOfUtcDay(now = Date.now()): number {
  return now - (now % DAY_MS);
}

export { HOUR_MS };

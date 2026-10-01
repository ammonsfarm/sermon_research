import type { AppEnv } from "./env.ts";
import type { Feed, FeedEpisode } from "./feed.ts";
import { getSetting } from "./settings.ts";

export type EpisodeStatus = "not_imported" | "queued" | "running" | "done" | "failed";
export type EpisodeStage = "transcribe" | "summarize" | "index";

export interface EpisodeRow {
  readonly id: string;
  readonly guid: string;
  readonly title: string;
  readonly published_at: string | null;
  readonly audio_url: string | null;
  readonly duration_seconds: number | null;
  readonly status: EpisodeStatus;
  readonly stage: EpisodeStage | null;
  readonly attempts: number;
  readonly error: string | null;
  readonly detail: string | null;
  readonly last_error: string | null;
  readonly audio_bytes: number | null;
  readonly speaker: string | null;
  readonly updated_at: string;
}

/** Episodes processed at once unless an admin changes it. Free provider tiers often allow only one or two. */
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 5;

export interface ProcessingSettings {
  readonly concurrency: number;
}

export async function concurrency(db: D1Database): Promise<number> {
  const value = (await getSetting<ProcessingSettings>(db, "processing"))?.concurrency;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CONCURRENCY ? value : DEFAULT_CONCURRENCY;
}
/** A run still marked running after this long is treated as lost and marked failed. */
const STALE_RUN_MS = 6 * 3_600_000;

function newestFirst(episodes: readonly FeedEpisode[]): FeedEpisode[] {
  return [...episodes].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
}

/**
 * Records feed episodes we haven't seen. On the first import only the newest
 * `backfill` episodes are queued; later, every new episode is queued.
 * Episodes already recorded get the feed's current description and author.
 * Returns how many episodes were queued.
 */
export async function recordFeed(db: D1Database, feed: Feed, options: { backfill?: number } = {}): Promise<number> {
  const known = await db.prepare("SELECT count(*) AS n FROM episodes").first<{ n: number }>();
  const firstImport = (known?.n ?? 0) === 0 && options.backfill !== undefined;
  const now = new Date().toISOString();
  const rows = newestFirst(feed.episodes).filter((episode) => episode.audioUrl).map((episode, index) => ({
    episode,
    status: (firstImport && index >= (options.backfill ?? 0) ? "not_imported" : "queued") as EpisodeStatus,
  }));
  let queued = 0;
  for (let start = 0; start < rows.length; start += 50) {
    const batch = rows.slice(start, start + 50);
    const results = await db.batch([
      ...batch.map(({ episode, status }) => db.prepare(
        `INSERT INTO episodes (id, guid, title, published_at, audio_url, duration_seconds, status, created_at, updated_at, description, author)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(guid) DO NOTHING`,
      ).bind(crypto.randomUUID(), episode.guid, episode.title, episode.publishedAt, episode.audioUrl, episode.durationSeconds, status, now, now, episode.description, episode.author)),
      ...batch.map(({ episode }) => db.prepare("UPDATE episodes SET description = ?1, author = ?2 WHERE guid = ?3 AND (description IS NOT ?1 OR author IS NOT ?2)")
        .bind(episode.description, episode.author, episode.guid)),
    ]);
    results.slice(0, batch.length).forEach((result, offset) => {
      if (result.meta.changes === 1 && batch[offset]?.status === "queued") queued += 1;
    });
  }
  return queued;
}

/** Moves episodes back into the queue: failed ones to retry, not-imported ones to import. */
export async function queueEpisodes(db: D1Database, ids: readonly string[]): Promise<void> {
  const now = new Date().toISOString();
  await db.batch(ids.map((id) => db.prepare(
    "UPDATE episodes SET status = 'queued', stage = NULL, detail = NULL, last_error = NULL, error = NULL, updated_at = ? WHERE id = ? AND status IN ('failed', 'not_imported')",
  ).bind(now, id)));
}

export async function queueAllFailed(db: D1Database): Promise<number> {
  const result = await db.prepare("UPDATE episodes SET status = 'queued', stage = NULL, detail = NULL, last_error = NULL, error = NULL, updated_at = ? WHERE status = 'failed'")
    .bind(new Date().toISOString()).run();
  return result.meta.changes;
}

export async function queueAllNotImported(db: D1Database): Promise<number> {
  const result = await db.prepare("UPDATE episodes SET status = 'queued', updated_at = ? WHERE status = 'not_imported'").bind(new Date().toISOString()).run();
  return result.meta.changes;
}

/**
 * Starts workflow runs for queued episodes, newest first, up to the concurrency setting at
 * once. Each run starts the next when it finishes; the hourly tick also calls
 * this, so a lost hand-off only delays work.
 */
export async function dispatchQueued(env: AppEnv, now = Date.now()): Promise<number> {
  const db = env.DB;
  await db.prepare(
    "UPDATE episodes SET status = 'failed', stage = NULL, detail = NULL, error = COALESCE('The run stopped reporting progress. Last error: ' || last_error, 'The run stopped reporting progress. Retry it.'), last_error = NULL, updated_at = ? WHERE status = 'running' AND updated_at < ?",
  ).bind(new Date(now).toISOString(), new Date(now - STALE_RUN_MS).toISOString()).run();
  const running = await db.prepare("SELECT count(*) AS n FROM episodes WHERE status = 'running'").first<{ n: number }>();
  const slots = (await concurrency(db)) - (running?.n ?? 0);
  if (slots <= 0) return 0;
  const { results } = await db.prepare(
    "SELECT id, attempts FROM episodes WHERE status = 'queued' ORDER BY published_at DESC, created_at DESC LIMIT ?",
  ).bind(slots).all<{ id: string; attempts: number }>();
  let started = 0;
  for (const episode of results) {
    const attempt = episode.attempts + 1;
    const claimed = await db.prepare(
      "UPDATE episodes SET status = 'running', stage = 'transcribe', detail = 'Starting', last_error = NULL, attempts = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'",
    ).bind(attempt, new Date(now).toISOString(), episode.id).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      await env.EPISODE_WORKFLOW.create({ id: `${episode.id}-${attempt}`, params: { episodeId: episode.id } });
      started += 1;
    } catch (error) {
      console.error("could not start episode workflow", episode.id, error);
      await db.prepare("UPDATE episodes SET status = 'queued', stage = NULL, detail = NULL, updated_at = ? WHERE id = ?").bind(new Date(now).toISOString(), episode.id).run();
      break;
    }
  }
  return started;
}

export async function statusCounts(db: D1Database): Promise<Record<EpisodeStatus, number>> {
  const counts: Record<EpisodeStatus, number> = { not_imported: 0, queued: 0, running: 0, done: 0, failed: 0 };
  const { results } = await db.prepare("SELECT status, count(*) AS n FROM episodes GROUP BY status").all<{ status: EpisodeStatus; n: number }>();
  for (const row of results) counts[row.status] = row.n;
  return counts;
}

export async function listEpisodes(db: D1Database, limit = 200): Promise<EpisodeRow[]> {
  const { results } = await db.prepare(
    `SELECT id, guid, title, published_at, audio_url, duration_seconds, status, stage, attempts, error, detail, last_error, audio_bytes, speaker, updated_at
     FROM episodes ORDER BY published_at DESC, created_at DESC LIMIT ?`,
  ).bind(limit).all<EpisodeRow>();
  return results;
}

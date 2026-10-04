import type { AppEnv } from "./env.ts";
import type { Feed, FeedEpisode } from "./feed.ts";
import { getSetting } from "./settings.ts";

export type EpisodeStatus = "not_imported" | "queued" | "running" | "done" | "failed";
export type EpisodeStage = "transcribe" | "summarize" | "index";

/**
 * What an admin can redo for a finished episode, in pipeline order: the
 * transcript from the audio, its rewrite (names, punctuation, capitals), the
 * summary, and the search passages. Redoing one redoes those after it, since
 * each is made from the one before.
 */
export const REDO_STEPS = ["transcribe", "rewrite", "summary", "index"] as const;
export type RedoStep = (typeof REDO_STEPS)[number];

export const REDO_LABELS: Record<RedoStep, string> = {
  transcribe: "Transcript, from the audio",
  rewrite: "Transcript rewrite (grammar, names, capitals)",
  summary: "Summary",
  index: "Search vectors",
};

export function isRedoStep(value: unknown): value is RedoStep {
  return REDO_STEPS.includes(value as RedoStep);
}

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
  /** Set while an admin's re-processing is waiting, running or failed; the episode stays 'done'. */
  readonly redo: RedoStep | null;
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
/** Queues failed and not-imported episodes, and retries failed re-processing. */
export async function queueEpisodes(db: D1Database, ids: readonly string[]): Promise<void> {
  const now = new Date().toISOString();
  await db.batch(ids.flatMap((id) => [
    db.prepare("UPDATE episodes SET status = 'queued', stage = NULL, detail = NULL, last_error = NULL, error = NULL, updated_at = ? WHERE id = ? AND status IN ('failed', 'not_imported')").bind(now, id),
    db.prepare(`UPDATE episodes SET last_error = NULL, error = NULL, updated_at = ? WHERE id = ? AND ${REDO_FAILED}`).bind(now, id),
  ]));
}

export async function queueAllFailed(db: D1Database): Promise<number> {
  const now = new Date().toISOString();
  const [failed, redo] = await db.batch([
    db.prepare("UPDATE episodes SET status = 'queued', stage = NULL, detail = NULL, last_error = NULL, error = NULL, updated_at = ? WHERE status = 'failed'").bind(now),
    db.prepare(`UPDATE episodes SET last_error = NULL, error = NULL, updated_at = ? WHERE ${REDO_FAILED}`).bind(now),
  ]);
  return (failed?.meta.changes ?? 0) + (redo?.meta.changes ?? 0);
}

// Re-processing keeps status 'done', so these tell its states apart.
const REDO_RUNNING = "status = 'done' AND redo IS NOT NULL AND stage IS NOT NULL";
const REDO_WAITING = "status = 'done' AND redo IS NOT NULL AND stage IS NULL AND error IS NULL";
const REDO_FAILED = "status = 'done' AND redo IS NOT NULL AND stage IS NULL AND error IS NOT NULL";

/**
 * Asks for a finished episode to be redone from `step`. The sermon stays up
 * with its current transcript, summary and passages, each replaced only once
 * its new version is ready. A request while one is waiting or failed keeps the
 * earlier of the two steps. Returns false when the episode isn't finished or
 * is being re-processed right now.
 */
export async function requestRedo(db: D1Database, id: string, step: RedoStep): Promise<boolean> {
  const row = await db.prepare("SELECT status, stage, redo FROM episodes WHERE id = ?").bind(id).first<{ status: EpisodeStatus; stage: string | null; redo: RedoStep | null }>();
  if (row?.status !== "done" || row.stage !== null) return false;
  const from = row.redo && REDO_STEPS.indexOf(row.redo) < REDO_STEPS.indexOf(step) ? row.redo : step;
  const statements = from === "rewrite" ? [
    // Sermons transcribed before drafts were kept are rewritten from their current transcript.
    db.prepare("INSERT OR IGNORE INTO transcripts_draft (episode_id, text, segments_json, model, created_at) SELECT episode_id, text, segments_json, model, created_at FROM transcripts WHERE episode_id = ?").bind(id),
    // Start the rewrite over rather than carrying on from the last one's saved progress.
    db.prepare("UPDATE transcripts_draft SET cleaned_json = NULL WHERE episode_id = ?").bind(id),
  ] : [];
  const results = await db.batch([
    ...statements,
    db.prepare("UPDATE episodes SET redo = ?, error = NULL, last_error = NULL, detail = NULL, updated_at = ? WHERE id = ? AND status = 'done' AND stage IS NULL").bind(from, new Date().toISOString(), id),
  ]);
  return results.at(-1)?.meta.changes === 1;
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
  const at = new Date(now).toISOString();
  const staleBefore = new Date(now - STALE_RUN_MS).toISOString();
  await db.batch([
    db.prepare(
      "UPDATE episodes SET status = 'failed', stage = NULL, detail = NULL, error = COALESCE('The run stopped reporting progress. Last error: ' || last_error, 'The run stopped reporting progress. Retry it.'), last_error = NULL, updated_at = ? WHERE status = 'running' AND updated_at < ?",
    ).bind(at, staleBefore),
    db.prepare(
      `UPDATE episodes SET stage = NULL, detail = NULL, error = COALESCE('Re-processing stopped reporting progress. Last error: ' || last_error, 'Re-processing stopped reporting progress. Retry it.'), last_error = NULL, updated_at = ? WHERE ${REDO_RUNNING} AND updated_at < ?`,
    ).bind(at, staleBefore),
  ]);
  const running = await db.prepare(`SELECT count(*) AS n FROM episodes WHERE status = 'running' OR (${REDO_RUNNING})`).first<{ n: number }>();
  const slots = (await concurrency(db)) - (running?.n ?? 0);
  if (slots <= 0) return 0;
  // An admin's re-processing goes ahead of the queue.
  const { results } = await db.prepare(
    `SELECT id, attempts, status FROM episodes WHERE status = 'queued' OR (${REDO_WAITING}) ORDER BY status = 'done' DESC, published_at DESC, created_at DESC LIMIT ?`,
  ).bind(slots).all<{ id: string; attempts: number; status: EpisodeStatus }>();
  let started = 0;
  for (const episode of results) {
    const attempt = episode.attempts + 1;
    const redo = episode.status === "done";
    const claimed = await db.prepare(redo
      ? `UPDATE episodes SET stage = 'transcribe', detail = 'Starting', last_error = NULL, attempts = ?, updated_at = ? WHERE id = ? AND ${REDO_WAITING}`
      : "UPDATE episodes SET status = 'running', stage = 'transcribe', detail = 'Starting', last_error = NULL, attempts = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'",
    ).bind(attempt, at, episode.id).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      await env.EPISODE_WORKFLOW.create({ id: `${episode.id}-${attempt}`, params: { episodeId: episode.id } });
      started += 1;
    } catch (error) {
      console.error("could not start episode workflow", episode.id, error);
      await db.prepare(redo
        ? "UPDATE episodes SET stage = NULL, detail = NULL, updated_at = ? WHERE id = ?"
        : "UPDATE episodes SET status = 'queued', stage = NULL, detail = NULL, updated_at = ? WHERE id = ?").bind(at, episode.id).run();
      break;
    }
  }
  return started;
}

export interface StatusCounts extends Record<EpisodeStatus, number> {
  /** Finished episodes being re-processed, waiting to be, or whose re-processing failed. */
  readonly redo: { readonly running: number; readonly waiting: number; readonly failed: number };
}

export async function statusCounts(db: D1Database): Promise<StatusCounts> {
  const counts: Record<EpisodeStatus, number> = { not_imported: 0, queued: 0, running: 0, done: 0, failed: 0 };
  const [{ results }, redo] = await Promise.all([
    db.prepare("SELECT status, count(*) AS n FROM episodes GROUP BY status").all<{ status: EpisodeStatus; n: number }>(),
    db.prepare(`SELECT count(*) FILTER (WHERE ${REDO_RUNNING}) AS running, count(*) FILTER (WHERE ${REDO_WAITING}) AS waiting, count(*) FILTER (WHERE ${REDO_FAILED}) AS failed FROM episodes`)
      .first<{ running: number; waiting: number; failed: number }>(),
  ]);
  for (const row of results) counts[row.status] = row.n;
  return { ...counts, redo: { running: redo?.running ?? 0, waiting: redo?.waiting ?? 0, failed: redo?.failed ?? 0 } };
}

/** What the episode list can be narrowed to. Re-processing is its own choice, since those episodes stay 'done'. */
export const EPISODE_FILTERS = {
  all: "All", done: "Done", running: "Working", queued: "Waiting", failed: "Failed", not_imported: "Not imported", reprocessing: "Re-processing",
} as const;
export type EpisodeFilter = keyof typeof EPISODE_FILTERS;

export function isEpisodeFilter(value: unknown): value is EpisodeFilter {
  return typeof value === "string" && Object.hasOwn(EPISODE_FILTERS, value);
}

export interface EpisodeQuery {
  /** Matches the title (which ends with the series), the speaker, or the start of the date, like 2024-10. */
  readonly q: string;
  readonly status: EpisodeFilter;
  /** From 1. */
  readonly page: number;
}

export const EPISODES_PER_PAGE = 200;

export async function listEpisodes(db: D1Database, query: EpisodeQuery = { q: "", status: "all", page: 1 }, perPage = EPISODES_PER_PAGE): Promise<{ rows: EpisodeRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.q) {
    const escaped = query.q.replace(/[\\%_]/gu, (char) => `\\${char}`);
    where.push("(title LIKE ? ESCAPE '\\' OR speaker LIKE ? ESCAPE '\\' OR published_at LIKE ? ESCAPE '\\')");
    params.push(`%${escaped}%`, `%${escaped}%`, `${escaped}%`);
  }
  if (query.status === "reprocessing") where.push("status = 'done' AND redo IS NOT NULL");
  else if (query.status !== "all") {
    where.push("status = ?");
    params.push(query.status);
  }
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [{ results }, total] = await Promise.all([
    db.prepare(
      `SELECT id, guid, title, published_at, audio_url, duration_seconds, status, stage, attempts, error, detail, last_error, audio_bytes, speaker, updated_at, redo
       FROM episodes ${filter} ORDER BY published_at DESC, created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...params, perPage, (Math.max(1, query.page) - 1) * perPage).all<EpisodeRow>(),
    db.prepare(`SELECT count(*) AS n FROM episodes ${filter}`).bind(...params).first<{ n: number }>(),
  ]);
  return { rows: results, total: total?.n ?? 0 };
}

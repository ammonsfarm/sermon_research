import type { AppEnv } from "./env.ts";
import { chat, parseNumbered } from "./research.ts";

/** Sermons sent to the answers AI in one request. */
const BATCH = 10;
/** The start of each transcript: preachers usually announce and read their text first. */
const OPENING_CHARS = 2_500;
const MAX_TOKENS = 4_000;
const TIMEOUT_MS = 90_000;
/** How many sermons the hourly tick (or "Choose now") checks at most. */
export const HOURLY_MAIN_TEXTS = 60;

/** One tidy reference ("Matthew 5:21-26"), or null for anything that isn't one. */
export function normalizeReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reference = value.replace(/[–—]/gu, "-").replace(/\s+/gu, " ").trim().replace(/[.;,]+$/u, "").trim().slice(0, 100);
  return reference && !/^(null|none|n\/a|unknown|topical|no main passage)$/iu.test(reference) ? reference : null;
}

/** True when two references name the same passage, ignoring spacing, dashes and case. */
export function sameReference(a: string | null, b: string | null): boolean {
  const key = (value: string | null) => (value ?? "").replace(/[–—]/gu, "-").replace(/\s+/gu, "").toLowerCase();
  return Boolean(a && b) && key(a) === key(b);
}

const PROMPT = "You find the main Bible passage each sermon preaches from: the text it's based on, usually announced or read near the start (\"turn with me to Matthew 5, verses 21 through 26\"), not a verse quoted in passing. Give it as one reference in the usual form, like \"Matthew 5:21-26\" or \"Proverbs 19\". Use null for a topical sermon with no single main passage. Reply with only a JSON object mapping each sermon number to a reference or null, like {\"1\": \"John 15:1-11\", \"2\": null}.";

/**
 * Asks the answers AI for the main passage of sermons summarized before it
 * was kept. Stores an empty string when there isn't one, so it isn't asked
 * again. Returns how many were checked.
 */
export async function chooseMainScriptures(env: AppEnv, episodeIds: readonly string[]): Promise<number> {
  const db = env.DB;
  let checked = 0;
  for (let start = 0; start < episodeIds.length; start += BATCH) {
    const batch = episodeIds.slice(start, start + BATCH);
    const { results } = await db.prepare(
      `SELECT e.id, e.title, e.published_at, s.scriptures_json, substr(t.text, 1, ${OPENING_CHARS}) AS opening
       FROM summaries s JOIN episodes e ON e.id = s.episode_id LEFT JOIN transcripts t ON t.episode_id = e.id
       WHERE s.main_scripture IS NULL AND e.id IN (${batch.map(() => "?").join(", ")})`,
    ).bind(...batch).all<{ id: string; title: string; published_at: string | null; scriptures_json: string; opening: string | null }>();
    if (results.length === 0) continue;
    const sermons = results.map((row, index) => {
      const references = JSON.parse(row.scriptures_json) as string[];
      return [
        `${index + 1}. "${row.title}" (${row.published_at?.slice(0, 10) ?? "undated"})`,
        references.length ? `References it mentions: ${references.join(", ")}` : "",
        row.opening ? `Transcript start: ${row.opening}…` : "",
      ].filter(Boolean).join("\n");
    }).join("\n\n");
    const reply = await chat(env, PROMPT, sermons, { maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS, action: "summary" });
    const passages = parseNumbered(reply, results.length, normalizeReference, "main passages");
    await db.batch(results.map((row, index) => db.prepare("UPDATE summaries SET main_scripture = ? WHERE episode_id = ? AND main_scripture IS NULL").bind(passages[index] ?? "", row.id)));
    checked += results.length;
  }
  return checked;
}

/** Chooses the main passage for processed sermons that don't have one yet, newest first. */
export async function chooseMissingMainScriptures(env: AppEnv, limit: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT e.id FROM episodes e JOIN summaries s ON s.episode_id = e.id WHERE e.status = 'done' AND s.main_scripture IS NULL ORDER BY e.published_at DESC LIMIT ?",
  ).bind(limit).all<{ id: string }>();
  return results.length ? chooseMainScriptures(env, results.map((row) => row.id)) : 0;
}

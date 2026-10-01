import type { AppEnv } from "./env.ts";
import { fetchFeed } from "./feed.ts";
import { recordFeed } from "./episodes.ts";
import { ProviderError } from "./providers.ts";
import { chat } from "./research.ts";
import { getSetting, type Ministry, type PodcastSettings, putSetting } from "./settings.ts";

/** Episodes sent to the answers AI in one request. */
const SPEAKER_BATCH = 10;
/** The start of each transcript, for feeds that don't name the speaker: introductions usually come first. */
const OPENING_CHARS = 1_500;
const SPEAKER_MAX_TOKENS = 4_000;
const SPEAKER_TIMEOUT_MS = 90_000;
/** How many sermons the hourly tick identifies at most. */
export const HOURLY_SPEAKERS = 60;

const TITLES = /^(?:pastor|ps|rev|reverend|dr|doctor|elder|bishop|brother|bro|sister|father|fr|deacon|minister|evangelist|apostle)\.?\s+/iu;

/**
 * Books of the Bible that are also first names, so "Mark 4" or "John's
 * gospel" in a question isn't taken as naming a speaker.
 */
const BOOK_NAMES = new Set(["mark", "john", "luke", "matthew", "james", "jude", "peter", "paul", "daniel", "amos", "joel", "jonah", "micah", "ruth", "job", "titus", "timothy", "esther", "samuel", "ezra", "nehemiah", "isaiah", "jeremiah", "ezekiel", "hosea", "obadiah", "nahum", "habakkuk", "zephaniah", "haggai", "zechariah", "malachi", "joshua", "philemon"]);

/** A person's name without titles like Pastor or Dr, with single spaces. */
function bareName(name: string): string {
  let value = name.replace(/\s+/gu, " ").trim();
  while (TITLES.test(value)) value = value.replace(TITLES, "");
  return value;
}

/**
 * Cleans up a name from the answers AI: no titles, single spaces, and the
 * spelling from the ministry's speaker list when it's the same person.
 * Null for anything that isn't a name.
 */
export function normalizeSpeaker(value: unknown, known: readonly string[] = []): string | null {
  if (typeof value !== "string") return null;
  const name = bareName(value).slice(0, 100);
  if (!name || /^(unknown|none|null|n\/a|not sure|unclear)$/iu.test(name)) return null;
  return known.map(bareName).find((each) => each.toLowerCase() === name.toLowerCase()) ?? name;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The one speaker a question names, if any: their full name, their last
 * name, their first name after a title ("Pastor Phil"), or their first name
 * as a possessive ("Phil's sermons"). Null when none or several are named.
 */
export function mentionedSpeaker(question: string, speakers: readonly string[]): string | null {
  const text = question.replace(/[’‘]/gu, "'");
  const named = speakers.filter((speaker) => {
    const parts = speaker.split(" ");
    const first = parts[0] ?? "";
    const last = parts.length > 1 ? parts.at(-1)! : "";
    const word = (pattern: string) => new RegExp(`(?<![\\p{L}])${pattern}(?![\\p{L}])`, "iu").test(text);
    if (word(escapeRegExp(speaker))) return true;
    if (last.length >= 3 && !BOOK_NAMES.has(last.toLowerCase()) && word(escapeRegExp(last))) return true;
    if (!first) return false;
    if (word(`(?:pastor|ps\\.?|rev\\.?|reverend|dr\\.?|elder|bishop|brother|sister|father|fr\\.?|deacon)\\s+${escapeRegExp(first)}`)) return true;
    return !BOOK_NAMES.has(first.toLowerCase()) && word(`${escapeRegExp(first)}'s`);
  });
  return named.length === 1 ? named[0]! : null;
}

interface SpeakerRow {
  readonly id: string;
  readonly title: string;
  readonly published_at: string | null;
  readonly description: string | null;
  readonly author: string | null;
  readonly opening: string | null;
}

function prompt(ministry: Ministry | null): string {
  const church = ministry?.churchName ?? "a church";
  const known = ministry?.speakerNames.length ? ` The church's regular speakers are ${ministry.speakerNames.map(bareName).join(", ")}; when it's one of them, spell the name that way.` : "";
  return `You work out who preached each sermon from ${church}. Use each episode's feed details first (they often say something like "Sermon from <name>"), then the start of its transcript, where the speaker may be introduced or introduce themselves; someone else may give announcements first.${known} Give each speaker's name without titles like Pastor or Dr. If you can't tell who preached, use null rather than guessing. Reply with only a JSON object mapping each episode number to a name or null, like {"1": "Jane Doe", "2": null}.`;
}

/** Reads the answers AI's reply: episode number to name or null. */
export function parseSpeakers(content: string, count: number, known: readonly string[]): (string | null)[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1)) as Record<string, unknown>;
  } catch {
    throw new ProviderError("The answers AI didn't return the speakers as JSON.");
  }
  return Array.from({ length: count }, (_unused, index) => normalizeSpeaker(parsed[String(index + 1)], known));
}

/**
 * Asks the answers AI who preached these episodes and saves the answers.
 * Skips episodes an admin has set or that were already identified. Returns
 * how many were checked.
 */
export async function identifySpeakers(env: AppEnv, episodeIds: readonly string[]): Promise<number> {
  const db = env.DB;
  const ministry = await getSetting<Ministry>(db, "ministry");
  let checked = 0;
  for (let start = 0; start < episodeIds.length; start += SPEAKER_BATCH) {
    const batch = episodeIds.slice(start, start + SPEAKER_BATCH);
    const { results } = await db.prepare(
      `SELECT e.id, e.title, e.published_at, e.description, e.author, substr(t.text, 1, ${OPENING_CHARS}) AS opening
       FROM episodes e LEFT JOIN transcripts t ON t.episode_id = e.id
       WHERE e.speaker_source IS NULL AND e.id IN (${batch.map(() => "?").join(", ")})`,
    ).bind(...batch).all<SpeakerRow>();
    if (results.length === 0) continue;
    const episodes = results.map((row, index) => [
      `${index + 1}. "${row.title}" (${row.published_at?.slice(0, 10) ?? "undated"})`,
      row.author ? `Feed author: ${row.author}` : "",
      row.description ? `Feed description: ${row.description}` : "",
      row.opening ? `Transcript start: ${row.opening}…` : "",
    ].filter(Boolean).join("\n")).join("\n\n");
    const reply = await chat(env, prompt(ministry), episodes, { maxTokens: SPEAKER_MAX_TOKENS, timeoutMs: SPEAKER_TIMEOUT_MS });
    const speakers = parseSpeakers(reply, results.length, ministry?.speakerNames ?? []);
    await db.batch(results.map((row, index) => db.prepare("UPDATE episodes SET speaker = ?, speaker_source = 'ai' WHERE id = ? AND speaker_source IS NULL").bind(speakers[index], row.id)));
    checked += results.length;
  }
  return checked;
}

/**
 * Identifies speakers for processed sermons that don't have one yet, newest
 * first. The first time, it reads the feed so episodes recorded before
 * descriptions were kept get theirs. Returns how many were checked.
 */
export async function identifyMissingSpeakers(env: AppEnv, limit: number): Promise<number> {
  const db = env.DB;
  const { results } = await db.prepare("SELECT id FROM episodes WHERE status = 'done' AND speaker_source IS NULL ORDER BY published_at DESC LIMIT ?")
    .bind(limit).all<{ id: string }>();
  if (results.length === 0) return 0;
  if (!(await getSetting<string>(db, "feed_details_at"))) {
    const podcast = await getSetting<PodcastSettings>(db, "podcast");
    if (podcast) {
      try {
        // Episodes recorded before descriptions were kept get them now. New episodes aren't queued here.
        const feed = await fetchFeed(podcast.feedUrl);
        const known = new Set((await db.prepare("SELECT guid FROM episodes").all<{ guid: string }>()).results.map((row) => row.guid));
        await recordFeed(db, { ...feed, episodes: feed.episodes.filter((episode) => known.has(episode.guid)) });
        await putSetting(db, "feed_details_at", new Date().toISOString());
      } catch (error) {
        console.error("could not read the feed for episode details", error);
      }
    }
  }
  return identifySpeakers(env, results.map((row) => row.id));
}

/** Distinct speakers, most sermons first. */
export function speakerList(entries: readonly { readonly speaker: string | null }[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) if (entry.speaker) counts.set(entry.speaker, (counts.get(entry.speaker) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

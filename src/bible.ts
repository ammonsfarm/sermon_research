import type { AppEnv } from "./env.ts";
import { embed, type PipelineStep, requireKey, type StepConfig } from "./pipeline.ts";
import { ProviderError, withUserAgent } from "./providers.ts";
import { getSetting, putSetting } from "./settings.ts";

/**
 * The translation this site offers. The World English Bible is in the public
 * domain; its name is a trademark of eBible.org and may be used as long as the
 * text is unchanged, which it is: verses are stored exactly as downloaded.
 */
export const BIBLE = {
  name: "World English Bible",
  short: "WEB",
  /** One verse per line ("GEN 1:1 In the beginning…"), zipped. Protestant canon, 66 books. */
  url: "https://ebible.org/Scriptures/engwebp_vpl.zip",
  file: "_vpl.txt",
  about: "https://ebible.org/find/show.php?id=engwebp",
} as const;

/** Bible vectors share the sermons' index; this value in `episodeId` tells them apart. */
export const BIBLE_VECTOR_OWNER = "bible";

/** The download's book codes, in order, with each book's name and number of chapters. */
const BOOK_TABLE: readonly (readonly [string, string, number])[] = [
  ["GEN", "Genesis", 50], ["EXO", "Exodus", 40], ["LEV", "Leviticus", 27], ["NUM", "Numbers", 36], ["DEU", "Deuteronomy", 34],
  ["JOS", "Joshua", 24], ["JDG", "Judges", 21], ["RUT", "Ruth", 4], ["1SA", "1 Samuel", 31], ["2SA", "2 Samuel", 24],
  ["1KI", "1 Kings", 22], ["2KI", "2 Kings", 25], ["1CH", "1 Chronicles", 29], ["2CH", "2 Chronicles", 36], ["EZR", "Ezra", 10],
  ["NEH", "Nehemiah", 13], ["EST", "Esther", 10], ["JOB", "Job", 42], ["PSA", "Psalms", 150], ["PRO", "Proverbs", 31],
  ["ECC", "Ecclesiastes", 12], ["SOL", "Song of Solomon", 8], ["ISA", "Isaiah", 66], ["JER", "Jeremiah", 52], ["LAM", "Lamentations", 5],
  ["EZE", "Ezekiel", 48], ["DAN", "Daniel", 12], ["HOS", "Hosea", 14], ["JOE", "Joel", 3], ["AMO", "Amos", 9],
  ["OBA", "Obadiah", 1], ["JON", "Jonah", 4], ["MIC", "Micah", 7], ["NAH", "Nahum", 3], ["HAB", "Habakkuk", 3],
  ["ZEP", "Zephaniah", 3], ["HAG", "Haggai", 2], ["ZEC", "Zechariah", 14], ["MAL", "Malachi", 4],
  ["MAT", "Matthew", 28], ["MAR", "Mark", 16], ["LUK", "Luke", 24], ["JOH", "John", 21], ["ACT", "Acts", 28],
  ["ROM", "Romans", 16], ["1CO", "1 Corinthians", 16], ["2CO", "2 Corinthians", 13], ["GAL", "Galatians", 6], ["EPH", "Ephesians", 6],
  ["PHI", "Philippians", 4], ["COL", "Colossians", 4], ["1TH", "1 Thessalonians", 5], ["2TH", "2 Thessalonians", 3], ["1TI", "1 Timothy", 6],
  ["2TI", "2 Timothy", 4], ["TIT", "Titus", 3], ["PHM", "Philemon", 1], ["HEB", "Hebrews", 13], ["JAM", "James", 5],
  ["1PE", "1 Peter", 5], ["2PE", "2 Peter", 3], ["1JO", "1 John", 5], ["2JO", "2 John", 1], ["3JO", "3 John", 1],
  ["JUD", "Jude", 1], ["REV", "Revelation", 22],
];

export interface Book {
  /** 1 (Genesis) to 66 (Revelation). */
  readonly number: number;
  readonly code: string;
  readonly name: string;
  /** The name as it appears in addresses: "1-samuel". */
  readonly slug: string;
  readonly chapters: number;
  readonly testament: "old" | "new";
}

export const BOOKS: readonly Book[] = BOOK_TABLE.map(([code, name, chapters], index) => ({
  number: index + 1, code, name, slug: name.toLowerCase().replaceAll(" ", "-"), chapters, testament: index < 39 ? "old" : "new",
}));

const BY_CODE = new Map(BOOKS.map((book) => [book.code, book]));
const BY_SLUG = new Map(BOOKS.map((book) => [book.slug, book]));

export function bookBySlug(slug: string): Book | null {
  return BY_SLUG.get(slug) ?? null;
}

export function bookByNumber(number: number): Book | null {
  return BOOKS[number - 1] ?? null;
}

export function chapterPath(book: Book, chapter: number, verse?: number | null): string {
  return `/bible/${book.slug}/${chapter}${verse ? `#v${verse}` : ""}`;
}

/** Other names people type for a book. */
const ALIASES: Readonly<Record<string, string>> = {
  psalm: "Psalms", "song of songs": "Song of Solomon", song: "Song of Solomon", canticles: "Song of Solomon", revelations: "Revelation",
  gen: "Genesis", ex: "Exodus", deut: "Deuteronomy", ps: "Psalms", prov: "Proverbs", matt: "Matthew", mk: "Mark", lk: "Luke", jn: "John",
  rom: "Romans", phil: "Philippians", philem: "Philemon", heb: "Hebrews", jas: "James", rev: "Revelation",
  lev: "Leviticus", num: "Numbers", josh: "Joshua", judg: "Judges", neh: "Nehemiah", eccl: "Ecclesiastes", isa: "Isaiah", jer: "Jeremiah",
  lam: "Lamentations", ezek: "Ezekiel", dan: "Daniel", hos: "Hosea", mic: "Micah", hab: "Habakkuk", zeph: "Zephaniah", hag: "Haggai",
  zech: "Zechariah", mal: "Malachi", gal: "Galatians", eph: "Ephesians", col: "Colossians", tit: "Titus",
  "1 sam": "1 Samuel", "2 sam": "2 Samuel", "1 kgs": "1 Kings", "2 kgs": "2 Kings", "1 chron": "1 Chronicles", "2 chron": "2 Chronicles",
  "1 cor": "1 Corinthians", "2 cor": "2 Corinthians", "1 thess": "1 Thessalonians", "2 thess": "2 Thessalonians",
  "1 tim": "1 Timothy", "2 tim": "2 Timothy", "1 pet": "1 Peter", "2 pet": "2 Peter", "1 jn": "1 John", "2 jn": "2 John", "3 jn": "3 John",
};

export interface Reference {
  readonly book: Book;
  /** Null when only a book was named. */
  readonly chapter: number | null;
  readonly verse: number | null;
}

/**
 * Reads "John 3:16", "1 cor 13", "Psalm 23" or "II Timothy 2.15-17" as a place
 * in the Bible. Null for anything else, so ordinary searches aren't mistaken
 * for references: a book's name alone must be written out in full.
 */
export function parseReference(text: string): Reference | null {
  const match = /^((?:[1-3]|i{1,3})\s*)?([a-z][a-z ]*?)\.?\s*(?:(\d{1,3})(?:\s*[:.]\s*(\d{1,3}))?(?:\s*[-–—]\s*\d{1,3}(?:\s*:\s*\d{1,3})?)?)?$/u.exec(text.trim().toLowerCase().replace(/\s+/gu, " "));
  if (!match) return null;
  const ordinal = match[1]?.trim();
  const prefix = ordinal ? `${/^i+$/u.test(ordinal) ? ordinal.length : ordinal} ` : "";
  const typed = `${prefix}${match[2]!.trim()}`;
  const chapter = match[3] ? Number(match[3]) : null;
  // Short forms ("rom 8", "1 cor 13") count only with a chapter after them, so a search for "song" or "rev" stays a search.
  const alias = chapter !== null || typed.length >= 5 ? ALIASES[typed] : undefined;
  const exact = BOOKS.find((book) => book.name.toLowerCase() === typed) ?? BOOKS.find((book) => book.name === alias);
  const book = exact ?? (chapter !== null && typed.replace(/^\d /u, "").length >= 3 ? BOOKS.find((each) => each.name.toLowerCase().startsWith(typed)) : undefined);
  if (!book) return null;
  if (chapter === null) return { book, chapter: null, verse: null };
  // Books with one chapter are cited by verse alone: "Jude 5".
  if (book.chapters === 1 && !match[4]) return { book, chapter: 1, verse: chapter > 1 ? chapter : null };
  if (chapter < 1 || chapter > book.chapters) return null;
  return { book, chapter, verse: match[4] ? Number(match[4]) : null };
}

export interface Mention {
  readonly book: Book;
  readonly chapter: number;
  /** The verses named, or null for the whole chapter. */
  readonly from: number | null;
  readonly to: number | null;
}

const NAMES = [...BOOKS.map((book) => book.name.toLowerCase()), ...Object.keys(ALIASES)]
  .sort((a, b) => b.length - a.length)
  .map((name) => name.replace(/^([1-3]) /u, (_match, digit: string) => `(?:${digit}|${"i".repeat(Number(digit))})\\s?`));
const MENTION = new RegExp(`(?<![a-z0-9])(${NAMES.join("|")})\\.?\\s+(\\d{1,3})(?:\\s?:\\s?(\\d{1,3})(?:\\s?[-–—]\\s?(\\d{1,3}))?)?`, "giu");
const MAX_MENTIONS = 3;

/** The references written in a question, like "What does Romans 8:28-30 mean?", so those verses can be read rather than searched for. */
export function referencesIn(text: string): Mention[] {
  const found = new Map<string, Mention>();
  for (const match of text.matchAll(MENTION)) {
    const place = parseReference(`${match[1]} ${match[2]}${match[3] ? `:${match[3]}` : ""}`);
    if (!place?.chapter) continue;
    const from = place.verse;
    const to = from !== null && match[4] && Number(match[4]) >= from ? Number(match[4]) : from;
    found.set(`${place.book.number}:${place.chapter}:${from}:${to}`, { book: place.book, chapter: place.chapter, from, to });
    if (found.size === MAX_MENTIONS) break;
  }
  return [...found.values()];
}

// ------------------------------------------------------------------ the text

export interface Verse {
  readonly book: number;
  readonly chapter: number;
  readonly verse: number;
  readonly text: string;
}

/** A few verses in a row from one chapter: the unit that's searched by meaning. */
export interface BiblePassage {
  readonly id: string;
  readonly book: number;
  readonly chapter: number;
  readonly verseStart: number;
  readonly verseEnd: number;
  readonly text: string;
}

/** About five verses: short enough that a match points at the right place, long enough to carry a thought. */
const PASSAGE_CHARS = 900;

/**
 * Finds the file whose name ends with `suffix` in a zip archive and returns its
 * bytes, or null when the archive has no such file or can't be read.
 */
export async function unzipFile(zip: Uint8Array, suffix: string): Promise<Uint8Array | null> {
  try {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // The directory of files is at the end, after a record that starts with this signature.
    let end = zip.byteLength - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
    if (end < 0) return null;
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const decoder = new TextDecoder();
    for (let index = 0; index < count; index += 1) {
      if (view.getUint32(at, true) !== 0x02014b50) return null;
      const method = view.getUint16(at + 10, true);
      const size = view.getUint32(at + 20, true);
      const nameLength = view.getUint16(at + 28, true);
      const local = view.getUint32(at + 42, true);
      if (decoder.decode(zip.subarray(at + 46, at + 46 + nameLength)).endsWith(suffix)) {
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = zip.subarray(start, start + size);
        if (method === 0) return data;
        if (method !== 8) return null;
        return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      }
      at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
    return null;
  } catch {
    return null;
  }
}

/** Reads the verse-per-line file. Verses this edition leaves out (an empty line such as "ACT 8:37 ") are skipped. */
export function parseVerses(file: string): Verse[] {
  const verses: Verse[] = [];
  for (const line of file.split(/\r?\n/u)) {
    const match = /^﻿?(\S{3}) (\d+):(\d+) (.*)$/u.exec(line);
    const book = match && BY_CODE.get(match[1]!);
    const text = match?.[4]?.trim();
    if (book && text) verses.push({ book: book.number, chapter: Number(match![2]), verse: Number(match![3]), text });
  }
  return verses;
}

/** Groups each chapter's verses into passages of about PASSAGE_CHARS, never across a chapter. */
export function buildPassages(verses: readonly Verse[]): BiblePassage[] {
  const passages: BiblePassage[] = [];
  let run: Verse[] = [];
  let length = 0;
  const flush = () => {
    const first = run[0];
    if (!first) return;
    passages.push({
      id: `${BIBLE_VECTOR_OWNER}:${first.book}:${first.chapter}:${first.verse}`,
      book: first.book, chapter: first.chapter, verseStart: first.verse, verseEnd: run.at(-1)!.verse,
      text: run.map((verse) => verse.text).join(" "),
    });
    run = [];
    length = 0;
  };
  for (const verse of verses) {
    const first = run[0];
    if (first && (first.book !== verse.book || first.chapter !== verse.chapter || length + verse.text.length + 1 > PASSAGE_CHARS)) flush();
    run.push(verse);
    length += verse.text.length + 1;
  }
  flush();
  return passages;
}

/** "John 3:16-21", or "John 3:16" for a single verse. */
export function passageLabel(passage: Pick<BiblePassage, "book" | "chapter" | "verseStart" | "verseEnd">): string {
  const name = bookByNumber(passage.book)?.name ?? "";
  return `${name} ${passage.chapter}:${passage.verseStart}${passage.verseEnd > passage.verseStart ? `-${passage.verseEnd}` : ""}`;
}

// -------------------------------------------------------------------- import

export interface BibleState {
  readonly status: "working" | "done" | "failed";
  /** What the import is doing now, while it's working. */
  readonly detail: string | null;
  readonly error: string | null;
  /** Verses stored; above zero once the Bible can be read. */
  readonly verses: number;
  /** Passages stored, and how many of them can be searched by meaning. */
  readonly passages: number;
  readonly indexed: number;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export async function bibleState(db: D1Database): Promise<BibleState | null> {
  return getSetting<BibleState>(db, "bible");
}

async function update(db: D1Database, changes: Partial<BibleState>): Promise<void> {
  const now = new Date().toISOString();
  const current = await bibleState(db);
  await putSetting(db, "bible", { status: "working", detail: null, error: null, verses: 0, passages: 0, indexed: 0, startedAt: now, ...current, ...changes, updatedAt: now });
}

/** Starts the background run that downloads the Bible and prepares it for search. */
export async function startBibleImport(env: AppEnv): Promise<void> {
  const now = new Date().toISOString();
  await update(env.DB, { status: "working", detail: "Starting", error: null, startedAt: now });
  try {
    await env.BIBLE_WORKFLOW.create({ id: `bible-${Date.now()}` });
  } catch (error) {
    await update(env.DB, { status: "failed", detail: null, error: "The background run couldn't be started. Try again in a minute." });
    console.error("bible import failed to start", error);
  }
}

const DOWNLOAD: StepConfig = { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" };
const EMBED: StepConfig = { retries: { limit: 4, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" };
const FINISH: StepConfig = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" };
/** Rows in one statement, sent as a single JSON value so D1's limit of 100 bound values doesn't apply. */
const VERSES_PER_STATEMENT = 400;
const PASSAGES_PER_STATEMENT = 150;
/** Passages embedded and written to the search index in one step. */
const EMBED_ROUND = 256;
/** More rounds than any Bible needs; stops a run that isn't getting anywhere. */
const MAX_ROUNDS = 200;

function slices<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

async function download(): Promise<Verse[]> {
  const response = await fetch(BIBLE.url, { headers: withUserAgent(), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new ProviderError(`eBible.org returned HTTP ${response.status} for the ${BIBLE.name} download.`);
  const file = await unzipFile(new Uint8Array(await response.arrayBuffer()), BIBLE.file);
  const verses = file ? parseVerses(new TextDecoder().decode(file)) : [];
  if (verses.length === 0) throw new ProviderError(`The ${BIBLE.name} download from eBible.org couldn't be read. It may have been a page instead of the file.`);
  return verses;
}

/**
 * The whole import, as workflow steps: download and store the verses, then
 * embed the passages a few hundred at a time. Starting it again replaces the
 * text and its vectors; verses stay readable throughout.
 */
export async function importBible(env: AppEnv, step: PipelineStep): Promise<void> {
  const db = env.DB;
  try {
    await step.do("store the text", DOWNLOAD, async () => {
      await update(db, { detail: "Downloading the text from eBible.org" });
      const verses = await download();
      const passages = buildPassages(verses);
      const previous = (await db.prepare("SELECT id FROM bible_passages").all<{ id: string }>()).results.map((row) => row.id);
      // Verses are replaced in place, so the Bible stays readable while it's added again.
      const statements = [
        db.prepare("DELETE FROM bible_passages"),
        ...slices(verses, VERSES_PER_STATEMENT).map((rows) => db.prepare(
          `INSERT OR REPLACE INTO bible_verses (book, chapter, verse, text)
           SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?)`,
        ).bind(JSON.stringify(rows.map((row) => [row.book, row.chapter, row.verse, row.text])))),
        ...slices(passages, PASSAGES_PER_STATEMENT).map((rows) => db.prepare(
          `INSERT OR REPLACE INTO bible_passages (id, book, chapter, verse_start, verse_end, text, indexed)
           SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'), 0 FROM json_each(?)`,
        ).bind(JSON.stringify(rows.map((row) => [row.id, row.book, row.chapter, row.verseStart, row.verseEnd, row.text])))),
      ];
      for (const batch of slices(statements, 10)) await db.batch(batch);
      // A newer edition can divide a chapter differently; vectors of passages that no longer exist would point nowhere.
      const kept = new Set(passages.map((passage) => passage.id));
      for (const stale of slices(previous.filter((id) => !kept.has(id)), 500)) await env.VECTORS.deleteByIds(stale);
      await update(db, { verses: verses.length, passages: passages.length, indexed: 0, detail: "Preparing passages for search" });
    });

    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      const left = await step.do(`prepare search ${round}`, EMBED, async () => {
        const { results } = await db.prepare("SELECT id, book, chapter, verse_start AS verseStart, verse_end AS verseEnd, text FROM bible_passages WHERE indexed = 0 ORDER BY book, chapter, verse_start LIMIT ?")
          .bind(EMBED_ROUND).all<BiblePassage>();
        if (results.length === 0) return 0;
        // The reference goes in with the words, so a search for "John 3:16" or "the Sermon on the Mount in Matthew" has something to match.
        const vectors = await embed(results.map((passage) => `${passageLabel(passage)} (${BIBLE.name})\n${passage.text}`), await requireKey(env, "embeddings"));
        await env.VECTORS.upsert(results.map((passage, index) => ({
          id: passage.id,
          values: vectors[index]!,
          metadata: { episodeId: BIBLE_VECTOR_OWNER, kind: "bible", book: passage.book, chapter: passage.chapter },
        })));
        await db.prepare("UPDATE bible_passages SET indexed = 1 WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(results.map((passage) => passage.id))).run();
        const counts = await db.prepare("SELECT count(*) AS total, coalesce(sum(indexed), 0) AS indexed FROM bible_passages").first<{ total: number; indexed: number }>();
        const total = counts?.total ?? 0;
        const indexed = counts?.indexed ?? 0;
        await update(db, { indexed, detail: `Preparing passages for search: ${indexed.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}` });
        return total - indexed;
      });
      if (left === 0) break;
    }

    await step.do("finish", FINISH, async () => {
      const left = await db.prepare("SELECT count(*) AS n FROM bible_passages WHERE indexed = 0").first<{ n: number }>();
      if (left?.n) await update(db, { status: "failed", detail: null, error: `${left.n} passages still aren't searchable. Add it again to finish.` });
      else await update(db, { status: "done", detail: null, error: null });
    });
  } catch (error) {
    await step.do("record failure", FINISH, async () => {
      await update(db, { status: "failed", detail: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) || "Unknown error." });
    });
  }
}

// -------------------------------------------------------------------- lookup

type PassageRow = { id: string; book: number; chapter: number; verse_start: number; verse_end: number; text: string };

function fromRow(row: PassageRow): BiblePassage {
  return { id: row.id, book: row.book, chapter: row.chapter, verseStart: row.verse_start, verseEnd: row.verse_end, text: row.text };
}

/** The passages closest in meaning to `query`, best first. One embeddings call. */
export async function searchBible(env: AppEnv, query: string, topK = 10): Promise<BiblePassage[]> {
  const [vector] = await embed([query], await requireKey(env, "embeddings"));
  const result = await env.VECTORS.query(vector!, { topK, returnMetadata: "none", returnValues: false, filter: { episodeId: BIBLE_VECTOR_OWNER } });
  const ids = result.matches.map((match) => match.id);
  if (ids.length === 0) return [];
  const { results } = await env.DB.prepare(`SELECT id, book, chapter, verse_start, verse_end, text FROM bible_passages WHERE id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all<PassageRow>();
  const byId = new Map(results.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [fromRow(row)] : [];
  });
}

/** Passages of one chapter a reference can bring in; enough for all but the longest chapters. */
const MENTION_PASSAGES = 8;

/** The closest passages, each with the passages just before and after it in its chapter, in reading order. */
async function withNeighbours(db: D1Database, hits: readonly BiblePassage[], before: number, after: number): Promise<BiblePassage[]> {
  if (hits.length === 0 || (before === 0 && after === 0)) return [...hits];
  const chapters = [...new Map(hits.map((hit) => [`${hit.book}:${hit.chapter}`, hit])).values()];
  const rows: BiblePassage[] = [];
  // Two bound values a chapter, and D1 allows 100 a statement.
  for (let start = 0; start < chapters.length; start += 40) {
    const some = chapters.slice(start, start + 40);
    const { results } = await db.prepare(`SELECT id, book, chapter, verse_start, verse_end, text FROM bible_passages WHERE ${some.map(() => "(book = ? AND chapter = ?)").join(" OR ")} ORDER BY book, chapter, verse_start`)
      .bind(...some.flatMap((hit) => [hit.book, hit.chapter])).all<PassageRow>();
    rows.push(...results.map(fromRow));
  }
  return hits.flatMap((hit) => {
    const chapter = rows.filter((row) => row.book === hit.book && row.chapter === hit.chapter);
    const at = chapter.findIndex((row) => row.id === hit.id);
    return at < 0 ? [hit] : chapter.slice(Math.max(0, at - before), at + after + 1);
  });
}

/**
 * Bible passages to answer a question from: the verses the question names,
 * then the `hits` passages closest to it in meaning, each with the passages
 * `before` and `after` it in its chapter, up to `maxChars` of text in all.
 * Passages that follow one another are joined, so a stretch of a chapter
 * reads as one source.
 */
export async function bibleForQuestion(env: AppEnv, question: string, limits: { hits: number; before: number; after: number; maxChars: number }): Promise<BiblePassage[]> {
  const named: BiblePassage[] = [];
  for (const mention of referencesIn(question)) {
    const { results } = await env.DB.prepare("SELECT id, book, chapter, verse_start, verse_end, text FROM bible_passages WHERE book = ? AND chapter = ? AND verse_end >= ? AND verse_start <= ? ORDER BY verse_start LIMIT ?")
      .bind(mention.book.number, mention.chapter, mention.from ?? 1, mention.to ?? 999, MENTION_PASSAGES).all<PassageRow>();
    named.push(...results.map(fromRow));
  }
  const seen = new Set<string>();
  const joined: BiblePassage[] = [];
  const close = await withNeighbours(env.DB, await searchBible(env, question, limits.hits), limits.before, limits.after);
  let total = 0;
  for (const passage of [...named, ...close]) {
    if (seen.has(passage.id)) continue;
    seen.add(passage.id);
    // Past the character limit the rest are left out; they're the less close ones. The first always stays.
    total += passage.text.length;
    if (total > limits.maxChars && joined.length > 0) break;
    const last = joined.at(-1);
    if (last && last.book === passage.book && last.chapter === passage.chapter && passage.verseStart === last.verseEnd + 1) {
      joined[joined.length - 1] = { ...last, verseEnd: passage.verseEnd, text: `${last.text} ${passage.text}` };
    } else joined.push(passage);
  }
  return joined;
}

/** Verses containing the words as typed, in Bible order. */
export async function findVerses(db: D1Database, query: string, limit = 30): Promise<Verse[]> {
  const pattern = `%${query.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;
  return (await db.prepare("SELECT book, chapter, verse, text FROM bible_verses WHERE text LIKE ? ESCAPE '\\' ORDER BY book, chapter, verse LIMIT ?").bind(pattern, limit).all<Verse>()).results;
}

export async function chapterVerses(db: D1Database, book: number, chapter: number): Promise<Verse[]> {
  return (await db.prepare("SELECT book, chapter, verse, text FROM bible_verses WHERE book = ? AND chapter = ? ORDER BY verse").bind(book, chapter).all<Verse>()).results;
}

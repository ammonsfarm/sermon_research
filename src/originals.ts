import { type Book, bookByNumber, BOOKS } from "./bible.ts";
import type { AppEnv } from "./env.ts";
import type { PipelineStep, StepConfig } from "./pipeline.ts";
import { ProviderError, withUserAgent } from "./providers.ts";
import { getSetting, putSetting } from "./settings.ts";

/**
 * The texts the translations are made from: an edited Greek New Testament and
 * a transcription of the Leningrad Codex, the oldest complete Hebrew Bible.
 * Verses are stored as published, in each text's own chapter and verse numbers.
 */
export const ORIGINALS = {
  greek: {
    language: "Greek",
    lang: "grc",
    name: "SBL Greek New Testament",
    short: "SBLGNT",
    /** One tab-separated verse per line, a file per book. */
    url: (file: string) => `https://raw.githubusercontent.com/Faithlife/SBLGNT/master/data/sblgnt/text/${file}.txt`,
    about: "https://sblgnt.com",
    /** Creative Commons Attribution 4.0, which asks for this credit and a note of changes. */
    credit: "SBL Greek New Testament, copyright 2010 Society of Biblical Literature and Logos Bible Software, used under CC BY 4.0. The marks pointing to its apparatus are left out.",
  },
  hebrew: {
    language: "Hebrew",
    lang: "he",
    name: "Unicode/XML Leningrad Codex",
    short: "UXLC",
    /** One XML file per book: chapters, verses and words. */
    url: (file: string) => `https://tanach.us/Books/${file}.xml`,
    about: "https://tanach.us",
    /** Tanach.us lets the text be copied freely, asks to be cited, and asks that it not be called the Westminster Leningrad Codex. */
    credit: "Unicode/XML Leningrad Codex (UXLC), Tanach.us Inc., West Redding, CT, USA. Where the codex writes one word and reads another, the written form is in brackets before the one read.",
  },
} as const;

export type Original = (typeof ORIGINALS)[keyof typeof ORIGINALS];

/** Each source's file for a book, in the order of BOOKS: 39 from Tanach.us, then 27 from the SBLGNT. */
const FILES = ("Genesis Exodus Leviticus Numbers Deuteronomy Joshua Judges Ruth Samuel_1 Samuel_2 Kings_1 Kings_2 Chronicles_1 Chronicles_2 Ezra Nehemiah Esther Job "
  + "Psalms Proverbs Ecclesiastes Song_of_Songs Isaiah Jeremiah Lamentations Ezekiel Daniel Hosea Joel Amos Obadiah Jonah Micah Nahum Habakkuk Zephaniah Haggai Zechariah Malachi "
  + "Matt Mark Luke John Acts Rom 1Cor 2Cor Gal Eph Phil Col 1Thess 2Thess 1Tim 2Tim Titus Phlm Heb Jas 1Pet 2Pet 1John 2John 3John Jude Rev").split(" ");

/** The text a book was written in, as this site has it. Parts of Daniel and Ezra are Aramaic, in the same script and file. */
export function originalOf(book: Book | number): Original {
  return (typeof book === "number" ? book : book.number) <= 39 ? ORIGINALS.hebrew : ORIGINALS.greek;
}

export interface OriginalVerse {
  readonly book: number;
  /** In the source's own numbering, which for the Hebrew is not always the English Bible's. */
  readonly chapter: number;
  readonly verse: number;
  readonly text: string;
}

/** Marks in the SBLGNT that point to its apparatus of variant readings, which isn't part of this text. */
const APPARATUS = /[⸀⸁⸂⸃⸄⸅]/gu;

/** Reads one SBLGNT book: a title line, then "John 1:1<tab>Ἐν ἀρχῇ…" lines. */
export function parseGreek(file: string, book: number): OriginalVerse[] {
  const verses: OriginalVerse[] = [];
  for (const line of file.split(/\r?\n/u)) {
    const match = /^\S+ (\d+):(\d+)\t(.*)$/u.exec(line);
    const text = match?.[3]?.replace(APPARATUS, "").replace(/\s+/gu, " ").trim();
    if (match && text) verses.push({ book, chapter: Number(match[1]), verse: Number(match[2]), text });
  }
  return verses;
}

/**
 * Reads one Tanach.us book. A verse is its words in order, joined by spaces
 * except after a maqaf, which binds a word to the next. Transcription notes
 * (`<x>`) and paragraph marks are dropped. A ketiv, the word as written, goes
 * in square brackets before its qere, the word as read.
 */
export function parseHebrew(xml: string, book: number): OriginalVerse[] {
  const verses: OriginalVerse[] = [];
  const body = xml.slice(Math.max(0, xml.indexOf("<tanach>")));
  for (const chapter of body.matchAll(/<c n="(\d+)">([\s\S]*?)<\/c>/gu)) {
    for (const verse of chapter[2]!.matchAll(/<v n="(\d+)">([\s\S]*?)<\/v>/gu)) {
      let text = "";
      for (const word of verse[2]!.matchAll(/<(w|k|q)>([\s\S]*?)<\/\1>|<reversednun\s*\/>/gu)) {
        const plain = word[1] ? word[2]!.replace(/<x>[\s\S]*?<\/x>/gu, "").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim() : "׆";
        if (!plain) continue;
        text += `${text && !text.endsWith("־") ? " " : ""}${word[1] === "k" ? `[${plain}]` : plain}`;
      }
      if (text) verses.push({ book, chapter: Number(chapter[1]), verse: Number(verse[1]), text });
    }
  }
  return verses;
}

/** The accents that mark chanting and phrasing. Vowel points and letters stay. */
const CANTILLATION = /[֑-ֽ֯͏]/gu;

/** Hebrew without its cantillation marks, which cost an AI model many tokens and add little to what it reads. */
export function withoutCantillation(text: string): string {
  return text.replace(CANTILLATION, "");
}

// ----------------------------------------------------------------- numbering

/**
 * Where the English Bible's chapters and verses differ from the Hebrew text's:
 * [book, English chapter, first verse, last verse, Hebrew chapter, Hebrew
 * verse of the first]. A Hebrew verse of 0 means the codex doesn't have the
 * verse. Checked against the World English Bible, UXLC 2.6 and SBLGNT 1.2:
 * every English verse lands on a verse that exists, apart from the handful
 * the Greek text leaves out as later additions (Matthew 17:21, John 5:4…).
 */
const SHIFTS: readonly (readonly [number, number, number, number, number, number])[] = [
  [1, 31, 55, 55, 32, 1], [1, 32, 1, 32, 32, 2],
  [2, 8, 1, 4, 7, 26], [2, 8, 5, 32, 8, 1], [2, 22, 1, 1, 21, 37], [2, 22, 2, 31, 22, 1],
  [3, 6, 1, 7, 5, 20], [3, 6, 8, 30, 6, 1],
  [4, 16, 36, 50, 17, 1], [4, 17, 1, 13, 17, 16], [4, 29, 40, 40, 30, 1], [4, 30, 1, 16, 30, 2],
  [5, 12, 32, 32, 13, 1], [5, 13, 1, 18, 13, 2], [5, 22, 30, 30, 23, 1], [5, 23, 1, 25, 23, 2], [5, 29, 1, 1, 28, 69], [5, 29, 2, 29, 29, 1],
  [9, 21, 1, 15, 21, 2], [9, 23, 29, 29, 24, 1], [9, 24, 1, 22, 24, 2],
  [10, 18, 33, 33, 19, 1], [10, 19, 1, 43, 19, 2],
  [11, 4, 21, 34, 5, 1], [11, 5, 1, 18, 5, 15], [11, 22, 44, 53, 22, 45],
  [12, 11, 21, 21, 12, 1], [12, 12, 1, 21, 12, 2],
  [13, 6, 1, 15, 5, 27], [13, 6, 16, 81, 6, 1], [13, 12, 5, 40, 12, 6],
  [14, 2, 1, 1, 1, 18], [14, 2, 2, 18, 2, 1], [14, 14, 1, 1, 13, 23], [14, 14, 2, 15, 14, 1],
  [16, 4, 1, 6, 3, 33], [16, 4, 7, 23, 4, 1], [16, 7, 68, 68, 7, 0], [16, 7, 69, 73, 7, 68], [16, 9, 38, 38, 10, 1], [16, 10, 1, 39, 10, 2],
  [18, 41, 1, 8, 40, 25], [18, 41, 9, 34, 41, 1],
  [21, 5, 1, 1, 4, 17], [21, 5, 2, 20, 5, 1],
  [22, 6, 13, 13, 7, 1], [22, 7, 1, 13, 7, 2],
  [23, 9, 1, 1, 8, 23], [23, 9, 2, 21, 9, 1], [23, 64, 1, 1, 63, 19], [23, 64, 2, 12, 64, 1],
  [24, 9, 1, 1, 8, 23], [24, 9, 2, 26, 9, 1],
  [26, 20, 45, 49, 21, 1], [26, 21, 1, 32, 21, 6],
  [27, 4, 1, 3, 3, 31], [27, 4, 4, 37, 4, 1], [27, 5, 31, 31, 6, 1], [27, 6, 1, 28, 6, 2],
  [28, 1, 10, 11, 2, 1], [28, 2, 1, 23, 2, 3], [28, 11, 12, 12, 12, 1], [28, 12, 1, 14, 12, 2], [28, 13, 16, 16, 14, 1], [28, 14, 1, 9, 14, 2],
  [29, 2, 28, 32, 3, 1], [29, 3, 1, 21, 4, 1],
  [32, 1, 17, 17, 2, 1], [32, 2, 1, 10, 2, 2],
  [33, 5, 1, 1, 4, 14], [33, 5, 2, 15, 5, 1],
  [34, 1, 15, 15, 2, 1], [34, 2, 1, 13, 2, 2],
  [38, 1, 18, 21, 2, 1], [38, 2, 1, 13, 2, 5],
  [39, 4, 1, 6, 3, 19],
  // The Greek New Testament: Acts 19:41 is the end of 19:40, the closing praise of Romans stands at 16:25-27, and 2 Corinthians 13 has one verse fewer.
  [44, 19, 41, 41, 19, 40], [45, 14, 24, 26, 16, 25], [47, 13, 13, 13, 13, 12], [47, 13, 14, 14, 13, 13],
];

/** Psalms whose heading is the Hebrew text's first verse, or its first two, so every verse after is one or two higher. */
const TITLE_IS_ONE = new Set([3, 4, 5, 6, 7, 8, 9, 12, 18, 19, 20, 21, 22, 30, 31, 34, 36, 38, 39, 40, 41, 42, 44, 45, 46, 47, 48, 49, 53, 55, 56, 57, 58, 59, 61, 62, 63, 64, 65, 67, 68, 69, 70, 75, 76, 77, 80, 81, 83, 84, 85, 88, 89, 92, 102, 108, 140, 142]);
const TITLE_IS_TWO = new Set([51, 52, 54, 60]);
const PSALMS = 19;

/** How many verses of a psalm's heading the Hebrew text counts and the English Bible doesn't. */
export function psalmTitleVerses(book: number, chapter: number): number {
  return book !== PSALMS ? 0 : TITLE_IS_TWO.has(chapter) ? 2 : TITLE_IS_ONE.has(chapter) ? 1 : 0;
}

/** The place in the Greek or Hebrew text of an English Bible verse, or null when that text doesn't have it. */
export function toOriginal(book: number, chapter: number, verse: number): { chapter: number; verse: number } | null {
  if (book === PSALMS) return { chapter, verse: verse + psalmTitleVerses(book, chapter) };
  const shift = SHIFTS.find((rule) => rule[0] === book && rule[1] === chapter && verse >= rule[2] && verse <= rule[3]);
  if (!shift) return { chapter, verse };
  return shift[5] === 0 ? null : { chapter: shift[4], verse: shift[5] + verse - shift[2] };
}

/** "Joel 3:1" for a verse of the original, in its own numbering. */
export function originalLabel(book: number, chapter: number, verse: number): string {
  return `${bookByNumber(book)?.name ?? ""} ${chapter}:${verse}`;
}

// -------------------------------------------------------------------- lookup

export interface AlignedVerse {
  /** The English Bible's verse number, or 0 for a psalm's heading, which the English doesn't number. */
  readonly verse: number;
  readonly original: OriginalVerse;
}

/**
 * The Greek or Hebrew for verses `from` to `to` of an English Bible chapter,
 * in order, with a psalm's heading first when the range starts at verse 1.
 * Verses the original doesn't have are left out.
 */
export async function originalVerses(db: D1Database, book: number, chapter: number, from: number, to: number): Promise<AlignedVerse[]> {
  const wanted: { verse: number; chapter: number; at: number }[] = [];
  if (from <= 1) for (let title = 1; title <= psalmTitleVerses(book, chapter); title += 1) wanted.push({ verse: 0, chapter, at: title });
  for (let verse = Math.max(1, from); verse <= to; verse += 1) {
    const place = toOriginal(book, chapter, verse);
    if (place) wanted.push({ verse, chapter: place.chapter, at: place.verse });
  }
  if (wanted.length === 0) return [];
  // A chapter's verses fall in at most a few chapters of the original; read those and pick.
  const chapters = [...new Set(wanted.map((each) => each.chapter))];
  const { results } = await db.prepare(`SELECT book, chapter, verse, text FROM bible_originals WHERE book = ? AND chapter IN (${chapters.map(() => "?").join(", ")})`)
    .bind(book, ...chapters).all<OriginalVerse>();
  const found = new Map(results.map((row) => [`${row.chapter}:${row.verse}`, row]));
  // Two English verses can be one verse of the original (Isaiah 63:19 and 64:1); it's given once.
  let last: OriginalVerse | undefined;
  return wanted.flatMap((each) => {
    const original = found.get(`${each.chapter}:${each.at}`);
    if (!original || original === last) return [];
    last = original;
    return [{ verse: each.verse, original }];
  });
}

// -------------------------------------------------------------------- import

export interface OriginalsState {
  readonly status: "working" | "done" | "failed";
  readonly detail: string | null;
  readonly error: string | null;
  /** Verses stored of each text. */
  readonly greek: number;
  readonly hebrew: number;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export async function originalsState(db: D1Database): Promise<OriginalsState | null> {
  return getSetting<OriginalsState>(db, "bible_originals");
}

/** True once both texts can be read. */
export function originalsReady(state: OriginalsState | null): boolean {
  return Boolean(state && state.greek > 0 && state.hebrew > 0);
}

async function update(db: D1Database, changes: Partial<OriginalsState>): Promise<void> {
  const now = new Date().toISOString();
  const current = await originalsState(db);
  await putSetting(db, "bible_originals", { status: "working", detail: null, error: null, greek: 0, hebrew: 0, startedAt: now, ...current, ...changes, updatedAt: now });
}

/** Starts the background run that downloads the Greek and Hebrew texts. */
export async function startOriginalsImport(env: AppEnv): Promise<void> {
  await update(env.DB, { status: "working", detail: "Starting", error: null, startedAt: new Date().toISOString() });
  try {
    await env.BIBLE_WORKFLOW.create({ id: `originals-${Date.now()}`, params: { texts: "originals" } });
  } catch (error) {
    await update(env.DB, { status: "failed", detail: null, error: "The background run couldn't be started. Try again in a minute." });
    console.error("originals import failed to start", error);
  }
}

const STORE: StepConfig = { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" };
const FINISH: StepConfig = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" };
/** Books fetched and stored in one step; the Hebrew files are a megabyte or more each. */
const BOOKS_PER_STEP = 9;
const VERSES_PER_STATEMENT = 200;

async function storeBook(db: D1Database, book: Book): Promise<number> {
  const source = originalOf(book);
  const address = source.url(FILES[book.number - 1]!);
  const response = await fetch(address, { headers: withUserAgent(), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new ProviderError(`${new URL(address).hostname} returned HTTP ${response.status} for ${book.name} in the ${source.name}.`);
  const file = await response.text();
  const verses = source === ORIGINALS.greek ? parseGreek(file, book.number) : parseHebrew(file, book.number);
  if (verses.length === 0) throw new ProviderError(`${book.name} in the ${source.name} couldn't be read. ${new URL(address).hostname} may have sent a page instead of the file.`);
  const statements = [db.prepare("DELETE FROM bible_originals WHERE book = ?").bind(book.number)];
  for (let start = 0; start < verses.length; start += VERSES_PER_STATEMENT) {
    statements.push(db.prepare(
      `INSERT OR REPLACE INTO bible_originals (book, chapter, verse, text)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?)`,
    ).bind(JSON.stringify(verses.slice(start, start + VERSES_PER_STATEMENT).map((row) => [row.book, row.chapter, row.verse, row.text]))));
  }
  // One book at a time, all or nothing, so a chapter is never half there.
  await db.batch(statements);
  return verses.length;
}

/** The whole import, as workflow steps of a few books each. Starting it again replaces the texts with the sources' current editions. */
export async function importOriginals(env: AppEnv, step: PipelineStep): Promise<void> {
  const db = env.DB;
  try {
    for (let start = 0; start < BOOKS.length; start += BOOKS_PER_STEP) {
      const books = BOOKS.slice(start, start + BOOKS_PER_STEP);
      await step.do(`store ${books[0]!.name} to ${books.at(-1)!.name}`, STORE, async () => {
        for (const book of books) {
          await update(db, { detail: `Adding ${book.name} (${originalOf(book).language}), book ${book.number} of ${BOOKS.length}` });
          await storeBook(db, book);
        }
      });
    }
    await step.do("finish", FINISH, async () => {
      const counts = await db.prepare("SELECT coalesce(sum(book <= 39), 0) AS hebrew, coalesce(sum(book > 39), 0) AS greek FROM bible_originals").first<{ hebrew: number; greek: number }>();
      await update(db, { status: "done", detail: null, error: null, hebrew: counts?.hebrew ?? 0, greek: counts?.greek ?? 0 });
    });
  } catch (error) {
    await step.do("record failure", FINISH, async () => {
      await update(db, { status: "failed", detail: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) || "Unknown error." });
    });
  }
}

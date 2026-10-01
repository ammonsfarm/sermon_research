import { OUTPUTS, type OutputKind } from "./ask.ts";
import { splitTitle, unfence } from "./documents.ts";
import type { AppEnv } from "./env.ts";
import type { PipelineStep, StepConfig } from "./pipeline.ts";
import { ProviderError } from "./providers.ts";
import { chat, nearest, type Passage, preamble, sourcesPrompt, type StoredSource, toStored } from "./research.ts";
import { type Scope, scopeIds, seriesOf } from "./scope.ts";
import { getSetting, type Ministry } from "./settings.ts";

export type DocumentKind = Exclude<OutputKind, "answer">;

/** Sermons listed for the planner; larger libraries are narrowed to the closest matches first. */
const PLAN_CATALOG_MAX = 300;
/** Transcript characters one part is written from (about 60k tokens). Past this, the passages closest to the part are kept. */
export const PART_SOURCE_CHARS = 240_000;
/** The most parts (chapters, lessons) a document is split into. */
const MAX_PARTS = 30;
const MIN_WORDS = 150;
const MAX_WORDS = 5_000;
/** How much of the previous part the next one sees, so a long document reads as one piece. */
const PREVIOUS_TAIL_CHARS = 1_500;
/** Room for a long part, plus whatever a thinking model spends first. */
const PART_MAX_TOKENS = 16_000;
const PART_TIMEOUT_MS = 5 * 60_000;
const PLAN_MAX_TOKENS = 8_000;
const PLAN_TIMEOUT_MS = 2 * 60_000;
/** Runs that report nothing for this long are marked failed by the hourly tick. */
const STALE_WRITING_MS = 2 * 3_600_000;

const PLAN: StepConfig = { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "5 minutes" };
const WRITE: StepConfig = { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" };
const FINISH: StepConfig = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" };

const INSTRUCTIONS: Record<DocumentKind, string> = {
  outline: "Write a sermon outline for the request: a title, the big idea in one sentence, the main scripture passage, three or four main points each with sub-points and supporting scripture, illustrations taken from the sources, and a closing application section.",
  questions: "Write a small-group study guide for the request: a short introduction, the scripture to read first, then 8 to 12 discussion questions grouped under the headings Observation, Interpretation and Application, and a closing prayer prompt.",
  custom: "Write the document the request asks for.",
};

const SOURCE_RULES = "Use only the numbered sources: sermon summaries, and the sermons' transcripts in order, split into numbered passages. Draw on what the preacher actually said (explanations, stories, illustrations and applications), retold in your own words, and cite it with the source number in square brackets, like [2] or [2, 5]. Where the sources don't cover something the request asks for, say so briefly rather than inventing it. Don't add notes about the sources in general, their length, or how you wrote this.";

/** The instructions for a document written in one go (outlines, study guides, short custom documents). */
export function documentPrompt(kind: DocumentKind, ministry: Ministry | null): string {
  return `${preamble(ministry)} ${INSTRUCTIONS[kind]} ${SOURCE_RULES} Reply with a Markdown document only: start with a "# " title line, use "##" headings and "-" or numbered lists, and don't add a list of sources at the end, because one is added automatically.`;
}

function partPrompt(ministry: Ministry | null): string {
  return `${preamble(ministry)} You're writing one part of a longer document; the parts are written one at a time and joined in order. ${SOURCE_RULES} Reply with this part only, in Markdown: start with a "## " heading line, use "###" for subheadings and "-" or numbered lists, and don't add a list of sources, because one is added automatically.`;
}

function planPrompt(kind: DocumentKind, ministry: Ministry | null): string {
  const shape = kind === "custom"
    ? `If the request is for something long, like a book, a course or a series of lessons, split it into parts in reading order (for example one chapter per sermon or passage, plus an introduction or conclusion if the request suggests one), using at most ${MAX_PARTS} parts. Otherwise plan a single part.`
    : `The request is for a ${OUTPUTS[kind].toLowerCase()}, so plan a single part.`;
  return `${preamble(ministry)} You plan documents that will be written from the full transcripts of these sermons. You get a numbered list of sermons with their dates, scripture and topics, then a request. Choose every sermon the request draws on, and only those. ${shape} For each part give a heading, a one or two sentence brief, the numbers of the sermons it draws on (a part with none, like an introduction, works from the summaries of all the chosen sermons), and a length in words: the request's length if it gives one (10 minutes of reading is about 2,300 words), otherwise what suits the part. Reply with only a JSON object: {"title": "the document's title", "parts": [{"heading": "...", "brief": "...", "sermons": [1, 2], "words": 1500}]}.`;
}

// ---------------------------------------------------------------- planning

export interface PlannedPart {
  readonly heading: string;
  readonly brief: string;
  readonly episodeIds: readonly string[];
  /** Target length; 0 leaves it to the instructions. */
  readonly words: number;
}

export interface Plan {
  /** Empty when the document's own "# " line should give the title. */
  readonly title: string;
  /** Every sermon the plan uses, in reading order. */
  readonly episodeIds: readonly string[];
  readonly parts: readonly PlannedPart[];
}

interface Candidate {
  readonly id: string;
  readonly title: string;
  readonly publishedAt: string | null;
  readonly scriptures: readonly string[];
  readonly topics: readonly string[];
}

/** Indexed sermons the document's scope allows, oldest first. */
async function candidates(env: AppEnv, scope: Scope, request: string): Promise<Candidate[]> {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.title, e.published_at, s.scriptures_json, s.topics_json FROM episodes e JOIN summaries s ON s.episode_id = e.id
     WHERE e.status = 'done' ORDER BY e.published_at, e.id`,
  ).all<{ id: string; title: string; published_at: string | null; scriptures_json: string; topics_json: string }>();
  let rows: Candidate[] = results.map((row) => ({
    id: row.id, title: row.title, publishedAt: row.published_at,
    scriptures: JSON.parse(row.scriptures_json) as string[], topics: JSON.parse(row.topics_json) as string[],
  }));
  const allowed = scopeIds(scope, rows.map((row) => ({ id: row.id, title: row.title, publishedAt: row.publishedAt, series: seriesOf(row.title) })));
  if (allowed) {
    const ids = new Set(allowed);
    rows = rows.filter((row) => ids.has(row.id));
  }
  if (rows.length > PLAN_CATALOG_MAX) {
    const closest = new Set((await nearest(env, request, 100, allowed)).map((match) => match.id.split(":")[0]!));
    rows = rows.filter((row) => closest.has(row.id));
  }
  return rows;
}

/** Chooses the sermons and splits the document into parts. */
export async function planDocument(env: AppEnv, ministry: Ministry | null, kind: DocumentKind, request: string, scope: Scope): Promise<Plan> {
  const sermons = await candidates(env, scope, request);
  if (sermons.length === 0) throw new ProviderError("No indexed sermons match this document's scope.");
  if (kind !== "custom" && scope.episodes?.length) {
    // An outline or study guide of chosen sermons needs no planning.
    const ids = sermons.map((sermon) => sermon.id);
    return { title: "", episodeIds: ids, parts: [{ heading: "", brief: "", episodeIds: ids, words: 0 }] };
  }
  const list = sermons.map((sermon, index) => `${index + 1}. "${sermon.title}" (${sermon.publishedAt?.slice(0, 10) ?? "undated"})`
    + `${sermon.scriptures.length ? `. Scripture: ${sermon.scriptures.join(", ")}` : ""}${sermon.topics.length ? `. Topics: ${sermon.topics.join(", ")}` : ""}`).join("\n");
  const reply = await chat(env, planPrompt(kind, ministry), `Sermons:\n${list}\n\nRequest: ${request}`, { maxTokens: PLAN_MAX_TOKENS, timeoutMs: PLAN_TIMEOUT_MS });
  return parsePlan(reply, sermons);
}

/** Reads the planner's JSON leniently; sermon numbers refer to `sermons`. */
export function parsePlan(content: string, sermons: readonly { readonly id: string }[]): Plan {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1)) as Record<string, unknown>;
  } catch {
    throw new ProviderError("The answers AI didn't return the document's plan as JSON. Try again, or try a stronger model.");
  }
  const text = (value: unknown, max: number) => typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";
  const parts = (Array.isArray(parsed.parts) ? parsed.parts : []).slice(0, MAX_PARTS).map((value): PlannedPart => {
    const part = (value ?? {}) as Record<string, unknown>;
    const numbers = (Array.isArray(part.sermons) ? part.sermons : []).map(Number);
    const words = Number(part.words);
    return {
      heading: text(part.heading, 200),
      brief: text(part.brief, 600),
      episodeIds: [...new Set(numbers.flatMap((n) => Number.isInteger(n) && n >= 1 && n <= sermons.length ? [sermons[n - 1]!.id] : []))],
      words: Number.isFinite(words) && words > 0 ? Math.round(Math.min(MAX_WORDS, Math.max(MIN_WORDS, words))) : 0,
    };
  });
  const chosen = new Set(parts.flatMap((part) => part.episodeIds));
  if (chosen.size === 0) {
    throw new ProviderError("The answers AI didn't find sermons for this request. Name the sermons, series or passage, or choose sermons under Scope.");
  }
  return { title: text(parsed.title, 200).replace(/^#+\s*/u, ""), episodeIds: sermons.flatMap((sermon) => chosen.has(sermon.id) ? [sermon.id] : []), parts };
}

// ---------------------------------------------------------------- sources

type Row = Omit<Passage, "n">;

/** Every indexed passage of these sermons (or only their summaries), in reading order. */
async function passagesOf(db: D1Database, episodeIds: readonly string[], summariesOnly: boolean): Promise<Row[]> {
  const rows: Row[] = [];
  // D1 allows 100 bound parameters per statement.
  for (let start = 0; start < episodeIds.length; start += 50) {
    const batch = episodeIds.slice(start, start + 50);
    const { results } = await db.prepare(
      `SELECT c.id, c.episode_id, c.kind, c.seq, c.text, c.start_seconds, e.title, e.published_at
       FROM chunks c JOIN episodes e ON e.id = c.episode_id
       WHERE e.status = 'done' AND c.episode_id IN (${batch.map(() => "?").join(", ")})${summariesOnly ? " AND c.kind = 'summary'" : ""}`,
    ).bind(...batch).all<{ id: string; episode_id: string; kind: "summary" | "transcript"; seq: number; text: string; start_seconds: number | null; title: string; published_at: string | null }>();
    rows.push(...results.map((row) => ({
      chunkId: row.id, episodeId: row.episode_id, title: row.title, publishedAt: row.published_at,
      kind: row.kind, seq: row.seq, start: row.start_seconds, text: row.text,
    })));
  }
  return rows.sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? "") || a.episodeId.localeCompare(b.episodeId) || a.seq - b.seq);
}

/**
 * Whole transcripts when they fit in `budget` characters. Otherwise every
 * summary, then the passages in `closest` order while they fit, returned in
 * reading order.
 */
export function withinBudget(rows: readonly Row[], closest: readonly string[], budget: number): Row[] {
  if (rows.reduce((sum, row) => sum + row.text.length, 0) <= budget) return [...rows];
  const byId = new Map(rows.map((row) => [row.chunkId, row]));
  const priority = [...rows.filter((row) => row.kind === "summary"), ...closest.flatMap((id) => byId.get(id)?.kind === "transcript" ? [byId.get(id)!] : [])];
  const kept = new Set<string>();
  let left = budget;
  for (const row of priority) {
    if (row.text.length > left) continue;
    kept.add(row.chunkId);
    left -= row.text.length;
  }
  return rows.filter((row) => kept.has(row.chunkId));
}

async function partSources(env: AppEnv, plan: Plan, part: PlannedPart, request: string): Promise<Passage[]> {
  // A part without sermons of its own (an introduction, say) works from every chosen sermon's summary.
  const ids = part.episodeIds.length ? part.episodeIds : plan.episodeIds;
  const rows = await passagesOf(env.DB, ids, part.episodeIds.length === 0);
  const total = rows.reduce((sum, row) => sum + row.text.length, 0);
  const closest = total > PART_SOURCE_CHARS ? (await nearest(env, `${part.heading}\n${part.brief}\n${request}`, 100, ids)).map((match) => match.id) : [];
  return withinBudget(rows, closest, PART_SOURCE_CHARS).map((row, index) => ({ ...row, n: index + 1 }));
}

// ---------------------------------------------------------------- citations

/** A written part, with citations held as passage ids until the parts are joined and numbered. */
export interface WrittenPart {
  readonly markdown: string;
  readonly sources: readonly Row[];
}

const CITATION = /([ \t]*)\[(\d+(?:\s*[,–-]\s*\d+)*)\]/gu;
const PLACEHOLDER = /\{\{cite ([^}]+)\}\}/gu;

/** [2], [1, 3] and [4-6] as numbers. */
function citedNumbers(group: string): number[] {
  return group.split(",").flatMap((piece) => {
    const [from, to] = piece.split(/[–-]/u).map((value) => Number(value.trim()));
    return to !== undefined && to >= from! && to - from! < 20 ? Array.from({ length: to - from! + 1 }, (_unused, offset) => from! + offset) : [from!];
  });
}

/** Swaps a part's own source numbers for the passages they name, dropping numbers that aren't sources. */
export function toPlaceholders(markdown: string, passages: readonly Passage[]): WrittenPart {
  const cited = new Map<string, Row>();
  const text = markdown.replace(CITATION, (_match, space: string, group: string) => {
    const ids = [...new Set(citedNumbers(group).flatMap((n) => {
      const passage = passages[n - 1];
      if (!passage) return [];
      const { n: _n, ...row } = passage;
      cited.set(row.chunkId, row);
      return [row.chunkId];
    }))];
    return ids.length ? `${space}{{cite ${ids.join(" ")}}}` : "";
  });
  return { markdown: text, sources: [...cited.values()] };
}

/** Joins written parts and numbers the cited passages in the order they're first cited. */
export function assemble(parts: readonly WrittenPart[]): { markdown: string; sources: StoredSource[] } {
  const known = new Map(parts.flatMap((part) => part.sources.map((source) => [source.chunkId, source] as const)));
  const order = new Map<string, number>();
  const number = (id: string) => {
    if (!order.has(id)) order.set(id, order.size + 1);
    return order.get(id)!;
  };
  const markdown = parts.map((part) => part.markdown.trim()).join("\n\n")
    .replace(PLACEHOLDER, (_match, ids: string) => `[${ids.split(" ").filter((id) => known.has(id)).map(number).join(", ")}]`);
  return { markdown, sources: toStored([...order].map(([id, n]) => ({ ...known.get(id)!, n }))) };
}

/** Strips code fences and makes sure a part starts with a "## " heading. */
export function asPart(reply: string, heading: string): string {
  const text = unfence(reply);
  if (/^##\s/u.test(text)) return text;
  if (/^#\s/u.test(text)) return `#${text}`;
  return `## ${heading}\n\n${text}`;
}

// ---------------------------------------------------------------- the run

interface Job {
  readonly kind: DocumentKind;
  readonly request: string;
  readonly title: string;
  readonly scope: Scope;
}

async function loadJob(db: D1Database, documentId: string): Promise<Job> {
  const row = await db.prepare("SELECT kind, request, title, scope_json FROM documents WHERE id = ?").bind(documentId)
    .first<{ kind: DocumentKind; request: string; title: string; scope_json: string | null }>();
  if (!row) throw new ProviderError("The document was deleted.");
  return { kind: row.kind, request: row.request, title: row.title, scope: JSON.parse(row.scope_json ?? "{}") as Scope };
}

async function writePart(env: AppEnv, ministry: Ministry | null, job: Job, plan: Plan, index: number, previous: string): Promise<WrittenPart> {
  const part = plan.parts[index]!;
  const passages = await partSources(env, plan, part, job.request);
  if (passages.length === 0) throw new ProviderError("The chosen sermons have no indexed passages. Retry them in Admin → Episodes.");
  const sources = `Sources:\n\n${sourcesPrompt(passages)}`;
  const length = part.words ? `Aim for about ${part.words.toLocaleString("en-US")} words.` : "";
  const options = { maxTokens: PART_MAX_TOKENS, timeoutMs: PART_TIMEOUT_MS };
  if (plan.parts.length === 1) {
    const reply = await chat(env, documentPrompt(job.kind, ministry), [sources, `Request: ${job.request}`, length].filter(Boolean).join("\n\n"), options);
    return toPlaceholders(unfence(reply), passages);
  }
  const outline = plan.parts.map((each, at) => `${at + 1}. ${each.heading}${each.brief ? `: ${each.brief}` : ""}`).join("\n");
  const reply = await chat(env, partPrompt(ministry), [
    sources,
    `Request for the whole document: ${job.request}`,
    `The document is "${plan.title || job.title}", in ${plan.parts.length} parts:\n${outline}`,
    previous ? `Part ${index} ended like this. Carry on from it without repeating it:\n\n…${previous}` : "",
    `Write part ${index + 1} only: "${part.heading}".${part.brief ? ` It covers: ${part.brief}` : ""} ${length}`.trim(),
  ].filter(Boolean).join("\n\n"), options);
  return toPlaceholders(asPart(reply, part.heading || `Part ${index + 1}`), passages);
}

async function setDetail(db: D1Database, documentId: string, detail: string): Promise<void> {
  await db.prepare("UPDATE documents SET detail = ?, updated_at = ? WHERE id = ?").bind(detail, new Date().toISOString(), documentId).run();
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500) || "Unknown error.";
}

/** Shows what a step is doing, and that an error is being retried rather than ignored. */
function tracked<T>(db: D1Database, documentId: string, detail: string, work: () => Promise<T>): () => Promise<T> {
  return async () => {
    await setDetail(db, documentId, detail);
    try {
      return await work();
    } catch (error) {
      await setDetail(db, documentId, `${detail}: hit an error (${describeError(error).slice(0, 200)}), retrying automatically`).catch(() => undefined);
      throw error;
    }
  };
}

/**
 * Plans the document, writes each part from the full transcripts of its
 * sermons, then joins the parts. Every step's result is kept, so a retry
 * resumes at the part that failed.
 */
export async function writeDocument(env: AppEnv, step: PipelineStep, documentId: string): Promise<void> {
  const db = env.DB;
  try {
    const plan = await step.do("plan", PLAN, tracked(db, documentId, "Choosing the sermons and planning the parts", async () => {
      const [job, ministry] = await Promise.all([loadJob(db, documentId), getSetting<Ministry>(db, "ministry")]);
      const planned = await planDocument(env, ministry, job.kind, job.request, job.scope);
      if (planned.title) await db.prepare("UPDATE documents SET title = ? WHERE id = ?").bind(planned.title, documentId).run();
      return planned;
    }));
    const written: WrittenPart[] = [];
    for (const [index, part] of plan.parts.entries()) {
      const sermons = (part.episodeIds.length || plan.episodeIds.length).toLocaleString("en-US");
      const detail = plan.parts.length === 1
        ? `Writing from the full transcripts of ${sermons === "1" ? "1 sermon" : `${sermons} sermons`}`
        : `Writing part ${index + 1} of ${plan.parts.length}: ${part.heading}`;
      const previous = (written.at(-1)?.markdown ?? "").replace(PLACEHOLDER, "").slice(-PREVIOUS_TAIL_CHARS);
      written.push(await step.do(`write part ${index + 1}`, WRITE, tracked(db, documentId, detail, async () => {
        const [job, ministry] = await Promise.all([loadJob(db, documentId), getSetting<Ministry>(db, "ministry")]);
        return writePart(env, ministry, job, plan, index, previous);
      })));
    }
    await step.do("finish", FINISH, async () => {
      const job = await loadJob(db, documentId);
      const { markdown, sources } = assemble(written);
      const { title, body } = plan.parts.length === 1 ? splitTitle(markdown, plan.title || job.title) : { title: plan.title || job.title, body: markdown };
      await db.prepare("UPDATE documents SET status = 'done', title = ?, markdown = ?, sources_json = ?, detail = NULL, error = NULL, updated_at = ? WHERE id = ?")
        .bind(title, body, JSON.stringify(sources), new Date().toISOString(), documentId).run();
    });
  } catch (error) {
    await step.do("record failure", FINISH, async () => {
      await db.prepare("UPDATE documents SET status = 'failed', detail = NULL, error = ?, updated_at = ? WHERE id = ?")
        .bind(describeError(error), new Date().toISOString(), documentId).run();
    });
  }
}

/** Starts the background run that writes a document. False when Workflows couldn't take it. */
export async function startWriting(env: AppEnv, documentId: string, runId = documentId): Promise<boolean> {
  try {
    await env.DOCUMENT_WORKFLOW.create({ id: runId, params: { documentId } });
    return true;
  } catch (error) {
    console.error("could not start document workflow", documentId, error);
    return false;
  }
}

/** Fails documents whose run stopped reporting progress, so they can be tried again. Called hourly. */
export async function failStaleDocuments(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare("UPDATE documents SET status = 'failed', detail = NULL, error = 'The writing stopped reporting progress. Try again.', updated_at = ? WHERE status = 'writing' AND updated_at < ?")
    .bind(new Date(now).toISOString(), new Date(now - STALE_WRITING_MS).toISOString()).run();
}

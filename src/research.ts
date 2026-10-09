import { type Context, clientIp, redirect, requireAdmin, chrome } from "./context.ts";
import { html, type Html, page } from "./html.ts";
import { renderMarkdown } from "./markdown.ts";
import { ProviderError } from "./providers.ts";
import { embed, requireKey, type Segment } from "./pipeline.ts";
import { chatCompletion, type LlmAction, resolveTarget } from "./llm.ts";
import { getSetting, getSetupStep, type Ministry, putSetting } from "./settings.ts";
import { HOUR_MS, recordUse, startOfUtcDay, usedSince } from "./usage.ts";
import type { AppEnv } from "./env.ts";

export interface ResearchSettings {
  /** Who can use the research pages. Admin pages always need an admin. */
  readonly access: "members" | "public";
  /** Questions per UTC day across everyone except admins; caps AI spending. */
  readonly dailyQuestions: number;
}

export const DEFAULT_RESEARCH: ResearchSettings = { access: "members", dailyQuestions: 200 };

/** Questions per hour for one visitor (by IP) or one signed-in person. */
export const ANONYMOUS_PER_HOUR = 20;
const SIGNED_IN_PER_HOUR = 60;
/** Semantic searches per hour; past this, search falls back to keywords only. */
export const SEARCHES_PER_HOUR = 60;
export const QUESTION_MAX = 500;
const SOURCES = 8;
/** Generous because thinking models can spend part of this before replying; the prompt keeps answers short. */
const ANSWER_MAX_TOKENS = 4_000;

export async function researchSettings(db: D1Database): Promise<ResearchSettings> {
  return { ...DEFAULT_RESEARCH, ...(await getSetting<Partial<ResearchSettings>>(db, "research")) };
}

/** True when this visitor may use the research pages and play episode audio. */
export async function canViewResearch(context: Context): Promise<boolean> {
  if ((await getSetupStep(context.db)) !== "complete") return false;
  if (context.session) return true;
  return (await researchSettings(context.db)).access === "public";
}

/** Null when the visitor may use the research pages, otherwise the response to send. */
export async function gate(context: Context): Promise<Response | null> {
  if ((await getSetupStep(context.db)) !== "complete") {
    return context.session?.user.role === "admin" ? redirect("/admin") : page("Not ready", html`<h1>Not ready yet</h1><p class="lead">This site is still being set up.</p>`, { status: 503, ...chrome(context) });
  }
  if (context.session) return null;
  return (await researchSettings(context.db)).access === "public" ? null : redirect("/login");
}

/**
 * Counts one question or document against the per-person hourly limit and
 * the site's daily limit (admins are exempt from the daily one). Returns the
 * message to show when a limit is reached.
 */
export async function useQuota(context: Context): Promise<string | null> {
  const { db } = context;
  const who = actor(context);
  const now = Date.now();
  if (await usedSince(db, who.bucket, now - HOUR_MS) >= who.perHour) return "You've asked a lot of questions this hour. Try again later.";
  const isAdmin = context.session?.user.role === "admin";
  if (!isAdmin && await usedSince(db, "ask-all", startOfUtcDay(now)) >= (await researchSettings(db)).dailyQuestions) {
    return "This site has reached its limit of questions for today. Try again tomorrow.";
  }
  await recordUse(db, isAdmin ? [who.bucket] : [who.bucket, "ask-all"], now);
  return null;
}

function actor(context: Context): { bucket: string; perHour: number } {
  return context.session
    ? { bucket: `ask-user:${context.session.user.id}`, perHour: SIGNED_IN_PER_HOUR }
    : { bucket: `ask-ip:${clientIp(context.request)}`, perHour: ANONYMOUS_PER_HOUR };
}

export function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// ---------------------------------------------------------------- retrieval

export interface Passage {
  readonly n: number;
  readonly chunkId: string;
  readonly episodeId: string;
  readonly title: string;
  readonly publishedAt: string | null;
  /** Who preached it; missing from sources saved before speakers were kept. */
  readonly speaker?: string | null;
  readonly kind: "summary" | "transcript";
  readonly seq: number;
  readonly start: number | null;
  readonly text: string;
}

/** A source as saved with an answer or document, so it survives re-indexing. */
export type StoredSource = Omit<Passage, "chunkId">;
const STORED_SOURCE_CHARS = 600;

export function toStored(passages: readonly Passage[]): StoredSource[] {
  return passages.map(({ chunkId: _chunkId, ...passage }) => ({ ...passage, text: passage.text.slice(0, STORED_SOURCE_CHARS) }));
}

/** Vectorize filters are limited in size, so larger scopes filter the results instead. */
const MAX_FILTER_IDS = 40;
/** The most matches Vectorize returns without metadata. */
const MAX_TOP_K = 100;

/**
 * Vector ids are `${episodeId}:${seq}`, matching rows in `chunks`. With
 * `episodeIds`, only passages from those episodes are returned.
 */
export async function nearest(env: AppEnv, text: string, topK: number, episodeIds: readonly string[] | null = null): Promise<{ id: string; score: number }[]> {
  if (episodeIds?.length === 0) return [];
  const [vector] = await embed([text], await requireKey(env, "embeddings"));
  const filtered = episodeIds && episodeIds.length <= MAX_FILTER_IDS;
  const result = await env.VECTORS.query(vector!, {
    topK: episodeIds && !filtered ? MAX_TOP_K : topK,
    returnMetadata: "none",
    returnValues: false,
    ...(filtered ? { filter: { episodeId: { $in: [...episodeIds] } } } : {}),
  });
  const allowed = episodeIds ? new Set(episodeIds) : null;
  return result.matches
    .filter((match) => !allowed || allowed.has(match.id.split(":")[0]!))
    .slice(0, topK)
    .map((match) => ({ id: match.id, score: match.score }));
}

export async function retrieve(env: AppEnv, question: string, topK = SOURCES, episodeIds: readonly string[] | null = null): Promise<Passage[]> {
  const matches = await nearest(env, question, topK, episodeIds);
  if (matches.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.episode_id, c.kind, c.seq, c.text, c.start_seconds, e.title, e.published_at, e.speaker
     FROM chunks c JOIN episodes e ON e.id = c.episode_id
     WHERE e.status = 'done' AND c.id IN (${matches.map(() => "?").join(", ")})`,
  ).bind(...matches.map((match) => match.id)).all<{ id: string; episode_id: string; kind: "summary" | "transcript"; seq: number; text: string; start_seconds: number | null; title: string; published_at: string | null; speaker: string | null }>();
  const byId = new Map(results.map((row) => [row.id, row]));
  return matches.flatMap((match) => byId.get(match.id) ?? []).map((row, index) => ({
    n: index + 1, chunkId: row.id, episodeId: row.episode_id, title: row.title, publishedAt: row.published_at, speaker: row.speaker,
    kind: row.kind, seq: row.seq, start: row.start_seconds, text: row.text,
  }));
}

/** Who the sermons come from, for the answers AI's instructions. */
export function preamble(ministry: Ministry | null): string {
  const church = ministry?.churchName ?? "this church";
  const speakers = ministry?.speakerNames.length ? ` The speakers include ${ministry.speakerNames.join(", ")}.` : "";
  return `You help people study sermons preached at ${church}.${speakers}`;
}

/** The numbered sources block every prompt shares. */
export function sourcesPrompt(passages: readonly Passage[]): string {
  return passages.map((passage) =>
    `[${passage.n}] "${passage.title}" (${[passage.publishedAt?.slice(0, 10) ?? "undated", passage.speaker].filter(Boolean).join(", ")})${passage.kind === "summary" ? ", summary" : passage.start !== null ? `, at ${formatTime(passage.start)}` : ""}:\n${passage.text}`).join("\n\n");
}

/**
 * Reads a reply mapping item numbers to values, like {"1": "a", "2": null},
 * into `count` values in order, each passed through `read`. Throws when the
 * reply isn't JSON; `what` names the items in that message.
 */
export function parseNumbered<T>(content: string, count: number, read: (value: unknown) => T, what: string): T[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1)) as Record<string, unknown>;
  } catch {
    throw new ProviderError(`The answers AI didn't return the ${what} as JSON.`);
  }
  return Array.from({ length: count }, (_unused, index) => read(parsed[String(index + 1)]));
}

/**
 * One chat completion from the answers AI. Sermon processing passes `action: "summary"` and document
 * writing `"document"`; the rest are chat. `userId` applies that person's limit on models, and `model`
 * is the one they picked ("provider/model"), used when they're allowed it.
 */
export async function chat(env: AppEnv, system: string, user: string, options: { maxTokens: number; timeoutMs: number; action?: LlmAction; userId?: string | null; model?: string | null }): Promise<string> {
  const target = await resolveTarget(env, { action: options.action ?? "chat", userId: options.userId ?? null, choice: options.model ?? null });
  const { content } = await chatCompletion(target, [{ role: "system", content: system }, { role: "user", content: user }], options);
  if (!content?.trim()) throw new ProviderError("The answers AI returned an empty answer.");
  return content.trim();
}

/** Earlier questions and answers in a conversation, oldest first. */
export interface Exchange { readonly question: string; readonly answer: string }
/** How many earlier exchanges a follow-up sees. */
const HISTORY_TURNS = 3;

export async function answer(
  env: AppEnv, ministry: Ministry | null, question: string, passages: readonly Passage[], history: readonly Exchange[] = [], who: { userId?: string | null; model?: string | null } = {},
): Promise<string> {
  const system = `${preamble(ministry)} Answer only from the numbered sources, which are passages from sermon transcripts and summaries. Cite every claim with the source number in square brackets, like [2]. If the sources don't answer the question, say so plainly and don't guess. Keep answers under 250 words, in plain paragraphs.${history.length ? " This is a follow-up: use the earlier conversation to understand what the question refers to, but cite only the numbered sources below." : ""}`;
  const earlier = history.slice(-HISTORY_TURNS).map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join("\n\n");
  return chat(env, system, `${earlier ? `Earlier in this conversation:\n\n${earlier}\n\n` : ""}Sources:\n\n${sourcesPrompt(passages)}\n\nQuestion: ${question}`, { maxTokens: ANSWER_MAX_TOKENS, timeoutMs: 60_000, ...who });
}

/** The numbered list of sources under an answer or document, as cards. */
export function sourcesList(passages: readonly Omit<Passage, "chunkId">[], options: { prefix?: string; collapsed?: boolean } = {}): Html {
  const prefix = options.prefix ?? "source";
  const list = html`<ol class="sources">
${passages.map((passage) => html`<li id="${prefix}-${passage.n}"><span class="n">${passage.n}</span> <a href="/episodes/${passage.episodeId}#t-${passage.seq}">${passage.title}</a>
<span class="hint">${passage.publishedAt?.slice(0, 10) ?? ""}${passage.speaker ? ` · ${passage.speaker}` : ""}${passage.kind === "summary" ? " · summary" : passage.start !== null ? ` · ${formatTime(passage.start)}` : ""}</span>
<p class="quote">${passage.text.length > 400 ? `${passage.text.slice(0, 400)}…` : passage.text}</p></li>`)}
</ol>`;
  return options.collapsed
    ? html`<details class="sources"><summary>Sources (${passages.length})</summary>${list}</details>`
    : html`<h2>Sources</h2>${list}`;
}

/** Renders an answer (a little Markdown) and turns [1] or [1, 3] into links to the matching sources. */
export function renderAnswer(text: string, sourceCount: number, prefix = "source"): Html {
  return renderMarkdown(text, sourceCount, prefix);
}

// ---------------------------------------------------------------- pages

// ---------------------------------------------------------------- admin

/** GET/POST /admin/research */
export async function researchAdmin(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  let settings = await researchSettings(context.db);
  let error = "";
  if (context.request.method === "POST") {
    const form = await context.request.formData();
    const access = String(form.get("access"));
    const daily = Number(form.get("dailyQuestions"));
    if (access !== "members" && access !== "public") error = "Choose who can use the research pages.";
    else if (!Number.isInteger(daily) || daily < 0 || daily > 100_000) error = "Enter a daily limit between 0 and 100,000.";
    else {
      settings = { access, dailyQuestions: daily };
      await putSetting(context.db, "research", settings);
      return redirect("/admin?saved=1");
    }
  }
  const option = (value: ResearchSettings["access"], label: string, hint: string) =>
    html`<label class="choice"><input type="radio" name="access" value="${value}"${settings.access === value ? html` checked` : ""}><span><strong>${label}</strong><br><span class="hint">${hint}</span></span></label>`;
  return page("Research access", html`<h1>Research access</h1>
${error ? html`<p class="alert">${error}</p>` : ""}
<form method="post" action="/admin/research">
<fieldset class="choices"><legend>Who can ask questions and read episodes?</legend>
${option("members", "Members only", "People you invite from Admin → Members, plus admins.")}
${option("public", "Anyone", `Visitors without an account can ask up to ${ANONYMOUS_PER_HOUR} questions an hour each.`)}
</fieldset>
<div class="field"><label for="f-dailyQuestions">Questions per day, across everyone</label>
<p class="hint">Each question costs one answers-AI call. Admins aren't counted. The count resets at midnight UTC.</p>
<input id="f-dailyQuestions" name="dailyQuestions" type="number" min="0" max="100000" value="${settings.dailyQuestions}" required></div>
<button type="submit">Save</button>
</form>`, { status: error ? 400 : 200, ...chrome(context) });
}

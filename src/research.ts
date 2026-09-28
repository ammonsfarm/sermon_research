import { type Context, clientIp, redirect, requireAdmin, siteTitle } from "./context.ts";
import { html, type Html, page } from "./html.ts";
import { ProviderError, withUserAgent } from "./providers.ts";
import { embed, requireKey } from "./pipeline.ts";
import { getSetting, getSetupStep, type LlmSettingsRecord, type Ministry, putSetting } from "./settings.ts";
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
const ANONYMOUS_PER_HOUR = 20;
const SIGNED_IN_PER_HOUR = 60;
/** Semantic searches per hour; past this, search falls back to keywords only. */
const SEARCHES_PER_HOUR = 60;
const QUESTION_MAX = 500;
const SOURCES = 8;
/** Generous because thinking models can spend part of this before replying; the prompt keeps answers short. */
const ANSWER_MAX_TOKENS = 4_000;

export async function researchSettings(db: D1Database): Promise<ResearchSettings> {
  return { ...DEFAULT_RESEARCH, ...(await getSetting<Partial<ResearchSettings>>(db, "research")) };
}

/** Null when the visitor may use the research pages, otherwise the response to send. */
async function gate(context: Context): Promise<Response | null> {
  if ((await getSetupStep(context.db)) !== "complete") {
    return context.session?.user.role === "admin" ? redirect("/admin") : page("Not ready", html`<h1>Not ready yet</h1><p class="lead">This site is still being set up.</p>`, { status: 503, ...siteTitle(context) });
  }
  if (context.session) return null;
  return (await researchSettings(context.db)).access === "public" ? null : redirect("/login");
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

function nav(context: Context, current: "ask" | "episodes"): Html {
  const user = context.session?.user;
  return html`<p class="steps">${current === "ask" ? html`<strong>Ask</strong>` : html`<a href="/research">Ask</a>`} · ${current === "episodes" ? html`<strong>Episodes</strong>` : html`<a href="/episodes">Episodes</a>`}${user?.role === "admin" ? html` · <a href="/admin">Admin</a>` : ""}${user ? "" : html` · <a href="/login">Sign in</a>`}</p>`;
}

// ---------------------------------------------------------------- retrieval

export interface Passage {
  readonly n: number;
  readonly chunkId: string;
  readonly episodeId: string;
  readonly title: string;
  readonly publishedAt: string | null;
  readonly kind: "summary" | "transcript";
  readonly seq: number;
  readonly start: number | null;
  readonly text: string;
}

/** Vector ids are `${episodeId}:${seq}`, matching rows in `chunks`. */
async function nearest(env: AppEnv, text: string, topK: number): Promise<{ id: string; score: number }[]> {
  const [vector] = await embed([text], await requireKey(env, "embeddings"));
  const result = await env.VECTORS.query(vector!, { topK, returnMetadata: "none", returnValues: false });
  return result.matches.map((match) => ({ id: match.id, score: match.score }));
}

export async function retrieve(env: AppEnv, question: string): Promise<Passage[]> {
  const matches = await nearest(env, question, SOURCES);
  if (matches.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.episode_id, c.kind, c.seq, c.text, c.start_seconds, e.title, e.published_at
     FROM chunks c JOIN episodes e ON e.id = c.episode_id
     WHERE e.status = 'done' AND c.id IN (${matches.map(() => "?").join(", ")})`,
  ).bind(...matches.map((match) => match.id)).all<{ id: string; episode_id: string; kind: "summary" | "transcript"; seq: number; text: string; start_seconds: number | null; title: string; published_at: string | null }>();
  const byId = new Map(results.map((row) => [row.id, row]));
  return matches.flatMap((match) => byId.get(match.id) ?? []).map((row, index) => ({
    n: index + 1, chunkId: row.id, episodeId: row.episode_id, title: row.title, publishedAt: row.published_at,
    kind: row.kind, seq: row.seq, start: row.start_seconds, text: row.text,
  }));
}

export async function answer(env: AppEnv, ministry: Ministry | null, question: string, passages: readonly Passage[]): Promise<string> {
  const llm = await getSetting<LlmSettingsRecord>(env.DB, "llm");
  if (!llm) throw new ProviderError("The answers AI isn't set up.");
  const apiKey = await requireKey(env, "llm");
  const church = ministry?.churchName ?? "this church";
  const speakers = ministry?.speakerNames.length ? ` The speakers include ${ministry.speakerNames.join(", ")}.` : "";
  const system = `You help people study sermons preached at ${church}.${speakers} Answer only from the numbered sources, which are passages from sermon transcripts and summaries. Cite every claim with the source number in square brackets, like [2]. If the sources don't answer the question, say so plainly and don't guess. Keep answers under 250 words, in plain paragraphs.`;
  const sources = passages.map((passage) =>
    `[${passage.n}] "${passage.title}" (${passage.publishedAt?.slice(0, 10) ?? "undated"})${passage.kind === "summary" ? ", summary" : passage.start !== null ? `, at ${formatTime(passage.start)}` : ""}:\n${passage.text}`).join("\n\n");
  const response = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: withUserAgent({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }),
    body: JSON.stringify({
      model: llm.model,
      messages: [{ role: "system", content: system }, { role: "user", content: `Sources:\n\n${sources}\n\nQuestion: ${question}` }],
      max_tokens: ANSWER_MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new ProviderError(`The answers AI returned HTTP ${response.status}.`);
  const content = ((await response.json()) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new ProviderError("The answers AI returned an empty answer.");
  return content.trim();
}

/** Escapes the answer and turns [1] or [1, 3] into links to the matching sources. */
export function renderAnswer(text: string, sourceCount: number): Html {
  const paragraphs = text.split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter(Boolean);
  return html`${paragraphs.map((paragraph) => {
    const parts: Html[] = [];
    let last = 0;
    for (const match of paragraph.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/gu)) {
      parts.push(html`${paragraph.slice(last, match.index)}`);
      const numbers = match[1]!.split(",").map((value) => Number(value.trim()));
      parts.push(numbers.every((n) => n >= 1 && n <= sourceCount)
        ? html`<sup>${numbers.map((n, index) => html`${index ? ", " : ""}<a href="#source-${n}">${n}</a>`)}</sup>`
        : html`${match[0]}`);
      last = match.index + match[0].length;
    }
    parts.push(html`${paragraph.slice(last)}`);
    return html`<p>${parts}</p>`;
  })}`;
}

// ---------------------------------------------------------------- pages

function askForm(question = ""): Html {
  return html`<form method="post" action="/research">
<div class="field"><label for="f-question">Ask about the sermons</label>
<textarea id="f-question" name="question" rows="3" maxlength="${QUESTION_MAX}" required>${question}</textarea></div>
<button type="submit">Ask</button>
</form>`;
}

/** GET /research */
export async function researchPage(context: Context): Promise<Response> {
  const blocked = await gate(context);
  if (blocked) return blocked;
  const done = await context.db.prepare("SELECT count(*) AS n FROM episodes WHERE status = 'done'").first<{ n: number }>();
  return page("Ask", html`${nav(context, "ask")}
<h1>Ask</h1>
<p class="lead">Answers come only from ${done?.n ?? 0} indexed sermons, with links to the passages they're based on.</p>
${askForm()}`, siteTitle(context));
}

/** POST /research */
export async function researchAsk(context: Context): Promise<Response> {
  const blocked = await gate(context);
  if (blocked) return blocked;
  const question = String((await context.request.formData()).get("question") ?? "").trim().slice(0, QUESTION_MAX);
  const show = (body: Html, status = 200) => page("Ask", html`${nav(context, "ask")}<h1>Ask</h1>${askForm(question)}${body}`, { status, ...siteTitle(context) });
  if (question.length < 3) return show(html`<p class="alert">Type a question first.</p>`, 400);

  const { db } = context;
  const who = actor(context);
  const now = Date.now();
  if (await usedSince(db, who.bucket, now - HOUR_MS) >= who.perHour) {
    return show(html`<p class="alert">You've asked a lot of questions this hour. Try again later.</p>`, 429);
  }
  const isAdmin = context.session?.user.role === "admin";
  if (!isAdmin && await usedSince(db, "ask-all", startOfUtcDay(now)) >= (await researchSettings(db)).dailyQuestions) {
    return show(html`<p class="alert">This site has reached its limit of questions for today. Try again tomorrow.</p>`, 429);
  }
  await recordUse(db, isAdmin ? [who.bucket] : [who.bucket, "ask-all"], now);

  let passages: Passage[];
  let text: string;
  try {
    passages = await retrieve(context.env, question);
    if (passages.length === 0) return show(html`<p>No sermons have been indexed yet, so there's nothing to answer from.</p>`);
    text = await answer(context.env, context.ministry, question, passages);
  } catch (error) {
    console.error("research answer failed", error);
    return show(html`<p class="alert">The answer couldn't be generated right now. Try again in a minute.</p>`, 502);
  }
  return show(html`<section class="answer">${renderAnswer(text, passages.length)}</section>
<h2>Sources</h2>
<ol class="sources">
${passages.map((passage) => html`<li id="source-${passage.n}"><a href="/episodes/${passage.episodeId}#t-${passage.seq}">${passage.title}</a>
<span class="hint">${passage.publishedAt?.slice(0, 10) ?? ""}${passage.kind === "summary" ? " · summary" : passage.start !== null ? ` · ${formatTime(passage.start)}` : ""}</span>
<p class="quote">${passage.text.length > 400 ? `${passage.text.slice(0, 400)}…` : passage.text}</p></li>`)}
</ol>
<p class="hint">AI answers can be wrong. Check the sources before quoting them.</p>`);
}

interface EpisodeListRow { readonly id: string; readonly title: string; readonly published_at: string | null; readonly summary: string | null }

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;
}

/** GET /episodes?q= : keyword matches first, then semantic matches the keywords missed. */
export async function episodesPage(context: Context): Promise<Response> {
  const blocked = await gate(context);
  if (blocked) return blocked;
  const { db } = context;
  const query = (context.url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const select = "SELECT e.id, e.title, e.published_at, s.summary FROM episodes e LEFT JOIN summaries s ON s.episode_id = e.id WHERE e.status = 'done'";
  let keyword: EpisodeListRow[];
  let related: EpisodeListRow[] = [];
  let note = "";
  if (!query) {
    keyword = (await db.prepare(`${select} ORDER BY e.published_at DESC LIMIT 100`).all<EpisodeListRow>()).results;
  } else {
    const like = likePattern(query);
    keyword = (await db.prepare(`${select} AND (e.title LIKE ?1 ESCAPE '\\' OR s.summary LIKE ?1 ESCAPE '\\' OR s.topics_json LIKE ?1 ESCAPE '\\' OR s.scriptures_json LIKE ?1 ESCAPE '\\') ORDER BY e.published_at DESC LIMIT 50`)
      .bind(like).all<EpisodeListRow>()).results;
    const bucket = context.session ? `search-user:${context.session.user.id}` : `search-ip:${clientIp(context.request)}`;
    if (await usedSince(db, bucket, Date.now() - HOUR_MS) >= SEARCHES_PER_HOUR) {
      note = "Showing keyword matches only; related-meaning search is paused for this hour.";
    } else {
      await recordUse(db, [bucket]);
      try {
        const seen = new Set(keyword.map((row) => row.id));
        const ids = [...new Set((await nearest(context.env, query, 20)).map((match) => match.id.split(":")[0]!))].filter((id) => !seen.has(id)).slice(0, 10);
        if (ids.length > 0) {
          const rows = (await db.prepare(`${select} AND e.id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all<EpisodeListRow>()).results;
          const byId = new Map(rows.map((row) => [row.id, row]));
          related = ids.flatMap((id) => byId.get(id) ?? []);
        }
      } catch (error) {
        console.error("semantic search failed", error);
        note = "Related-meaning search isn't available right now; showing keyword matches.";
      }
    }
  }
  const list = (rows: readonly EpisodeListRow[]) => html`<ul class="episode-list">${rows.map((row) => html`<li><a href="/episodes/${row.id}">${row.title}</a> <span class="hint">${row.published_at?.slice(0, 10) ?? ""}</span>
${row.summary ? html`<p class="hint">${row.summary.length > 220 ? `${row.summary.slice(0, 220)}…` : row.summary}</p>` : ""}</li>`)}</ul>`;
  return page("Episodes", html`${nav(context, "episodes")}
<h1>Episodes</h1>
<form method="get" action="/episodes" class="row search">
<input name="q" type="search" value="${query}" placeholder="Search titles, topics, scripture or ideas" aria-label="Search episodes">
<button type="submit">Search</button>
</form>
${note ? html`<p class="hint">${note}</p>` : ""}
${query && keyword.length === 0 && related.length === 0 ? html`<p>No episodes match.</p>` : ""}
${keyword.length ? list(keyword) : ""}
${related.length ? html`<h2>Related</h2>${list(related)}` : ""}
${!query && keyword.length === 0 ? html`<p>No episodes have been processed yet.</p>` : ""}`, siteTitle(context));
}

function isWebUrl(value: string | null): value is string {
  return Boolean(value && /^https?:\/\//iu.test(value));
}

/** GET /episodes/:id */
export async function episodePage(context: Context, id: string): Promise<Response> {
  const blocked = await gate(context);
  if (blocked) return blocked;
  const { db } = context;
  const episode = await db.prepare(
    `SELECT e.id, e.title, e.published_at, e.audio_url, s.summary, s.topics_json, s.scriptures_json
     FROM episodes e JOIN summaries s ON s.episode_id = e.id WHERE e.id = ? AND e.status = 'done'`,
  ).bind(id).first<{ id: string; title: string; published_at: string | null; audio_url: string | null; summary: string; topics_json: string; scriptures_json: string }>();
  if (!episode) return page("Not found", html`<h1>Episode not found</h1><p><a href="/episodes">All episodes</a></p>`, { status: 404, ...siteTitle(context) });
  const chunks = (await db.prepare("SELECT seq, text, start_seconds FROM chunks WHERE episode_id = ? AND kind = 'transcript' ORDER BY seq")
    .bind(id).all<{ seq: number; text: string; start_seconds: number | null }>()).results;
  const topics = JSON.parse(episode.topics_json) as string[];
  const scriptures = JSON.parse(episode.scriptures_json) as string[];
  const audio = isWebUrl(episode.audio_url) ? episode.audio_url : null;
  return page(episode.title, html`${nav(context, "episodes")}
<h1>${episode.title}</h1>
<p class="hint">${episode.published_at?.slice(0, 10) ?? ""}</p>
${audio ? html`<audio controls preload="none" src="${audio}"></audio>` : ""}
<section id="t-0"><h2>Summary</h2>${episode.summary.split(/\n\s*\n/u).map((paragraph) => html`<p>${paragraph}</p>`)}
${topics.length ? html`<p><strong>Topics:</strong> ${topics.join(", ")}</p>` : ""}
${scriptures.length ? html`<p><strong>Scripture:</strong> ${scriptures.join(", ")}</p>` : ""}</section>
<h2>Transcript</h2>
${chunks.map((chunk) => html`<div class="passage" id="t-${chunk.seq}">
${chunk.start_seconds !== null ? html`<p class="hint">${audio ? html`<a href="${audio}#t=${Math.floor(chunk.start_seconds)}">Listen from ${formatTime(chunk.start_seconds)}</a>` : formatTime(chunk.start_seconds)}</p>` : ""}
<p>${chunk.text}</p></div>`)}`, siteTitle(context));
}

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
  return page("Research access", html`<p class="steps"><a href="/admin">Admin</a></p>
<h1>Research access</h1>
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
</form>`, { status: error ? 400 : 200, ...siteTitle(context) });
}

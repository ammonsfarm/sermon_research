import { hasAdmin } from "./auth.ts";
import { chrome, type Context, redirect } from "./context.ts";
import { createDocument, recentDocuments } from "./documents.ts";
import { html, type Html, page } from "./html.ts";
import {
  answer, canViewResearch, type Exchange, gate, type Passage, QUESTION_MAX, renderAnswer, retrieve, sourcesList, type StoredSource, toStored, useQuota,
} from "./research.ts";
import { type CatalogEntry, catalog, describeScope, isAll, parseScope, type Scope, scopeControls, scopeFields, scopeIds, titleWithoutSeries } from "./scope.ts";
import { getSetupStep } from "./settings.ts";
import { homeView } from "./views.ts";

export const OUTPUTS = {
  answer: "Answer",
  outline: "Sermon outline",
  questions: "Study questions",
  custom: "Custom document",
} as const;
export type OutputKind = keyof typeof OUTPUTS;

export function parseOutput(value: unknown): OutputKind {
  return typeof value === "string" && Object.hasOwn(OUTPUTS, value) ? value as OutputKind : "answer";
}

const BUSY = "Reading the sermons and writing… this can take up to a minute.";

interface AskBoxOptions {
  readonly question?: string;
  readonly kind?: OutputKind;
  readonly scope?: Scope;
  readonly entries: readonly CatalogEntry[];
  /** A conversation to add a follow-up to; its scope is fixed. */
  readonly thread?: string;
  readonly label?: string;
  readonly autofocus?: boolean;
  /** Keep the scope as given, without the scope controls (sermon pages). */
  readonly fixedScope?: boolean;
}

/** The question box with its output choice and scope, used on Ask, conversations and sermon pages. */
export function askBox(context: Context, options: AskBoxOptions): Html {
  const signedIn = Boolean(context.session);
  const kind = options.kind ?? "answer";
  const scope = options.scope ?? {};
  return html`<form class="ask-box" method="post" action="/research" data-busy="${BUSY}">
<label for="f-question" class="visually-hidden">${options.label ?? "Your question"}</label>
<textarea id="f-question" name="question" rows="3" maxlength="${QUESTION_MAX}" required placeholder="${options.label ?? "Ask anything about the sermons, or describe a document you want"}"${options.autofocus ? html` autofocus` : ""}>${options.question ?? ""}</textarea>
<div class="controls">
${options.fixedScope ? html`<input type="hidden" name="kind" value="answer">` : html`<label for="f-kind" class="inline-label hint">Create</label>
<select id="f-kind" name="kind">${Object.entries(OUTPUTS).map(([value, label]) => html`<option value="${value}"${value === kind ? html` selected` : ""}${value !== "answer" && !signedIn ? html` disabled` : ""}>${label}</option>`)}</select>`}
${options.thread ? html`<input type="hidden" name="thread" value="${options.thread}">` : ""}${options.thread || options.fixedScope ? scopeFields(scope) : scopeControls(scope, options.entries)}
<span class="spacer"></span>
<button type="submit">${options.thread ? "Ask follow-up" : "Ask"}</button>
</div>
${signedIn ? "" : html`<p class="hint"><a href="/login">Sign in</a> to keep conversations and create outlines, study questions and other documents.</p>`}
</form>`;
}

// ---------------------------------------------------------------- storage

interface TurnRow {
  readonly id: string;
  readonly thread_id: string;
  readonly user_id: string | null;
  readonly question: string;
  readonly answer: string;
  readonly sources_json: string;
  readonly scope_json: string;
  readonly created_at: string;
}

/** A conversation's turns, oldest first, if the signed-in person owns it. */
async function loadThread(context: Context, threadId: string): Promise<TurnRow[] | null> {
  const user = context.session?.user;
  if (!user) return null;
  const { results } = await context.db.prepare("SELECT * FROM turns WHERE thread_id = ? ORDER BY created_at, rowid").bind(threadId).all<TurnRow>();
  if (results.length === 0 || results[0]!.user_id !== user.id) return null;
  return results;
}

export interface ThreadSummary { readonly id: string; readonly question: string; readonly turns: number; readonly updated: string; readonly scope: Scope }

export async function recentThreads(context: Context, limit: number): Promise<ThreadSummary[]> {
  const user = context.session?.user;
  if (!user) return [];
  const { results } = await context.db.prepare(
    `SELECT thread_id, count(*) AS turns, max(created_at) AS updated,
       (SELECT question FROM turns f WHERE f.thread_id = t.thread_id ORDER BY created_at, rowid LIMIT 1) AS question,
       (SELECT scope_json FROM turns f WHERE f.thread_id = t.thread_id ORDER BY created_at, rowid LIMIT 1) AS scope_json
     FROM turns t WHERE user_id = ? GROUP BY thread_id ORDER BY updated DESC LIMIT ?`,
  ).bind(user.id, limit).all<{ thread_id: string; turns: number; updated: string; question: string; scope_json: string }>();
  return results.map((row) => ({ id: row.thread_id, question: row.question, turns: row.turns, updated: row.updated, scope: JSON.parse(row.scope_json) as Scope }));
}

// ---------------------------------------------------------------- pages

/** GET / once the site is set up: the Ask page. */
export async function home(context: Context): Promise<Response> {
  if (!(await hasAdmin(context.db))) return redirect("/setup");
  const ready = (await getSetupStep(context.db)) === "complete";
  if (!ready || !(await canViewResearch(context))) {
    return page("Home", homeView(context.ministry, context.session?.user ?? null, false), chrome(context));
  }
  return askPage(context, { scope: parseScope(context.url.searchParams) });
}

async function askPage(context: Context, options: { question?: string; kind?: OutputKind; scope?: Scope; result?: Html; status?: number } = {}): Promise<Response> {
  const entries = await catalog(context.db);
  const [threads, documents] = await Promise.all([recentThreads(context, 5), recentDocuments(context, 5)]);
  const church = context.ministry?.churchName;
  const latest = entries.slice(0, 4);
  return page("Ask", html`<section class="ask-hero">
<h1>Ask the sermons</h1>
<p class="lead">${entries.length} sermon${entries.length === 1 ? "" : "s"}${church ? ` from ${church}` : ""}. Answers quote the exact passages they come from.</p>
${askBox(context, { question: options.question ?? "", kind: options.kind ?? "answer", scope: options.scope ?? {}, entries, autofocus: !options.result })}
</section>
${options.result ?? ""}
${context.session && !options.result ? html`<div class="two-col">
<section><h2>Recent conversations</h2>${threads.length ? threadList(threads, entries) : html`<p class="empty">Your questions and follow-ups are saved here.</p>`}</section>
<section><h2>Recent documents</h2>${documents.length ? html`<ul class="list-plain">${documents.map((doc) => html`<li><a href="/documents/${doc.id}">${doc.title}</a><br><span class="hint">${OUTPUTS[doc.kind as OutputKind] ?? doc.kind} · ${doc.created_at.slice(0, 10)}</span></li>`)}</ul>` : html`<p class="empty">Outlines and study guides you create appear here.</p>`}</section>
</div>` : ""}
${!options.result && latest.length ? html`<section><h2>Latest sermons</h2>
<ul class="cards">${latest.map((entry) => html`<li class="card"><h3><a href="/episodes/${entry.id}">${titleWithoutSeries(entry.title)}</a></h3>
<p class="hint">${entry.publishedAt?.slice(0, 10) ?? ""}${entry.series ? html` · <span class="chip series">${entry.series}</span>` : ""}</p>
<p class="actions"><a href="/episodes/${entry.id}#panel-ask">Ask about it</a></p></li>`)}</ul>
<p><a href="/episodes">All sermons</a></p></section>` : ""}`, { status: options.status ?? 200, ...chrome(context) });
}

function threadList(threads: readonly ThreadSummary[], entries: readonly CatalogEntry[]): Html {
  return html`<ul class="list-plain">${threads.map((thread) => html`<li><a href="/ask/${thread.id}">${thread.question}</a><br>
<span class="hint">${thread.turns} question${thread.turns === 1 ? "" : "s"} · ${thread.updated.slice(0, 10)}${isAll(thread.scope) ? "" : ` · ${describeScope(thread.scope, entries)}`}</span></li>`)}</ul>`;
}

/** GET /research: the old address of the Ask page. */
export function researchRedirect(): Response {
  return redirect("/");
}

/** POST /research: an answer (kept as a conversation when signed in) or a document. */
export async function ask(context: Context): Promise<Response> {
  const blocked = await gate(context);
  if (blocked) return blocked;
  const form = await context.request.formData();
  const question = String(form.get("question") ?? "").trim().slice(0, QUESTION_MAX);
  const kind = parseOutput(form.get("kind"));
  const threadId = String(form.get("thread") ?? "");
  let scope = parseScope(form);
  const entries = await catalog(context.db);

  let history: TurnRow[] = [];
  if (threadId) {
    const thread = await loadThread(context, threadId);
    if (!thread) return redirect("/");
    history = thread;
    scope = JSON.parse(thread[0]!.scope_json) as Scope;
  }
  const fail = (message: Html | string, status: number) => threadId
    ? conversationPage(context, threadId, { question, alert: message, status })
    : askPage(context, { question, kind, scope, status, result: html`<p class="alert">${message}</p>` });

  if (question.length < 3) return fail("Type a question first.", 400);
  if (kind !== "answer" && !context.session) return fail("Sign in to create documents.", 403);
  const ids = scopeIds(scope, entries);
  if (ids?.length === 0) return fail("No sermons match that scope. Widen it and try again.", 400);

  const limited = await useQuota(context);
  if (limited) return fail(limited, 429);
  if (kind !== "answer") {
    return createDocument(context, kind, question, scope, ids, (message, status) => fail(message, status));
  }

  let passages: Passage[];
  let text: string;
  try {
    // A follow-up like "what about in Matthew?" searches better alongside the question it follows.
    const searchText = history.length ? `${history.at(-1)!.question}\n${question}` : question;
    passages = await retrieve(context.env, searchText, undefined, ids);
    if (passages.length === 0) return fail("No sermons have been indexed yet, so there's nothing to answer from.", 200);
    const exchanges: Exchange[] = history.map((turn) => ({ question: turn.question, answer: turn.answer }));
    text = await answer(context.env, context.ministry, question, passages, exchanges);
  } catch (error) {
    console.error("research answer failed", error);
    return fail("The answer couldn't be written right now. Try again in a minute.", 502);
  }

  if (!context.session) {
    // Visitors without an account get the answer on the page; nothing is saved.
    return askPage(context, {
      question, kind, scope,
      result: html`<section class="turn"><p class="question">${question}</p>
${isAll(scope) ? "" : html`<p class="scope-note">Scope: <strong>${describeScope(scope, entries)}</strong></p>`}
<div class="answer">${renderAnswer(text, passages.length)}</div>
${sourcesList(passages)}
<p class="hint">AI answers can be wrong. Check the sources before quoting them.</p></section>`,
    });
  }
  const turnId = crypto.randomUUID();
  const thread = threadId || crypto.randomUUID();
  await context.db.prepare("INSERT INTO turns (id, thread_id, user_id, question, answer, sources_json, scope_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(turnId, thread, context.session.user.id, question, text, JSON.stringify(toStored(passages)), JSON.stringify(scope), new Date().toISOString()).run();
  return redirect(`/ask/${thread}#turn-${turnId}`);
}

/** GET /ask/:thread */
export async function conversation(context: Context, threadId: string): Promise<Response> {
  const blocked = (await gate(context)) ?? (context.session ? null : redirect("/login"));
  if (blocked) return blocked;
  return conversationPage(context, threadId, {});
}

async function conversationPage(context: Context, threadId: string, options: { question?: string; alert?: Html | string; status?: number }): Promise<Response> {
  const turns = await loadThread(context, threadId);
  if (!turns) return page("Not found", html`<h1>Conversation not found</h1><p><a href="/library">Your library</a></p>`, { status: 404, ...chrome(context) });
  const entries = await catalog(context.db);
  const scope = JSON.parse(turns[0]!.scope_json) as Scope;
  return page(turns[0]!.question.slice(0, 80), html`<h1 class="visually-hidden">Conversation: ${turns[0]!.question}</h1>
<p class="meta"><a href="/library">Library</a> · Conversation started ${turns[0]!.created_at.slice(0, 10)}</p>
<p class="scope-note">Scope: <strong>${describeScope(scope, entries)}</strong></p>
${turns.map((turn, index) => {
    const sources = JSON.parse(turn.sources_json) as StoredSource[];
    const prefix = `t${index + 1}-source`;
    return html`<section class="turn" id="turn-${turn.id}"><p class="question">${turn.question}</p>
<div class="answer">${renderAnswer(turn.answer, sources.length, prefix)}</div>
${sourcesList(sources, { prefix, collapsed: true })}</section>`;
  })}
<p class="hint">AI answers can be wrong. Check the sources before quoting them.</p>
<div class="follow-up">
${options.alert ? html`<p class="alert">${options.alert}</p>` : ""}
${askBox(context, { question: options.question ?? "", scope, entries, thread: threadId, label: "Ask a follow-up question" })}
</div>
<form method="post" action="/ask/${threadId}/delete"><button class="link" type="submit">Delete this conversation</button></form>`, { status: options.status ?? 200, ...chrome(context) });
}

/** POST /ask/:thread/delete */
export async function deleteConversation(context: Context, threadId: string): Promise<Response> {
  const turns = await loadThread(context, threadId);
  if (!turns) return page("Not found", html`<h1>Conversation not found</h1>`, { status: 404, ...chrome(context) });
  await context.db.prepare("DELETE FROM turns WHERE thread_id = ?").bind(threadId).run();
  return redirect("/library");
}

/** GET /library: the signed-in person's conversations and documents. */
export async function library(context: Context): Promise<Response> {
  const blocked = (await gate(context)) ?? (context.session ? null : redirect("/login"));
  if (blocked) return blocked;
  const isAdmin = context.session!.user.role === "admin";
  const [entries, threads, documents] = await Promise.all([catalog(context.db), recentThreads(context, 200), recentDocuments(context, 200, isAdmin)]);
  return page("Library", html`<h1>Library</h1>
<p class="lead">Your saved conversations and documents.${isAdmin ? " As an admin you also see everyone's documents." : ""} Start something new from <a href="/">Ask</a>.</p>
<div class="two-col">
<section><h2>Conversations</h2>${threads.length ? threadList(threads, entries) : html`<p class="empty">No conversations yet.</p>`}</section>
<section><h2>Documents</h2>${documents.length ? html`<ul class="list-plain">${documents.map((doc) => html`<li><a href="/documents/${doc.id}">${doc.title}</a> <a class="hint" href="/documents/${doc.id}.md" download>.md</a><br>
<span class="hint">${OUTPUTS[doc.kind as OutputKind] ?? doc.kind} · ${doc.created_at.slice(0, 10)}${doc.author && doc.user_id !== context.session!.user.id ? ` · ${doc.author}` : ""}</span></li>`)}</ul>` : html`<p class="empty">No documents yet.</p>`}</section>
</div>`, chrome(context));
}

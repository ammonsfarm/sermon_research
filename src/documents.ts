import { type Context, redirect, chrome } from "./context.ts";
import { html, type Html, page } from "./html.ts";
import { renderMarkdown } from "./markdown.ts";
import { type OutputKind, OUTPUTS } from "./ask.ts";
import { chat, formatTime, gate, type Passage, preamble, retrieve, sourcesList, sourcesPrompt, type StoredSource, toStored } from "./research.ts";
import { catalog, describeScope, isAll, type Scope } from "./scope.ts";

/** Documents draw on more of the sermons than a short answer does. */
const DOCUMENT_SOURCES = 16;
/** Room for a long outline, plus whatever a thinking model spends first. */
const DOCUMENT_MAX_TOKENS = 8_000;
const DOCUMENT_TIMEOUT_MS = 120_000;

type DocumentKind = Exclude<OutputKind, "answer">;

const INSTRUCTIONS: Record<DocumentKind, string> = {
  outline: "Write a sermon outline for the request: a title, the big idea in one sentence, the main scripture passage, three or four main points each with sub-points and supporting scripture, illustrations taken from the sources, and a closing application section.",
  questions: "Write a small-group study guide for the request: a short introduction, the scripture to read first, then 8 to 12 discussion questions grouped under the headings Observation, Interpretation and Application, and a closing prayer prompt.",
  custom: "Write the document the request asks for.",
};


interface DocumentRow {
  readonly id: string;
  readonly user_id: string | null;
  readonly kind: DocumentKind;
  readonly request: string;
  readonly title: string;
  readonly markdown: string;
  readonly sources_json: string;
  readonly scope_json: string | null;
  readonly created_at: string;
}

export function documentPrompt(kind: DocumentKind, ministry: Context["ministry"]): string {
  return `${preamble(ministry)} ${INSTRUCTIONS[kind]} Use only the numbered sources, which are passages from sermon transcripts and summaries, and cite them with the source number in square brackets, like [2]. Where the sources don't cover something, say so rather than inventing it. Reply with a Markdown document only: start with a "# " title line, use "##" headings and "-" or numbered lists, and don't add a list of sources at the end, because one is added automatically.`;
}

/** Splits off the leading "# Title" line, which becomes the page title. */
export function splitTitle(markdown: string, fallback: string): { title: string; body: string } {
  const text = markdown.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/u, "$1").trim();
  const match = /^#\s+(.+?)\s*#*\s*(?:\n|$)/u.exec(text);
  if (!match) return { title: fallback, body: text };
  return { title: match[1]!.replace(/[*_`]/gu, "").slice(0, 200), body: text.slice(match[0].length).trim() };
}

/** Called from POST /research once the request has passed the gate and the limits. */
export async function createDocument(
  context: Context, kind: DocumentKind, request: string, scope: Scope, episodeIds: readonly string[] | null,
  fail: (message: string, status: number) => Promise<Response>,
): Promise<Response> {
  let passages: Passage[];
  let markdown: string;
  try {
    passages = await retrieve(context.env, request, DOCUMENT_SOURCES, episodeIds);
    if (passages.length === 0) return fail("No sermons have been indexed yet, so there's nothing to write from.", 200);
    markdown = await chat(context.env, documentPrompt(kind, context.ministry), `Sources:\n\n${sourcesPrompt(passages)}\n\nRequest: ${request}`, { maxTokens: DOCUMENT_MAX_TOKENS, timeoutMs: DOCUMENT_TIMEOUT_MS });
  } catch (error) {
    console.error("document generation failed", error);
    return fail("The document couldn't be written right now. Try again in a minute.", 502);
  }
  const { title, body } = splitTitle(markdown, `${OUTPUTS[kind]}: ${request.slice(0, 80)}`);
  const sources = toStored(passages);
  const id = crypto.randomUUID();
  await context.db.prepare("INSERT INTO documents (id, user_id, kind, request, title, markdown, sources_json, scope_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, context.session!.user.id, kind, request, title, body, JSON.stringify(sources), JSON.stringify(scope), new Date().toISOString()).run();
  return redirect(`/documents/${id}`);
}

/** Members see their own documents; admins see everyone's. */
async function findDocument(context: Context, id: string): Promise<DocumentRow | null> {
  const user = context.session?.user;
  if (!user) return null;
  const row = await context.db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first<DocumentRow>();
  return row && (row.user_id === user.id || user.role === "admin") ? row : null;
}

function signedInGate(context: Context): Response | null {
  return context.session ? null : redirect("/login");
}

function notFound(context: Context): Response {
  return page("Not found", html`<h1>Document not found</h1><p><a href="/library">Your library</a></p>`, { status: 404, ...chrome(context) });
}

export interface DocumentSummary { readonly id: string; readonly user_id: string | null; readonly kind: string; readonly title: string; readonly created_at: string; readonly author: string | null }

/** The signed-in person's documents, newest first; with `everyone`, all documents (for admins). */
export async function recentDocuments(context: Context, limit: number, everyone = false): Promise<DocumentSummary[]> {
  const user = context.session?.user;
  if (!user) return [];
  const all = everyone && user.role === "admin";
  const { results } = await context.db.prepare(
    `SELECT d.id, d.user_id, d.kind, d.title, d.created_at, u.name AS author FROM documents d LEFT JOIN users u ON u.id = d.user_id
     ${all ? "" : "WHERE d.user_id = ?"} ORDER BY d.created_at DESC LIMIT ?`,
  ).bind(...(all ? [] : [user.id]), limit).all<DocumentSummary>();
  return results;
}

/** GET /documents/:id */
export async function documentPage(context: Context, id: string): Promise<Response> {
  const blocked = (await gate(context)) ?? signedInGate(context);
  if (blocked) return blocked;
  const row = await findDocument(context, id);
  if (!row) return notFound(context);
  const sources = JSON.parse(row.sources_json) as StoredSource[];
  const scope = JSON.parse(row.scope_json ?? "{}") as Scope;
  return page(row.title, html`<p class="meta"><a href="/library">Library</a> · ${OUTPUTS[row.kind] ?? row.kind} · ${row.created_at.slice(0, 10)}</p>
<h1>${row.title}</h1>
<p class="scope-note">Asked for: ${row.request}${isAll(scope) ? "" : html` · Scope: <strong>${describeScope(scope, await catalog(context.db))}</strong>`}</p>
<div class="row">
<a class="button" href="/documents/${row.id}.md" download>Download .md</a>
<form class="inline" method="post" action="/documents/${row.id}/delete"><button class="quiet" type="submit">Delete</button></form>
</div>
<article class="document">${renderMarkdown(row.markdown, sources.length)}</article>
${sourcesList(sources)}
<p class="hint">AI-written documents can be wrong. Check the sources before preaching or teaching from them.</p>`, chrome(context));
}

/** GET /documents/:id.md : the document with its sources as absolute links. */
export async function documentDownload(context: Context, id: string): Promise<Response> {
  const blocked = (await gate(context)) ?? signedInGate(context);
  if (blocked) return blocked;
  const row = await findDocument(context, id);
  if (!row) return notFound(context);
  const sources = JSON.parse(row.sources_json) as StoredSource[];
  const origin = context.url.origin;
  const list = sources.map((source) => {
    const where = source.kind === "summary" ? "summary" : source.start !== null ? `at ${formatTime(source.start)}` : "";
    return `${source.n}. [${source.title.replaceAll("]", "\\]")}](${origin}/episodes/${source.episodeId}#t-${source.seq}), ${[source.publishedAt?.slice(0, 10), where].filter(Boolean).join(", ")}`;
  });
  const markdown = `# ${row.title}\n\n${row.markdown}\n\n## Sources\n\n${list.join("\n")}\n`;
  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName(row.title)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** POST /documents/:id/delete */
export async function deleteDocument(context: Context, id: string): Promise<Response> {
  const blocked = signedInGate(context);
  if (blocked) return blocked;
  const row = await findDocument(context, id);
  if (!row) return notFound(context);
  await context.db.prepare("DELETE FROM documents WHERE id = ?").bind(row.id).run();
  return redirect("/library");
}

export function fileName(title: string, extension = ".md"): string {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
  return `${slug || "document"}${extension}`;
}

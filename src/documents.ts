import { type Context, redirect, chrome } from "./context.ts";
import { html, page } from "./html.ts";
import { ago } from "./imports.ts";
import { renderMarkdown } from "./markdown.ts";
import { OUTPUTS } from "./ask.ts";
import { formatTime, gate, sourcesList, type StoredSource, useQuota } from "./research.ts";
import { catalog, describeScope, isAll, type Scope } from "./scope.ts";
import { type DocumentKind, startWriting } from "./writing.ts";

/** How often a document's page reloads while it's being written. */
const WRITING_REFRESH_SECONDS = 10;


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
  readonly status: "writing" | "done" | "failed";
  readonly detail: string | null;
  readonly error: string | null;
  readonly updated_at: string | null;
}

/** Removes the code fence some models wrap Markdown in. */
export function unfence(markdown: string): string {
  return markdown.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/u, "$1").trim();
}

/** Splits off the leading "# Title" line, which becomes the page title. */
export function splitTitle(markdown: string, fallback: string): { title: string; body: string } {
  const text = unfence(markdown);
  const match = /^#\s+(.+?)\s*#*\s*(?:\n|$)/u.exec(text);
  if (!match) return { title: fallback, body: text };
  return { title: match[1]!.replace(/[*_`]/gu, "").slice(0, 200), body: text.slice(match[0].length).trim() };
}

/**
 * Called from POST /research once the request has passed the gate and the
 * limits. Saves the document as "writing" and starts the background run
 * (see writing.ts), then shows its page, which follows the progress.
 */
export async function createDocument(
  context: Context, kind: DocumentKind, request: string, scope: Scope, model: string | null,
  fail: (message: string, status: number) => Promise<Response>,
): Promise<Response> {
  if (!(await context.db.prepare("SELECT 1 FROM episodes WHERE status = 'done' LIMIT 1").first())) {
    return fail("No sermons have been indexed yet, so there's nothing to write from.", 200);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await context.db.prepare("INSERT INTO documents (id, user_id, kind, request, title, markdown, sources_json, scope_json, created_at, status, detail, updated_at, model) VALUES (?, ?, ?, ?, ?, '', '[]', ?, ?, 'writing', 'Starting', ?, ?)")
    .bind(id, context.session!.user.id, kind, request, `${OUTPUTS[kind]}: ${request.slice(0, 80)}`, JSON.stringify(scope), now, now, model).run();
  if (!(await startWriting(context.env, id))) {
    await context.db.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
    return fail("Writing couldn't start right now. Try again in a minute.", 503);
  }
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

export interface DocumentSummary { readonly id: string; readonly user_id: string | null; readonly kind: string; readonly title: string; readonly created_at: string; readonly status: DocumentRow["status"]; readonly author: string | null }

/** The signed-in person's documents, newest first; with `everyone`, all documents (for admins). */
export async function recentDocuments(context: Context, limit: number, everyone = false): Promise<DocumentSummary[]> {
  const user = context.session?.user;
  if (!user) return [];
  const all = everyone && user.role === "admin";
  const { results } = await context.db.prepare(
    `SELECT d.id, d.user_id, d.kind, d.title, d.created_at, d.status, u.name AS author FROM documents d LEFT JOIN users u ON u.id = d.user_id
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
  const header = html`<p class="meta"><a href="/library">Library</a> · ${OUTPUTS[row.kind] ?? row.kind} · ${row.created_at.slice(0, 10)}</p>
<h1>${row.title}</h1>
<p class="scope-note">Asked for: ${row.request}${isAll(scope) ? "" : html` · Scope: <strong>${describeScope(scope, await catalog(context.db))}</strong>`}</p>`;
  const remove = html`<form class="inline" method="post" action="/documents/${row.id}/delete"><button class="quiet" type="submit">Delete</button></form>`;
  if (row.status === "writing") {
    return page(row.title, html`${header}
<p class="live">${row.detail ?? "Starting"} · updated ${ago(row.updated_at)}</p>
<p class="hint">Documents are written from the full transcripts, a part at a time, so a long one can take several minutes or more. This page updates every ${WRITING_REFRESH_SECONDS} seconds. You can leave and find it in your Library.</p>
<div class="row">${remove}</div>`, { ...chrome(context), refreshSeconds: WRITING_REFRESH_SECONDS });
  }
  if (row.status === "failed") {
    return page(row.title, html`${header}
<p class="alert">This document couldn't be written: ${row.error ?? "unknown error."}</p>
<div class="row">
<form class="inline" method="post" action="/documents/${row.id}/retry"><button type="submit">Try again</button></form>
${remove}
</div>`, chrome(context));
  }
  return page(row.title, html`${header}
<div class="row">
<a class="button" href="/documents/${row.id}.md" download>Download .md</a>
${remove}
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
  if (row.status !== "done") return redirect(`/documents/${row.id}`);
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

/** POST /documents/:id/retry: writes a failed document again, from the start. */
export async function retryDocument(context: Context, id: string): Promise<Response> {
  const blocked = (await gate(context)) ?? signedInGate(context);
  if (blocked) return blocked;
  const row = await findDocument(context, id);
  if (!row) return notFound(context);
  if (row.status !== "failed") return redirect(`/documents/${row.id}`);
  const limited = await useQuota(context);
  if (limited) return page("Try again later", html`<h1>Try again later</h1><p class="alert">${limited}</p><p><a href="/documents/${row.id}">Back to the document</a></p>`, { status: 429, ...chrome(context) });
  await context.db.prepare("UPDATE documents SET status = 'writing', detail = 'Starting', error = NULL, updated_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();
  if (!(await startWriting(context.env, row.id, `${row.id}-${Date.now()}`))) {
    await context.db.prepare("UPDATE documents SET status = 'failed', detail = NULL, error = 'Writing couldn''t start. Try again in a minute.' WHERE id = ?").bind(row.id).run();
  }
  return redirect(`/documents/${row.id}`);
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

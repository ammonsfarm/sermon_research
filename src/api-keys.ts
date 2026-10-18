import { chrome, type Context, redirect, requireAdmin } from "./context.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { field, html, type Html, page } from "./html.ts";

/** Requests per hour for one key, across every /api/v1 endpoint. Each search is one embeddings call. */
export const API_REQUESTS_PER_HOUR = 600;
const MAX_KEYS = 20;
/** Keys start with this, so they're easy to spot in a config file or a leaked log. */
const KEY_PREFIX = "sr_";
/** last_used_at is written at most this often per key. */
const TOUCH_MS = 60_000;

interface KeyRow { readonly id: string; readonly name: string; readonly prefix: string; readonly created_at: string; readonly last_used_at: string | null }

/** The key a request carries as `Authorization: Bearer <key>`, or null when it carries none or an unknown one. */
export async function apiKeyFor(db: D1Database, request: Request): Promise<{ id: string; name: string } | null> {
  const match = /^Bearer\s+(\S+)\s*$/iu.exec(request.headers.get("Authorization") ?? "");
  const token = match?.[1];
  if (!token || !token.startsWith(KEY_PREFIX) || token.length > 128) return null;
  const row = await db.prepare("SELECT id, name, last_used_at FROM api_keys WHERE token_hash = ?").bind(await sha256(token)).first<{ id: string; name: string; last_used_at: string | null }>();
  if (!row) return null;
  const now = Date.now();
  if (!row.last_used_at || now - Date.parse(row.last_used_at) > TOUCH_MS) {
    await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(new Date(now).toISOString(), row.id).run();
  }
  return { id: row.id, name: row.name };
}

async function listKeys(db: D1Database): Promise<KeyRow[]> {
  return (await db.prepare("SELECT id, name, prefix, created_at, last_used_at FROM api_keys ORDER BY created_at").all<KeyRow>()).results;
}

function keysView(context: Context, keys: readonly KeyRow[], options: { error?: string; name?: string; created?: { name: string; token: string } } = {}): Html {
  const origin = context.url.origin;
  return html`<h1>API keys</h1>
<p class="lead">Other systems, like a Custom GPT or your church website, can search the sermons through the API with one of these keys. They get passages and sermon details, never your settings, members or AI keys.</p>
${options.created ? html`<div class="alert-ok"><p><strong>The key for ${options.created.name} is ready.</strong> Copy it now; it's shown only once:</p>
<pre>${options.created.token}</pre></div>` : ""}
${keys.length ? html`<table>
<thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead>
<tbody>${keys.map((key) => html`<tr>
<td>${key.name}<br><span class="hint">${key.prefix}…</span></td>
<td>${key.created_at.slice(0, 10)}</td>
<td>${key.last_used_at ? key.last_used_at.slice(0, 16).replace("T", " ") + " UTC" : "Never"}</td>
<td><form class="inline" method="post" action="/admin/api/revoke"><input type="hidden" name="id" value="${key.id}"><button class="quiet" type="submit">Revoke</button></form></td>
</tr>`)}</tbody>
</table>` : html`<p class="empty">No keys yet.</p>`}
<h2>Create a key</h2>
${options.error ? html`<p class="alert">${options.error}</p>` : ""}
<form method="post" action="/admin/api">
${field({ name: "name", label: "What it's for", value: options.name ?? "", hint: "For example “Custom GPT” or “Church website”.", required: true })}
<button type="submit">Create key</button>
</form>
<h2>Connecting a Custom GPT</h2>
<ol>
<li>In ChatGPT, edit your GPT, open Configure, and choose <strong>Create new action</strong>.</li>
<li>Choose <strong>Import from URL</strong> and paste <code>${origin}/api/v1/openapi.json</code>.</li>
<li>Under Authentication choose <strong>API Key</strong>, then <strong>Bearer</strong>, and paste a key from this page.</li>
<li>In the GPT's instructions, tell it to search the sermons before answering and to link each sermon it quotes.</li>
</ol>
<p class="hint">Each key can make ${API_REQUESTS_PER_HOUR} requests an hour. Each search costs one embeddings call (a small fraction of a cent) and no answers-AI calls; the other system writes the answer itself. Revoking a key stops it at once.</p>`;
}

/** GET/POST /admin/api */
export async function apiKeysPage(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const { db } = context;
  if (context.request.method === "GET") return page("API keys", keysView(context, await listKeys(db)), chrome(context));

  const name = String((await context.request.formData()).get("name") ?? "").trim().slice(0, 80);
  const keys = await listKeys(db);
  const error = !name ? "Say what the key is for." : keys.length >= MAX_KEYS ? `You can have up to ${MAX_KEYS} keys. Revoke one you no longer use.` : "";
  if (error) return page("API keys", keysView(context, keys, { error, name }), { status: 400, ...chrome(context) });

  const token = KEY_PREFIX + randomToken();
  await db.prepare("INSERT INTO api_keys (id, name, token_hash, prefix, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), name, await sha256(token), token.slice(0, KEY_PREFIX.length + 6), context.session!.user.id, new Date().toISOString()).run();
  return page("API keys", keysView(context, await listKeys(db), { created: { name, token } }), chrome(context));
}

/** POST /admin/api/revoke */
export async function revokeApiKey(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const id = String((await context.request.formData()).get("id") ?? "");
  await context.db.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
  return redirect("/admin/api");
}

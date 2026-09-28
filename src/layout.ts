import type { Session } from "./auth.ts";
import { html, type Html } from "./html.ts";

interface Place { readonly path: string; readonly signedIn: boolean; readonly admin: boolean; readonly researchOpen: boolean }

/** Which main tab a path belongs to. */
function section(path: string): "ask" | "sermons" | "library" | "admin" | null {
  if (path === "/" || path === "/research" || path.startsWith("/ask/")) return "ask";
  if (path.startsWith("/episodes")) return "sermons";
  if (path.startsWith("/library") || path.startsWith("/documents")) return "library";
  if (path.startsWith("/admin")) return "admin";
  return null;
}

/** The main navigation and account links shown in the header of every page after setup. */
export function siteHeader(session: Session | null, path: string, researchOpen: boolean): Html {
  const place: Place = { path, signedIn: Boolean(session), admin: session?.user.role === "admin", researchOpen };
  if (path.startsWith("/setup")) return html``;
  const current = section(path);
  const link = (key: NonNullable<ReturnType<typeof section>>, href: string, label: string) =>
    html`<a href="${href}"${current === key ? html` aria-current="page"` : ""}>${label}</a>`;
  const tabs: Html[] = [];
  if (place.signedIn || place.researchOpen) tabs.push(link("ask", "/", "Ask"), link("sermons", "/episodes", "Sermons"));
  if (place.signedIn) tabs.push(link("library", "/library", "Library"));
  if (place.admin) tabs.push(link("admin", "/admin", "Admin"));
  return html`${tabs.length ? html`<nav class="tabs-main" aria-label="Main">${tabs}</nav>` : ""}
<div class="account">${session
    ? html`<span class="who">${session.user.name}</span><form class="inline" method="post" action="/logout"><button class="link" type="submit">Sign out</button></form>`
    : html`<a href="/login">Sign in</a>`}</div>`;
}

const ADMIN_MENU: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  ["Site", [["/admin", "Overview"], ["/admin/ministry", "Ministry"], ["/admin/members", "Members"], ["/admin/research", "Access"]]],
  ["Sermons", [["/admin/episodes", "Episodes"], ["/admin/schedule", "Schedule"], ["/admin/podcast", "Podcast feed"]]],
  ["AI connections", [["/admin/llm", "Answers AI"], ["/admin/embeddings", "Embeddings"], ["/admin/transcription", "Transcription"], ["/admin/email", "Email"]]],
];

/** The side menu on admin pages. */
export function adminMenu(path: string): Html {
  return html`<nav class="side" aria-label="Admin">${ADMIN_MENU.map(([heading, items]) => html`<p class="side-heading">${heading}</p>
<ul>${items.map(([href, label]) => html`<li><a href="${href}"${path === href ? html` aria-current="page"` : ""}>${label}</a></li>`)}</ul>`)}</nav>`;
}

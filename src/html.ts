import type { Mode, SchemeId } from "./theme.ts";

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Marks a string as already-safe HTML. */
export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

/** Tagged template that escapes every interpolated value unless it is `Html` (or an array of it). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? "");
  });
  return new Html(out);
}

function render(value: unknown): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(String(value));
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https:; media-src 'self' https: http:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

export interface PageOptions {
  readonly siteTitle?: string;
  /** The ministry's logo, shown beside the site title. */
  readonly logoUrl?: string;
  readonly logoTile?: boolean;
  /** The admin's color scheme and the visitor's light / dark choice. */
  readonly scheme?: SchemeId;
  readonly mode?: Mode;
  readonly status?: number;
  readonly headers?: HeadersInit;
  readonly refreshSeconds?: number;
  /** Main navigation and account links, from `chrome(context)`. */
  readonly header?: Html;
  /** A side menu, used on admin pages. */
  readonly aside?: Html;
  /** Use the full page width, for pages with their own columns. */
  readonly wide?: boolean;
}

export function page(title: string, body: Html, options: PageOptions = {}): Response {
  const heading = options.siteTitle ?? "Sermon Research";
  const document = html`<!doctype html>
<html lang="en" data-scheme="${options.scheme ?? "navy"}"${options.mode && options.mode !== "system" ? html` data-mode="${options.mode}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${options.refreshSeconds ? html`<meta http-equiv="refresh" content="${options.refreshSeconds}">
` : ""}<title>${title} · ${heading}</title>
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script>
</head>
<body>
<header class="site"><div class="bar"><a class="brand" href="/">${options.logoUrl ? html`<img class="logo${options.logoTile ? " tile" : ""}" src="${options.logoUrl}" alt="" referrerpolicy="no-referrer">` : ""}<span>${heading}</span></a>${options.header ?? ""}</div></header>
<main class="${options.wide || options.aside ? "wide" : "narrow"}">
${options.aside ? html`<div class="with-side">${options.aside}<div class="content">${body}</div></div>` : body}
</main>
</body>
</html>`;
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(document.value, { status: options.status ?? 200, headers });
}

export function field(options: {
  name: string;
  label: string;
  type?: string;
  value?: string;
  error?: string | undefined;
  hint?: string;
  required?: boolean;
  autocomplete?: string;
}): Html {
  const id = `f-${options.name}`;
  return html`<div class="field${options.error ? " invalid" : ""}">
<label for="${id}">${options.label}</label>
${options.hint ? html`<p class="hint">${options.hint}</p>` : ""}
${options.type === "textarea"
    ? html`<textarea id="${id}" name="${options.name}" rows="3">${options.value ?? ""}</textarea>`
    : html`<input id="${id}" name="${options.name}" type="${options.type ?? "text"}" value="${options.value ?? ""}"${options.required ? html` required` : ""}${options.autocomplete ? html` autocomplete="${options.autocomplete}"` : ""}>`}
${options.error ? html`<p class="error">${options.error}</p>` : ""}
</div>`;
}

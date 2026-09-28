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
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self' https:; media-src https: http:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

export function page(title: string, body: Html, options: { siteTitle?: string; status?: number; headers?: HeadersInit } = {}): Response {
  const heading = options.siteTitle ?? "Sermon Research";
  const document = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${heading}</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<header class="site"><a href="/">${heading}</a></header>
<main>
${body}
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

export const STYLESHEET = `
:root { --bg: #fbfaf7; --fg: #1f2328; --muted: #5b636b; --line: #d8dadd; --accent: #2f5d50; --error: #a3302a; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #16181b; --fg: #e8eaed; --muted: #a0a7ae; --line: #33373c; --accent: #7fb8a6; --error: #f08a80; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
header.site { padding: 12px 16px; border-bottom: 1px solid var(--line); }
header.site a { color: inherit; font-weight: 600; text-decoration: none; }
main { max-width: 640px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.6rem; margin: 0 0 8px; }
p.lead, .hint { color: var(--muted); }
.hint { margin: 0 0 4px; font-size: .9rem; }
.field { margin: 0 0 16px; }
label { display: block; font-weight: 600; margin-bottom: 4px; }
input, textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; font: inherit; }
.invalid input, .invalid textarea { border-color: var(--error); }
.error, .alert { color: var(--error); }
.alert { border: 1px solid var(--error); border-radius: 6px; padding: 8px 12px; }
button { padding: 9px 16px; border: 0; border-radius: 6px; background: var(--accent); color: var(--bg); font: inherit; font-weight: 600; cursor: pointer; }
button.quiet { background: transparent; color: var(--accent); border: 1px solid var(--line); }
.steps { color: var(--muted); font-size: .9rem; margin: 0 0 16px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
form.inline { display: inline; }
select { padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: inherit; font: inherit; }
fieldset.choices { border: 0; padding: 0; margin: 0 0 16px; }
fieldset.choices legend { font-weight: 600; margin-bottom: 8px; }
label.choice { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 8px; }
label.choice input { width: auto; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; margin-top: 16px; }
th, td { text-align: left; vertical-align: top; padding: 8px 6px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; font-size: .9rem; }
a.button { display: inline-block; padding: 9px 16px; border-radius: 6px; background: var(--accent); color: var(--bg); font-weight: 600; text-decoration: none; }
.answer { margin: 24px 0; }
.answer sup a { text-decoration: none; }
ol.sources li { margin-bottom: 12px; }
.quote { margin: 4px 0 0; padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted); font-size: .95rem; }
.alert-ok { border: 1px solid var(--accent); border-radius: 6px; padding: 8px 12px; margin-bottom: 16px; }
form.search input { flex: 1; min-width: 12rem; width: auto; }
ul.episode-list { padding-left: 18px; }
ul.episode-list li { margin-bottom: 10px; }
.passage { margin-bottom: 12px; }
audio { width: 100%; margin: 12px 0; }
pre { background: color-mix(in srgb, var(--line) 40%, transparent); padding: 8px 12px; border-radius: 6px; overflow-x: auto; }
`;

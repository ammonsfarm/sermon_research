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
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https:; media-src 'self' https: http:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

export function page(title: string, body: Html, options: { siteTitle?: string; status?: number; headers?: HeadersInit; refreshSeconds?: number; scripts?: readonly string[] } = {}): Response {
  const heading = options.siteTitle ?? "Sermon Research";
  const document = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${options.refreshSeconds ? html`<meta http-equiv="refresh" content="${options.refreshSeconds}">
` : ""}<title>${title} · ${heading}</title>
<link rel="stylesheet" href="/assets/app.css">
${(options.scripts ?? []).map((src) => html`<script src="${src}" defer></script>
`)}</head>
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
.document { margin: 24px 0; }
.document h2, .document h3, .document h4 { margin: 20px 0 8px; }
.document li { margin-bottom: 4px; }
.document blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--line); color: var(--muted); }
.live { color: var(--accent); font-weight: 600; margin: 0 0 12px; }
label.inline-label { display: inline; margin: 0; }
.row select { width: auto; }
audio { width: 100%; margin: 12px 0; }
.player { position: sticky; top: 0; z-index: 1; background: var(--bg); padding: 4px 0; border-bottom: 1px solid var(--line); }
.player audio { margin: 4px 0; }
label.follow { display: inline-flex; gap: 6px; align-items: center; font-weight: 400; font-size: .9rem; color: var(--muted); margin: 0; }
label.follow input { width: auto; }
.reader .seg { cursor: pointer; border-radius: 3px; }
.reader .seg:hover { text-decoration: underline dotted var(--muted); }
.reader .seg-active { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.reader .word-active { background: color-mix(in srgb, var(--accent) 40%, transparent); border-radius: 3px; }
pre { background: color-mix(in srgb, var(--line) 40%, transparent); padding: 8px 12px; border-radius: 6px; overflow-x: auto; }
`;

/**
 * Read-along for episode pages: highlights the sentence being played and
 * estimates the word by spreading the sentence's time evenly across its words
 * (the transcript has sentence timings, not word timings). Clicking a sentence
 * or a "Listen from" link seeks the player.
 */
export const READER_SCRIPT = `(() => {
  const audio = document.getElementById("player");
  const reader = document.querySelector(".reader");
  if (!audio || !reader) return;
  const follow = document.getElementById("follow");
  const segments = Array.from(reader.querySelectorAll(".seg"), (el) => ({ el, start: Number(el.dataset.start), end: Number(el.dataset.end), text: el.textContent, words: null }));
  let active = null;
  let activeWord = -1;

  function find(time) {
    let low = 0, high = segments.length - 1, found = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (segments[mid].start <= time) { found = segments[mid]; low = mid + 1; } else high = mid - 1;
    }
    return found;
  }

  function release(segment) {
    segment.el.classList.remove("seg-active");
    segment.el.textContent = segment.text;
    segment.words = null;
  }

  function activate(segment) {
    if (active) release(active);
    active = segment;
    activeWord = -1;
    if (!segment) return;
    segment.el.textContent = "";
    segment.words = [];
    for (const part of segment.text.split(/(\\s+)/)) {
      if (!part.trim()) { segment.el.append(part); continue; }
      const word = document.createElement("span");
      word.className = "word";
      word.textContent = part;
      segment.el.append(word);
      segment.words.push(word);
    }
    segment.el.classList.add("seg-active");
    if (follow && follow.checked && !audio.paused) segment.el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function update() {
    const time = audio.currentTime;
    const segment = find(time);
    if (segment !== active) activate(segment);
    if (!segment || segment.words.length === 0) return;
    const span = Math.max(0.001, segment.end - segment.start);
    const progress = Math.min(0.999, Math.max(0, (time - segment.start) / span));
    const index = Math.floor(progress * segment.words.length);
    if (index === activeWord) return;
    if (activeWord >= 0) segment.words[activeWord].classList.remove("word-active");
    segment.words[index].classList.add("word-active");
    activeWord = index;
  }

  let frame = 0;
  function loop() { update(); frame = audio.paused ? 0 : requestAnimationFrame(loop); }
  audio.addEventListener("play", () => { if (!frame) frame = requestAnimationFrame(loop); });
  audio.addEventListener("seeked", update);
  audio.addEventListener("timeupdate", () => { if (!frame) update(); });

  function seek(seconds) {
    audio.currentTime = seconds;
    audio.play().catch(() => {});
  }
  reader.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-seek]");
    if (link) { event.preventDefault(); seek(Number(link.dataset.seek)); return; }
    const segment = event.target.closest(".seg");
    if (segment && !window.getSelection().toString()) seek(Number(segment.dataset.start));
  });
})();
`;

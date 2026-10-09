import { schemeStyles } from "./theme.ts";

/** The site's only stylesheet, served at /assets/app.css. */
export const STYLESHEET = `
${schemeStyles()}
:root {
  --bg: #f8f6f1; --surface: #ffffff; --fg: #1b2330; --muted: #5d6674; --line: #e3ded3; --soft: #f1ede4;
  --ink: var(--scheme-ink); --ink-2: color-mix(in srgb, var(--scheme-ink) 72%, var(--scheme-brand)); --ink-fg: #f6f1e6; --ink-muted: color-mix(in srgb, #ffffff 72%, var(--scheme-ink));
  --accent: var(--scheme-brand); --accent-strong: color-mix(in srgb, var(--scheme-brand) 78%, #000000); --accent-fg: #ffffff; --accent-soft: color-mix(in srgb, var(--scheme-brand) 10%, #ffffff);
  --gold: var(--scheme-trim); --gold-bright: color-mix(in srgb, var(--scheme-trim) 72%, #ffffff); --gold-soft: color-mix(in srgb, var(--scheme-trim) 16%, #ffffff);
  --error: #a3302a; --ok: #2e6b4f;
  --radius: 12px; --shadow: 0 1px 2px rgb(22 35 58 / 6%), 0 4px 16px rgb(22 35 58 / 6%);
  --shadow-lift: 0 2px 4px rgb(22 35 58 / 8%), 0 10px 28px rgb(22 35 58 / 10%);
  --sans: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  --serif: "Source Serif 4", ui-serif, "Iowan Old Style", Georgia, serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root:not([data-mode="light"]) { color-scheme: dark; --bg: #0f131a; --surface: #171d27; --fg: #e9ecf1; --muted: #a2abb8; --line: #2a3240; --soft: #1e2531;
    --ink: color-mix(in srgb, var(--scheme-ink) 70%, #000000); --ink-2: color-mix(in srgb, var(--scheme-ink) 60%, var(--scheme-brand)); --ink-fg: #f1ece1; --ink-muted: #a6afbd;
    --accent: color-mix(in srgb, var(--scheme-brand) 45%, #ffffff); --accent-strong: color-mix(in srgb, var(--scheme-brand) 25%, #ffffff); --accent-fg: #0d1826; --accent-soft: color-mix(in srgb, var(--scheme-brand) 24%, #111723);
    --gold: color-mix(in srgb, var(--scheme-trim) 70%, #ffffff); --gold-bright: color-mix(in srgb, var(--scheme-trim) 60%, #ffffff); --gold-soft: color-mix(in srgb, var(--scheme-trim) 20%, #141a22);
    --error: #f08a80; --ok: #7fc2a1; --shadow: none; --shadow-lift: 0 0 0 1px var(--line); } }
:root[data-mode="dark"] { color-scheme: dark; --bg: #0f131a; --surface: #171d27; --fg: #e9ecf1; --muted: #a2abb8; --line: #2a3240; --soft: #1e2531;
    --ink: color-mix(in srgb, var(--scheme-ink) 70%, #000000); --ink-2: color-mix(in srgb, var(--scheme-ink) 60%, var(--scheme-brand)); --ink-fg: #f1ece1; --ink-muted: #a6afbd;
    --accent: color-mix(in srgb, var(--scheme-brand) 45%, #ffffff); --accent-strong: color-mix(in srgb, var(--scheme-brand) 25%, #ffffff); --accent-fg: #0d1826; --accent-soft: color-mix(in srgb, var(--scheme-brand) 24%, #111723);
    --gold: color-mix(in srgb, var(--scheme-trim) 70%, #ffffff); --gold-bright: color-mix(in srgb, var(--scheme-trim) 60%, #ffffff); --gold-soft: color-mix(in srgb, var(--scheme-trim) 20%, #141a22);
    --error: #f08a80; --ok: #7fc2a1; --shadow: none; --shadow-lift: 0 0 0 1px var(--line); }
@font-face { font-family: "Inter"; src: url("/fonts/inter.woff2") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }
@font-face { font-family: "Source Serif 4"; src: url("/fonts/source-serif-4.woff2") format("woff2"); font-weight: 200 900; font-style: normal; font-display: swap; }
@font-face { font-family: "Source Serif 4"; src: url("/fonts/source-serif-4-italic.woff2") format("woff2"); font-weight: 200 900; font-style: italic; font-display: swap; }
* { box-sizing: border-box; }
html { scroll-padding-top: 76px; -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 var(--sans); font-feature-settings: "cv11", "ss01"; -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-underline-offset: 2px; text-decoration-thickness: 1px; }
a:hover { color: var(--accent-strong); }
h1, h2, h3 { font-family: var(--serif); font-weight: 600; letter-spacing: -.01em; color: var(--fg); }
h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 10px; }
h2 { font-size: 1.35rem; line-height: 1.3; margin: 32px 0 12px; }
h3 { font-size: 1.1rem; margin: 20px 0 8px; }
p.lead, .hint, .meta { color: var(--muted); }
p.lead { font-size: 1.05rem; }
.hint { margin: 0 0 4px; font-size: .9rem; }
.meta { font-size: .88rem; margin: 0 0 12px; }
pre { background: var(--soft); padding: 8px 12px; border-radius: 6px; overflow-x: auto; }
code { background: var(--soft); padding: 1px 4px; border-radius: 4px; }
::selection { background: var(--gold-soft); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* Header */
header.site { position: sticky; top: 0; z-index: 10; background: var(--ink); color: var(--ink-fg); border-bottom: 3px solid var(--gold); box-shadow: 0 2px 12px rgb(0 0 0 / 12%); }
header.site .bar { max-width: 1180px; margin: 0 auto; padding: 10px 16px; display: flex; gap: 8px 24px; align-items: center; flex-wrap: wrap; }
header.site .brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink-fg); font-family: var(--serif); font-size: 1.2rem; font-weight: 600; letter-spacing: -.005em; text-decoration: none; margin-right: auto; }
header.site .brand .logo { height: 36px; width: auto; max-width: 160px; object-fit: contain; }
header.site .brand .logo.tile { border-radius: 6px; background: #fff; padding: 3px 6px; }
label.check { display: flex; gap: 8px; align-items: center; font-weight: 400; margin: -8px 0 16px; }
label.check input { width: auto; margin: 0; }
nav.tabs-main { display: flex; gap: 2px; order: 3; width: 100%; overflow-x: auto; }
nav.tabs-main a { position: relative; padding: 8px 12px; color: var(--ink-muted); text-decoration: none; font-weight: 500; font-size: .95rem; white-space: nowrap; border-radius: 8px; }
nav.tabs-main a:hover { color: var(--ink-fg); background: rgb(255 255 255 / 8%); }
nav.tabs-main a[aria-current="page"] { color: var(--ink-fg); }
nav.tabs-main a[aria-current="page"]::after { content: ""; position: absolute; left: 12px; right: 12px; bottom: 1px; height: 2px; border-radius: 2px; background: var(--gold-bright); }
.account { display: flex; gap: 12px; align-items: center; font-size: .88rem; }
.account .who { color: var(--ink-muted); }
header.site .account a, header.site .account button.link { color: var(--ink-fg); }
@media (min-width: 720px) {
  header.site .brand { margin-right: 12px; }
  nav.tabs-main { order: 0; width: auto; flex: 1; }
}

/* Page frames */
main { margin: 0 auto; padding: 28px 16px 72px; }
main.narrow { max-width: 760px; }
main.wide { max-width: 1180px; }
.with-side { display: grid; gap: 24px; }
nav.side { font-size: .95rem; }
nav.side ul { list-style: none; margin: 0 0 12px; padding: 0; }
nav.side .side-heading { margin: 0 0 4px; font-size: .75rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
nav.side a { display: block; padding: 5px 10px; border-radius: 6px; color: var(--fg); text-decoration: none; }
nav.side a:hover { background: var(--soft); }
nav.side a[aria-current="page"] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.with-side .content { min-width: 0; max-width: 780px; }
nav.side a[aria-current="page"] { box-shadow: inset 3px 0 0 var(--gold); }
@media (max-width: 859px) {
  nav.side { display: flex; gap: 4px 12px; flex-wrap: wrap; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
  nav.side .side-heading { display: none; }
  nav.side ul { display: contents; }
  nav.side a { padding: 4px 8px; }
}
@media (min-width: 860px) { .with-side { grid-template-columns: 200px 1fr; gap: 40px; } nav.side { position: sticky; top: 76px; align-self: start; } }

/* Forms */
.field { margin: 0 0 16px; }
label { display: block; font-weight: 600; margin-bottom: 4px; }
input, textarea, select { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: inherit; font: inherit; }
input:focus, textarea:focus, select:focus { outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent); outline-offset: 1px; border-color: var(--accent); }
.invalid input, .invalid textarea { border-color: var(--error); }
.error, .alert { color: var(--error); }
.alert { border: 1px solid var(--error); border-radius: 8px; padding: 10px 14px; }
.alert-ok { border: 1px solid var(--ok); border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; background: var(--accent-soft); }
button, a.button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 20px; border: 1px solid transparent; border-radius: 10px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; letter-spacing: .005em; cursor: pointer; text-decoration: none; box-shadow: 0 1px 2px rgb(22 35 58 / 15%); transition: background-color .15s, box-shadow .15s, transform .15s; }
button:hover, a.button:hover { background: var(--accent-strong); color: var(--accent-fg); }
button:active { transform: translateY(1px); }
button.quiet, a.button.quiet { background: var(--surface); color: var(--accent); border-color: var(--line); box-shadow: none; }
button.quiet:hover, a.button.quiet:hover { background: var(--accent-soft); color: var(--accent-strong); border-color: color-mix(in srgb, var(--accent) 30%, var(--line)); }
button.link, button.link:hover { background: none; border: 0; padding: 0; color: var(--accent); font-weight: 400; text-decoration: underline; box-shadow: none; }
button:disabled { opacity: .6; cursor: progress; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
form.inline { display: inline; }
label.inline-label { display: inline; margin: 0; }
.row select, .row input[type="date"] { width: auto; max-width: 100%; }
fieldset.choices { border: 0; padding: 0; margin: 0 0 16px; }
fieldset.choices legend { font-weight: 600; margin-bottom: 8px; }
label.choice { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px; background: var(--surface); }
label.choice input { width: auto; margin-top: 4px; }
.steps { color: var(--muted); font-size: .9rem; margin: 0 0 16px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; margin-top: 16px; }
th, td { text-align: left; vertical-align: top; padding: 8px 6px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; font-size: .9rem; }
.live { color: var(--accent); font-weight: 600; margin: 0 0 12px; }
section.provider { border: 1px solid var(--line); border-radius: var(--radius); padding: 2px 16px 14px; margin: 0 0 12px; background: var(--surface); }
section.provider h3 { margin-top: 12px; }
details.add-provider { margin: 16px 0; }
details.add-provider summary { cursor: pointer; font-weight: 600; color: var(--accent); }
.busy-note { color: var(--muted); font-size: .9rem; margin: 8px 0 0; }
.busy-note::before { content: ""; display: inline-block; width: .8em; height: .8em; margin-right: 8px; border: 2px solid var(--accent); border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -1px; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Cards and chips */
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; box-shadow: var(--shadow); transition: box-shadow .2s, transform .2s, border-color .2s; }
.cards .card:hover { box-shadow: var(--shadow-lift); transform: translateY(-2px); border-color: color-mix(in srgb, var(--gold) 45%, var(--line)); }
.cards { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); padding: 0; margin: 0; list-style: none; }
.cards .card { display: flex; flex-direction: column; gap: 6px; }
.card h3 { margin: 0; font-size: 1.12rem; line-height: 1.3; }
.card h3 a { color: inherit; text-decoration: none; }
.card h3 a:hover { color: var(--accent); }
.card p { margin: 0; }
.card .excerpt { color: var(--muted); font-size: .92rem; }
.card .actions { margin-top: auto; padding-top: 6px; display: flex; gap: 12px; font-size: .9rem; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 0; padding: 0; list-style: none; }
.chip { display: inline-block; padding: 1px 9px; border-radius: 999px; background: var(--soft); color: var(--muted); font-size: .8rem; }
.chip.series { background: var(--gold-soft); color: color-mix(in srgb, var(--gold) 70%, var(--fg)); font-weight: 500; }
.list-plain { list-style: none; padding: 0; margin: 0; }
.list-plain li { padding: 10px 0; border-bottom: 1px solid var(--line); }
.list-plain li:last-child { border-bottom: 0; }
.empty { color: var(--muted); padding: 16px; border: 1px dashed var(--line); border-radius: var(--radius); text-align: center; }

/* Ask */
.ask-hero { position: relative; margin: -4px 0 32px; padding: 36px 32px 32px; border-radius: 20px; color: var(--ink-fg); background: radial-gradient(120% 140% at 100% 0%, var(--ink-2) 0%, var(--ink) 60%); box-shadow: var(--shadow-lift); overflow: hidden; }
.ask-hero h1 { color: var(--ink-fg); font-size: clamp(1.9rem, 4vw, 2.6rem); margin-bottom: 6px; }
.ask-hero .lead { color: var(--ink-muted); margin: 0 0 20px; }
.ask-hero .ask-box { color: var(--fg); }
@media (max-width: 600px) { .ask-hero { padding: 28px 16px 16px; border-radius: 16px; } }
.ask-box { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 16px; box-shadow: var(--shadow); }
.ask-box:focus-within { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.ask-box textarea { border: 0; padding: 4px 2px; font-family: var(--serif); font-size: 1.15rem; resize: vertical; min-height: 3.2em; background: transparent; }
.ask-box textarea:focus { outline: none; }
.ask-box .controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; border-top: 1px solid var(--line); padding-top: 10px; margin-top: 6px; }
.ask-box .controls .spacer { flex: 1; }
.ask-box .controls select { width: auto; padding: 6px 8px; }
details.scope { width: 100%; order: 5; }
details.scope summary { cursor: pointer; color: var(--accent); font-size: .92rem; list-style: none; display: inline-flex; gap: 6px; align-items: center; }
details.scope summary::-webkit-details-marker { display: none; }
details.scope summary::before { content: "▸"; font-size: .8em; }
details.scope[open] summary::before { content: "▾"; }
details.scope .scope-body { display: grid; gap: 12px; padding: 12px 0 4px; }
details.scope .scope-body label { font-size: .9rem; }
details.scope select, .ask-box details.scope select { width: 100%; }
details.scope select[multiple] { min-height: 9em; }
@media (min-width: 720px) { details.scope .scope-body { grid-template-columns: 1fr 1fr; } details.scope .scope-body .span { grid-column: 1 / -1; } }
.scope-note { font-size: .9rem; color: var(--muted); margin: 0 0 12px; }
.scope-note strong { color: var(--fg); }
.two-col { display: grid; gap: 24px; }
form.filters { margin: 16px 0 20px; }
form.filters .grow { flex: 1; min-width: 14rem; width: auto; }
form.filters select { width: auto; }
.sermon-panel form.create-one { display: inline-block; margin: 0 6px 10px 0; }
.sermon-panel .ask-box { box-shadow: none; padding: 10px; }
@media (min-width: 860px) { .two-col { grid-template-columns: 1fr 1fr; } }

/* Conversations */
.turn { margin: 0 0 28px; }
.turn .question { display: inline-block; background: var(--ink); color: var(--ink-fg); padding: 10px 16px; border-radius: 16px 16px 16px 4px; font-weight: 500; margin: 0 0 12px; }
.answer, .document { font-family: var(--serif); font-size: 1.12rem; line-height: 1.7; }
.answer sup a, .document sup a { text-decoration: none; font-family: var(--sans); font-size: .7em; font-weight: 600; color: var(--gold); }
details.sources { margin-top: 10px; }
details.sources summary { cursor: pointer; color: var(--accent); font-size: .92rem; }
ol.sources { list-style: none; padding: 0; margin: 10px 0 0; display: grid; gap: 10px; }
ol.sources li { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
ol.sources li:target { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-soft); }
ol.sources .n { display: inline-grid; place-items: center; width: 1.7em; height: 1.7em; margin-right: 6px; border-radius: 50%; font-size: .8rem; font-weight: 700; color: var(--gold); background: var(--gold-soft); }
.quote { margin: 6px 0 0; padding-left: 10px; border-left: 3px solid var(--gold-soft); font-family: var(--serif); color: var(--muted); font-size: .92rem; }
.follow-up { position: sticky; bottom: 0; padding: 12px 0 16px; background: linear-gradient(transparent, var(--bg) 20%); }
.document h2, .document h3, .document h4 { font-family: var(--serif); }
.document li { margin-bottom: 4px; }
.document blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--line); color: var(--muted); }

/* Sermon page */
.sermon { display: grid; gap: 20px; }
.sermon-head h1 { margin-bottom: 4px; }
.player { position: sticky; top: 56px; z-index: 5; background: var(--bg); padding: 6px 0; }
.player audio { width: 100%; display: block; }
label.follow { display: inline-flex; gap: 6px; align-items: center; font-weight: 400; font-size: .9rem; color: var(--muted); margin: 4px 0 0; }
label.follow input { width: auto; }
.sermon-panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; box-shadow: var(--shadow); align-self: start; }
.sermon-panel h2 { margin-top: 8px; }
.sermon-panel textarea { min-height: 5em; }
.sermon-transcript .passage { margin-bottom: 18px; }
.transcript-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; }
.transcript-head .downloads { margin: 0; font-size: .9rem; color: var(--muted); }
.sermon-transcript .passage p:last-child { font-family: var(--serif); font-size: 1.05rem; line-height: 1.7; margin: 0; }
@media (min-width: 960px) {
  .sermon { grid-template-columns: minmax(0, 1fr) 360px; grid-template-rows: auto 1fr; column-gap: 36px; }
  .sermon-head, .sermon-transcript { grid-column: 1; }
  .sermon-panel { grid-column: 2; grid-row: 1 / span 2; position: sticky; top: 76px; max-height: calc(100vh - 96px); overflow: auto; }
}
.reader .seg { cursor: pointer; border-radius: 3px; }
.reader .seg:hover { text-decoration: underline dotted var(--muted); }
.reader .seg-active { background: color-mix(in srgb, var(--gold-bright) 22%, transparent); }
.reader .word-active { background: color-mix(in srgb, var(--gold-bright) 60%, transparent); border-radius: 3px; }

/* Tabs: without the script every panel shows, each under its own heading */
.tabs [role="tablist"] { display: none; }
.tabs.js [role="tablist"] { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin: -4px 0 12px; }
.tabs.js [role="tab"] { background: none; box-shadow: none; color: var(--muted); border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 8px 10px; }
.tabs.js [role="tab"]:hover { background: none; color: var(--fg); }
.tabs.js [role="tab"][aria-selected="true"] { color: var(--fg); border-bottom-color: var(--gold); }
.tabs.js [role="tabpanel"] > h2.panel-heading { display: none; }
.tabs.js [role="tabpanel"][hidden] { display: none; }

/* Light / dark switch */
form.mode-switch { display: inline-flex; padding: 2px; border-radius: 999px; background: rgb(255 255 255 / 8%); }
form.mode-switch button { background: none; box-shadow: none; color: var(--ink-muted); padding: 3px 9px; border-radius: 999px; font-size: .9rem; line-height: 1.2; }
form.mode-switch button:hover { background: rgb(255 255 255 / 10%); color: var(--ink-fg); }
form.mode-switch button[aria-pressed="true"] { background: rgb(255 255 255 / 18%); color: var(--ink-fg); }

/* Scheme picker */
fieldset.schemes { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
fieldset.schemes legend, fieldset.schemes .hint { grid-column: 1 / -1; }
label.choice.scheme { align-items: center; margin: 0; cursor: pointer; }
label.choice.scheme input { margin: 0; }
label.choice.scheme:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.swatch { display: inline-flex; border-radius: 6px; overflow: hidden; border: 1px solid var(--line); }
.swatch span { width: 18px; height: 24px; }
.swatch .ink { background: var(--scheme-ink); }
.swatch .brand { background: var(--scheme-brand); }
.swatch .trim { background: var(--scheme-trim); }
`;

/**
 * The site's only script, served at /assets/app.js. Every page works without
 * it; it adds:
 * - a "working" state on forms that call the AI (data-busy);
 * - tabs (.tabs);
 * - the episode read-along, which highlights the sentence being played and
 *   estimates the word by spreading the sentence's time evenly across its
 *   words (the transcript has sentence timings, not word timings). Clicking a
 *   sentence or a "Listen from" link seeks the player.
 */
export const APP_SCRIPT = `(() => {
  for (const form of document.querySelectorAll("form[data-busy]")) {
    form.addEventListener("submit", () => {
      for (const button of form.querySelectorAll("button")) button.disabled = true;
      form.setAttribute("aria-busy", "true");
      if (!form.querySelector(".busy-note")) {
        const note = document.createElement("p");
        note.className = "busy-note";
        note.setAttribute("role", "status");
        note.textContent = form.dataset.busy;
        form.append(note);
      }
    });
  }

  // Admin → Answers AI: only offer the reasoning efforts the chosen model takes.
  for (const model of document.querySelectorAll("select[data-effort-select]")) {
    const effort = document.getElementById(model.dataset.effortSelect);
    if (!effort) continue;
    const sync = () => {
      const allowed = (model.selectedOptions[0]?.dataset.efforts ?? "").split(",").filter(Boolean);
      for (const option of effort.options) option.hidden = option.disabled = option.value !== "" && allowed.length > 0 && !allowed.includes(option.value);
      if (effort.selectedOptions[0]?.disabled) effort.value = "";
    };
    model.addEventListener("change", sync);
    sync();
  }

  // Citations can point into collapsed source lists; open them first.
  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#"]');
    const target = link && document.getElementById(link.getAttribute("href").slice(1));
    const details = target && target.closest("details");
    if (details) details.open = true;
  });

  for (const tabs of document.querySelectorAll(".tabs")) {
    const buttons = Array.from(tabs.querySelectorAll('[role="tab"]'));
    const show = (button, focus) => {
      for (const other of buttons) {
        const selected = other === button;
        other.setAttribute("aria-selected", String(selected));
        other.tabIndex = selected ? 0 : -1;
        document.getElementById(other.getAttribute("aria-controls")).hidden = !selected;
      }
      if (focus) button.focus();
    };
    buttons.forEach((button, index) => {
      button.addEventListener("click", () => show(button, false));
      button.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (step) show(buttons[(index + step + buttons.length) % buttons.length], true);
      });
    });
    tabs.classList.add("js");
    const wanted = buttons.find((button) => location.hash === "#" + button.getAttribute("aria-controls"));
    show(wanted || buttons[0], false);
  }

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
    for (const part of segment.text.split(/(\\\\s+)/)) {
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

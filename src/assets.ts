/** The site's only stylesheet, served at /assets/app.css. */
export const STYLESHEET = `
:root {
  --bg: #f7f5f0; --surface: #ffffff; --fg: #1d2125; --muted: #5b636b; --line: #dedbd3; --soft: #efece5;
  --accent: #2f5d50; --accent-fg: #ffffff; --accent-soft: #e3eee9; --error: #a3302a; --ok: #2f5d50;
  --radius: 10px; --shadow: 0 1px 2px rgb(0 0 0 / 6%), 0 2px 8px rgb(0 0 0 / 4%);
  --serif: ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #131517; --surface: #1b1e21; --fg: #e8eaed; --muted: #a0a7ae; --line: #30353a; --soft: #23272b;
    --accent: #7fb8a6; --accent-fg: #0f1a16; --accent-soft: #1f302a; --error: #f08a80; --ok: #7fb8a6; --shadow: none; }
}
* { box-sizing: border-box; }
html { scroll-padding-top: 72px; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); }
h1 { font-size: 1.7rem; line-height: 1.25; margin: 0 0 8px; }
h2 { font-size: 1.2rem; margin: 28px 0 10px; }
h3 { font-size: 1.05rem; margin: 20px 0 8px; }
p.lead, .hint, .meta { color: var(--muted); }
.hint { margin: 0 0 4px; font-size: .9rem; }
.meta { font-size: .9rem; margin: 0 0 12px; }
pre { background: var(--soft); padding: 8px 12px; border-radius: 6px; overflow-x: auto; }
code { background: var(--soft); padding: 1px 4px; border-radius: 4px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* Header */
header.site { position: sticky; top: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
header.site .bar { max-width: 1180px; margin: 0 auto; padding: 10px 16px; display: flex; gap: 8px 20px; align-items: center; flex-wrap: wrap; }
header.site .brand { color: inherit; font-weight: 700; text-decoration: none; margin-right: auto; }
nav.tabs-main { display: flex; gap: 4px; order: 3; width: 100%; overflow-x: auto; }
nav.tabs-main a { padding: 6px 12px; border-radius: 999px; color: var(--muted); text-decoration: none; font-weight: 600; white-space: nowrap; }
nav.tabs-main a:hover { color: var(--fg); background: var(--soft); }
nav.tabs-main a[aria-current="page"] { color: var(--accent); background: var(--accent-soft); }
.account { display: flex; gap: 10px; align-items: center; font-size: .9rem; }
.account .who { color: var(--muted); }
@media (min-width: 720px) {
  header.site .brand { margin-right: 8px; }
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
input, textarea, select { width: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: inherit; font: inherit; }
input:focus, textarea:focus, select:focus { outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent); outline-offset: 1px; border-color: var(--accent); }
.invalid input, .invalid textarea { border-color: var(--error); }
.error, .alert { color: var(--error); }
.alert { border: 1px solid var(--error); border-radius: 8px; padding: 10px 14px; }
.alert-ok { border: 1px solid var(--ok); border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; background: var(--accent-soft); }
button, a.button { display: inline-flex; align-items: center; gap: 6px; padding: 9px 18px; border: 1px solid transparent; border-radius: 8px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
button.quiet, a.button.quiet { background: transparent; color: var(--accent); border-color: var(--line); }
button.link { background: none; border: 0; padding: 0; color: var(--accent); font-weight: 400; text-decoration: underline; }
button:disabled { opacity: .6; cursor: progress; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
form.inline { display: inline; }
label.inline-label { display: inline; margin: 0; }
.row select, .row input[type="date"] { width: auto; }
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
.busy-note { color: var(--muted); font-size: .9rem; margin: 8px 0 0; }
.busy-note::before { content: ""; display: inline-block; width: .8em; height: .8em; margin-right: 8px; border: 2px solid var(--accent); border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -1px; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Cards and chips */
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; box-shadow: var(--shadow); }
.cards { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); padding: 0; margin: 0; list-style: none; }
.cards .card { display: flex; flex-direction: column; gap: 6px; }
.card h3 { margin: 0; font-size: 1.02rem; line-height: 1.35; }
.card h3 a { color: inherit; text-decoration: none; }
.card h3 a:hover { color: var(--accent); }
.card p { margin: 0; }
.card .excerpt { color: var(--muted); font-size: .92rem; }
.card .actions { margin-top: auto; padding-top: 6px; display: flex; gap: 12px; font-size: .9rem; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 0; padding: 0; list-style: none; }
.chip { display: inline-block; padding: 1px 9px; border-radius: 999px; background: var(--soft); color: var(--muted); font-size: .8rem; }
.chip.series { background: var(--accent-soft); color: var(--accent); }
.list-plain { list-style: none; padding: 0; margin: 0; }
.list-plain li { padding: 10px 0; border-bottom: 1px solid var(--line); }
.list-plain li:last-child { border-bottom: 0; }
.empty { color: var(--muted); padding: 16px; border: 1px dashed var(--line); border-radius: var(--radius); text-align: center; }

/* Ask */
.ask-hero { margin-bottom: 28px; }
.ask-box { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px; box-shadow: var(--shadow); }
.ask-box textarea { border: 0; padding: 4px 2px; font-size: 1.05rem; resize: vertical; min-height: 3.2em; background: transparent; }
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
.turn .question { display: inline-block; background: var(--accent-soft); color: var(--fg); padding: 8px 14px; border-radius: 14px 14px 14px 4px; font-weight: 600; margin: 0 0 10px; }
.answer, .document { font-family: var(--serif); font-size: 1.06rem; line-height: 1.65; }
.answer sup a, .document sup a { text-decoration: none; font-family: system-ui, sans-serif; font-size: .75em; }
details.sources { margin-top: 10px; }
details.sources summary { cursor: pointer; color: var(--accent); font-size: .92rem; }
ol.sources { list-style: none; padding: 0; margin: 10px 0 0; display: grid; gap: 10px; }
ol.sources li { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
ol.sources li:target { border-color: var(--accent); }
ol.sources .n { display: inline-block; min-width: 1.6em; font-weight: 700; color: var(--accent); }
.quote { margin: 6px 0 0; padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted); font-size: .92rem; }
.follow-up { position: sticky; bottom: 0; padding: 12px 0 16px; background: linear-gradient(transparent, var(--bg) 20%); }
.document h2, .document h3, .document h4 { font-family: system-ui, sans-serif; }
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
.sermon-transcript .passage p:last-child { font-family: var(--serif); font-size: 1.05rem; line-height: 1.7; margin: 0; }
@media (min-width: 960px) {
  .sermon { grid-template-columns: minmax(0, 1fr) 360px; column-gap: 36px; }
  .sermon-head, .sermon-transcript { grid-column: 1; }
  .sermon-panel { grid-column: 2; grid-row: 1 / span 2; position: sticky; top: 76px; max-height: calc(100vh - 96px); overflow: auto; }
}
.reader .seg { cursor: pointer; border-radius: 3px; }
.reader .seg:hover { text-decoration: underline dotted var(--muted); }
.reader .seg-active { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.reader .word-active { background: color-mix(in srgb, var(--accent) 40%, transparent); border-radius: 3px; }

/* Tabs: without the script every panel shows, each under its own heading */
.tabs [role="tablist"] { display: none; }
.tabs.js [role="tablist"] { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin: -4px 0 12px; }
.tabs.js [role="tab"] { background: none; color: var(--muted); border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 8px 10px; }
.tabs.js [role="tab"][aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
.tabs.js [role="tabpanel"] > h2.panel-heading { display: none; }
.tabs.js [role="tabpanel"][hidden] { display: none; }
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

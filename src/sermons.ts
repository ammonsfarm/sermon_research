import { askBox, OUTPUTS } from "./ask.ts";
import { chrome, type Context, clientIp, redirect, requireAdmin } from "./context.ts";
import { fileName } from "./documents.ts";
import { dispatchQueued, isRedoStep, REDO_LABELS, REDO_STEPS, type RedoStep, requestRedo } from "./episodes.ts";
import { html, type Html, page } from "./html.ts";
import { rememberOrigin } from "./imports.ts";
import type { Segment } from "./pipeline.ts";
import { formatTime, gate, nearest, SEARCHES_PER_HOUR } from "./research.ts";
import { catalog, seriesList, seriesOf, titleWithoutSeries } from "./scope.ts";
import { sameReference } from "./scriptures.ts";
import { speakerList } from "./speakers.ts";
import { HOUR_MS, recordUse, usedSince } from "./usage.ts";

interface SermonCard {
  readonly id: string;
  readonly title: string;
  readonly published_at: string | null;
  readonly speaker: string | null;
  readonly summary: string | null;
  /** Null until chosen, empty when there's no single main passage. */
  readonly main_scripture: string | null;
  readonly topics_json: string | null;
  readonly scriptures_json: string | null;
}

const SELECT_CARDS = `SELECT e.id, e.title, e.published_at, e.speaker, s.summary, s.main_scripture, s.topics_json, s.scriptures_json
  FROM episodes e LEFT JOIN summaries s ON s.episode_id = e.id WHERE e.status = 'done'`;

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;
}

function parseList(json: string | null): string[] {
  try {
    const value = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function card(row: SermonCard): Html {
  const series = seriesOf(row.title);
  const topics = parseList(row.topics_json).slice(0, 3);
  // Until the main passage is chosen, the first reference listed usually is it.
  const scripture = row.main_scripture ?? parseList(row.scriptures_json)[0];
  const summary = row.summary ?? "";
  return html`<li class="card">
<p class="hint">${row.published_at?.slice(0, 10) ?? ""}${row.speaker ? ` · ${row.speaker}` : ""}${series ? html` · <span class="chip series">${series}</span>` : ""}</p>
<h3><a href="/episodes/${row.id}">${titleWithoutSeries(row.title)}</a></h3>
${summary ? html`<p class="excerpt">${summary.length > 180 ? `${summary.slice(0, 180)}…` : summary}</p>` : ""}
${topics.length || scripture ? html`<ul class="chips">${topics.map((topic) => html`<li class="chip">${topic}</li>`)}${scripture ? html`<li class="chip">${scripture}</li>` : ""}</ul>` : ""}
<p class="actions"><a href="/episodes/${row.id}">Read and listen</a><a href="/episodes/${row.id}#panel-ask">Ask about it</a></p>
</li>`;
}

/** GET /episodes?q=&series=&speaker=&sort= : keyword matches first, then semantic matches the keywords missed. */
export async function sermonsPage(context: Context): Promise<Response> {
  const blocked = await gate(context);
  if (blocked) return blocked;
  const { db } = context;
  const params = context.url.searchParams;
  const query = (params.get("q") ?? "").trim().slice(0, 200);
  const entries = await catalog(db);
  const allSeries = seriesList(entries);
  const series = allSeries.includes(params.get("series") ?? "") ? params.get("series")! : "";
  const allSpeakers = speakerList(entries);
  const speaker = allSpeakers.includes(params.get("speaker") ?? "") ? params.get("speaker")! : "";
  const oldest = params.get("sort") === "oldest";
  const inSeries = (row: { title: string; speaker: string | null }) => (!series || seriesOf(row.title) === series) && (!speaker || row.speaker === speaker);
  const order = `ORDER BY e.published_at ${oldest ? "ASC" : "DESC"}`;

  let matches: SermonCard[];
  let related: SermonCard[] = [];
  let note = "";
  if (!query) {
    matches = (await db.prepare(`${SELECT_CARDS} ${order} LIMIT 500`).all<SermonCard>()).results.filter(inSeries);
  } else {
    const like = likePattern(query);
    matches = (await db.prepare(`${SELECT_CARDS} AND (e.title LIKE ?1 ESCAPE '\\' OR e.speaker LIKE ?1 ESCAPE '\\' OR s.main_scripture LIKE ?1 ESCAPE '\\' OR s.summary LIKE ?1 ESCAPE '\\' OR s.topics_json LIKE ?1 ESCAPE '\\' OR s.scriptures_json LIKE ?1 ESCAPE '\\') ${order} LIMIT 100`)
      .bind(like).all<SermonCard>()).results.filter(inSeries);
    const bucket = context.session ? `search-user:${context.session.user.id}` : `search-ip:${clientIp(context.request)}`;
    if (await usedSince(db, bucket, Date.now() - HOUR_MS) >= SEARCHES_PER_HOUR) {
      note = "Showing keyword matches only; related-meaning search is paused for this hour.";
    } else {
      await recordUse(db, [bucket]);
      try {
        const seen = new Set(matches.map((row) => row.id));
        const scoped = series || speaker ? entries.filter((entry) => (!series || entry.series === series) && (!speaker || entry.speaker === speaker)).map((entry) => entry.id) : null;
        const ids = [...new Set((await nearest(context.env, query, 30, scoped)).map((match) => match.id.split(":")[0]!))].filter((id) => !seen.has(id)).slice(0, 12);
        if (ids.length > 0) {
          const rows = (await db.prepare(`${SELECT_CARDS} AND e.id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all<SermonCard>()).results;
          const byId = new Map(rows.map((row) => [row.id, row]));
          related = ids.flatMap((id) => byId.get(id) ?? []);
        }
      } catch (error) {
        console.error("semantic search failed", error);
        note = "Related-meaning search isn't available right now; showing keyword matches.";
      }
    }
  }
  const filtered = Boolean(query || series || speaker);
  return page("Sermons", html`<h1>Sermons</h1>
<p class="lead">${entries.length} sermon${entries.length === 1 ? "" : "s"} with transcripts, summaries and read-along audio.</p>
<form method="get" action="/episodes" class="row filters">
<input name="q" type="search" value="${query}" placeholder="Search titles, speakers, topics, scripture or ideas" aria-label="Search sermons" class="grow">
${allSeries.length ? html`<select name="series" aria-label="Series"><option value="">All series</option>${allSeries.map((name) => html`<option value="${name}"${name === series ? html` selected` : ""}>${name}</option>`)}</select>` : ""}
${allSpeakers.length ? html`<select name="speaker" aria-label="Speaker"><option value="">All speakers</option>${allSpeakers.map((name) => html`<option value="${name}"${name === speaker ? html` selected` : ""}>${name}</option>`)}</select>` : ""}
<select name="sort" aria-label="Order"><option value="newest">Newest first</option><option value="oldest"${oldest ? html` selected` : ""}>Oldest first</option></select>
<button type="submit">Search</button>
${filtered ? html`<a href="/episodes">Clear</a>` : ""}
</form>
${note ? html`<p class="hint">${note}</p>` : ""}
${series || speaker ? html`<p class="scope-note">${[series ? `Series: ${series}` : "", speaker ? `Speaker: ${speaker}` : ""].filter(Boolean).join(" · ")} · <a href="/?${new URLSearchParams({ ...(series ? { scope_series: series } : {}), ...(speaker ? { scope_speaker: speaker } : {}) }).toString()}">Ask about ${series && speaker ? "these sermons" : series ? "this series" : "this speaker's sermons"}</a></p>` : ""}
${matches.length ? html`<ul class="cards">${matches.map(card)}</ul>` : ""}
${related.length ? html`<h2>Related in meaning</h2><ul class="cards">${related.map(card)}</ul>` : ""}
${matches.length === 0 && related.length === 0 ? html`<p class="empty">${filtered ? "No sermons match." : "No sermons have been processed yet."}</p>` : ""}`, { wide: true, ...chrome(context) });
}

function isWebUrl(value: string | null): value is string {
  return Boolean(value && /^https?:\/\//iu.test(value));
}

/** GET /episodes/:id : read-along transcript, with a panel to ask about or create from this sermon. */
export async function sermonPage(context: Context, id: string): Promise<Response> {
  const blocked = await gate(context);
  if (blocked) return blocked;
  const { db } = context;
  const episode = await db.prepare(
    `SELECT e.id, e.title, e.published_at, e.audio_url, e.audio_key, e.speaker, e.redo, e.stage, e.detail, e.error, s.summary, s.main_scripture, s.topics_json, s.scriptures_json
     FROM episodes e JOIN summaries s ON s.episode_id = e.id WHERE e.id = ? AND e.status = 'done'`,
  ).bind(id).first<{
    id: string; title: string; published_at: string | null; audio_url: string | null; audio_key: string | null; speaker: string | null;
    redo: RedoStep | null; stage: string | null; detail: string | null; error: string | null;
    summary: string; main_scripture: string | null; topics_json: string; scriptures_json: string;
  }>();
  if (!episode) return page("Not found", html`<h1>Sermon not found</h1><p><a href="/episodes">All sermons</a></p>`, { status: 404, ...chrome(context) });
  const [chunkRows, transcript, entries] = await Promise.all([
    db.prepare("SELECT seq, text, start_seconds FROM chunks WHERE episode_id = ? AND kind = 'transcript' ORDER BY seq")
      .bind(id).all<{ seq: number; text: string; start_seconds: number | null }>(),
    db.prepare("SELECT segments_json FROM transcripts WHERE episode_id = ?").bind(id).first<{ segments_json: string }>(),
    catalog(db),
  ]);
  const chunks = chunkRows.results;
  const topics = parseList(episode.topics_json);
  const mainText = episode.main_scripture || null;
  const scriptures = parseList(episode.scriptures_json).filter((reference) => !sameReference(reference, mainText));
  const series = seriesOf(episode.title);
  // Our own copy in R2 when we have one; the feed's link otherwise.
  const audio = episode.audio_key ? `/audio/${episode.id}` : isWebUrl(episode.audio_url) ? episode.audio_url : null;
  const segments = audio && transcript ? segmentsByChunk(chunks, JSON.parse(transcript.segments_json) as Segment[]) : null;
  const scope = { episodes: [episode.id] };

  return page(episode.title, html`<div class="sermon">
<div class="sermon-head">
<p class="meta"><a href="/episodes">Sermons</a>${series ? html` · <a href="/episodes?series=${encodeURIComponent(series)}">${series}</a>` : ""} · ${episode.published_at?.slice(0, 10) ?? ""}${episode.speaker ? html` · <a href="/episodes?speaker=${encodeURIComponent(episode.speaker)}">${episode.speaker}</a>` : ""}${mainText ? ` · ${mainText}` : ""}</p>
<h1>${titleWithoutSeries(episode.title)}</h1>
${audio ? html`<div class="player"><audio id="player" controls preload="metadata" src="${audio}"></audio>
${segments ? html`<label class="follow"><input type="checkbox" id="follow" checked> Follow along as it plays</label>` : ""}</div>` : ""}
</div>
<aside class="sermon-panel tabs" aria-label="About this sermon">
<div role="tablist" aria-label="About this sermon">
<button type="button" role="tab" id="tab-summary" aria-controls="panel-summary">Summary</button>
<button type="button" role="tab" id="tab-ask" aria-controls="panel-ask">Ask</button>
<button type="button" role="tab" id="tab-create" aria-controls="panel-create">Create</button>
</div>
<section role="tabpanel" id="panel-summary" aria-labelledby="tab-summary"><h2 class="panel-heading">Summary</h2>
<div id="t-0">${episode.summary.split(/\n\s*\n/u).map((paragraph) => html`<p>${paragraph}</p>`)}</div>
${topics.length ? html`<h3>Topics</h3><ul class="chips">${topics.map((topic) => html`<li class="chip">${topic}</li>`)}</ul>` : ""}
${mainText ? html`<h3>Main text</h3><ul class="chips"><li class="chip">${mainText}</li></ul>` : ""}
${scriptures.length ? html`<h3>${mainText ? "Also mentioned" : "Scripture"}</h3><ul class="chips">${scriptures.map((ref) => html`<li class="chip">${ref}</li>`)}</ul>` : ""}
${context.session?.user.role === "admin" ? html`<form class="row" method="post" action="/episodes/${episode.id}/speaker">
<label for="f-speaker" class="inline-label">Speaker</label>
<input id="f-speaker" name="speaker" value="${episode.speaker ?? ""}" maxlength="100" list="speakers" placeholder="Unknown">
<datalist id="speakers">${speakerList(entries).map((name) => html`<option value="${name}"></option>`)}</datalist>
<button class="quiet" type="submit">Save</button>
<span class="hint">Only admins see this. Leave it blank if it isn't known.</span>
</form>
${reprocessControl(episode)}` : ""}
</section>
<section role="tabpanel" id="panel-ask" aria-labelledby="tab-ask"><h2 class="panel-heading">Ask about this sermon</h2>
<p class="hint">Answers come only from this sermon.</p>
${askBox(context, { scope, entries, label: "Ask about this sermon", fixedScope: true })}
</section>
<section role="tabpanel" id="panel-create" aria-labelledby="tab-create"><h2 class="panel-heading">Create from this sermon</h2>
${context.session ? html`<p class="hint">Written in Markdown from this sermon, saved to your Library.</p>
${(["outline", "questions"] as const).map((kind) => html`<form method="post" action="/research" data-busy="Starting…" class="create-one">
<input type="hidden" name="kind" value="${kind}"><input type="hidden" name="scope_episode" value="${episode.id}">
<input type="hidden" name="question" value="${`${OUTPUTS[kind]} for “${episode.title}”`}">
<button class="quiet" type="submit">${OUTPUTS[kind]}</button></form>`)}
<form method="post" action="/research" data-busy="Starting…">
<input type="hidden" name="kind" value="custom"><input type="hidden" name="scope_episode" value="${episode.id}">
<label for="f-custom">Something else</label>
<textarea id="f-custom" name="question" rows="3" maxlength="500" required placeholder="For example: a one-page summary for the church newsletter"></textarea>
<p><button type="submit">Create</button></p></form>` : html`<p><a href="/login">Sign in</a> to create outlines, study questions and other documents from this sermon.</p>`}
</section>
</aside>
<section class="sermon-transcript" aria-label="Transcript">
<div class="transcript-head"><h2>Transcript</h2>
<p class="downloads">Download <a href="/episodes/${episode.id}/transcript.md" download>Markdown</a> · <a href="/episodes/${episode.id}/transcript.txt" download>Plain text</a></p></div>
${segments ? html`<p class="hint">Click any sentence to play from there. Highlighted words are estimated from sentence timings.</p>` : ""}
<div class="${segments ? "reader" : "transcript"}">
${chunks.map((chunk, index) => html`<div class="passage" id="t-${chunk.seq}">
${chunk.start_seconds !== null ? html`<p class="hint">${audio ? html`<a href="${audio}#t=${Math.floor(chunk.start_seconds)}" data-seek="${chunk.start_seconds}">Listen from ${formatTime(chunk.start_seconds)}</a>` : formatTime(chunk.start_seconds)}</p>` : ""}
<p>${segments?.[index]?.length
    ? segments[index]!.map((segment) => html`<span class="seg" data-start="${segment.start}" data-end="${segment.end}">${segment.text.trim()}</span> `)
    : chunk.text}</p></div>`)}
</div>
</section>
</div>`, { wide: true, ...chrome(context) });
}

/**
 * The full transcript as a file: Markdown with the summary, topics, scripture
 * and a timestamp before each passage, or plain text with timestamps.
 */
export async function transcriptDownload(context: Context, id: string, format: "md" | "txt"): Promise<Response> {
  const blocked = await gate(context);
  if (blocked) return blocked;
  const { db } = context;
  const episode = await db.prepare(
    `SELECT e.id, e.title, e.published_at, e.speaker, s.summary, s.main_scripture, s.topics_json, s.scriptures_json
     FROM episodes e JOIN summaries s ON s.episode_id = e.id WHERE e.id = ? AND e.status = 'done'`,
  ).bind(id).first<{ id: string; title: string; published_at: string | null; speaker: string | null; summary: string; main_scripture: string | null; topics_json: string; scriptures_json: string }>();
  if (!episode) return new Response("Sermon not found.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const { results: chunks } = await db.prepare("SELECT text, start_seconds FROM chunks WHERE episode_id = ? AND kind = 'transcript' ORDER BY seq")
    .bind(id).all<{ text: string; start_seconds: number | null }>();
  const date = episode.published_at?.slice(0, 10) ?? "";
  const church = context.ministry?.churchName ?? "";
  const link = `${context.url.origin}/episodes/${episode.id}`;
  const stamp = (seconds: number | null) => seconds === null ? "" : `[${formatTime(seconds)}] `;
  const body = format === "md"
    ? [
      `# ${episode.title}`,
      [date, episode.speaker, church].filter(Boolean).join(" · "),
      `## Summary\n\n${episode.summary.trim()}`,
      ...(episode.main_scripture ? [`**Main text:** ${episode.main_scripture}`] : []),
      ...(parseList(episode.topics_json).length ? [`**Topics:** ${parseList(episode.topics_json).join(", ")}`] : []),
      ...(parseList(episode.scriptures_json).length ? [`**Scripture:** ${parseList(episode.scriptures_json).join(", ")}`] : []),
      "## Transcript",
      ...chunks.map((chunk) => `${chunk.start_seconds === null ? "" : `**${formatTime(chunk.start_seconds)}** `}${chunk.text.trim()}`),
      `---\n\nFrom ${link}`,
    ].filter(Boolean).join("\n\n")
    : [episode.title, [date, episode.speaker, church].filter(Boolean).join(" · "), "", ...chunks.map((chunk) => `${stamp(chunk.start_seconds)}${chunk.text.trim()}\n`), `From ${link}`].join("\n");
  return new Response(`${body}\n`, {
    headers: {
      "Content-Type": `${format === "md" ? "text/markdown" : "text/plain"}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="${fileName(`${date} ${episode.title} transcript`, `.${format}`)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Where an admin redoes part of a finished sermon, or sees how a redo is going. */
function reprocessControl(episode: { id: string; redo: RedoStep | null; stage: string | null; detail: string | null; error: string | null }): Html {
  const progress = html`<a href="/admin/episodes?status=reprocessing">Admin → Episodes</a>`;
  if (episode.redo && episode.stage) return html`<p class="hint">Re-processing now: ${episode.detail ?? "Starting"}. Follow it in ${progress}.</p>`;
  return html`${episode.redo ? html`<p class="hint">${episode.error ? html`Re-processing failed: ${episode.error} Retry it in ${progress}, or start again below.` : html`Waiting to re-process from: ${REDO_LABELS[episode.redo]}.`}</p>` : ""}
<form method="post" action="/episodes/${episode.id}/reprocess" data-busy="Starting…">
<label for="f-redo">Re-process</label>
<p class="hint">Each choice also redoes the ones after it in this list, since each is made from the one before. The sermon keeps its current version until each new part is ready.</p>
<select id="f-redo" name="from" required><option value="" selected disabled>Choose what to redo</option>${REDO_STEPS.map((step) => html`<option value="${step}">${REDO_LABELS[step]}</option>`)}</select>
<p><button class="quiet" type="submit">Start</button></p>
</form>`;
}

/** POST /episodes/:id/reprocess : an admin redoes a finished sermon from one step on. */
export async function reprocessEpisode(context: Context, id: string): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const from = (await context.request.formData()).get("from");
  if (!isRedoStep(from)) return redirect(`/episodes/${id}`);
  const episode = await context.db.prepare("SELECT title FROM episodes WHERE id = ?").bind(id).first<{ title: string }>();
  if (!episode) return redirect("/admin/episodes");
  await rememberOrigin(context);
  const started = await requestRedo(context.db, id, from);
  if (started) await dispatchQueued(context.env);
  const notice = started
    ? `Re-processing “${episode.title}” from: ${REDO_LABELS[from]}. It keeps its current version until each new part is ready.`
    : `“${episode.title}” can't be re-processed right now: it's either still being processed or not finished yet.`;
  return redirect(`/admin/episodes?status=reprocessing&notice=${encodeURIComponent(notice)}`);
}

/** POST /episodes/:id/speaker : an admin sets or clears who preached. The AI never changes it afterwards. */
export async function saveSpeaker(context: Context, id: string): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const form = await context.request.formData();
  const speaker = String(form.get("speaker") ?? "").replace(/\s+/gu, " ").trim().slice(0, 100);
  await context.db.prepare("UPDATE episodes SET speaker = ?, speaker_source = 'admin' WHERE id = ?").bind(speaker || null, id).run();
  return redirect(`/episodes/${id}`);
}

/**
 * Splits the transcript's timed segments into the stored passages. Passages
 * are built from consecutive segments, so each segment belongs to the last
 * passage that starts at or before it.
 */
export function segmentsByChunk(chunks: readonly { start_seconds: number | null }[], segments: readonly Segment[]): Segment[][] {
  const groups: Segment[][] = chunks.map(() => []);
  let current = 0;
  for (const segment of segments) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || !segment.text.trim()) continue;
    while (current + 1 < chunks.length && (chunks[current + 1]!.start_seconds ?? Infinity) <= segment.start) current += 1;
    groups[current]?.push(segment);
  }
  return groups;
}


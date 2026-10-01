import { askBox, OUTPUTS } from "./ask.ts";
import { chrome, type Context, clientIp } from "./context.ts";
import { fileName } from "./documents.ts";
import { html, type Html, page } from "./html.ts";
import type { Segment } from "./pipeline.ts";
import { formatTime, gate, nearest, SEARCHES_PER_HOUR } from "./research.ts";
import { catalog, seriesList, seriesOf, titleWithoutSeries } from "./scope.ts";
import { HOUR_MS, recordUse, usedSince } from "./usage.ts";

interface SermonCard {
  readonly id: string;
  readonly title: string;
  readonly published_at: string | null;
  readonly summary: string | null;
  readonly topics_json: string | null;
  readonly scriptures_json: string | null;
}

const SELECT_CARDS = `SELECT e.id, e.title, e.published_at, s.summary, s.topics_json, s.scriptures_json
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
  const scripture = parseList(row.scriptures_json)[0];
  const summary = row.summary ?? "";
  return html`<li class="card">
<p class="hint">${row.published_at?.slice(0, 10) ?? ""}${series ? html` · <span class="chip series">${series}</span>` : ""}</p>
<h3><a href="/episodes/${row.id}">${titleWithoutSeries(row.title)}</a></h3>
${summary ? html`<p class="excerpt">${summary.length > 180 ? `${summary.slice(0, 180)}…` : summary}</p>` : ""}
${topics.length || scripture ? html`<ul class="chips">${topics.map((topic) => html`<li class="chip">${topic}</li>`)}${scripture ? html`<li class="chip">${scripture}</li>` : ""}</ul>` : ""}
<p class="actions"><a href="/episodes/${row.id}">Read and listen</a><a href="/episodes/${row.id}#panel-ask">Ask about it</a></p>
</li>`;
}

/** GET /episodes?q=&series=&sort= : keyword matches first, then semantic matches the keywords missed. */
export async function sermonsPage(context: Context): Promise<Response> {
  const blocked = await gate(context);
  if (blocked) return blocked;
  const { db } = context;
  const params = context.url.searchParams;
  const query = (params.get("q") ?? "").trim().slice(0, 200);
  const entries = await catalog(db);
  const allSeries = seriesList(entries);
  const series = allSeries.includes(params.get("series") ?? "") ? params.get("series")! : "";
  const oldest = params.get("sort") === "oldest";
  const inSeries = (row: { title: string }) => !series || seriesOf(row.title) === series;
  const order = `ORDER BY e.published_at ${oldest ? "ASC" : "DESC"}`;

  let matches: SermonCard[];
  let related: SermonCard[] = [];
  let note = "";
  if (!query) {
    matches = (await db.prepare(`${SELECT_CARDS} ${order} LIMIT 500`).all<SermonCard>()).results.filter(inSeries);
  } else {
    const like = likePattern(query);
    matches = (await db.prepare(`${SELECT_CARDS} AND (e.title LIKE ?1 ESCAPE '\\' OR s.summary LIKE ?1 ESCAPE '\\' OR s.topics_json LIKE ?1 ESCAPE '\\' OR s.scriptures_json LIKE ?1 ESCAPE '\\') ${order} LIMIT 100`)
      .bind(like).all<SermonCard>()).results.filter(inSeries);
    const bucket = context.session ? `search-user:${context.session.user.id}` : `search-ip:${clientIp(context.request)}`;
    if (await usedSince(db, bucket, Date.now() - HOUR_MS) >= SEARCHES_PER_HOUR) {
      note = "Showing keyword matches only; related-meaning search is paused for this hour.";
    } else {
      await recordUse(db, [bucket]);
      try {
        const seen = new Set(matches.map((row) => row.id));
        const scoped = series ? entries.filter((entry) => entry.series === series).map((entry) => entry.id) : null;
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
  const filtered = Boolean(query || series);
  return page("Sermons", html`<h1>Sermons</h1>
<p class="lead">${entries.length} sermon${entries.length === 1 ? "" : "s"} with transcripts, summaries and read-along audio.</p>
<form method="get" action="/episodes" class="row filters">
<input name="q" type="search" value="${query}" placeholder="Search titles, topics, scripture or ideas" aria-label="Search sermons" class="grow">
${allSeries.length ? html`<select name="series" aria-label="Series"><option value="">All series</option>${allSeries.map((name) => html`<option value="${name}"${name === series ? html` selected` : ""}>${name}</option>`)}</select>` : ""}
<select name="sort" aria-label="Order"><option value="newest">Newest first</option><option value="oldest"${oldest ? html` selected` : ""}>Oldest first</option></select>
<button type="submit">Search</button>
${filtered ? html`<a href="/episodes">Clear</a>` : ""}
</form>
${note ? html`<p class="hint">${note}</p>` : ""}
${series ? html`<p class="scope-note">Series: <strong>${series}</strong> · <a href="/?scope_series=${encodeURIComponent(series)}">Ask about this series</a></p>` : ""}
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
    `SELECT e.id, e.title, e.published_at, e.audio_url, e.audio_key, s.summary, s.topics_json, s.scriptures_json
     FROM episodes e JOIN summaries s ON s.episode_id = e.id WHERE e.id = ? AND e.status = 'done'`,
  ).bind(id).first<{ id: string; title: string; published_at: string | null; audio_url: string | null; audio_key: string | null; summary: string; topics_json: string; scriptures_json: string }>();
  if (!episode) return page("Not found", html`<h1>Sermon not found</h1><p><a href="/episodes">All sermons</a></p>`, { status: 404, ...chrome(context) });
  const [chunkRows, transcript, entries] = await Promise.all([
    db.prepare("SELECT seq, text, start_seconds FROM chunks WHERE episode_id = ? AND kind = 'transcript' ORDER BY seq")
      .bind(id).all<{ seq: number; text: string; start_seconds: number | null }>(),
    db.prepare("SELECT segments_json FROM transcripts WHERE episode_id = ?").bind(id).first<{ segments_json: string }>(),
    catalog(db),
  ]);
  const chunks = chunkRows.results;
  const topics = parseList(episode.topics_json);
  const scriptures = parseList(episode.scriptures_json);
  const series = seriesOf(episode.title);
  // Our own copy in R2 when we have one; the feed's link otherwise.
  const audio = episode.audio_key ? `/audio/${episode.id}` : isWebUrl(episode.audio_url) ? episode.audio_url : null;
  const segments = audio && transcript ? segmentsByChunk(chunks, JSON.parse(transcript.segments_json) as Segment[]) : null;
  const scope = { episodes: [episode.id] };

  return page(episode.title, html`<div class="sermon">
<div class="sermon-head">
<p class="meta"><a href="/episodes">Sermons</a>${series ? html` · <a href="/episodes?series=${encodeURIComponent(series)}">${series}</a>` : ""} · ${episode.published_at?.slice(0, 10) ?? ""}</p>
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
${scriptures.length ? html`<h3>Scripture</h3><ul class="chips">${scriptures.map((ref) => html`<li class="chip">${ref}</li>`)}</ul>` : ""}
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
    `SELECT e.id, e.title, e.published_at, s.summary, s.topics_json, s.scriptures_json
     FROM episodes e JOIN summaries s ON s.episode_id = e.id WHERE e.id = ? AND e.status = 'done'`,
  ).bind(id).first<{ id: string; title: string; published_at: string | null; summary: string; topics_json: string; scriptures_json: string }>();
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
      [date, church].filter(Boolean).join(" · "),
      `## Summary\n\n${episode.summary.trim()}`,
      ...(parseList(episode.topics_json).length ? [`**Topics:** ${parseList(episode.topics_json).join(", ")}`] : []),
      ...(parseList(episode.scriptures_json).length ? [`**Scripture:** ${parseList(episode.scriptures_json).join(", ")}`] : []),
      "## Transcript",
      ...chunks.map((chunk) => `${chunk.start_seconds === null ? "" : `**${formatTime(chunk.start_seconds)}** `}${chunk.text.trim()}`),
      `---\n\nFrom ${link}`,
    ].filter(Boolean).join("\n\n")
    : [episode.title, [date, church].filter(Boolean).join(" · "), "", ...chunks.map((chunk) => `${stamp(chunk.start_seconds)}${chunk.text.trim()}\n`), `From ${link}`].join("\n");
  return new Response(`${body}\n`, {
    headers: {
      "Content-Type": `${format === "md" ? "text/markdown" : "text/plain"}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="${fileName(`${date} ${episode.title} transcript`, `.${format}`)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
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


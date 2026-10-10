import { html, type Html } from "./html.ts";
import { speakerList } from "./speakers.ts";

/** Which sermons a question or document draws on. An empty scope means all of them. */
export interface Scope {
  readonly series?: string;
  readonly speaker?: string;
  /** Inclusive dates, YYYY-MM-DD. */
  readonly from?: string;
  readonly to?: string;
  readonly episodes?: readonly string[];
  /** How sermon text reaches the answers AI: "full" sends every sermon in the scope whole, "search" only the closest passages. Unset means automatic. */
  readonly text?: "full" | "search";
  /** Sermons whose whole text always goes in, with the rest of the scope searched for related passages. */
  readonly full?: readonly string[];
}

export interface CatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly publishedAt: string | null;
  readonly series: string | null;
  readonly speaker: string | null;
}

const MAX_PICKED = 50;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ID = /^[0-9a-f-]{36}$/u;

/**
 * Podcast feeds often name episodes "Sermon title - Series name". The part
 * after the last " - " is taken as the series when it is short enough to be one.
 */
export function seriesOf(title: string): string | null {
  const at = title.lastIndexOf(" - ");
  if (at <= 0) return null;
  const series = title.slice(at + 3).trim();
  return series && series.length <= 80 ? series : null;
}

/** The title without its series suffix, for cards that show the series separately. */
export function titleWithoutSeries(title: string): string {
  const series = seriesOf(title);
  return series ? title.slice(0, title.lastIndexOf(" - ")).trim() : title;
}

export async function catalog(db: D1Database): Promise<CatalogEntry[]> {
  const { results } = await db.prepare("SELECT id, title, published_at, speaker FROM episodes WHERE status = 'done' ORDER BY published_at DESC")
    .all<{ id: string; title: string; published_at: string | null; speaker: string | null }>();
  return results.map((row) => ({ id: row.id, title: row.title, publishedAt: row.published_at, series: seriesOf(row.title), speaker: row.speaker }));
}

/** Series names, most recently preached first. */
export function seriesList(entries: readonly CatalogEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.series ?? []))];
}

/** Reads scope fields from a form or query string, dropping anything malformed. */
export function parseScope(values: FormData | URLSearchParams): Scope {
  const text = (name: string) => String(values.get(name) ?? "").trim();
  const series = text("scope_series").slice(0, 120);
  const speaker = text("scope_speaker").slice(0, 120);
  const from = text("scope_from");
  const to = text("scope_to");
  const episodes = [...new Set(values.getAll("scope_episode").map(String).filter((id) => ID.test(id)))].slice(0, MAX_PICKED);
  const mode = text("scope_text");
  const full = [...new Set(values.getAll("scope_full").map(String).filter((id) => ID.test(id)))].slice(0, MAX_PICKED);
  return {
    ...(mode === "full" || mode === "search" ? { text: mode } : {}),
    ...(full.length ? { full } : {}),
    ...(series ? { series } : {}),
    ...(speaker ? { speaker } : {}),
    ...(DATE.test(from) ? { from } : {}),
    ...(DATE.test(to) ? { to } : {}),
    ...(episodes.length ? { episodes } : {}),
  };
}

export function isAll(scope: Scope): boolean {
  return !scope.series && !scope.speaker && !scope.from && !scope.to && !scope.episodes?.length;
}

/** The episode ids a scope allows, or null for all sermons. */
export function scopeIds(scope: Scope, entries: readonly CatalogEntry[]): string[] | null {
  if (isAll(scope)) return null;
  const picked = scope.episodes?.length ? new Set(scope.episodes) : null;
  return entries.filter((entry) => {
    if (picked && !picked.has(entry.id)) return false;
    if (scope.series && entry.series !== scope.series) return false;
    if (scope.speaker && entry.speaker?.toLowerCase() !== scope.speaker.toLowerCase()) return false;
    const day = entry.publishedAt?.slice(0, 10);
    if (scope.from && (!day || day < scope.from)) return false;
    if (scope.to && (!day || day > scope.to)) return false;
    return true;
  }).map((entry) => entry.id);
}

/** A short description, like "Series: Matthew, Speaker: Jane Doe, from 2026-01-01" or "“Grace Alone”". */
export function describeScope(scope: Scope, entries: readonly CatalogEntry[]): string {
  if (isAll(scope)) return "All sermons";
  const parts: string[] = [];
  if (scope.episodes?.length) {
    const titles = new Map(entries.map((entry) => [entry.id, entry.title]));
    parts.push(scope.episodes.length === 1 ? `“${titles.get(scope.episodes[0]!) ?? "One sermon"}”` : `${scope.episodes.length} chosen sermons`);
  }
  if (scope.series) parts.push(`Series: ${scope.series}`);
  if (scope.speaker) parts.push(`Speaker: ${scope.speaker}`);
  if (scope.from && scope.to) parts.push(`${scope.from} to ${scope.to}`);
  else if (scope.from) parts.push(`from ${scope.from}`);
  else if (scope.to) parts.push(`up to ${scope.to}`);
  return parts.join(", ");
}

/** Hidden fields that carry a scope into a follow-up question. */
export function scopeFields(scope: Scope): Html {
  return html`${scope.series ? html`<input type="hidden" name="scope_series" value="${scope.series}">` : ""}${scope.speaker ? html`<input type="hidden" name="scope_speaker" value="${scope.speaker}">` : ""}${scope.from ? html`<input type="hidden" name="scope_from" value="${scope.from}">` : ""}${scope.to ? html`<input type="hidden" name="scope_to" value="${scope.to}">` : ""}${(scope.episodes ?? []).map((id) => html`<input type="hidden" name="scope_episode" value="${id}">`)}${scope.text ? html`<input type="hidden" name="scope_text" value="${scope.text}">` : ""}${(scope.full ?? []).map((id) => html`<input type="hidden" name="scope_full" value="${id}">`)}`;
}

/** The "Scope" disclosure in the ask box: series, dates and specific sermons. */
export function scopeControls(scope: Scope, entries: readonly CatalogEntry[]): Html {
  const series = seriesList(entries);
  const speakers = speakerList(entries);
  const picked = new Set(scope.episodes ?? []);
  const whole = new Set(scope.full ?? []);
  return html`<details class="scope"${isAll(scope) && !scope.text && !scope.full?.length ? "" : html` open`}>
<summary>Scope: ${describeScope(scope, entries)}</summary>
<div class="scope-body">
<div><label for="f-scope-series">Series</label>
<select id="f-scope-series" name="scope_series"><option value="">Any series</option>${series.map((name) => html`<option value="${name}"${name === scope.series ? html` selected` : ""}>${name}</option>`)}</select></div>
${speakers.length ? html`<div><label for="f-scope-speaker">Speaker</label>
<select id="f-scope-speaker" name="scope_speaker"><option value="">Any speaker</option>${speakers.map((name) => html`<option value="${name}"${name === scope.speaker ? html` selected` : ""}>${name}</option>`)}</select></div>` : ""}
<div class="row"><div><label for="f-scope-from">From</label><input id="f-scope-from" name="scope_from" type="date" value="${scope.from ?? ""}"></div>
<div><label for="f-scope-to">To</label><input id="f-scope-to" name="scope_to" type="date" value="${scope.to ?? ""}"></div></div>
<div class="span"><label for="f-scope-episode">Only these sermons</label>
<p class="hint">Optional. Hold Ctrl or ⌘ to pick several.</p>
<select id="f-scope-episode" name="scope_episode" multiple>${entries.map((entry) => html`<option value="${entry.id}"${picked.has(entry.id) ? html` selected` : ""}>${entry.publishedAt?.slice(0, 10) ?? ""} · ${entry.title}${entry.speaker ? ` · ${entry.speaker}` : ""}</option>`)}</select></div>
<div><label for="f-scope-text">Sermon text</label>
<select id="f-scope-text" name="scope_text"><option value="">Automatic</option><option value="full"${scope.text === "full" ? html` selected` : ""}>Full sermons</option><option value="search"${scope.text === "search" ? html` selected` : ""}>Search only</option></select>
<p class="hint">Automatic sends whole sermons when the scope is small enough, and otherwise the closest passages with the text around them.</p></div>
<div class="span"><label for="f-scope-full">Always include in full</label>
<p class="hint">Optional. These sermons go in whole, and the rest of the scope is searched for related passages.</p>
<select id="f-scope-full" name="scope_full" multiple>${entries.map((entry) => html`<option value="${entry.id}"${whole.has(entry.id) ? html` selected` : ""}>${entry.publishedAt?.slice(0, 10) ?? ""} · ${entry.title}${entry.speaker ? ` · ${entry.speaker}` : ""}</option>`)}</select></div>
</div>
</details>`;
}

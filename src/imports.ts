import { type Context, redirect, requireAdmin, chrome } from "./context.ts";
import { formatBytes } from "./audio.ts";
import { concurrency, dispatchQueued, type EpisodeRow, listEpisodes, MAX_CONCURRENCY, type ProcessingSettings, queueAllFailed, queueAllNotImported, queueEpisodes, recordFeed, statusCounts } from "./episodes.ts";
import { type Feed, FeedError, fetchFeed } from "./feed.ts";
import { html, page, type Html } from "./html.ts";
import { DEFAULT_SCHEDULE, describeSchedule, isDue, isValidTimeZone, localSlot, parseSchedule, type Schedule, WEEKDAYS } from "./schedule.ts";
import { getSetting, getSetupStep, type PodcastSettings, putSetting } from "./settings.ts";
import type { AppEnv } from "./env.ts";
import { failStaleDocuments } from "./writing.ts";
import { chooseMissingMainScriptures, HOURLY_MAIN_TEXTS } from "./scriptures.ts";
import { HOURLY_SPEAKERS, identifyMissingSpeakers } from "./speakers.ts";

/** Mistral's list price for Voxtral Mini transcription when this was written; check mistral.ai/pricing. */
const TRANSCRIPTION_USD_PER_MINUTE = 0.001;
/** Used when a feed doesn't say how long an episode is. */
const ASSUMED_MINUTES = 40;
/** Rough spoken-English token rate, used to size the answers AI's work: reading the transcript to clean it, writing it back, then reading it to summarize. */
const TOKENS_PER_MINUTE = 200;

export interface Estimate {
  readonly episodes: number;
  readonly minutes: number;
  readonly guessedDurations: number;
  readonly transcriptionUsd: number;
  readonly aiTokens: number;
}

export function estimate(feed: Feed, count: number): Estimate {
  const chosen = [...feed.episodes].filter((episode) => episode.audioUrl)
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")).slice(0, count);
  const guessed = chosen.filter((episode) => !episode.durationSeconds).length;
  const minutes = Math.round(chosen.reduce((total, episode) => total + (episode.durationSeconds ? episode.durationSeconds / 60 : ASSUMED_MINUTES), 0));
  return {
    episodes: chosen.length,
    minutes,
    guessedDurations: guessed,
    transcriptionUsd: minutes * TRANSCRIPTION_USD_PER_MINUTE,
    aiTokens: minutes * TOKENS_PER_MINUTE * 3 + chosen.length * 4_000,
  };
}

function money(usd: number): string {
  return usd < 0.01 && usd > 0 ? "under $0.01" : `$${usd.toFixed(2)}`;
}

function scheduleFields(schedule: Schedule): Html {
  return html`<div class="field"><label for="f-frequency">Check for new episodes</label>
<select id="f-frequency" name="frequency">
<option value="weekly"${schedule.frequency === "weekly" ? html` selected` : ""}>Weekly</option>
<option value="daily"${schedule.frequency === "daily" ? html` selected` : ""}>Daily</option>
</select></div>
<div class="field"><label for="f-weekday">Day (weekly only)</label>
<select id="f-weekday" name="weekday">${WEEKDAYS.map((day, index) => html`<option value="${index}"${schedule.weekday === index ? html` selected` : ""}>${day}</option>`)}</select></div>
<div class="field"><label for="f-hour">Hour</label>
<select id="f-hour" name="hour">${Array.from({ length: 24 }, (_unused, hour) => html`<option value="${hour}"${schedule.hour === hour ? html` selected` : ""}>${String(hour).padStart(2, "0")}:00</option>`)}</select></div>
<div class="field"><label for="f-timeZone">Time zone</label>
<p class="hint">For example America/Chicago or Europe/London.</p>
<input id="f-timeZone" name="timeZone" value="${schedule.timeZone}" required></div>`;
}

function importView(context: Context, feed: Feed, schedule: Schedule, error?: string): Html {
  const total = feed.episodes.filter((episode) => episode.audioUrl).length;
  const options = [0, 10, 50].filter((count) => count < total).concat(total);
  return html`<p class="steps">Setup · step 8 of 8</p>
<h1>Import episodes</h1>
<p class="lead">${feed.title} has ${total} episodes with audio. Choose how many recent ones to process now. New episodes are picked up on your schedule, and you can import older ones later.</p>
${error ? html`<p class="alert">${error}</p>` : ""}
<form method="post" action="/setup/import">
<fieldset class="choices"><legend>How many past episodes?</legend>
${options.map((count) => {
    const cost = estimate(feed, count);
    return html`<label class="choice"><input type="radio" name="count" value="${count}"${count === Math.min(10, total) ? html` checked` : ""}>
<span><strong>${count === 0 ? "None, only new ones" : count === total ? `All ${count}` : `Newest ${count}`}</strong>${count > 0 ? html`<br><span class="hint">About ${cost.minutes.toLocaleString("en-US")} minutes of audio · transcription ${money(cost.transcriptionUsd)} · about ${cost.aiTokens.toLocaleString("en-US")} tokens on your answers AI, about a third of them written out${cost.guessedDurations ? ` · ${cost.guessedDurations} lengths guessed` : ""}</span>` : ""}</span></label>`;
  })}
</fieldset>
<p class="hint">Transcription uses Mistral's list price of $${TRANSCRIPTION_USD_PER_MINUTE} per minute when this was written; embeddings add a few cents at most. Check your providers' current prices.</p>
<h2>Schedule</h2>
${scheduleFields(schedule)}
<button type="submit">Start import</button>
</form>`;
}

/** GET/POST /setup/import: the last wizard step. */
export async function importStep(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const current = await getSetupStep(context.db);
  if (current !== "import") return redirect(current === "complete" ? "/admin/episodes" : `/setup/${current}`);
  const podcast = await getSetting<PodcastSettings>(context.db, "podcast");
  if (!podcast) return redirect("/setup/podcast");
  let feed: Feed;
  try {
    feed = await fetchFeed(podcast.feedUrl);
  } catch (error) {
    const message = error instanceof FeedError ? error.message : "The feed couldn't be read.";
    return page("Import", html`<h1>Import episodes</h1><p class="alert">${message}</p><p><a href="/setup/import">Try again</a></p>`, { status: 502, ...chrome(context) });
  }
  const guessedZone = (context.request as Request & { cf?: { timezone?: string } }).cf?.timezone;
  const defaults: Schedule = { ...DEFAULT_SCHEDULE, timeZone: guessedZone && isValidTimeZone(guessedZone) ? guessedZone : DEFAULT_SCHEDULE.timeZone };
  if (context.request.method === "GET") return page("Import", importView(context, feed, defaults), chrome(context));

  const form = await context.request.formData();
  const parsed = parseSchedule(form);
  const count = Number(form.get("count"));
  if ("error" in parsed) return page("Import", importView(context, feed, defaults, parsed.error), { status: 400, ...chrome(context) });
  if (!Number.isInteger(count) || count < 0) return page("Import", importView(context, feed, parsed.schedule, "Choose how many episodes to import."), { status: 400, ...chrome(context) });
  await putSetting(context.db, "schedule", parsed.schedule);
  await rememberOrigin(context);
  await recordFeed(context.db, feed, { backfill: count });
  await putSetting(context.db, "setup_step", "complete");
  await dispatchQueued(context.env);
  return redirect("/admin/episodes");
}

const STATUS_LABELS: Record<EpisodeRow["status"], string> = {
  not_imported: "Not imported",
  queued: "Waiting",
  running: "Working",
  done: "Done",
  failed: "Failed",
};

/** Seconds between automatic reloads of the dashboard while anything is waiting or working. */
const LIVE_REFRESH_SECONDS = 10;

/** "just now", "4 min ago", "3 h ago". */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3_600)} h ago`;
  return `${Math.round(seconds / 86_400)} days ago`;
}

/**
 * The Workflow needs the site's public address to give Mistral a link to the
 * stored audio, and Workers don't know their own hostname, so admin pages save it.
 */
export async function rememberOrigin(context: Context): Promise<void> {
  if ((await getSetting<string>(context.db, "site_origin")) !== context.url.origin) await putSetting(context.db, "site_origin", context.url.origin);
}

function episodeStatus(episode: EpisodeRow): Html {
  const label = STATUS_LABELS[episode.status];
  if (episode.status === "running") {
    return html`<strong>${label}</strong> · attempt ${episode.attempts}<br><span class="hint">${episode.detail ?? "Starting"} · updated ${ago(episode.updated_at)}</span>
${episode.last_error ? html`<br><span class="error">Last error: ${episode.last_error}</span>` : ""}`;
  }
  if (episode.status === "failed") return html`<strong>${label}</strong> · ${ago(episode.updated_at)}<br><span class="error">${episode.error ?? "Unknown error."}</span>`;
  if (episode.status === "done") return html`${label}${episode.audio_bytes ? html`<br><span class="hint">${formatBytes(episode.audio_bytes)} of audio</span>` : ""}`;
  return html`${label}`;
}

/** GET /admin/episodes */
export async function episodesDashboard(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const current = await getSetupStep(context.db);
  if (current !== "complete") return redirect(`/setup/${current}`);
  await rememberOrigin(context);
  const [counts, episodes, schedule, lastCheck, lastTick, atOnce, speakers, mainTexts] = await Promise.all([
    statusCounts(context.db),
    listEpisodes(context.db),
    getSetting<Schedule>(context.db, "schedule"),
    getSetting<{ at: string; queued: number; error?: string }>(context.db, "last_check"),
    getSetting<string>(context.db, "last_tick"),
    concurrency(context.db),
    context.db.prepare("SELECT count(speaker) AS named, sum(speaker_source IS NULL) AS waiting FROM episodes WHERE status = 'done'").first<{ named: number; waiting: number | null }>(),
    context.db.prepare("SELECT count(nullif(s.main_scripture, '')) AS chosen, sum(s.main_scripture IS NULL) AS waiting FROM summaries s JOIN episodes e ON e.id = s.episode_id WHERE e.status = 'done'")
      .first<{ chosen: number; waiting: number | null }>(),
  ]);
  const waitingMainTexts = mainTexts?.waiting ?? 0;
  const waitingSpeakers = speakers?.waiting ?? 0;
  const notice = context.url.searchParams.get("notice");
  const live = counts.running + counts.queued > 0;
  return page("Episodes", html`<h1>Episodes</h1>
${notice ? html`<p class="alert-ok">${notice}</p>` : ""}
<p class="${live ? "live" : "hint"}">${live
    ? `Processing: ${counts.running} working, ${counts.queued} waiting. This page updates every ${LIVE_REFRESH_SECONDS} seconds.`
    : "Nothing is processing right now."}</p>
<dl>
<dt>Done</dt><dd>${counts.done}</dd>
<dt>Working</dt><dd>${counts.running}</dd>
<dt>Waiting</dt><dd>${counts.queued}</dd>
<dt>Failed</dt><dd>${counts.failed}</dd>
<dt>Not imported</dt><dd>${counts.not_imported}</dd>
<dt>Schedule</dt><dd>${schedule ? describeSchedule(schedule) : "Not set"} · <a href="/admin/schedule">Change</a></dd>
<dt>Last feed check</dt><dd>${lastCheck ? `${ago(lastCheck.at)} · ${lastCheck.error ?? `${lastCheck.queued} new`}` : "Not yet"}</dd>
<dt>Speakers</dt><dd>${speakers?.named ?? 0} named${waitingSpeakers ? html` · ${waitingSpeakers} waiting for the AI, which checks hourly <form class="inline" method="post" action="/admin/episodes/speakers" data-busy="Identifying speakers… this can take a minute."><button class="link" type="submit">Identify now</button></form>` : ""} · fix one on its sermon page</dd>
<dt>Main texts</dt><dd>${mainTexts?.chosen ?? 0} chosen${waitingMainTexts ? html` · ${waitingMainTexts} waiting for the AI, which checks hourly <form class="inline" method="post" action="/admin/episodes/scriptures" data-busy="Choosing main texts… this can take a minute."><button class="link" type="submit">Choose now</button></form>` : ""}</dd>
<dt>Background worker</dt><dd>${lastTick ? `last ran ${ago(lastTick)}` : "hasn't run yet"} · runs hourly and restarts stalled work</dd>
</dl>
<form class="row" method="post" action="/admin/episodes/concurrency">
<label for="f-concurrency" class="inline-label">Episodes at once</label>
<select id="f-concurrency" name="concurrency">${Array.from({ length: MAX_CONCURRENCY }, (_unused, index) => index + 1).map((value) => html`<option value="${value}"${value === atOnce ? html` selected` : ""}>${value}</option>`)}</select>
<button class="quiet" type="submit">Save</button>
<span class="hint">Use 1 if your transcription or AI plan has low rate limits.</span>
</form>
<div class="row">
<form class="inline" method="post" action="/admin/episodes/check"><button class="quiet" type="submit">Check for new episodes now</button></form>
${counts.failed > 0 ? html`<form class="inline" method="post" action="/admin/episodes/queue"><input type="hidden" name="failed" value="1"><button class="quiet" type="submit">Retry all ${counts.failed} failed</button></form>` : ""}
${counts.not_imported > 0 ? html`<form class="inline" method="post" action="/admin/episodes/queue"><input type="hidden" name="all" value="1"><button class="quiet" type="submit">Import all ${counts.not_imported} older episodes</button></form>` : ""}
</div>
<table class="episodes">
<thead><tr><th>Episode</th><th>Status</th><th></th></tr></thead>
<tbody>
${episodes.map((episode) => html`<tr>
<td>${episode.status === "done" ? html`<a href="/episodes/${episode.id}">${episode.title}</a>` : episode.title}<br><span class="hint">${episode.published_at?.slice(0, 10) ?? ""}${episode.speaker ? ` · ${episode.speaker}` : ""}</span></td>
<td>${episodeStatus(episode)}</td>
<td>${episode.status === "failed" || episode.status === "not_imported"
    ? html`<form method="post" action="/admin/episodes/queue"><input type="hidden" name="id" value="${episode.id}"><button class="quiet" type="submit">${episode.status === "failed" ? "Retry" : "Import"}</button></form>`
    : ""}</td>
</tr>`)}
</tbody>
</table>`, { ...chrome(context), ...(live ? { refreshSeconds: LIVE_REFRESH_SECONDS } : {}) });
}

/** POST /admin/episodes/concurrency */
export async function saveConcurrency(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const value = Number((await context.request.formData()).get("concurrency"));
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) return redirect(`/admin/episodes?notice=${encodeURIComponent(`Choose between 1 and ${MAX_CONCURRENCY}.`)}`);
  await putSetting(context.db, "processing", { concurrency: value } satisfies ProcessingSettings);
  await dispatchQueued(context.env);
  return redirect(`/admin/episodes?notice=${encodeURIComponent(`Now processing up to ${value} episode${value === 1 ? "" : "s"} at once. Episodes already working finish first.`)}`);
}

/** Fetches the feed, queues anything new and starts work. Shared by the button and the hourly tick. */
export async function checkFeed(env: AppEnv): Promise<{ queued: number; error?: string }> {
  const podcast = await getSetting<PodcastSettings>(env.DB, "podcast");
  if (!podcast) return { queued: 0, error: "No podcast feed is set." };
  let result: { queued: number; error?: string };
  try {
    result = { queued: await recordFeed(env.DB, await fetchFeed(podcast.feedUrl)) };
  } catch (error) {
    result = { queued: 0, error: error instanceof FeedError ? error.message : "The feed couldn't be read." };
  }
  await putSetting(env.DB, "last_check", { at: new Date().toISOString(), ...result });
  await dispatchQueued(env);
  return result;
}

/** POST /admin/episodes/check */
export async function checkNow(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  await rememberOrigin(context);
  const result = await checkFeed(context.env);
  const notice = result.error ?? (result.queued === 0 ? "No new episodes." : `Found ${result.queued} new episode${result.queued === 1 ? "" : "s"}.`);
  return redirect(`/admin/episodes?notice=${encodeURIComponent(notice)}`);
}

/** POST /admin/episodes/speakers : identifies speakers now rather than waiting for the hourly tick. */
export async function identifySpeakersNow(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  let notice: string;
  try {
    const checked = await identifyMissingSpeakers(context.env, HOURLY_SPEAKERS);
    notice = `Checked ${checked} sermon${checked === 1 ? "" : "s"} for their speaker.`;
  } catch (error) {
    console.error("speaker identification failed", error);
    notice = `Speakers couldn't be identified right now: ${error instanceof Error ? error.message : "unknown error"}`;
  }
  return redirect(`/admin/episodes?notice=${encodeURIComponent(notice)}`);
}

/** POST /admin/episodes/scriptures : chooses main passages now rather than waiting for the hourly tick. */
export async function chooseMainScripturesNow(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  let notice: string;
  try {
    const checked = await chooseMissingMainScriptures(context.env, HOURLY_MAIN_TEXTS);
    notice = `Checked ${checked} sermon${checked === 1 ? "" : "s"} for their main text.`;
  } catch (error) {
    console.error("main text selection failed", error);
    notice = `Main texts couldn't be chosen right now: ${error instanceof Error ? error.message : "unknown error"}`;
  }
  return redirect(`/admin/episodes?notice=${encodeURIComponent(notice)}`);
}

/** POST /admin/episodes/queue */
export async function queueFromDashboard(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  await rememberOrigin(context);
  const form = await context.request.formData();
  if (form.get("all") === "1") await queueAllNotImported(context.db);
  else if (form.get("failed") === "1") await queueAllFailed(context.db);
  else await queueEpisodes(context.db, [String(form.get("id") ?? "")]);
  await dispatchQueued(context.env);
  return redirect("/admin/episodes");
}

/** GET/POST /admin/schedule */
export async function scheduleSettings(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const current = await getSetupStep(context.db);
  if (current !== "complete") return redirect(`/setup/${current}`);
  const schedule = (await getSetting<Schedule>(context.db, "schedule")) ?? DEFAULT_SCHEDULE;
  let error: string | undefined;
  if (context.request.method === "POST") {
    const parsed = parseSchedule(await context.request.formData());
    if ("schedule" in parsed) {
      await putSetting(context.db, "schedule", parsed.schedule);
      return redirect(`/admin/episodes?notice=${encodeURIComponent(`Schedule saved: ${describeSchedule(parsed.schedule)}.`)}`);
    }
    error = parsed.error;
  }
  return page("Schedule", html`<h1>Schedule</h1>
<p class="lead">When the site checks your feed for new episodes.</p>
${error ? html`<p class="alert">${error}</p>` : ""}
<form method="post" action="/admin/schedule">${scheduleFields(schedule)}<button type="submit">Save</button></form>`, { status: error ? 400 : 200, ...chrome(context) });
}

/** The hourly cron: check the feed when the schedule says so, and always keep the queue moving. */
export async function hourlyTick(env: AppEnv, at: Date): Promise<void> {
  if ((await getSetupStep(env.DB)) !== "complete") return;
  await putSetting(env.DB, "last_tick", at.toISOString());
  await failStaleDocuments(env.DB, at.getTime());
  await identifyMissingSpeakers(env, HOURLY_SPEAKERS).catch((error: unknown) => console.error("speaker identification failed", error));
  await chooseMissingMainScriptures(env, HOURLY_MAIN_TEXTS).catch((error: unknown) => console.error("main text selection failed", error));
  const schedule = await getSetting<Schedule>(env.DB, "schedule");
  const lastSlot = await getSetting<string>(env.DB, "last_scheduled_slot");
  if (schedule && isDue(schedule, at, lastSlot)) {
    await putSetting(env.DB, "last_scheduled_slot", localSlot(at, schedule.timeZone).slot);
    await checkFeed(env);
    return;
  }
  await dispatchQueued(env);
}

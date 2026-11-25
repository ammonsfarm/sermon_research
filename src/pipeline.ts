import { NonRetryableError } from "cloudflare:workflows";
import { downloadAudio, formatBytes, signedAudioUrl } from "./audio.ts";
import { batchEnd, cleanSegments } from "./cleanup.ts";
import { REDO_STEPS, type RedoStep } from "./episodes.ts";
import { decodeMp3 } from "./mp3.ts";
import { MUSE_LIMITS, MUSE_PART_SETTING, MUSE_SAMPLE_RATE, MUSE_TOO_LONG, type PartLimits, partSegments, quietestSplit, SERVER_LIMITS, SERVER_PART_SETTING, SERVER_TOO_LONG, turnsToSegments, WAV_HEADER_BYTES, writeWavHeader } from "./muse.ts";
import type { AppEnv } from "./env.ts";
import { getKey } from "./keys.ts";
import { EMBEDDING_MODEL, MISTRAL_TRANSCRIPTION_MODEL, MUSE_TRANSCRIPTION_MODEL, MuseTranscribeError, museTranscribe, ProviderError, segmentsFrom, ServerTranscribeError, serverTranscribe, type TranscriptionServer, withUserAgent } from "./providers.ts";
import { formatTime } from "./research.ts";
import { chatWithFallback, type LlmTarget, resolveTargets } from "./llm.ts";
import { getSetting, type Ministry, putSetting, type TranscriptionSettings } from "./settings.ts";
import { normalizeReference } from "./scriptures.ts";
import { identifySpeakers } from "./speakers.ts";

export interface Segment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface Chunk {
  readonly seq: number;
  readonly kind: "summary" | "transcript";
  readonly text: string;
  readonly start: number | null;
  readonly end: number | null;
}

export interface SermonSummary {
  readonly summary: string;
  /** The passage the sermon preaches from, or null for a topical sermon. */
  readonly mainScripture: string | null;
  readonly topics: readonly string[];
  readonly scriptures: readonly string[];
}

/** The subset of Cloudflare's WorkflowStep the pipeline uses, so tests can run it directly. */
export interface PipelineStep {
  do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>;
}

export interface StepConfig {
  readonly retries: { readonly limit: number; readonly delay: `${number} ${"second" | "seconds" | "minute" | "minutes"}`; readonly backoff: "exponential" };
  readonly timeout: `${number} ${"minute" | "minutes"}`;
}

const DOWNLOAD: StepConfig = { retries: { limit: 3, delay: "1 minute", backoff: "exponential" }, timeout: "15 minutes" };
const TRANSCRIBE: StepConfig = { retries: { limit: 3, delay: "1 minute", backoff: "exponential" }, timeout: "15 minutes" };
/**
 * One part for Muse or the admin's server: decode a few minutes of the MP3 and transcribe it. Extra retries ride out
 * rate limits. 15 minutes leaves room for a non-MP3 that goes to the server whole, which waits up to 14.
 */
const PART: StepConfig = { retries: { limit: 5, delay: "1 minute", backoff: "exponential" }, timeout: "15 minutes" };
/** About 4 hours of audio in the shortest parts, so a runaway loop stops well inside a workflow's step limit. */
const MAX_PART_SECONDS = 4 * 60 * 60;
/** Several calls in one step; each batch is saved as it's done, so a retry or a timeout loses at most one. */
const CLEAN: StepConfig = { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" }, timeout: "20 minutes" };
const SUMMARIZE: StepConfig = { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "5 minutes" };
const INDEX: StepConfig = { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" };
const FINISH: StepConfig = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" };

/** Transcript characters sent for summarizing; roughly 30k tokens. */
const SUMMARY_INPUT_CHARS = 120_000;
const SUMMARY_MAX_TOKENS = 8_000;
const CHUNK_CHARS = 1_200;
const EMBED_BATCH = 64;

/** Runs one episode end to end. Every step writes its own results, so a retry resumes where it stopped. */
export async function runEpisode(env: AppEnv, step: PipelineStep, episodeId: string, parts?: PartLimits): Promise<void> {
  const db = env.DB;
  const secret = env.APP_SECRET ?? "";
  try {
    await step.do("download audio", DOWNLOAD, tracked(db, episodeId, "transcribe", "Downloading the audio", async () => {
      if (!(await redoing(db, episodeId, "transcribe")) && await hasTranscript(db, episodeId)) return;
      const episode = await db.prepare("SELECT audio_url, audio_key FROM episodes WHERE id = ?").bind(episodeId).first<{ audio_url: string | null; audio_key: string | null }>();
      if (episode?.audio_key && await env.AUDIO.head(episode.audio_key)) return;
      // An uploaded sermon has only its R2 copy, so there's nowhere to fetch it from again.
      if (episode && !episode.audio_url && episode.audio_key) throw new NonRetryableError("This sermon's uploaded audio is missing from storage. Upload it again from Admin → Upload a sermon.");
      if (!episode?.audio_url) throw new ProviderError("This episode has no audio file in the feed.");
      const stored = await downloadAudio(env, episodeId, episode.audio_url);
      await db.prepare("UPDATE episodes SET audio_key = ?, audio_bytes = ?, updated_at = ? WHERE id = ?").bind(stored.key, stored.bytes, new Date().toISOString(), episodeId).run();
    }));

    const service = await step.do("choose transcription service", FINISH, async () => (await getSetting<TranscriptionSettings>(db, "transcription"))?.provider ?? "mistral");

    if (service === "muse" || service === "server") {
      // Muse takes 10 minutes at a time, and a server behind Cloudflare must answer within 100 seconds,
      // so each part is its own step, and each saves its progress.
      const limits = parts ?? (service === "muse" ? MUSE_LIMITS : SERVER_LIMITS);
      const name = service === "muse" ? "Muse" : "your server";
      for (let part = 1; !(await step.do(`transcribe with ${name}, part ${part}`, PART, tracked(db, episodeId, "transcribe", `Transcribing with ${name}`, () => transcribePart(env, episodeId, service, limits)))); part++) {
        if (part >= Math.ceil(MAX_PART_SECONDS / limits.minPartSeconds)) throw new ProviderError(`This recording is too long to transcribe with ${name}.`);
      }
    } else await step.do("transcribe", TRANSCRIBE, tracked(db, episodeId, "transcribe", "Transcribing with Mistral (often 2 to 10 minutes)", async () => {
      if (!(await redoing(db, episodeId, "transcribe")) && await hasTranscript(db, episodeId)) return;
      const [episode, origin] = await Promise.all([
        db.prepare("SELECT audio_bytes FROM episodes WHERE id = ?").bind(episodeId).first<{ audio_bytes: number | null }>(),
        getSetting<string>(db, "site_origin"),
      ]);
      if (!origin) throw new ProviderError("The site doesn't know its own address yet. Open Admin → Episodes once, then retry.");
      if (episode?.audio_bytes) await setDetail(db, episodeId, `Transcribing ${formatBytes(episode.audio_bytes)} of audio with Mistral (often 2 to 10 minutes)`);
      const apiKey = await requireKey(env, "transcription");
      // Mistral fetches our own copy through a short-lived signed link.
      const segments = await transcribe(await signedAudioUrl(secret, origin, episodeId), apiKey);
      await db.batch([
        db.prepare("INSERT OR REPLACE INTO transcripts_draft (episode_id, text, segments_json, model, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(episodeId, joined(segments), JSON.stringify(segments), MISTRAL_TRANSCRIPTION_MODEL, new Date().toISOString()),
        redone(db, episodeId, "transcribe"),
      ]);
    }));

    await step.do("clean transcript", CLEAN, tracked(db, episodeId, "transcribe", "Cleaning up the transcript", async () => {
      if (!(await redoing(db, episodeId, "rewrite")) && await db.prepare("SELECT 1 FROM transcripts WHERE episode_id = ?").bind(episodeId).first()) return;
      const [ministry, draft] = await Promise.all([
        getSetting<Ministry>(db, "ministry"),
        db.prepare("SELECT e.title, d.segments_json, d.cleaned_json, d.model FROM transcripts_draft d JOIN episodes e ON e.id = d.episode_id WHERE d.episode_id = ?")
          .bind(episodeId).first<{ title: string; segments_json: string; cleaned_json: string | null; model: string }>(),
      ]);
      if (!draft) throw new ProviderError("The draft transcript is missing.");
      const segments = JSON.parse(draft.segments_json) as Segment[];
      const cleaned = draft.cleaned_json ? JSON.parse(draft.cleaned_json) as string[] : [];
      // A fallback model may do some batches, so every model used is named.
      const models = new Set<string>();
      while (cleaned.length < segments.length) {
        await setDetail(db, episodeId, `Cleaning up the transcript with the answers AI (${Math.floor(cleaned.length / segments.length * 100)}% done)`);
        const first = cleaned.length;
        const batch = await cleanSegments(env, ministry, draft.title, segments.slice(first, batchEnd(segments, first)), first);
        cleaned.push(...batch.texts);
        models.add(batch.model);
        await db.prepare("UPDATE transcripts_draft SET cleaned_json = ? WHERE episode_id = ?").bind(JSON.stringify(cleaned), episodeId).run();
      }
      const clean = segments.map((segment, index) => ({ ...segment, text: cleaned[index] ?? segment.text }));
      const cleanedBy = models.size ? [...models].join(", ") : (await resolveTargets(env, { action: "summary" }))[0]!.model;
      await db.batch([
        db.prepare("INSERT OR REPLACE INTO transcripts (episode_id, text, segments_json, model, created_at, cleaned_by) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(episodeId, joined(clean), JSON.stringify(clean), draft.model, new Date().toISOString(), cleanedBy),
        redone(db, episodeId, "rewrite"),
      ]);
    }));

    await step.do("summarize", SUMMARIZE, tracked(db, episodeId, "summarize", "Writing the summary", async () => {
      if (!(await redoing(db, episodeId, "summary")) && await db.prepare("SELECT 1 FROM summaries WHERE episode_id = ?").bind(episodeId).first()) return;
      const [targets, ministry, row] = await Promise.all([
        resolveTargets(env, { action: "summary" }),
        getSetting<Ministry>(db, "ministry"),
        db.prepare("SELECT e.title, e.published_at, e.main_scripture, t.text FROM episodes e JOIN transcripts t ON t.episode_id = e.id WHERE e.id = ?")
          .bind(episodeId).first<{ title: string; published_at: string | null; main_scripture: string | null; text: string }>(),
      ]);
      if (!row) throw new ProviderError("The transcript is missing.");
      const result = await summarize({ targets, ministry, title: row.title, publishedAt: row.published_at, transcript: row.text });
      // The passage an admin gave with an upload stands; the AI's is used otherwise.
      const mainScripture = row.main_scripture ?? result.mainScripture;
      // A null main passage is left for the hourly catch-up to look at again, which records an empty one if there truly isn't one.
      await db.batch([
        db.prepare("INSERT OR REPLACE INTO summaries (episode_id, summary, topics_json, scriptures_json, model, created_at, main_scripture) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(episodeId, result.summary, JSON.stringify(result.topics), JSON.stringify(result.scriptures), result.model, new Date().toISOString(), mainScripture),
        redone(db, episodeId, "summary"),
      ]);
    }));

    await step.do("identify speaker", SUMMARIZE, tracked(db, episodeId, "summarize", "Identifying the speaker", async () => {
      try {
        await identifySpeakers(env, [episodeId]);
      } catch (error) {
        // A missing speaker shouldn't hold up the sermon; the hourly tick tries again.
        console.error("speaker identification failed", episodeId, error);
      }
    }));

    await step.do("index", INDEX, tracked(db, episodeId, "index", "Indexing for search", async () => {
      const [transcript, summary] = await Promise.all([
        db.prepare("SELECT segments_json FROM transcripts WHERE episode_id = ?").bind(episodeId).first<{ segments_json: string }>(),
        db.prepare("SELECT summary, main_scripture, topics_json, scriptures_json FROM summaries WHERE episode_id = ?").bind(episodeId).first<{ summary: string; main_scripture: string | null; topics_json: string; scriptures_json: string }>(),
      ]);
      if (!transcript || !summary) throw new ProviderError("The transcript or summary is missing.");
      const chunks = buildChunks(
        JSON.parse(transcript.segments_json) as Segment[],
        { summary: summary.summary, mainScripture: summary.main_scripture || null, topics: JSON.parse(summary.topics_json), scriptures: JSON.parse(summary.scriptures_json) },
      );
      const vectors = await embed(chunks.map((chunk) => chunk.text), await requireKey(env, "embeddings"));
      // Replace this episode's chunks wholesale so a re-run never leaves stale ones behind.
      const previous = await db.prepare("SELECT id FROM chunks WHERE episode_id = ?").bind(episodeId).all<{ id: string }>();
      const ids = chunks.map((chunk) => `${episodeId}:${chunk.seq}`);
      const stale = previous.results.map((row) => row.id).filter((id) => !ids.includes(id));
      if (stale.length > 0) await env.VECTORS.deleteByIds(stale);
      for (let start = 0; start < chunks.length; start += 500) {
        await env.VECTORS.upsert(chunks.slice(start, start + 500).map((chunk, offset) => ({
          id: ids[start + offset]!,
          values: vectors[start + offset]!,
          metadata: { episodeId, kind: chunk.kind, seq: chunk.seq, ...(chunk.start === null ? {} : { start: chunk.start }) },
        })));
      }
      await db.batch([
        db.prepare("DELETE FROM chunks WHERE episode_id = ?").bind(episodeId),
        ...chunks.map((chunk, index) => db.prepare("INSERT INTO chunks (id, episode_id, kind, seq, text, start_seconds, end_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(ids[index]!, episodeId, chunk.kind, chunk.seq, chunk.text, chunk.start, chunk.end)),
        redone(db, episodeId, "index"),
      ]);
    }));

    await step.do("finish", FINISH, async () => {
      const now = new Date().toISOString();
      await db.prepare("UPDATE episodes SET status = 'done', stage = NULL, detail = NULL, last_error = NULL, error = NULL, redo = NULL, completed_at = ?, updated_at = ? WHERE id = ?").bind(now, now, episodeId).run();
    });
  } catch (error) {
    await step.do("record failure", FINISH, async () => {
      // A finished episode being re-processed stays up, with its error showing in Admin → Episodes.
      await db.prepare("UPDATE episodes SET status = CASE WHEN status = 'done' THEN 'done' ELSE 'failed' END, stage = CASE WHEN status = 'done' THEN NULL ELSE stage END, detail = NULL, last_error = NULL, error = ?, updated_at = ? WHERE id = ?")
        .bind(describeError(error), new Date().toISOString(), episodeId).run();
    });
  }
}

/** Muse, or the admin's own server: either takes the recording a few minutes at a time, as 16 kHz mono WAV. */
interface PartTranscriber {
  readonly name: string;
  /** The model named on the draft. */
  readonly model: string;
  /** The site-wide setting holding the part length it settled on. */
  readonly setting: string;
  transcribe(wav: Uint8Array, offsetSeconds: number, partSeconds: number): Promise<Segment[]>;
  /** Whether a failure means the part took too long, so shorter ones may go through. */
  tooLong(error: unknown): boolean;
}

async function partTranscriber(env: AppEnv, service: "muse" | "server"): Promise<PartTranscriber> {
  if (service === "muse") {
    const apiKey = await requireKey(env, "transcription");
    return {
      name: "Muse", model: MUSE_TRANSCRIPTION_MODEL, setting: MUSE_PART_SETTING,
      transcribe: async (wav, offset, seconds) => turnsToSegments(await museTranscribe(wav, apiKey), offset, seconds),
      tooLong: (error) => error instanceof MuseTranscribeError && MUSE_TOO_LONG.has(error.status),
    };
  }
  const server = await transcriptionServer(env);
  return {
    name: "your server", model: server.model, setting: SERVER_PART_SETTING,
    // Each part has 5 minutes, half the step's time, so a retry of a stuck server comes round sooner.
    transcribe: async (wav, offset, seconds) => partSegments(
      await serverTranscribe(server, { body: wav, bytes: wav.byteLength, filename: "part.wav", contentType: "audio/wav" }, undefined, 5 * 60_000), offset, seconds),
    tooLong: (error) => error instanceof ServerTranscribeError && SERVER_TOO_LONG.has(error.status),
  };
}

/** The admin's server as saved now, or a failure if the service was changed while this episode waited. */
async function transcriptionServer(env: AppEnv): Promise<TranscriptionServer> {
  const settings = await getSetting<TranscriptionSettings>(env.DB, "transcription");
  if (settings?.provider !== "server" || !settings.baseUrl) throw new NonRetryableError("The transcription service changed while this episode was waiting. Retry it to use the current one.");
  return { baseUrl: settings.baseUrl, model: settings.model, apiKey: await getKey(env.DB, env.APP_SECRET ?? "", "transcription:server") };
}

/**
 * Transcribes an episode's next part with Muse or the admin's server and saves
 * it. Returns true once the whole recording is done and the draft transcript
 * is written. Audio that isn't a readable MP3 goes to the server whole, since
 * it reads any format; Muse can't take it.
 */
async function transcribePart(env: AppEnv, episodeId: string, service: "muse" | "server", limits: PartLimits): Promise<boolean> {
  const db = env.DB;
  if (!(await redoing(db, episodeId, "transcribe")) && await hasTranscript(db, episodeId)) return true;
  const [episode, progress] = await Promise.all([
    db.prepare("SELECT audio_key, duration_seconds FROM episodes WHERE id = ?").bind(episodeId).first<{ audio_key: string | null; duration_seconds: number | null }>(),
    db.prepare("SELECT done_samples, segments_json FROM transcription_progress WHERE episode_id = ?").bind(episodeId).first<{ done_samples: number; segments_json: string }>(),
  ]);
  const transcriber = await partTranscriber(env, service);
  // Retrying the step can't fix these, so the episode fails straight away and frees its place in the queue.
  if (!episode?.audio_key) throw new NonRetryableError("The audio hasn't been copied yet. Retry to download it.");
  const switchToMistral = "Switch to Mistral in Admin → Transcription, then retry.";
  if (!episode.audio_key.endsWith(".mp3")) {
    if (service === "server") return transcribeWhole(env, episodeId, episode.audio_key);
    throw new NonRetryableError(`This site can only convert MP3s to the WAV that Muse accepts, and this episode's audio is .${episode.audio_key.split(".").pop()}. ${switchToMistral}`);
  }
  const object = await env.AUDIO.get(episode.audio_key);
  if (!object) throw new NonRetryableError("The copy of the audio is missing. Retry to download it again.");

  const from = progress?.done_samples ?? 0;
  const offset = from / MUSE_SAMPLE_RATE;
  const partSeconds = Math.min(limits.partSeconds, (await getSetting<number>(db, transcriber.setting)) ?? limits.partSeconds);
  await setDetail(db, episodeId, `Transcribing with ${transcriber.name}: ${formatTime(offset)}${episode.duration_seconds ? ` of ${formatTime(episode.duration_seconds)}` : ""} done`);
  // The part is decoded straight into a WAV file's body, so it's never copied.
  const max = Math.round(partSeconds * MUSE_SAMPLE_RATE);
  const wav = new Uint8Array(WAV_HEADER_BYTES + max * 2);
  const pcm = new Int16Array(wav.buffer, WAV_HEADER_BYTES, max);
  const { samples, more } = await decodeMp3(object.body, MUSE_SAMPLE_RATE, from, pcm);
  if (from === 0 && samples === 0) {
    if (service === "server") return transcribeWhole(env, episodeId, episode.audio_key);
    throw new NonRetryableError(`The audio couldn't be read as MP3. ${switchToMistral}`);
  }
  const end = more ? quietestSplit(pcm, samples, MUSE_SAMPLE_RATE, Math.min(limits.searchSeconds, partSeconds / 3)) : samples;

  const segments = progress ? JSON.parse(progress.segments_json) as Segment[] : [];
  if (end > 0) {
    writeWavHeader(wav, end);
    try {
      segments.push(...await transcriber.transcribe(wav.subarray(0, WAV_HEADER_BYTES + end * 2), offset, end / MUSE_SAMPLE_RATE));
    } catch (error) {
      if (!transcriber.tooLong(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (partSeconds <= limits.minPartSeconds) {
        if (service === "muse") throw error;
        throw new ProviderError(`${message} Even ${partSeconds}-second parts took too long, so your server may be stuck or much slower than usual. Check it, or reach it without a Cloudflare proxy, such as through Tailscale Funnel or a port forward with HTTPS.`);
      }
      // The service gave up on a part this long, so the retry, and every part after it on any episode, is shorter.
      // Halving the length that failed, rather than whatever is saved, means two episodes timing out together halve it once.
      const shorter = Math.max(limits.minPartSeconds, Math.floor(partSeconds / 2));
      await putSetting(db, transcriber.setting, Math.min(shorter, (await getSetting<number>(db, transcriber.setting)) ?? shorter));
      throw new ProviderError(`${message} The next try sends ${shorter}-second parts.`);
    }
  }
  const now = new Date().toISOString();
  if (more) {
    await db.prepare(
      `INSERT INTO transcription_progress (episode_id, done_samples, segments_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(episode_id) DO UPDATE SET done_samples = excluded.done_samples, segments_json = excluded.segments_json, updated_at = excluded.updated_at`,
    ).bind(episodeId, from + end, JSON.stringify(segments), now).run();
    return false;
  }
  if (segments.length === 0) {
    throw new ProviderError(service === "muse" ? "Muse heard no speech in this recording. Check that the audio plays."
      : "Your transcription server returned an empty transcript. Check that the audio plays and that the server's model is a speech-to-text one.");
  }
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO transcripts_draft (episode_id, text, segments_json, model, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(episodeId, joined(segments), JSON.stringify(segments), transcriber.model, now),
    db.prepare("DELETE FROM transcription_progress WHERE episode_id = ?").bind(episodeId),
    redone(db, episodeId, "transcribe"),
  ]);
  return true;
}

/** Whether an admin asked to redo this step, or one before it, for a finished episode. */
async function redoing(db: D1Database, episodeId: string, step: RedoStep): Promise<boolean> {
  const row = await db.prepare("SELECT redo FROM episodes WHERE id = ?").bind(episodeId).first<{ redo: RedoStep | null }>();
  return row?.redo != null && REDO_STEPS.indexOf(row.redo) <= REDO_STEPS.indexOf(step);
}

/** Moves an admin's redo on past a step once it's redone, so a retry carries on from the next one. */
function redone(db: D1Database, episodeId: string, step: RedoStep): D1PreparedStatement {
  return db.prepare("UPDATE episodes SET redo = ? WHERE id = ? AND redo = ?").bind(REDO_STEPS[REDO_STEPS.indexOf(step) + 1] ?? null, episodeId, step);
}

/**
 * Sends the episode's R2 copy of its audio to the admin's transcription server
 * in one request, for audio this site can't split (anything but a readable
 * MP3), and saves the draft, named after the server's model. Always true: the
 * whole recording is done.
 */
async function transcribeWhole(env: AppEnv, episodeId: string, audioKey: string): Promise<true> {
  const db = env.DB;
  const server = await transcriptionServer(env);
  const object = await env.AUDIO.get(audioKey);
  if (!object) throw new ProviderError("The stored copy of the audio is missing. Retry to download it again.");
  await setDetail(db, episodeId, `Transcribing ${formatBytes(object.size)} of audio with your server`);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  let segments: Segment[];
  try {
    segments = await serverTranscribe(server, { body: object.body, bytes: object.size, filename: audioKey.split("/").pop()!, contentType: headers.get("Content-Type") ?? "audio/mpeg" });
  } catch (error) {
    if (!(error instanceof ServerTranscribeError) || error.status !== 524) throw error;
    throw new ProviderError(`${error.message} Only MP3s can be sent a few minutes at a time, and this episode's audio isn't one, so it went whole, which takes longer than that. Reach the server without a Cloudflare proxy, such as through Tailscale Funnel or a port forward with HTTPS.`);
  }
  if (segments.length === 0) throw new ProviderError("Your transcription server returned an empty transcript. Check that the audio plays and that the server's model is a speech-to-text one.");
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO transcripts_draft (episode_id, text, segments_json, model, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(episodeId, joined(segments), JSON.stringify(segments), server.model, new Date().toISOString()),
    db.prepare("DELETE FROM transcription_progress WHERE episode_id = ?").bind(episodeId),
    redone(db, episodeId, "transcribe"),
  ]);
  return true;
}

/** True once Mistral's draft or the cleaned transcript is saved, so the audio needn't be fetched or transcribed again. */
async function hasTranscript(db: D1Database, episodeId: string): Promise<boolean> {
  return Boolean(await db.prepare("SELECT 1 FROM transcripts_draft WHERE episode_id = ?1 UNION ALL SELECT 1 FROM transcripts WHERE episode_id = ?1").bind(episodeId).first());
}

function joined(segments: readonly Segment[]): string {
  return segments.map((segment) => segment.text.trim()).join(" ");
}

/** Workflows re-create errors between steps, so rely on the message rather than the class. */
function describeError(error: unknown): string {
  // Long enough for each model's error when every fallback failed.
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000) || "Unknown error.";
}

async function setDetail(db: D1Database, episodeId: string, detail: string): Promise<void> {
  await db.prepare("UPDATE episodes SET detail = ?, updated_at = ? WHERE id = ?").bind(detail, new Date().toISOString(), episodeId).run();
}

/**
 * Wraps a step so the dashboard shows what it's doing, and so an error that
 * Workflows is about to retry is visible instead of silent.
 */
function tracked<T>(db: D1Database, episodeId: string, stage: "transcribe" | "summarize" | "index", detail: string, work: () => Promise<T>): () => Promise<T> {
  return async () => {
    await db.prepare("UPDATE episodes SET stage = ?, detail = ?, updated_at = ? WHERE id = ?").bind(stage, detail, new Date().toISOString(), episodeId).run();
    try {
      return await work();
    } catch (error) {
      await db.prepare("UPDATE episodes SET last_error = ?, detail = ?, updated_at = ? WHERE id = ?")
        .bind(describeError(error), `${detail}: hit an error, retrying automatically`, new Date().toISOString(), episodeId).run()
        .catch(() => undefined);
      throw error;
    }
  };
}

export async function requireKey(env: AppEnv, slot: "embeddings" | "transcription"): Promise<string> {
  const key = await getKey(env.DB, env.APP_SECRET ?? "", slot);
  if (!key) throw new ProviderError(`The ${slot} key is missing or unreadable. Re-enter it in Admin.`);
  return key;
}

async function post(url: string, init: RequestInit, what: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { ...init, headers: withUserAgent(init.headers), method: "POST", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).replace(/\s+/gu, " ").slice(0, 200);
    // Throwing lets the workflow step retry; the final message is what admins see.
    throw new ProviderError(`${what} returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
  }
  return response.json();
}

/** Mistral fetches the audio itself from the feed's URL, so nothing is downloaded here. */
export async function transcribe(audioUrl: string, apiKey: string): Promise<Segment[]> {
  const body = new FormData();
  body.set("file_url", audioUrl);
  body.set("model", MISTRAL_TRANSCRIPTION_MODEL);
  body.set("timestamp_granularities", "segment");
  const segments = segmentsFrom(await post("https://api.mistral.ai/v1/audio/transcriptions", { headers: { Authorization: `Bearer ${apiKey}` }, body }, "Mistral transcription", 14 * 60_000));
  if (segments.length > 0) return segments;
  throw new ProviderError("Mistral returned an empty transcript. Check that the audio link in the feed plays.");
}

/** Summarizes with the first of `targets` that answers; the rest are the job's fallbacks. */
export async function summarize(input: {
  targets: readonly LlmTarget[];
  ministry: Ministry | null;
  title: string;
  publishedAt: string | null;
  transcript: string;
  fetcher?: typeof fetch;
}): Promise<SermonSummary & { model: string }> {
  const speakers = input.ministry?.speakerNames.length ? ` Speakers include ${input.ministry.speakerNames.join(", ")}.` : "";
  const church = input.ministry?.churchName ?? "a church";
  const system = `You summarize sermons from ${church}.${speakers} Use only what the transcript says. Reply with only a JSON object: {"summary": "2 to 4 short paragraphs", "mainScripture": "the passage the sermon preaches from, as one reference like Matthew 5:21-26, or null for a topical sermon without one", "topics": ["3 to 8 short topics"], "scriptures": ["every Bible reference discussed, like John 3:16, with the main passage first"]}. The main passage is usually announced or read near the start ("turn with me to Matthew 5, verses 21 through 26"); a verse quoted in passing isn't it.`;
  const transcript = input.transcript.length > SUMMARY_INPUT_CHARS ? `${input.transcript.slice(0, SUMMARY_INPUT_CHARS)} [transcript truncated]` : input.transcript;
  // Generous because thinking models (Gemini 3.x, o-series) can spend part of this before replying.
  const result = await chatWithFallback(input.targets, [
    { role: "system", content: system },
    { role: "user", content: `Title: ${input.title}\nDate: ${input.publishedAt?.slice(0, 10) ?? "unknown"}\n\nTranscript:\n${transcript}` },
  ], { maxTokens: SUMMARY_MAX_TOKENS, timeoutMs: 4 * 60_000, ...(input.fetcher ? { fetcher: input.fetcher } : {}) });
  if (result.finishReason === "length" && !(result.content ?? "").includes("}")) {
    throw new ProviderError("The answers AI ran out of room before finishing the summary. Try a model that thinks less, or retry.");
  }
  return { ...parseSummary(result.content), model: result.target.model };
}

/** Accepts JSON with or without Markdown fences or surrounding prose. */
export function parseSummary(content: unknown): SermonSummary {
  if (typeof content !== "string") throw new ProviderError("The answers AI returned no text.");
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new ProviderError("The answers AI didn't return the summary as JSON. Try a stronger model.");
  }
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()).slice(0, 20) : [];
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) throw new ProviderError("The answers AI returned an empty summary.");
  return { summary: parsed.summary.trim(), mainScripture: normalizeReference(parsed.mainScripture), topics: strings(parsed.topics), scriptures: strings(parsed.scriptures) };
}

/** One summary chunk, then transcript segments packed into ~1,200-character chunks with their time range. */
export function buildChunks(segments: readonly Segment[], summary: SermonSummary): Chunk[] {
  const lines = [summary.summary];
  if (summary.mainScripture) lines.push(`Main text: ${summary.mainScripture}`);
  if (summary.topics.length) lines.push(`Topics: ${summary.topics.join(", ")}`);
  if (summary.scriptures.length) lines.push(`Scripture: ${summary.scriptures.join(", ")}`);
  const chunks: Chunk[] = [{ seq: 0, kind: "summary", text: lines.join("\n"), start: null, end: null }];
  let text = "";
  let start: number | null = null;
  let end: number | null = null;
  const flush = () => {
    if (!text) return;
    chunks.push({ seq: chunks.length, kind: "transcript", text, start, end });
    text = "";
    start = null;
  };
  for (const segment of segments) {
    if (text && text.length + segment.text.length + 1 > CHUNK_CHARS) flush();
    start ??= segment.start;
    end = segment.end;
    text = text ? `${text} ${segment.text}` : segment.text;
  }
  flush();
  return chunks;
}

export async function embed(texts: readonly string[], apiKey: string): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    const result = await post("https://api.openai.com/v1/embeddings", {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
    }, "OpenAI embeddings", 60_000) as { data?: { index?: number; embedding?: number[] }[] };
    const data = [...(result.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== batch.length || data.some((item) => item.embedding?.length !== 1536)) throw new ProviderError("OpenAI returned the wrong number or size of embeddings.");
    vectors.push(...data.map((item) => item.embedding!));
  }
  return vectors;
}

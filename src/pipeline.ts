import type { AppEnv } from "./env.ts";
import { getKey } from "./keys.ts";
import { EMBEDDING_MODEL, MISTRAL_TRANSCRIPTION_MODEL, ProviderError } from "./providers.ts";
import { getSetting, type LlmSettingsRecord, type Ministry } from "./settings.ts";

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

const TRANSCRIBE: StepConfig = { retries: { limit: 3, delay: "1 minute", backoff: "exponential" }, timeout: "15 minutes" };
const SUMMARIZE: StepConfig = { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "5 minutes" };
const INDEX: StepConfig = { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" };
const FINISH: StepConfig = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" };

/** Transcript characters sent for summarizing; roughly 30k tokens. */
const SUMMARY_INPUT_CHARS = 120_000;
const SUMMARY_MAX_TOKENS = 8_000;
const CHUNK_CHARS = 1_200;
const EMBED_BATCH = 64;

/** Runs one episode end to end. Every step writes its own results, so a retry resumes where it stopped. */
export async function runEpisode(env: AppEnv, step: PipelineStep, episodeId: string): Promise<void> {
  const db = env.DB;
  const secret = env.APP_SECRET ?? "";
  try {
    await step.do("transcribe", TRANSCRIBE, async () => {
      await setStage(db, episodeId, "transcribe");
      if (await db.prepare("SELECT 1 FROM transcripts WHERE episode_id = ?").bind(episodeId).first()) return;
      const episode = await db.prepare("SELECT audio_url FROM episodes WHERE id = ?").bind(episodeId).first<{ audio_url: string | null }>();
      if (!episode?.audio_url) throw new ProviderError("This episode has no audio file in the feed.");
      const apiKey = await requireKey(env, "transcription");
      const segments = await transcribe(episode.audio_url, apiKey);
      await db.prepare("INSERT OR REPLACE INTO transcripts (episode_id, text, segments_json, model, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(episodeId, segments.map((segment) => segment.text.trim()).join(" "), JSON.stringify(segments), MISTRAL_TRANSCRIPTION_MODEL, new Date().toISOString()).run();
    });

    await step.do("summarize", SUMMARIZE, async () => {
      await setStage(db, episodeId, "summarize");
      if (await db.prepare("SELECT 1 FROM summaries WHERE episode_id = ?").bind(episodeId).first()) return;
      const [llm, ministry, row] = await Promise.all([
        getSetting<LlmSettingsRecord>(db, "llm"),
        getSetting<Ministry>(db, "ministry"),
        db.prepare("SELECT e.title, e.published_at, t.text FROM episodes e JOIN transcripts t ON t.episode_id = e.id WHERE e.id = ?")
          .bind(episodeId).first<{ title: string; published_at: string | null; text: string }>(),
      ]);
      if (!llm) throw new ProviderError("The answers AI isn't set up.");
      if (!row) throw new ProviderError("The transcript is missing.");
      const apiKey = await requireKey(env, "llm");
      const result = await summarize({ llm, apiKey, ministry, title: row.title, publishedAt: row.published_at, transcript: row.text });
      await db.prepare("INSERT OR REPLACE INTO summaries (episode_id, summary, topics_json, scriptures_json, model, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(episodeId, result.summary, JSON.stringify(result.topics), JSON.stringify(result.scriptures), llm.model, new Date().toISOString()).run();
    });

    await step.do("index", INDEX, async () => {
      await setStage(db, episodeId, "index");
      const [transcript, summary] = await Promise.all([
        db.prepare("SELECT segments_json FROM transcripts WHERE episode_id = ?").bind(episodeId).first<{ segments_json: string }>(),
        db.prepare("SELECT summary, topics_json, scriptures_json FROM summaries WHERE episode_id = ?").bind(episodeId).first<{ summary: string; topics_json: string; scriptures_json: string }>(),
      ]);
      if (!transcript || !summary) throw new ProviderError("The transcript or summary is missing.");
      const chunks = buildChunks(
        JSON.parse(transcript.segments_json) as Segment[],
        { summary: summary.summary, topics: JSON.parse(summary.topics_json), scriptures: JSON.parse(summary.scriptures_json) },
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
      ]);
    });

    await step.do("finish", FINISH, async () => {
      const now = new Date().toISOString();
      await db.prepare("UPDATE episodes SET status = 'done', stage = NULL, error = NULL, completed_at = ?, updated_at = ? WHERE id = ?").bind(now, now, episodeId).run();
    });
  } catch (error) {
    await step.do("record failure", FINISH, async () => {
      await db.prepare("UPDATE episodes SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .bind(describeError(error), new Date().toISOString(), episodeId).run();
    });
  }
}

/** Workflows re-create errors between steps, so rely on the message rather than the class. */
function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500) || "Unknown error.";
}

async function setStage(db: D1Database, episodeId: string, stage: "transcribe" | "summarize" | "index"): Promise<void> {
  await db.prepare("UPDATE episodes SET stage = ?, updated_at = ? WHERE id = ?").bind(stage, new Date().toISOString(), episodeId).run();
}

export async function requireKey(env: AppEnv, slot: "llm" | "embeddings" | "transcription"): Promise<string> {
  const key = await getKey(env.DB, env.APP_SECRET ?? "", slot);
  if (!key) throw new ProviderError(`The ${slot === "llm" ? "answers AI" : slot} key is missing or unreadable. Re-enter it in Admin.`);
  return key;
}

async function post(url: string, init: RequestInit, what: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { ...init, method: "POST", signal: AbortSignal.timeout(timeoutMs) });
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
  const result = await post("https://api.mistral.ai/v1/audio/transcriptions", { headers: { Authorization: `Bearer ${apiKey}` }, body }, "Mistral transcription", 14 * 60_000) as { text?: unknown; segments?: unknown };
  const segments = Array.isArray(result.segments) ? result.segments.flatMap((segment): Segment[] => {
    const { text, start, end } = (segment ?? {}) as Record<string, unknown>;
    return typeof text === "string" && typeof start === "number" && typeof end === "number" && text.trim() ? [{ text: text.trim(), start, end }] : [];
  }) : [];
  if (segments.length > 0) return segments;
  if (typeof result.text === "string" && result.text.trim()) return [{ text: result.text.trim(), start: 0, end: 0 }];
  throw new ProviderError("Mistral returned an empty transcript. Check that the audio link in the feed plays.");
}

export async function summarize(input: {
  llm: LlmSettingsRecord;
  apiKey: string;
  ministry: Ministry | null;
  title: string;
  publishedAt: string | null;
  transcript: string;
}): Promise<SermonSummary> {
  const speakers = input.ministry?.speakerNames.length ? ` Speakers include ${input.ministry.speakerNames.join(", ")}.` : "";
  const church = input.ministry?.churchName ?? "a church";
  const system = `You summarize sermons from ${church}.${speakers} Use only what the transcript says. Reply with only a JSON object: {"summary": "2 to 4 short paragraphs", "topics": ["3 to 8 short topics"], "scriptures": ["Bible references discussed, like John 3:16"]}.`;
  const transcript = input.transcript.length > SUMMARY_INPUT_CHARS ? `${input.transcript.slice(0, SUMMARY_INPUT_CHARS)} [transcript truncated]` : input.transcript;
  const result = await post(`${input.llm.baseUrl}/chat/completions`, {
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: input.llm.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Title: ${input.title}\nDate: ${input.publishedAt?.slice(0, 10) ?? "unknown"}\n\nTranscript:\n${transcript}` },
      ],
      // Generous because thinking models (Gemini 3.x, o-series) can spend part of this before replying.
      max_tokens: SUMMARY_MAX_TOKENS,
    }),
  }, "The answers AI", 4 * 60_000) as { choices?: { finish_reason?: unknown; message?: { content?: unknown } }[] };
  const choice = result.choices?.[0];
  if (choice?.finish_reason === "length" && !String(choice.message?.content ?? "").includes("}")) {
    throw new ProviderError("The answers AI ran out of room before finishing the summary. Try a model that thinks less, or retry.");
  }
  return parseSummary(choice?.message?.content);
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
  return { summary: parsed.summary.trim(), topics: strings(parsed.topics), scriptures: strings(parsed.scriptures) };
}

/** One summary chunk, then transcript segments packed into ~1,200-character chunks with their time range. */
export function buildChunks(segments: readonly Segment[], summary: SermonSummary): Chunk[] {
  const lines = [summary.summary];
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

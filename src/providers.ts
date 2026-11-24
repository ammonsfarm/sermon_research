import { MUSE_SAMPLE_RATE, wavFile } from "./muse.ts";
import type { Segment } from "./pipeline.ts";

/** Fixed embedding model so every deployment's vectors match the Vectorize index (1536 dimensions). */
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const MISTRAL_TRANSCRIPTION_MODEL = "voxtral-mini-latest";
export const MUSE_TRANSCRIPTION_MODEL = "muse-voice-transcribe-1.0";
export const MUSE_TRANSCRIBE_URL = "https://api.meta.ai/v1/asr/transcribe";

/** `server` is the admin's own transcription server: any OpenAI-compatible `/audio/transcriptions` endpoint. */
export const TRANSCRIPTION_PROVIDERS = ["mistral", "muse", "server"] as const;
export type TranscriptionProvider = (typeof TRANSCRIPTION_PROVIDERS)[number];

export function isTranscriptionProvider(value: unknown): value is TranscriptionProvider {
  return TRANSCRIPTION_PROVIDERS.includes(value as TranscriptionProvider);
}

/** The fixed model of each hosted service. A transcription server's model is whatever the admin names. */
export const TRANSCRIPTION_MODELS: Record<Exclude<TranscriptionProvider, "server">, string> = { mistral: MISTRAL_TRANSCRIPTION_MODEL, muse: MUSE_TRANSCRIPTION_MODEL };

/**
 * Sent on every outbound request. Workers' fetch sends no User-Agent by default,
 * and APIs behind Cloudflare's bot checks (Resend among them) can refuse such
 * requests with a 403 that looks like a bad key.
 */
export const USER_AGENT = "sermon-research/1.0 (+https://github.com/ammonsfarm/sermon_research)";

/** Adds the User-Agent to a request's headers. */
export function withUserAgent(headers: HeadersInit = {}): Headers {
  const merged = new Headers(headers);
  merged.set("User-Agent", USER_AGENT);
  return merged;
}

export class ProviderError extends Error {}

/** Muse transcription's documented failures, explained. `status` is the HTTP status. */
export class MuseTranscribeError extends ProviderError {
  readonly status: number;

  constructor(status: number, body: string) {
    const detail = providerMessage(body);
    const explained = status === 400 ? "Muse couldn't use the audio (HTTP 400). Each part must be mono 16-bit WAV, at most 10 minutes long."
      : status === 401 || status === 403 ? `Muse refused the transcription key (HTTP ${status}). Check it in Admin → Transcription.`
        : status === 413 ? "Muse says the audio part is over its 32 MB limit (HTTP 413)."
          : status === 429 ? "Muse says the account is at its limit for transcriptions running at once or per hour (HTTP 429). It retries on its own; lower \"Episodes at once\" if it keeps happening."
            : status === 408 || status === 504 || status === 524 ? `Muse timed out transcribing this part (HTTP ${status}).`
            : `Muse transcription returned HTTP ${status}.`;
    super(`${explained}${detail ? ` It said: "${detail}"` : ""}`);
    this.status = status;
  }
}

/** Reasoning levels across providers, least to most. Each model takes some of them (see llm.ts). */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

/** Pulls the human-readable message out of a provider's error body (OpenAI, Gemini, Mistral and Resend shapes). */
export function providerMessage(body: string): string {
  if (body.trimStart().startsWith("<")) return ""; // an HTML error page says nothing useful
  let message: unknown = body;
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown; detail?: unknown };
    const error = parsed.error;
    message = typeof error === "object" && error !== null && "message" in error ? (error as { message: unknown }).message
      : parsed.message ?? (typeof error === "string" ? error : undefined) ?? parsed.detail ?? body;
  } catch {
    // Not JSON: use the text as is.
  }
  return (typeof message === "string" ? message : JSON.stringify(message)).replace(/\s+/gu, " ").trim().slice(0, 240);
}

async function call(url: string, init: RequestInit, fetcher: typeof fetch, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, headers: withUserAgent(init.headers), signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ProviderError(`${what} didn't respond. Check the address and try again.`);
  }
  if (response.ok) return response;
  const detail = providerMessage(await response.text().catch(() => ""));
  const said = detail ? ` It said: "${detail}"` : "";
  // A 403 isn't always the key: Resend uses it for an unverified sending domain, for example.
  if (response.status === 401 || response.status === 403) throw new ProviderError(`${what} refused the request (HTTP ${response.status}).${said || " Check the key."}`);
  if (response.status === 404) throw new ProviderError(`${what} couldn't find that model or address.${said}`);
  if (response.status === 429) throw new ProviderError(`${what} says the account is rate limited or out of credit.${said}`);
  throw new ProviderError(`${what} returned HTTP ${response.status}.${said}`);
}

export async function checkEmbeddings(apiKey: string, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await call(`${OPENAI_BASE_URL}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: "connection check" }),
  }, fetcher, "OpenAI");
  const body = await response.json().catch(() => null) as { data?: { embedding?: unknown[] }[] } | null;
  if (body?.data?.[0]?.embedding?.length !== EMBEDDING_DIMENSIONS) throw new ProviderError("OpenAI replied, but not with a 1536-dimension embedding.");
}

/**
 * Confirms the transcription key works. For Mistral, lists models: transcribing
 * a sample would cost money on every check. Muse has no free call, so it
 * transcribes one second of silence, a fraction of a cent.
 */
export async function checkTranscription(provider: Exclude<TranscriptionProvider, "server">, apiKey: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (provider === "muse") {
    const reply = await museTranscribe(wavFile(new Int16Array(MUSE_SAMPLE_RATE)), apiKey, fetcher, 30_000);
    if (typeof reply !== "object" || reply === null || Array.isArray(reply)) throw new ProviderError("Muse replied, but not with a transcription.");
    return;
  }
  await call("https://api.mistral.ai/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } }, fetcher, "Mistral");
}

/**
 * Sends one WAV (mono 16-bit, 16 or 24 kHz, up to 10 minutes and 32 MB) to
 * Muse's file transcription in ENDPOINTING mode, which splits it into timed
 * turns. The multipart body is written out by hand so the request part goes as
 * JSON without a filename, as in Muse's own curl example.
 */
export async function museTranscribe(wav: Uint8Array, apiKey: string, fetcher: typeof fetch = fetch, timeoutMs = 5 * 60_000): Promise<{ turns?: unknown; transcript?: unknown }> {
  const boundary = `sermon-research-${crypto.randomUUID()}`;
  const request = JSON.stringify({ mode: "ENDPOINTING", model: MUSE_TRANSCRIPTION_MODEL, audioEncoding: "WAV" });
  const body = new Blob([
    `--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${request}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    wav,
    `\r\n--${boundary}--\r\n`,
  ]);
  let response: Response;
  try {
    response = await fetcher(MUSE_TRANSCRIBE_URL, {
      method: "POST",
      headers: withUserAgent({ Authorization: `Bearer ${apiKey}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, Accept: "application/json" }),
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProviderError("Muse transcription didn't respond. Try again in a minute.");
  }
  if (!response.ok) throw new MuseTranscribeError(response.status, await response.text().catch(() => ""));
  const reply = await response.json().catch(() => null) as unknown;
  if (typeof reply !== "object" || reply === null) throw new ProviderError("Muse replied, but not with JSON.");
  return reply as { turns?: unknown; transcript?: unknown };
}

/** The admin's own transcription server, reached through its OpenAI-compatible API. */
export interface TranscriptionServer {
  /** Everything before `/audio/transcriptions`, usually ending in /v1. */
  readonly baseUrl: string;
  readonly model: string;
  /** Sent as a Bearer token; null for a server that needs none. */
  readonly apiKey: string | null;
}

/** One audio file for a transcription server. `body` is streamed, so `bytes` must be its exact length. */
export interface TranscriptionUpload {
  readonly body: ReadableStream<Uint8Array> | Uint8Array;
  readonly bytes: number;
  readonly filename: string;
  readonly contentType: string;
}

/**
 * Cleans an admin's server address: no trailing slash, and no
 * `/audio/transcriptions` if they pasted the whole endpoint. Null unless https.
 */
export function serverBaseUrl(value: string): string | null {
  const base = value.trim().replace(/\/+$/u, "").replace(/\/audio\/transcriptions$/u, "");
  return isHttpsUrl(base) ? base : null;
}

/** A transcription server's failures, explained. Its address is part of each message, since it's the admin's own machine. */
export class ServerTranscribeError extends ProviderError {
  readonly status: number;

  constructor(status: number, body: string, baseUrl: string) {
    const detail = providerMessage(body);
    const explained = status === 401 || status === 403 ? `Your transcription server refused the request (HTTP ${status}). Check the key in Admin → Transcription.`
      : status === 404 ? `Your transcription server has nothing at ${baseUrl}/audio/transcriptions (HTTP 404). The address should be the part before /audio/transcriptions, often ending in /v1.`
        : status === 413 ? "Your transcription server says the audio file is too large (HTTP 413). Raise its upload limit."
          : status === 524 ? "Cloudflare stopped waiting for your transcription server (HTTP 524). A Cloudflare proxy or Tunnel in front of a server waits only 100 seconds for each reply."
            : status === 408 || status === 504 ? `Your transcription server, or a proxy in front of it, timed out (HTTP ${status}).`
              : status === 502 || status === 503 || status === 530 ? `Your transcription server couldn't be reached (HTTP ${status}). Check that it's running and that its tunnel or proxy is up.`
                : `Your transcription server returned HTTP ${status}.`;
    super(`${explained}${detail ? ` It said: "${detail}"` : ""}`);
    this.status = status;
  }
}

/**
 * Sends a whole recording to a transcription server's OpenAI-compatible
 * `POST {baseUrl}/audio/transcriptions`, the API that whisper.cpp's server,
 * faster-whisper and speaches, LocalAI, vLLM and OpenAI itself take, asking for
 * segment timings (`verbose_json`). The multipart body is streamed around the
 * audio with its length set, so a long sermon never sits in the Worker's memory.
 */
export async function serverTranscribe(server: TranscriptionServer, upload: TranscriptionUpload, fetcher: typeof fetch = fetch, timeoutMs = 14 * 60_000): Promise<Segment[]> {
  const boundary = `sermon-research-${crypto.randomUUID()}`;
  const field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value.replace(/[\r\n]/gu, "")}\r\n`;
  const encoder = new TextEncoder();
  const head = encoder.encode(`${field("model", server.model)}${field("response_format", "verbose_json")}${field("timestamp_granularities[]", "segment")}`
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${upload.filename.replace(/["\r\n]/gu, "")}"\r\nContent-Type: ${upload.contentType}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = withLength(concatenated([head, upload.body, tail]), head.byteLength + upload.bytes + tail.byteLength);
  const headers: Record<string, string> = { "Content-Type": `multipart/form-data; boundary=${boundary}`, Accept: "application/json" };
  if (server.apiKey) headers.Authorization = `Bearer ${server.apiKey}`;
  let response: Response;
  try {
    // `duplex` is what Node needs for a streamed body; Workers ignore it.
    response = await fetcher(`${server.baseUrl}/audio/transcriptions`, { method: "POST", headers: withUserAgent(headers), body, duplex: "half", signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new ProviderError(timedOut
      ? `Your transcription server took longer than ${Math.round(timeoutMs / 60_000)} minutes to reply.`
      : `Your transcription server at ${server.baseUrl} didn't respond. Check that it's running and reachable from the internet over https.`);
  }
  if (!response.ok) throw new ServerTranscribeError(response.status, await response.text().catch(() => ""), server.baseUrl);
  const reply = await response.json().catch(() => null) as unknown;
  if (typeof reply !== "object" || reply === null || Array.isArray(reply)) throw new ProviderError("Your transcription server replied, but not with JSON. Check that the address is its OpenAI-compatible API.");
  return segmentsFrom(reply);
}

/**
 * Confirms a transcription server works by transcribing one second of silence.
 * Silence may come back empty, which is fine; any reply in the right shape is.
 */
export async function checkTranscriptionServer(server: TranscriptionServer, fetcher: typeof fetch = fetch): Promise<void> {
  const wav = wavFile(new Int16Array(MUSE_SAMPLE_RATE));
  await serverTranscribe(server, { body: wav, bytes: wav.byteLength, filename: "check.wav", contentType: "audio/wav" }, fetcher, 2 * 60_000);
}

/**
 * Timed segments from an OpenAI-shaped transcription reply (Mistral's, or a
 * server's `verbose_json`). A reply with only `text` becomes one untimed
 * segment; an empty one gives none.
 */
export function segmentsFrom(reply: unknown): Segment[] {
  const { text, segments } = (reply ?? {}) as { text?: unknown; segments?: unknown };
  const timed = Array.isArray(segments) ? segments.flatMap((segment): Segment[] => {
    const { text: words, start, end } = (segment ?? {}) as Record<string, unknown>;
    return typeof words === "string" && typeof start === "number" && typeof end === "number" && words.trim() ? [{ text: words.trim(), start, end }] : [];
  }) : [];
  if (timed.length > 0) return timed;
  return typeof text === "string" && text.trim() ? [{ text: text.trim(), start: 0, end: 0 }] : [];
}

/** One stream from byte arrays and streams, read in order. */
function concatenated(parts: readonly (Uint8Array | ReadableStream<Uint8Array>)[]): ReadableStream<Uint8Array> {
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (index < parts.length) {
        const part = parts[index]!;
        if (part instanceof Uint8Array) {
          index++;
          controller.enqueue(part);
          return;
        }
        reader ??= part.getReader();
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        reader = null;
        index++;
      }
      controller.close();
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}

/**
 * On Workers, a FixedLengthStream sends the body with a Content-Length instead
 * of chunked, which some servers and proxies refuse. Elsewhere (tests), the stream as is.
 */
function withLength(stream: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  if (!Fixed) return stream;
  const fixed = new Fixed(length);
  stream.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
}

export async function sendEmail(
  input: { apiKey: string; from: string; to: string; subject: string; text: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await call("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: input.from, to: [input.to], subject: input.subject, text: input.text }),
  }, fetcher, "Resend");
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

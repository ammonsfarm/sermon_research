import { MUSE_SAMPLE_RATE, wavFile } from "./muse.ts";

/** Fixed embedding model so every deployment's vectors match the Vectorize index (1536 dimensions). */
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const MISTRAL_TRANSCRIPTION_MODEL = "voxtral-mini-latest";
export const MUSE_TRANSCRIPTION_MODEL = "muse-voice-transcribe-1.0";
export const MUSE_TRANSCRIBE_URL = "https://api.meta.ai/v1/asr/transcribe";

export const TRANSCRIPTION_PROVIDERS = ["mistral", "muse"] as const;
export type TranscriptionProvider = (typeof TRANSCRIPTION_PROVIDERS)[number];

export function isTranscriptionProvider(value: unknown): value is TranscriptionProvider {
  return TRANSCRIPTION_PROVIDERS.includes(value as TranscriptionProvider);
}

export const TRANSCRIPTION_MODELS: Record<TranscriptionProvider, string> = { mistral: MISTRAL_TRANSCRIPTION_MODEL, muse: MUSE_TRANSCRIPTION_MODEL };

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
            : `Muse transcription returned HTTP ${status}.`;
    super(`${explained}${detail ? ` It said: "${detail}"` : ""}`);
    this.status = status;
  }
}

export interface LlmSettings {
  readonly baseUrl: string;
  readonly model: string;
}

/** Muse's chat completions `reasoning_effort` values, least to most. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

/** Meta's API, which serves Muse. */
export function isMetaApi(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "api.meta.ai" || host.endsWith(".api.meta.ai");
  } catch {
    return false;
  }
}

/**
 * The reasoning field for a chat completion body. Only Meta's API gets one: other
 * OpenAI-compatible providers can reject a field they don't know with a 400.
 */
export function reasoningFields(baseUrl: string, effort: ReasoningEffort = DEFAULT_REASONING_EFFORT): { reasoning_effort?: ReasoningEffort } {
  return isMetaApi(baseUrl) ? { reasoning_effort: effort } : {};
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

/** Sends one tiny chat completion to confirm the endpoint, model and key work together. */
export async function checkLlm(settings: LlmSettings, apiKey: string, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await call(`${settings.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: settings.model, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 16, ...reasoningFields(settings.baseUrl, "low") }),
  }, fetcher, "The answers provider");
  const body = await response.json().catch(() => null) as { choices?: unknown[] } | null;
  if (!Array.isArray(body?.choices)) throw new ProviderError("The answers provider replied, but not in the OpenAI chat format.");
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
export async function checkTranscription(provider: TranscriptionProvider, apiKey: string, fetcher: typeof fetch = fetch): Promise<void> {
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

/**
 * P6 Task 3a AUDIO-TRANSPORT-GATE — R2 → Mistral provider-reachable transport.
 *
 * Chosen transport: scoped short-lived S3 presigned GET (design option 1).
 * A dedicated authenticated streaming Worker (option 2) is documented as the
 * fallback only; it is not implemented here.
 *
 * Rules enforced by this module:
 * - A bearer URL is minted inside each transcription attempt immediately
 *   before the Mistral call. It is never returned, persisted, logged, or
 *   reused by a replay. A retry/resume always mints a fresh URL.
 * - Only the non-secret R2 object descriptor crosses step boundaries.
 * - The 60-minute bound below is the AIC project's conservative processing
 *   gate for deterministic single-pass transcription, not a current Mistral
 *   provider limit. Current Voxtral Mini Transcribe documentation supports
 *   up to 3 hours. Until deterministic preprocessing exists, over-gate input
 *   stays in `retry_required/audio_segmentation_required`.
 * - The 250 MiB AIC input bound is enforced before any provider call.
 * - Duration inventory outputs counts/durations/IDs only; no audio bytes,
 *   transcript text, URLs, or secrets.
 * - Mistral `/v1/audio/transcriptions` responses are validated against the
 *   real API shape (`model`, `text`, `segments`, optional `language`/`usage`).
 *   No provider-returned digest is trusted; the artifact digest is computed
 *   locally from the validated artifact.
 * - `MISTRAL_TRANSCRIPTION_URL` is allowlisted so `MISTRAL_API_KEY` can never
 *   be sent to an arbitrary HTTPS host.
 */

export const AUDIO_BUCKET = "aic-podcast-audio" as const;
export const AUDIO_KEY_PREFIX = "podcasts/" as const;
export const AUDIO_KEY_SUFFIX = ".mp3" as const;
export const MAX_AUDIO_BYTES = 262_144_000 as const; // 250 MiB
// AIC conservative single-pass processing gate (not the Mistral provider
// limit; Voxtral Mini Transcribe currently documents up to 3 hours).
export const MAX_AUDIO_DURATION_MS = 3_600_000 as const; // 60 minutes
export const PRESIGN_EXPIRY_SECONDS = 300 as const; // short-lived per attempt

export const MISTRAL_TRANSCRIPTION_URL_ALLOWLIST = [
  "https://api.mistral.ai/v1/audio/transcriptions",
] as const;

export const AUDIO_TRANSPORT_BINDINGS = ["AIC_DB", "AIC_PODCAST_AUDIO"] as const;
export const AUDIO_TRANSPORT_SECRETS = [
  "MISTRAL_API_KEY",
  "R2_AUDIO_PRESIGN_ACCESS_KEY_ID",
  "R2_AUDIO_PRESIGN_SECRET_ACCESS_KEY",
] as const;
export const AUDIO_TRANSPORT_CONFIG = [
  "MISTRAL_TRANSCRIPTION_URL",
  "MISTRAL_TRANSCRIPTION_MODEL",
] as const;

export type AudioTransportErrorCode =
  | "invalid_input"
  | "audio_segmentation_required"
  | "authentication"
  | "provider_timeout_unknown"
  | "throttled"
  | "transient_dependency"
  | "transcription_unavailable"
  | "configuration";

export class AudioTransportError extends Error {
  readonly code: AudioTransportErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(code: AudioTransportErrorCode, message: string, retryable = false, retryAfterSeconds?: number) {
    super(message);
    this.name = "AudioTransportError";
    this.code = code;
    this.retryable = retryable;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface AudioObjectDescriptor {
  readonly bucket: typeof AUDIO_BUCKET;
  readonly key: string;
  readonly sizeBytes: number;
  readonly sha256: `sha256:${string}`;
  readonly durationMs: number | null;
  readonly episodeId: string;
}

export interface MintUrlInput {
  readonly descriptor: AudioObjectDescriptor;
  readonly expiresInSeconds: number;
  readonly attempt: number;
}

export type MintAudioUrl = (input: MintUrlInput) => Promise<string>;

export interface MistralTranscriptionReceipt {
  readonly artifactKey: string;
  readonly model: string;
  readonly segmentCount: number;
  /** SHA-256 hex computed locally from the validated transcript artifact. */
  readonly artifactDigest: string;
  readonly durationMs: number | null;
}

export interface TranscriptionAttemptContext {
  readonly requestId: string;
  readonly revisionHash: `sha256:${string}`;
  readonly generation: number;
}

export interface NormalizedTranscriptionArtifact {
  readonly model: string;
  readonly text: string;
  readonly segments: readonly {
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly speakerId?: string;
  }[];
  readonly artifactDigest: string;
}

export interface CreateAudioTransportOptions {
  readonly mintUrl: MintAudioUrl;
  readonly mistralFetch: (request: Request) => Promise<Response>;
  readonly mistralUrl: string;
  readonly mistralModel: string;
  readonly mistralApiKey: string;
  readonly persistArtifact: (
    context: TranscriptionAttemptContext,
    descriptor: AudioObjectDescriptor,
    artifact: NormalizedTranscriptionArtifact,
  ) => Promise<{ readonly artifactKey: string }>;
  readonly maxResponseBytes?: number;
  readonly onEvent?: (event: Record<string, string | number>) => void;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const EPISODE_ID = /^(?:\d+|sa_\d+|wp-sermon:\d+|cms_[A-Za-z0-9_-]+)$/u;

function invalid(message: string): AudioTransportError {
  return new AudioTransportError("invalid_input", message, false);
}

function segmentation(message: string): AudioTransportError {
  return new AudioTransportError("audio_segmentation_required", message, false);
}

function unavailable(message: string): AudioTransportError {
  return new AudioTransportError("transcription_unavailable", message, true);
}

function transient(message: string): AudioTransportError {
  return new AudioTransportError("transient_dependency", message, true);
}

function timeoutUnknown(message: string): AudioTransportError {
  return new AudioTransportError("provider_timeout_unknown", message, true);
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.length > 64) return undefined;
  const input = value.trim();
  if (/^\d{1,10}$/u.test(input)) return Math.min(600, Number(input));
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(input)) return undefined;
  const time = Date.parse(input);
  if (!Number.isFinite(time) || new Date(time).toUTCString() !== input) return undefined;
  return Math.min(600, Math.max(0, Math.ceil((time - now) / 1_000)));
}

function providerError(status: number, retryAfter: string | null): AudioTransportError {
  if (status === 429) return new AudioTransportError("throttled", "Mistral transcription is temporarily throttled.", true, parseRetryAfter(retryAfter));
  if (status === 401 || status === 403) return new AudioTransportError("authentication", "Mistral transcription authentication failed.", false);
  if (status === 408 || status === 425 || status >= 500) return transient(`Mistral transcription returned status ${status}.`);
  return unavailable(`Mistral transcription was rejected with status ${status}.`);
}

function configuration(message: string): AudioTransportError {
  return new AudioTransportError("configuration", message, false);
}

export function episodeAudioKey(episodeId: string): string {
  if (typeof episodeId !== "string" || !EPISODE_ID.test(episodeId)) {
    throw invalid("Episode audio identity is invalid.");
  }
  const key = `${AUDIO_KEY_PREFIX}${episodeId}${AUDIO_KEY_SUFFIX}`;
  if (key.length > 512) throw invalid("Episode audio identity is invalid.");
  return key;
}

export function validateAudioDescriptor(value: unknown): asserts value is AudioObjectDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("Audio object descriptor is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (record.bucket !== AUDIO_BUCKET) throw invalid("Audio object bucket is invalid.");
  if (typeof record.key !== "string" || !record.key.startsWith(AUDIO_KEY_PREFIX) || !record.key.endsWith(AUDIO_KEY_SUFFIX)) {
    throw invalid("Audio object key is invalid.");
  }
  if (record.key.includes("\0") || /[\u0000-\u001F\u007F]/u.test(record.key)) {
    throw invalid("Audio object key is invalid.");
  }
  if (!Number.isSafeInteger(record.sizeBytes) || (record.sizeBytes as number) < 0) {
    throw invalid("Audio object size is invalid.");
  }
  if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256)) {
    throw invalid("Audio object fingerprint is invalid.");
  }
  if (typeof record.episodeId !== "string" || !EPISODE_ID.test(record.episodeId)) {
    throw invalid("Episode audio identity is invalid.");
  }
  if (record.key !== episodeAudioKey(record.episodeId)) {
    throw invalid("Audio object key does not match the episode identity.");
  }
  const duration = record.durationMs;
  if (duration !== null && (!Number.isSafeInteger(duration) || (duration as number) < 0)) {
    throw invalid("Audio duration is invalid.");
  }
}

export type AudioClassification =
  | { readonly decision: "transcribe" }
  | { readonly decision: "retry_required"; readonly code: "audio_segmentation_required"; readonly reason: string }
  | { readonly decision: "failed"; readonly code: "invalid_input"; readonly reason: string };

export function classifyAudioForTranscription(input: {
  readonly sizeBytes: number;
  readonly durationMs: number | null;
}): AudioClassification {
  const { sizeBytes, durationMs } = input;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return { decision: "failed", code: "invalid_input", reason: "Audio object is empty." };
  }
  if (sizeBytes > MAX_AUDIO_BYTES) {
    return { decision: "failed", code: "invalid_input", reason: "Audio object exceeds the 250 MiB bound." };
  }
  if (durationMs === null) {
    return {
      decision: "retry_required",
      code: "audio_segmentation_required",
      reason: "Audio duration is unknown; preprocessing must establish an AIC ≤60-minute manifest before transcription.",
    };
  }
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    return { decision: "failed", code: "invalid_input", reason: "Audio duration is invalid." };
  }
  if (durationMs > MAX_AUDIO_DURATION_MS) {
    return {
      decision: "retry_required",
      code: "audio_segmentation_required",
      reason: "Audio exceeds the AIC 60-minute single-pass gate; deterministic segmentation is required before transcription.",
    };
  }
  return { decision: "transcribe" };
}

/**
 * Parses SoundCloud `itunes:duration` shapes without touching audio bytes:
 * `SS`, `MM:SS`, `H:MM:SS`. Returns milliseconds or null when unknown.
 */
export function parseItunesDurationToMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d{1,5}$/u.test(part.trim()))) return null;
  const numbers = parts.map((part) => Number(part.trim()));
  if (numbers.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  let seconds = 0;
  if (numbers.length === 3) seconds = numbers[0]! * 3600 + numbers[1]! * 60 + numbers[2]!;
  else if (numbers.length === 2) {
    if (numbers[1]! > 59) return null;
    seconds = numbers[0]! * 60 + numbers[1]!;
  } else {
    seconds = numbers[0]!;
  }
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const ms = seconds * 1_000;
  return Number.isSafeInteger(ms) ? ms : null;
}

export interface DurationInventoryRecord {
  readonly episodeId: string;
  readonly durationMs: number | null;
}

export interface DurationInventorySummary {
  readonly total: number;
  readonly withDuration: number;
  readonly withoutDuration: number;
  readonly over60Min: readonly string[];
  readonly maxDurationMs: number | null;
  readonly buckets: {
    readonly under10Min: number;
    readonly min10To30: number;
    readonly min30To60: number;
    readonly over60Min: number;
  };
}

export function inventoryAudioDurations(records: readonly DurationInventoryRecord[]): DurationInventorySummary {
  const over60Min: string[] = [];
  let maxDurationMs: number | null = null;
  let withDuration = 0;
  const buckets = { under10Min: 0, min10To30: 0, min30To60: 0, over60Min: 0 };
  for (const record of records) {
    if (typeof record.episodeId !== "string" || !EPISODE_ID.test(record.episodeId)) {
      throw invalid("Duration inventory episode identity is invalid.");
    }
    const duration = record.durationMs;
    if (duration === null) continue;
    if (!Number.isSafeInteger(duration) || duration <= 0) {
      throw invalid("Duration inventory duration is invalid.");
    }
    withDuration += 1;
    if (maxDurationMs === null || duration > maxDurationMs) maxDurationMs = duration;
    if (duration > MAX_AUDIO_DURATION_MS) {
      buckets.over60Min += 1;
      over60Min.push(record.episodeId);
    } else if (duration < 600_000) {
      buckets.under10Min += 1;
    } else if (duration <= 1_800_000) {
      buckets.min10To30 += 1;
    } else {
      buckets.min30To60 += 1;
    }
  }
  return {
    total: records.length,
    withDuration,
    withoutDuration: records.length - withDuration,
    over60Min: [...over60Min].sort(),
    maxDurationMs,
    buckets: { ...buckets },
  };
}

function requireMistralUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configuration("Mistral transcription endpoint is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw configuration("Mistral transcription endpoint is invalid.");
  }
  const normalized = url.toString();
  if (!MISTRAL_TRANSCRIPTION_URL_ALLOWLIST.includes(normalized as (typeof MISTRAL_TRANSCRIPTION_URL_ALLOWLIST)[number]) && !MISTRAL_TRANSCRIPTION_URL_ALLOWLIST.includes(value as (typeof MISTRAL_TRANSCRIPTION_URL_ALLOWLIST)[number])) {
    throw configuration("Mistral transcription endpoint is not allowlisted.");
  }
  return normalized;
}

function requireMistralModel(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw configuration("Mistral transcription model is invalid.");
  }
  return value;
}

interface ValidatedTranscription {
  readonly model: string;
  readonly text: string;
  readonly segments: readonly {
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly speakerId?: string;
  }[];
}

function validateTranscriptionResponse(payload: unknown): ValidatedTranscription {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw unavailable("Mistral transcription response is invalid.");
  }
  const record = payload as Record<string, unknown>;
  const model = record.model;
  if (typeof model !== "string" || !model.trim() || model.length > 128 || /[\u0000-\u001F\u007F]/u.test(model)) {
    throw unavailable("Mistral transcription response is invalid.");
  }
  const text = record.text;
  if (typeof text !== "string" || text.length > 500_000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    throw unavailable("Mistral transcription response is invalid.");
  }
  const segments = record.segments;
  if (!Array.isArray(segments) || segments.length > 100_000) {
    throw unavailable("Mistral transcription response is invalid.");
  }
  const normalized = segments.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw unavailable("Mistral transcription response is invalid.");
    }
    const segment = entry as Record<string, unknown>;
    if (typeof segment.text !== "string" || segment.text.length > 50_000) {
      throw unavailable("Mistral transcription response is invalid.");
    }
    if (typeof segment.start !== "number" || !Number.isFinite(segment.start) || segment.start < 0) {
      throw unavailable("Mistral transcription response is invalid.");
    }
    if (typeof segment.end !== "number" || !Number.isFinite(segment.end) || segment.end < segment.start) {
      throw unavailable("Mistral transcription response is invalid.");
    }
    const speaker = (segment as Record<string, unknown>).speaker_id ?? (segment as Record<string, unknown>).speakerId;
    if (speaker !== undefined && (typeof speaker !== "string" || speaker.length > 64 || /[\u0000-\u001F\u007F]/u.test(speaker))) {
      throw unavailable("Mistral transcription response is invalid.");
    }
    return {
      text: segment.text as string,
      start: segment.start as number,
      end: segment.end as number,
      ...(speaker === undefined ? {} : { speakerId: speaker as string }),
    };
  });
  return { model, text, segments: normalized };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface AudioTransport {
  transcribeAttempt(
    descriptor: AudioObjectDescriptor,
    attempt: number,
    context: TranscriptionAttemptContext,
  ): Promise<MistralTranscriptionReceipt>;
}

export function createAudioTransport(options: CreateAudioTransportOptions): AudioTransport {
  const mistralUrl = requireMistralUrl(options.mistralUrl);
  const mistralModel = requireMistralModel(options.mistralModel);
  if (typeof options.mistralApiKey !== "string" || !options.mistralApiKey) {
    throw configuration("Mistral credential is missing.");
  }
  const maxResponseBytes = options.maxResponseBytes ?? 262_144;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1_048_576) {
    throw configuration("Mistral response bound is invalid.");
  }

  return {
    async transcribeAttempt(descriptor, attempt, context) {
      validateAudioDescriptor(descriptor);
      if (!Number.isSafeInteger(attempt) || attempt < 0) throw invalid("Transcription attempt is invalid.");
      if (
        !context
        || typeof context.requestId !== "string"
        || context.requestId.length === 0
        || !/^sha256:[0-9a-f]{64}$/u.test(context.revisionHash)
        || !Number.isSafeInteger(context.generation)
        || context.generation < 1
      ) throw invalid("Transcription attempt context is invalid.");
      const classification = classifyAudioForTranscription({
        sizeBytes: descriptor.sizeBytes,
        durationMs: descriptor.durationMs,
      });
      if (classification.decision === "failed") {
        throw new AudioTransportError("invalid_input", classification.reason, false);
      }
      if (classification.decision === "retry_required") {
        throw new AudioTransportError("audio_segmentation_required", classification.reason, false);
      }

      // The bearer URL is minted inside this attempt only. It never leaves
      // this callback except as the outbound Mistral `file_url` field.
      let audioUrl: string;
      try {
        audioUrl = await options.mintUrl({
          descriptor,
          expiresInSeconds: PRESIGN_EXPIRY_SECONDS,
          attempt,
        });
      } catch {
        throw unavailable("Audio transport minting failed without provider detail.");
      }
      if (typeof audioUrl !== "string" || !audioUrl.startsWith("https://")) {
        throw unavailable("Audio transport minting failed without provider detail.");
      }

      let response: Response;
      try {
        // Match Mistral's SDK wire encoding; only metadata, never an audio upload.
        const body = new FormData();
        body.set("file_url", audioUrl);
        body.set("model", mistralModel);
        body.set("timestamp_granularities", "segment");
        response = await options.mistralFetch(
          new Request(mistralUrl, {
            method: "POST",
            signal: AbortSignal.timeout(9 * 60_000),
            headers: {
              authorization: `Bearer ${options.mistralApiKey}`,
              accept: "application/json",
            },
            body,
          }),
        );
      } catch (error) {
        options.onEvent?.({ event: "audio.transcribe_fetch_failed", attempt, outcome: "unavailable" });
        if (error instanceof DOMException && error.name === "AbortError") throw timeoutUnknown("Mistral transcription outcome is unknown after timeout.");
        throw timeoutUnknown("Mistral transcription outcome is unknown after connection loss.");
      }

      if (!response.ok) {
        options.onEvent?.({ event: "audio.transcribe_rejected", attempt, status: response.status, outcome: "rejected" });
        await response.body?.cancel().catch(() => undefined);
        throw providerError(response.status, response.headers.get("retry-after"));
      }

      let payloadText: string;
      try {
        const declared = response.headers.get("content-length");
        if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxResponseBytes) {
          throw unavailable("Mistral response exceeds the bounded size.");
        }
        if (!response.body) throw unavailable("Mistral response has no body.");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          length += result.value.byteLength;
          if (length > maxResponseBytes) {
            await reader.cancel();
            throw unavailable("Mistral response exceeds the bounded size.");
          }
          chunks.push(result.value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        payloadText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        if (error instanceof AudioTransportError) throw error;
        throw timeoutUnknown("Mistral transcription outcome is unknown after response interruption.");
      }

      let payload: unknown;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        throw unavailable("Mistral transcription response is not valid JSON.");
      }
      // Real `/v1/audio/transcriptions` shape: `{model, text, segments[],
      // language?, usage?}`. Provider-returned digests are never trusted.
      const validated = validateTranscriptionResponse(payload);
      const artifactDigest = await sha256Hex(
        JSON.stringify({ model: validated.model, text: validated.text, segments: validated.segments }),
      );
      const persisted = await options.persistArtifact(context, descriptor, {
        ...validated,
        artifactDigest,
      });
      if (
        !persisted
        || typeof persisted.artifactKey !== "string"
        || persisted.artifactKey.length === 0
        || persisted.artifactKey.length > 512
        || /[\u0000-\u001F\u007F]/u.test(persisted.artifactKey)
      ) throw unavailable("Transcript artifact persistence returned an invalid descriptor.");

      options.onEvent?.({ event: "audio.transcribed", attempt, segments: validated.segments.length, outcome: "complete" });
      // Redacted receipt only. No URL, transcript text, header, or secret.
      return {
        artifactKey: persisted.artifactKey,
        model: validated.model,
        segmentCount: validated.segments.length,
        artifactDigest,
        durationMs: descriptor.durationMs,
      };
    },
  };
}

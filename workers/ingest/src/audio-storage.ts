import { createHash } from "node:crypto";
import {
  AUDIO_BUCKET,
  MAX_AUDIO_BYTES,
  episodeAudioKey,
  type AudioObjectDescriptor,
} from "./audio-transport.ts";

const MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const SOURCE_HOSTS = new Set(["feeds.soundcloud.com", "api.soundcloud.com"]);

export type AudioStorageErrorCode =
  | "audio_identity_conflict"
  | "invalid_input"
  | "transient_dependency";

export class AudioStorageError extends Error {
  readonly code: AudioStorageErrorCode;

  constructor(code: AudioStorageErrorCode, message: string) {
    super(message);
    this.name = "AudioStorageError";
    this.code = code;
  }
}

export interface R2StoredObject {
  readonly key?: unknown;
  readonly size?: unknown;
  readonly body?: ReadableStream<Uint8Array>;
  readonly httpMetadata?: { readonly contentType?: unknown };
  readonly customMetadata?: Readonly<Record<string, string>>;
  readonly checksums?: { readonly sha256?: unknown };
}

export interface R2MultipartUpload {
  uploadPart(partNumber: number, value: Uint8Array): Promise<{ readonly partNumber: number; readonly etag: string }>;
  complete(parts: readonly { readonly partNumber: number; readonly etag: string }[]): Promise<R2StoredObject>;
  abort(): Promise<void>;
}

export interface R2AudioWriteBucket {
  head(key: string): Promise<R2StoredObject | null>;
  get(key: string): Promise<R2StoredObject | null>;
  put(key: string, value: ReadableStream<Uint8Array>, options: {
    readonly httpMetadata: { readonly contentType: "audio/mpeg" };
    readonly customMetadata: Readonly<Record<string, string>>;
    readonly sha256: string;
  }): Promise<R2StoredObject | null>;
  delete(key: string): Promise<void>;
  createMultipartUpload(key: string, options: {
    readonly httpMetadata: { readonly contentType: "audio/mpeg" };
  }): Promise<R2MultipartUpload>;
}

export interface AudioSourceResponse {
  readonly body: ReadableStream<Uint8Array>;
  readonly sizeBytes: number | null;
  readonly contentType: string;
  readonly expectedSha256?: `sha256:${string}`;
}

export type OpenAudioSource = (url: string) => Promise<AudioSourceResponse>;

export interface StoreEpisodeAudioInput {
  readonly episodeId: string;
  readonly revisionHash: `sha256:${string}`;
  readonly sourceUrl: string;
  readonly expectedSizeBytes: number | null;
  readonly durationMs: number | null;
}

function invalid(message: string): AudioStorageError {
  return new AudioStorageError("invalid_input", message);
}

function unavailable(message: string): AudioStorageError {
  return new AudioStorageError("transient_dependency", message);
}

function fingerprintConflict(): AudioStorageError {
  return new AudioStorageError("audio_identity_conflict", "Canonical audio conflicts with the immutable source fingerprint.");
}

export function requireSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("Episode audio source URL is invalid.");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
    || !(host.endsWith(".sndcdn.com") || SOURCE_HOSTS.has(host))
  ) throw invalid("Episode audio source URL is not allowlisted.");
  return url.toString();
}

function requireSize(value: number | null, label: string): void {
  if (value === null) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_AUDIO_BYTES) {
    throw invalid(`${label} must be a non-empty MP3 no larger than 250 MiB.`);
  }
}

function hex(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storedChecksum(object: R2StoredObject): string | null {
  const custom = object.customMetadata?.sha256;
  if (typeof custom === "string" && /^sha256:[0-9a-f]{64}$/u.test(custom)) return custom;
  const checksum = object.checksums?.sha256;
  if (checksum instanceof ArrayBuffer || ArrayBuffer.isView(checksum)) return `sha256:${hex(checksum)}`;
  return null;
}

async function hashBody(body: ReadableStream<Uint8Array>, maximum = MAX_AUDIO_BYTES): Promise<{ readonly bytes: number; readonly sha256: `sha256:${string}` }> {
  const reader = body.getReader();
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw unavailable("Audio storage returned an invalid byte stream.");
      bytes += result.value.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > maximum) {
        await reader.cancel();
        throw invalid("Episode audio source exceeds the 250 MiB bound.");
      }
      hash.update(result.value);
    }
  } catch (error) {
    if (error instanceof AudioStorageError) throw error;
    throw unavailable("Episode audio streaming failed.");
  }
  if (bytes < 1) throw invalid("Episode audio source is empty.");
  return { bytes, sha256: `sha256:${hash.digest("hex")}` };
}

async function checksumObject(bucket: R2AudioWriteBucket, object: R2StoredObject): Promise<`sha256:${string}`> {
  const known = storedChecksum(object);
  if (known !== null) return known as `sha256:${string}`;
  if (typeof object.key !== "string") throw unavailable("Audio storage returned invalid object metadata.");
  const fetched = await bucket.get(object.key);
  if (!fetched?.body) throw unavailable("Audio storage could not verify the canonical object.");
  return (await hashBody(fetched.body)).sha256;
}

async function stageSource(
  bucket: R2AudioWriteBucket,
  tempKey: string,
  source: AudioSourceResponse,
): Promise<{ readonly bytes: number; readonly sha256: `sha256:${string}` }> {
  requireSize(source.sizeBytes, "Declared episode audio size");
  if (!/^audio\/(?:mpeg|mp3)(?:\s*;|$)/iu.test(source.contentType)) throw invalid("Episode audio source is not an MP3.");
  const upload = await bucket.createMultipartUpload(tempKey, { httpMetadata: { contentType: "audio/mpeg" } });
  const reader = source.body.getReader();
  const hash = createHash("sha256");
  const parts: { partNumber: number; etag: string }[] = [];
  let pending = new Uint8Array(MULTIPART_PART_BYTES);
  let pendingBytes = 0;
  let total = 0;
  try {
    const flush = async () => {
      if (pendingBytes === 0) return;
      const value = pendingBytes === pending.byteLength ? pending : pending.slice(0, pendingBytes);
      parts.push(await upload.uploadPart(parts.length + 1, value));
      pending = new Uint8Array(MULTIPART_PART_BYTES);
      pendingBytes = 0;
    };
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw unavailable("Episode audio source returned an invalid byte stream.");
      total += result.value.byteLength;
      if (!Number.isSafeInteger(total) || total > MAX_AUDIO_BYTES) {
        await reader.cancel();
        throw invalid("Episode audio source exceeds the 250 MiB bound.");
      }
      hash.update(result.value);
      let offset = 0;
      while (offset < result.value.byteLength) {
        const length = Math.min(pending.byteLength - pendingBytes, result.value.byteLength - offset);
        pending.set(result.value.subarray(offset, offset + length), pendingBytes);
        pendingBytes += length;
        offset += length;
        if (pendingBytes === pending.byteLength) await flush();
      }
    }
    if (total < 1) throw invalid("Episode audio source is empty.");
    if (source.sizeBytes !== null && source.sizeBytes !== total) throw invalid("Episode audio source length changed during streaming.");
    const sha256 = `sha256:${hash.digest("hex")}` as const;
    if (source.expectedSha256 !== undefined && source.expectedSha256 !== sha256) throw invalid("Episode audio source checksum does not match the approved fixture.");
    await flush();
    await upload.complete(parts);
    return { bytes: total, sha256 };
  } catch (error) {
    await upload.abort().catch(() => undefined);
    if (error instanceof AudioStorageError) throw error;
    throw unavailable("Episode audio streaming failed.");
  }
}

/** Fetches and hashes the source incrementally, then reconciles one immutable canonical R2 object. */
export async function storeEpisodeAudio(input: StoreEpisodeAudioInput, options: {
  readonly bucket: R2AudioWriteBucket;
  readonly openSource: OpenAudioSource;
  readonly validateSourceUrl?: (url: string) => string;
  readonly afterCanonicalPut?: () => Promise<void>;
}): Promise<AudioObjectDescriptor> {
  const sourceUrl = (options.validateSourceUrl ?? requireSourceUrl)(input.sourceUrl);
  requireSize(input.expectedSizeBytes, "Expected episode audio size");
  if (!/^sha256:[0-9a-f]{64}$/u.test(input.revisionHash)) throw invalid("Episode processing revision is invalid.");
  const key = episodeAudioKey(input.episodeId);
  const tempKey = `processing/audio/${input.episodeId}/${input.revisionHash.slice(7)}.mp3`;
  const staged = await stageSource(options.bucket, tempKey, await options.openSource(sourceUrl));
  if (input.expectedSizeBytes !== null && input.expectedSizeBytes !== staged.bytes) {
    await options.bucket.delete(tempKey).catch(() => undefined);
    throw invalid("Episode audio size does not match the immutable source descriptor.");
  }

  try {
    const existing = await options.bucket.head(key);
    if (existing !== null) {
      if (existing.key !== key || existing.size !== staged.bytes || await checksumObject(options.bucket, existing) !== staged.sha256) {
        throw fingerprintConflict();
      }
    } else {
      const temporary = await options.bucket.get(tempKey);
      if (!temporary?.body) throw unavailable("Staged episode audio could not be reopened.");
      await options.bucket.put(key, temporary.body, {
        httpMetadata: { contentType: "audio/mpeg" },
        customMetadata: { sha256: staged.sha256, episodeId: input.episodeId },
        sha256: staged.sha256.slice(7),
      });
      await options.afterCanonicalPut?.();
      const stored = await options.bucket.head(key);
      if (stored === null || stored.key !== key || stored.size !== staged.bytes || await checksumObject(options.bucket, stored) !== staged.sha256) {
        throw unavailable("Canonical episode audio verification failed.");
      }
    }
    return {
      bucket: AUDIO_BUCKET,
      key,
      sizeBytes: staged.bytes,
      sha256: staged.sha256,
      durationMs: input.durationMs,
      episodeId: input.episodeId,
    };
  } finally {
    await options.bucket.delete(tempKey).catch(() => undefined);
  }
}

export function createSoundCloudAudioSource(fetcher: typeof fetch): OpenAudioSource {
  return async (url) => {
    const requestUrl = requireSourceUrl(url);
    let response: Response;
    try {
      response = await fetcher(requestUrl, { redirect: "follow" });
    } catch {
      throw unavailable("Episode audio source is temporarily unavailable.");
    }
    if (!response.ok || !response.body) throw unavailable(`Episode audio source returned status ${response.status}.`);
    const length = response.headers.get("content-length");
    const sizeBytes = length !== null && /^\d+$/u.test(length) ? Number(length) : null;
    requireSize(sizeBytes, "Declared episode audio size");
    return {
      body: response.body,
      sizeBytes,
      contentType: response.headers.get("content-type")?.trim() ?? "",
    };
  };
}

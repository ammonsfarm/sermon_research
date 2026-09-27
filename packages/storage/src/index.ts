import {
  episodeAudioObjectKey,
  ServiceError,
  type AudioObjectReader,
  type BackgroundOperationContext,
  type ByteRangeRequest,
  type ObjectKey,
  type ObjectMetadata,
  type ObjectReadResult,
  type RequestOperationContext,
  resolveByteRange,
  type EpisodeId,
} from "@aic/contracts";

/**
 * Minimal structural types for the R2 Workers binding. These intentionally do
 * not import or expose @cloudflare/workers-types.
 */
export interface R2BucketBinding {
  head(key: string): Promise<R2ObjectBinding | null>;
  get(key: string, options?: R2GetOptionsBinding): Promise<R2ObjectBinding | null>;
}

export interface R2GetOptionsBinding {
  readonly range?: {
    readonly offset?: number;
    readonly length?: number;
    readonly suffix?: number;
  };
}

export interface R2ObjectBinding {
  readonly key?: unknown;
  readonly size?: unknown;
  readonly etag?: unknown;
  readonly httpEtag?: unknown;
  readonly uploaded?: unknown;
  readonly httpMetadata?: {
    readonly contentType?: unknown;
  };
  readonly body?: ReadableStream<Uint8Array>;
}

type OperationContext = RequestOperationContext | BackgroundOperationContext;

const AUDIO_CONTENT_TYPE = "audio/mpeg";
const AUDIO_READ_MESSAGE = "Audio storage is temporarily unavailable.";
const AUDIO_INTEGRITY_MESSAGE = "Audio storage returned invalid object metadata.";
const INVALID_RANGE_MESSAGE = "Audio byte range request is malformed.";

function dependencyError(cause?: unknown): ServiceError {
  return new ServiceError({
    code: "dependency_unavailable",
    message: AUDIO_READ_MESSAGE,
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

function integrityError(cause?: unknown): ServiceError {
  return new ServiceError({
    code: "dependency_unavailable",
    message: AUDIO_INTEGRITY_MESSAGE,
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

function cancelledError(cause?: unknown): ServiceError {
  return new ServiceError({
    code: "cancelled",
    message: "The audio request was cancelled.",
    ...(cause === undefined ? {} : { cause }),
  });
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelledError(signal.reason);
}

function invalidRangeError(): ServiceError {
  return new ServiceError({
    code: "invalid_argument",
    message: INVALID_RANGE_MESSAGE,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validates the runtime shape before the request can reach resolveByteRange/R2. */
function validateByteRangeRequest(value: unknown): asserts value is ByteRangeRequest {
  if (!isRecord(value) || typeof value.kind !== "string") throw invalidRangeError();

  switch (value.kind) {
    case "closed":
    {
      const start = value.start;
      const endInclusive = value.endInclusive;
      if (
        !hasExactlyKeys(value, ["kind", "start", "endInclusive"])
        || !isSafeNonNegativeInteger(start)
        || !isSafeNonNegativeInteger(endInclusive)
        || endInclusive < start
      ) {
        throw invalidRangeError();
      }
      return;
    }
    case "open":
    {
      const start = value.start;
      if (
        !hasExactlyKeys(value, ["kind", "start"])
        || !isSafeNonNegativeInteger(start)
      ) {
        throw invalidRangeError();
      }
      return;
    }
    case "suffix":
    {
      const length = value.length;
      if (
        !hasExactlyKeys(value, ["kind", "length"])
        || !isSafeNonNegativeInteger(length)
        || length <= 0
      ) {
        throw invalidRangeError();
      }
      return;
    }
    default:
      throw invalidRangeError();
  }
}

function safeUploadedAt(value: unknown): ObjectMetadata["uploadedAt"] | undefined {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined;
  // AIC's provider-neutral timestamp contract requires six fractional digits.
  const iso = value.toISOString().replace(/(\.\d{3})Z$/u, "$1000Z");
  return iso as ObjectMetadata["uploadedAt"];
}

function validateAndMapMetadata(
  object: R2ObjectBinding,
  expectedKey: ObjectKey,
  expectedSize?: number,
): ObjectMetadata {
  if (typeof object.key !== "string" || object.key !== expectedKey) {
    throw integrityError();
  }
  if (
    typeof object.size !== "number"
    || !Number.isSafeInteger(object.size)
    || object.size < 0
    || (expectedSize !== undefined && object.size !== expectedSize)
  ) {
    throw integrityError();
  }
  if (
    typeof object.httpMetadata?.contentType !== "string"
    || object.httpMetadata.contentType !== AUDIO_CONTENT_TYPE
  ) {
    throw integrityError();
  }

  const etag = typeof object.httpEtag === "string"
    ? object.httpEtag
    : typeof object.etag === "string"
      ? object.etag
      : undefined;
  const uploadedAt = safeUploadedAt(object.uploaded);
  return {
    key: expectedKey,
    size: object.size,
    contentType: AUDIO_CONTENT_TYPE,
    ...(etag === undefined ? {} : { etag }),
    ...(uploadedAt === undefined ? {} : { uploadedAt }),
  };
}

function requireBody(object: R2ObjectBinding): ReadableStream<Uint8Array> {
  if (!(object.body instanceof ReadableStream)) throw integrityError();
  return object.body;
}

/**
 * Wraps provider body reads so cancellation and provider failures remain
 * service-level errors even after the repository method has returned.
 */
function cancellableBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  expectedBytes: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let cleanedUp = false;
  let bytesRead = 0;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    signal.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        cleanup();
        controller.error(cancelledError(signal.reason));
        return;
      }
      try {
        const result = await reader.read();
        if (signal.aborted) {
          cleanup();
          controller.error(cancelledError(signal.reason));
          return;
        }
        if (result.done) {
          cleanup();
          if (bytesRead !== expectedBytes) {
            controller.error(integrityError());
          } else {
            controller.close();
          }
          return;
        }
        if (!(result.value instanceof Uint8Array)) {
          cleanup();
          void reader.cancel().catch(() => undefined);
          controller.error(integrityError());
          return;
        }
        const nextBytes = bytesRead + result.value.byteLength;
        if (!Number.isSafeInteger(nextBytes) || nextBytes > expectedBytes) {
          cleanup();
          void reader.cancel().catch(() => undefined);
          controller.error(integrityError());
          return;
        }
        bytesRead = nextBytes;
        controller.enqueue(result.value);
      } catch (error) {
        cleanup();
        controller.error(signal.aborted ? cancelledError(signal.reason) : dependencyError(error));
      }
    },
    async cancel(reason) {
      cleanup();
      try {
        await reader.cancel(reason);
      } catch (error) {
        throw dependencyError(error);
      }
    },
  });
}

function contextSignal(context: OperationContext): AbortSignal {
  return context.signal;
}

export class R2AudioObjectReader implements AudioObjectReader {
  readonly #bucket: R2BucketBinding;

  constructor(bucket: R2BucketBinding) {
    this.#bucket = bucket;
  }

  keyForEpisode(id: EpisodeId): ObjectKey {
    return episodeAudioObjectKey(id);
  }

  async headAudio(context: OperationContext, id: EpisodeId): Promise<ObjectMetadata | null> {
    const signal = contextSignal(context);
    checkCancelled(signal);
    const key = this.keyForEpisode(id);
    let object: R2ObjectBinding | null;
    try {
      object = await this.#bucket.head(key);
    } catch (error) {
      if (signal.aborted) throw cancelledError(signal.reason);
      throw dependencyError(error);
    }
    checkCancelled(signal);
    if (object === null) return null;
    return validateAndMapMetadata(object, key);
  }

  async readAudio(
    context: OperationContext,
    id: EpisodeId,
    range?: ByteRangeRequest,
  ): Promise<ObjectReadResult> {
    const signal = contextSignal(context);
    checkCancelled(signal);
    if (range !== undefined) validateByteRangeRequest(range);
    const key = this.keyForEpisode(id);

    let headObject: R2ObjectBinding | null;
    try {
      headObject = await this.#bucket.head(key);
    } catch (error) {
      if (signal.aborted) throw cancelledError(signal.reason);
      throw dependencyError(error);
    }
    checkCancelled(signal);
    if (headObject === null) return { kind: "not_found" };

    const metadata = validateAndMapMetadata(headObject, key);
    if (range === undefined) {
      let object: R2ObjectBinding | null;
      try {
        object = await this.#bucket.get(key);
      } catch (error) {
        if (signal.aborted) throw cancelledError(signal.reason);
        throw dependencyError(error);
      }
      checkCancelled(signal);
      if (object === null) return { kind: "not_found" };
      const readMetadata = validateAndMapMetadata(object, key, metadata.size);
      return {
        kind: "found",
        metadata: readMetadata,
        status: 200,
        body: cancellableBody(requireBody(object), signal, metadata.size),
      };
    }

    const resolution = resolveByteRange(range, metadata.size);
    if (resolution.kind !== "satisfied") {
      return { kind: "range_not_satisfiable", size: metadata.size };
    }

    const resolved = resolution.range;
    let object: R2ObjectBinding | null;
    try {
      object = await this.#bucket.get(key, {
        range: { offset: resolved.start, length: resolved.length },
      });
    } catch (error) {
      if (signal.aborted) throw cancelledError(signal.reason);
      throw dependencyError(error);
    }
    checkCancelled(signal);
    if (object === null) return { kind: "not_found" };
    const readMetadata = validateAndMapMetadata(object, key, metadata.size);
    return {
      kind: "found",
      metadata: readMetadata,
      status: 206,
      range: resolved,
      body: cancellableBody(requireBody(object), signal, resolved.length),
    };
  }
}

export function createR2AudioObjectReader(bucket: R2BucketBinding): AudioObjectReader {
  return new R2AudioObjectReader(bucket);
}

export { episodeAudioObjectKey };

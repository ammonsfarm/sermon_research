import type {
  BackgroundOperationContext,
  RequestOperationContext,
} from "./execution.ts";
import type {
  ContentHash,
  EpisodeId,
  IsoDateTime,
  ObjectKey,
  UploadSessionId,
  UserId,
} from "./ids.ts";

export type ByteRangeRequest =
  | { readonly kind: "closed"; readonly start: number; readonly endInclusive: number }
  | { readonly kind: "open"; readonly start: number }
  | { readonly kind: "suffix"; readonly length: number };

export interface ResolvedByteRange {
  readonly start: number;
  readonly endInclusive: number;
  readonly length: number;
}

export type ByteRangeResolution =
  | { readonly kind: "satisfied"; readonly range: ResolvedByteRange }
  | { readonly kind: "unsatisfiable" };

export type ParsedRangeHeader =
  | { readonly kind: "none" }
  | { readonly kind: "valid"; readonly range: ByteRangeRequest }
  | { readonly kind: "invalid" };

/** Parses one RFC 9110 bytes range. Multiple ranges are intentionally rejected. */
export function parseRangeHeader(value: string | null): ParsedRangeHeader {
  if (value === null) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return { kind: "invalid" };

  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") return { kind: "invalid" };

  if (startText === "") {
    const length = Number(endText);
    return Number.isSafeInteger(length) && length > 0
      ? { kind: "valid", range: { kind: "suffix", length } }
      : { kind: "invalid" };
  }

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0) return { kind: "invalid" };
  if (endText === "") return { kind: "valid", range: { kind: "open", start } };

  const endInclusive = Number(endText);
  if (
    !Number.isSafeInteger(endInclusive) ||
    endInclusive < 0 ||
    endInclusive < start
  ) {
    return { kind: "invalid" };
  }
  return { kind: "valid", range: { kind: "closed", start, endInclusive } };
}

export function resolveByteRange(
  request: ByteRangeRequest,
  size: number,
): ByteRangeResolution {
  if (!Number.isSafeInteger(size) || size < 0 || size === 0) {
    return { kind: "unsatisfiable" };
  }

  let start: number;
  let endInclusive: number;
  switch (request.kind) {
    case "closed":
      start = request.start;
      endInclusive = Math.min(request.endInclusive, size - 1);
      break;
    case "open":
      start = request.start;
      endInclusive = size - 1;
      break;
    case "suffix":
      if (request.length <= 0) return { kind: "unsatisfiable" };
      start = Math.max(0, size - request.length);
      endInclusive = size - 1;
      break;
  }

  if (start < 0 || start >= size || endInclusive < start) {
    return { kind: "unsatisfiable" };
  }

  return {
    kind: "satisfied",
    range: { start, endInclusive, length: endInclusive - start + 1 },
  };
}

export interface ObjectMetadata {
  readonly key: ObjectKey;
  readonly size: number;
  readonly contentType: string;
  readonly etag?: string;
  readonly uploadedAt?: IsoDateTime;
  readonly checksum?: {
    readonly algorithm: "sha256";
    readonly value: ContentHash;
  };
}

export interface ObjectReadRequest {
  readonly key: ObjectKey;
  readonly range?: ByteRangeRequest;
  readonly ifMatch?: string;
  readonly ifNoneMatch?: string;
}

export type ObjectReadResult =
  | {
      readonly kind: "found";
      readonly metadata: ObjectMetadata;
      readonly status: 200;
      readonly body: ReadableStream<Uint8Array>;
    }
  | {
      readonly kind: "found";
      readonly metadata: ObjectMetadata;
      readonly status: 206;
      readonly range: ResolvedByteRange;
      readonly body: ReadableStream<Uint8Array>;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_modified"; readonly metadata: ObjectMetadata }
  | {
      readonly kind: "range_not_satisfiable";
      readonly size: number;
    };

export interface ObjectReader {
  head(
    context: RequestOperationContext | BackgroundOperationContext,
    key: ObjectKey,
  ): Promise<ObjectMetadata | null>;
  read(
    context: RequestOperationContext | BackgroundOperationContext,
    request: ObjectReadRequest,
  ): Promise<ObjectReadResult>;
}

export interface AudioObjectReader {
  keyForEpisode(id: EpisodeId): ObjectKey;
  headAudio(
    context: RequestOperationContext | BackgroundOperationContext,
    id: EpisodeId,
  ): Promise<ObjectMetadata | null>;
  readAudio(
    context: RequestOperationContext | BackgroundOperationContext,
    id: EpisodeId,
    range?: ByteRangeRequest,
  ): Promise<ObjectReadResult>;
}

export interface ObjectWriteRequest {
  readonly key: ObjectKey;
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly contentType: string;
  readonly checksum: {
    readonly algorithm: "sha256";
    readonly value: ContentHash;
  };
  readonly ifAbsent?: boolean;
}

/** Durable ingestion/migration writes are background-only. */
export interface ObjectWriter {
  put(
    context: BackgroundOperationContext,
    request: ObjectWriteRequest,
  ): Promise<ObjectMetadata>;
  delete(context: BackgroundOperationContext, key: ObjectKey): Promise<void>;
}

export type UploadPurpose = "episode_audio" | "cms_image" | "cms_attachment";

export interface DirectUploadIntent {
  readonly actorId: UserId;
  readonly purpose: UploadPurpose;
  readonly filename: string;
  readonly size: number;
  readonly contentType: string;
  readonly checksum: {
    readonly algorithm: "sha256";
    readonly value: ContentHash;
  };
}

/** A presigned URL is a bearer credential and must never be logged. */
export type SensitiveUploadUrl = string & { readonly __sensitiveUploadUrl: unique symbol };

export interface DirectUploadRequest {
  readonly method: "PUT";
  readonly url: SensitiveUploadUrl;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: IsoDateTime;
}

export type DirectUploadSession =
  | {
      readonly strategy: "single_put";
      readonly sessionId: UploadSessionId;
      readonly objectKey: ObjectKey;
      readonly upload: DirectUploadRequest;
    }
  | {
      readonly strategy: "multipart";
      readonly sessionId: UploadSessionId;
      readonly objectKey: ObjectKey;
      readonly partSize: number;
      readonly partCount: number;
      readonly expiresAt: IsoDateTime;
    };

export interface UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface DirectUploadCoordinator {
  initiate(
    context: RequestOperationContext,
    intent: DirectUploadIntent,
  ): Promise<DirectUploadSession>;
  authorizePart(
    context: RequestOperationContext,
    input: {
      readonly sessionId: UploadSessionId;
      readonly partNumber: number;
      readonly size: number;
    },
  ): Promise<DirectUploadRequest>;
  complete(
    context: RequestOperationContext,
    input: {
      readonly sessionId: UploadSessionId;
      readonly parts: readonly UploadedPart[];
    },
  ): Promise<{
    readonly objectKey: ObjectKey;
    readonly verification: "pending";
  }>;
  abort(
    context: RequestOperationContext | BackgroundOperationContext,
    sessionId: UploadSessionId,
  ): Promise<void>;
}

export interface ObjectStorage {
  readonly objects: ObjectReader;
  readonly audio: AudioObjectReader;
  readonly writer: ObjectWriter;
  readonly directUploads: DirectUploadCoordinator;
}

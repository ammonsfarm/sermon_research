import { ServiceError } from "./errors.ts";

declare const brand: unique symbol;
export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type ArticleId = Brand<string, "ArticleId">;
export type BackgroundJobId = Brand<string, "BackgroundJobId">;
export type ContentHash = Brand<string, "ContentHash">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type EditorialDocumentId = Brand<string, "EditorialDocumentId">;
export type EpisodeId = Brand<string, "EpisodeId">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
export type IsoDate = Brand<string, "IsoDate">;
export type IsoDateTime = Brand<string, "IsoDateTime">;
export type ObjectKey = Brand<string, "ObjectKey">;
export type OperationKey = Brand<string, "OperationKey">;
export type OpaqueCursor = Brand<string, "OpaqueCursor">;
export type RequestId = Brand<string, "RequestId">;
export type RevisionToken = Brand<string, "RevisionToken">;
export type SessionId = Brand<string, "SessionId">;
export type TraceId = Brand<string, "TraceId">;
export type UploadSessionId = Brand<string, "UploadSessionId">;
export type UserId = Brand<string, "UserId">;
export type VectorId = Brand<string, "VectorId">;

export const EPISODE_ID_PATTERN = /^(?:\d+|sa_\d+|wp-sermon:\d+|cms_[A-Za-z0-9_-]+)$/;

function requireNonEmpty<Name extends string>(value: string, name: Name): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ServiceError({
      code: "invalid_argument",
      message: `${name} must not be empty.`,
    });
  }
  return normalized;
}

export function episodeId(value: string): EpisodeId {
  const normalized = requireNonEmpty(value, "episodeId");
  if (!EPISODE_ID_PATTERN.test(normalized)) {
    throw new ServiceError({
      code: "invalid_argument",
      message: "episodeId has an unsupported stable track ID form.",
    });
  }
  return normalized as EpisodeId;
}

export function articleId(value: string): ArticleId {
  return requireNonEmpty(value, "articleId") as ArticleId;
}

export function vectorId(value: string): VectorId {
  return requireNonEmpty(value, "vectorId") as VectorId;
}

export function objectKey(value: string): ObjectKey {
  const normalized = requireNonEmpty(value, "objectKey");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    /[\u0000-\u001F\u007F]/.test(normalized) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ServiceError({
      code: "invalid_argument",
      message: "objectKey must be a normalized relative object key.",
    });
  }
  return normalized as ObjectKey;
}

export function correlationId(value: string): CorrelationId {
  return requireNonEmpty(value, "correlationId") as CorrelationId;
}

export function idempotencyKey(value: string): IdempotencyKey {
  return requireNonEmpty(value, "idempotencyKey") as IdempotencyKey;
}

export type StableIdSource =
  | "postgresql"
  | "strapi"
  | "soundcloud"
  | "sermonaudio"
  | "clerk"
  | "migration";

export interface StableExternalReference {
  readonly source: StableIdSource;
  /** Exact source value. It must not be renumbered by a destination adapter. */
  readonly value: string;
}

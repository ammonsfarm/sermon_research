import { ServiceError } from "./errors.ts";
import type { RevisionToken } from "./ids.ts";

export const REPOSITORY_REVISION_TOKEN_VERSION = 1 as const;
export const MAX_REPOSITORY_REVISION_TOKEN_LENGTH = 2_048 as const;
export const REPOSITORY_REVISION_KINDS = [
  "article",
  "episode",
  "page",
  "site-settings",
  "user-access",
] as const;

export type RepositoryRevisionKind = (typeof REPOSITORY_REVISION_KINDS)[number];

export interface RepositoryRevision {
  readonly v: typeof REPOSITORY_REVISION_TOKEN_VERSION;
  readonly kind: RepositoryRevisionKind;
  readonly documentId: string;
  readonly updatedAt: string;
}

const REVISION_KINDS = new Set<string>(REPOSITORY_REVISION_KINDS);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;
const CANONICAL_UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/u;

function invalidRevisionToken(cause?: unknown): ServiceError {
  return new ServiceError({
    code: "invalid_argument",
    message: "Repository revision token is malformed.",
    ...(cause === undefined ? {} : { cause }),
  });
}

function requirePart(value: string): string {
  if (value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidRevisionToken();
  }
  return value;
}

function requireCanonicalTimestamp(value: string): string {
  requirePart(value);
  const match = CANONICAL_UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) throw invalidRevisionToken();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > (daysByMonth[month - 1] ?? 0)
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    throw invalidRevisionToken();
  }
  return value;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const paddingLength = (4 - (standard.length % 4)) % 4;
  const binary = atob(`${standard}${"=".repeat(paddingLength)}`);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Encodes the one canonical, provider-neutral p4-v1 repository revision shape. */
export function encodeRepositoryRevision(
  input: Omit<RepositoryRevision, "v">,
): RevisionToken {
  if (!REVISION_KINDS.has(input.kind)) throw invalidRevisionToken();
  const documentId = requirePart(input.documentId);
  const updatedAt = requireCanonicalTimestamp(input.updatedAt);
  const json = JSON.stringify({
    v: REPOSITORY_REVISION_TOKEN_VERSION,
    kind: input.kind,
    documentId,
    updatedAt,
  });
  const token = toBase64Url(new TextEncoder().encode(json));
  if (token.length > MAX_REPOSITORY_REVISION_TOKEN_LENGTH) throw invalidRevisionToken();
  return token as RevisionToken;
}

/** Decodes only canonical tokens produced by encodeRepositoryRevision. */
export function decodeRepositoryRevision(token: RevisionToken): RepositoryRevision {
  const value = String(token);
  if (
    value.length === 0
    || value.length > MAX_REPOSITORY_REVISION_TOKEN_LENGTH
    || !TOKEN_PATTERN.test(value)
  ) {
    throw invalidRevisionToken();
  }

  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(value)),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw invalidRevisionToken();
    }
    const candidate = parsed as Partial<Record<keyof RepositoryRevision, unknown>>;
    if (
      Object.keys(parsed).join(",") !== "v,kind,documentId,updatedAt"
      || candidate.v !== REPOSITORY_REVISION_TOKEN_VERSION
      || typeof candidate.kind !== "string"
      || !REVISION_KINDS.has(candidate.kind)
      || typeof candidate.documentId !== "string"
      || typeof candidate.updatedAt !== "string"
    ) {
      throw invalidRevisionToken();
    }
    const result: RepositoryRevision = {
      v: REPOSITORY_REVISION_TOKEN_VERSION,
      kind: candidate.kind as RepositoryRevisionKind,
      documentId: requirePart(candidate.documentId),
      updatedAt: requireCanonicalTimestamp(candidate.updatedAt),
    };
    if (encodeRepositoryRevision(result) !== value) throw invalidRevisionToken();
    return result;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw invalidRevisionToken(error);
  }
}

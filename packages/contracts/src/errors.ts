import type { CorrelationId } from "./ids.ts";

export const SERVICE_ERROR_CODES = [
  "invalid_argument",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "precondition_failed",
  "range_not_satisfiable",
  "rate_limited",
  "dependency_unavailable",
  "timeout",
  "cancelled",
  "internal",
] as const;

export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

export const ERROR_HTTP_STATUS = {
  invalid_argument: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  range_not_satisfiable: 416,
  rate_limited: 429,
  dependency_unavailable: 503,
  timeout: 504,
  cancelled: 408,
  internal: 500,
} as const satisfies Readonly<Record<ServiceErrorCode, number>>;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type SafeErrorDetails = Readonly<Record<string, JsonValue>>;

export interface ServiceErrorOptions {
  readonly code: ServiceErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly safeDetails?: SafeErrorDetails;
  readonly cause?: unknown;
}

/**
 * Adapter implementations translate provider failures into this error at their
 * boundary. `cause` is for server-side reporting only and never belongs in an
 * HTTP response, log field, or persisted request record.
 */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly retryable: boolean;
  readonly safeDetails: SafeErrorDetails | undefined;

  constructor(options: ServiceErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "ServiceError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.safeDetails = options.safeDetails;
  }
}

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ServiceErrorCode;
    readonly message: string;
    readonly correlationId: CorrelationId;
    readonly retryable: boolean;
    readonly details?: SafeErrorDetails;
  };
}

const INTERNAL_MESSAGE = "The request could not be completed.";

export function isServiceError(error: unknown): error is ServiceError {
  return error instanceof ServiceError;
}

/** Produces the only error shape that may cross an HTTP/service boundary. */
export function toErrorEnvelope(
  error: unknown,
  correlationId: CorrelationId,
): ErrorEnvelope {
  if (!isServiceError(error)) {
    return {
      error: {
        code: "internal",
        message: INTERNAL_MESSAGE,
        correlationId,
        retryable: false,
      },
    };
  }

  return {
    error: {
      code: error.code,
      message: error.message,
      correlationId,
      retryable: error.retryable,
      ...(error.safeDetails === undefined ? {} : { details: error.safeDetails }),
    },
  };
}

export function httpStatusForError(error: unknown): number {
  return isServiceError(error) ? ERROR_HTTP_STATUS[error.code] : 500;
}

import type { ErrorEnvelope, JsonValue, ServiceErrorCode } from "./errors.ts";
import type { CorrelationContext, OperationContext } from "./execution.ts";
import type { RequestId, TraceId } from "./ids.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type SafeLogFields = Readonly<Record<string, JsonValue>>;

export interface LogRecord {
  readonly level: LogLevel;
  readonly event: string;
  readonly message?: string;
  readonly fields?: SafeLogFields;
}

export interface StructuredLogger {
  write(context: OperationContext, record: LogRecord): void;
}

export interface ErrorReporter {
  capture(
    context: OperationContext,
    error: unknown,
    fields?: SafeLogFields,
  ): Promise<void>;
}

export interface ErrorResponseFactory {
  fromUnknown(context: OperationContext, error: unknown): ErrorEnvelope;
}

export interface CorrelationFactory {
  create(input: {
    /** Accept only after format/length validation; otherwise generate a new value. */
    readonly incomingCorrelationId?: string;
    readonly requestId?: RequestId;
    readonly traceId?: TraceId;
  }): CorrelationContext;
}

export interface DependencyHealth {
  readonly status: "ok" | "degraded" | "unavailable";
  readonly checkedAt: string;
  readonly errorCode?: ServiceErrorCode;
}

export interface HealthVersionReport {
  readonly status: "ok" | "degraded";
  readonly version: string;
  readonly commit: string;
  readonly environment: string;
  readonly dependencies?: Readonly<Record<string, DependencyHealth>>;
}

export const FORBIDDEN_LOG_FIELD_PATTERNS = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "secret",
  "token",
  "api_key",
  "signed_url",
  "upload_url",
  "request_body",
  "response_body",
] as const;

export interface ObservabilityServices {
  readonly correlations: CorrelationFactory;
  readonly logger: StructuredLogger;
  readonly errors: ErrorReporter;
  readonly errorResponses: ErrorResponseFactory;
}

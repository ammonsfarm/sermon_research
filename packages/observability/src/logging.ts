import type {
  JsonValue,
  LogLevel,
  LogRecord,
  OperationContext,
  SafeLogFields,
  StructuredLogger,
} from "@aic/contracts";
import { FORBIDDEN_LOG_FIELD_PATTERNS } from "@aic/contracts";

const forbiddenKeys = new RegExp(
  `(?:${FORBIDDEN_LOG_FIELD_PATTERNS.map((pattern) => pattern.replaceAll("_", "[-_]?")).join("|")})`,
  "i",
);
const forbiddenBodyKeys = /(?:body|payload)/i;
const MAX_DEPTH = 5;
const MAX_FIELDS = 64;
const MAX_STRING_LENGTH = 512;

export interface SafeLogEntry {
  readonly level: LogLevel;
  readonly event: string;
  readonly message?: string;
  readonly fields: SafeLogFields;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly traceId?: string;
}

export type LogSink = (entry: SafeLogEntry) => void;

function sanitize(value: unknown, depth: number): JsonValue | undefined {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[non-finite-number]";
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_FIELDS).flatMap((item) => {
      const safe = sanitize(item, depth + 1);
      return safe === undefined ? [] : [safe];
    });
  }
  if (typeof value !== "object") return undefined;

  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_FIELDS)) {
    if (forbiddenKeys.test(key) || forbiddenBodyKeys.test(key)) continue;
    const safe = sanitize(item, depth + 1);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

/** Drops forbidden fields and bounds arbitrary values before they reach a log sink. */
export function safeLogFields(fields: Readonly<Record<string, unknown>> = {}): SafeLogFields {
  return sanitize(fields, 0) as SafeLogFields;
}

export function createStructuredLogger(sink: LogSink): StructuredLogger {
  return {
    write(context, record) {
      const fields = safeLogFields({
        ...(record.fields ?? {}),
      });
      sink({
        level: record.level,
        event: record.event,
        ...(record.message === undefined ? {} : { message: record.message.slice(0, MAX_STRING_LENGTH) }),
        fields,
        correlationId: context.correlation.correlationId,
        ...(context.correlation.requestId === undefined ? {} : { requestId: context.correlation.requestId }),
        ...(context.correlation.traceId === undefined ? {} : { traceId: context.correlation.traceId }),
      });
    },
  };
}

/** Standard-console sink; the package does not select or configure a logging vendor. */
export function createConsoleLogger(): StructuredLogger {
  return createStructuredLogger((entry) => {
    console[entry.level](JSON.stringify(entry));
  });
}

import { ServiceError } from "../../../packages/contracts/src/errors.ts";
import type { OperationContext } from "../../../packages/contracts/src/execution.ts";

export type RagClock = () => Date | number | string;

const REQUEST_TIMEOUT_MS = 55_000;
const UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u;

function invalid(message: string): never {
  throw new ServiceError({ code: "invalid_argument", message });
}

function cancelled(): never {
  throw new ServiceError({ code: "cancelled", message: "The RAG request was cancelled." });
}

function timedOut(): never {
  throw new ServiceError({ code: "timeout", message: "The RAG request timed out.", retryable: true });
}

function isSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null
    && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function";
}

function parseUtc(value: unknown, label: string): number {
  if (typeof value !== "string" || !UTC.test(value)) invalid(`${label} is invalid.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid(`${label} is invalid.`);
  const match = UTC.exec(value)!;
  const date = new Date(parsed);
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2])
    || date.getUTCDate() !== Number(match[3]) || date.getUTCHours() !== Number(match[4])
    || date.getUTCMinutes() !== Number(match[5]) || date.getUTCSeconds() !== Number(match[6])) {
    invalid(`${label} is invalid.`);
  }
  return parsed;
}

export function clockMilliseconds(clock: RagClock): number {
  if (typeof clock !== "function") invalid("RAG clock is invalid.");
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime()
    : typeof value === "number" ? value
      : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds)) invalid("RAG clock returned an invalid time.");
  return milliseconds;
}

function validateContext(context: OperationContext): void {
  if (!context || typeof context !== "object" || !isSignal(context.signal)) invalid("RAG operation context is invalid.");
  if (context.signal.aborted) cancelled();
}

export function createRequestContext<T extends OperationContext>(context: T, clock: RagClock): T & { readonly deadline: string } {
  validateContext(context);
  const now = clockMilliseconds(clock);
  const parent = context.deadline === undefined ? Number.POSITIVE_INFINITY : parseUtc(context.deadline, "Operation deadline");
  const deadline = Math.min(parent, now + REQUEST_TIMEOUT_MS);
  if (deadline <= now) timedOut();
  return { ...context, deadline: new Date(deadline).toISOString() };
}

export function remainingMilliseconds(context: OperationContext, clock: RagClock): number {
  validateContext(context);
  if (context.deadline === undefined) return Number.POSITIVE_INFINITY;
  return parseUtc(context.deadline, "Operation deadline") - clockMilliseconds(clock);
}

export function stageContext<T extends OperationContext>(context: T, clock: RagClock, timeoutMs: number): T & { readonly deadline: string } {
  validateContext(context);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) invalid("RAG stage timeout is invalid.");
  const now = clockMilliseconds(clock);
  const parent = context.deadline === undefined ? Number.POSITIVE_INFINITY : parseUtc(context.deadline, "Operation deadline");
  const deadline = Math.min(parent, now + timeoutMs);
  if (deadline <= now) timedOut();
  return { ...context, deadline: new Date(deadline).toISOString() };
}

export function ensureRequestActive(context: OperationContext, clock: RagClock): void {
  validateContext(context);
  if (context.deadline !== undefined && parseUtc(context.deadline, "Operation deadline") <= clockMilliseconds(clock)) timedOut();
}

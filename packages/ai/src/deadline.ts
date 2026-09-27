import { ServiceError } from "../../contracts/src/errors.ts";
import type { OperationContext } from "../../contracts/src/execution.ts";

function invalid(message: string): never {
  throw new ServiceError({ code: "invalid_argument", message });
}

function cancelled(): ServiceError {
  return new ServiceError({ code: "cancelled", message: "The AI operation was cancelled." });
}

function timedOut(): ServiceError {
  return new ServiceError({ code: "timeout", message: "The AI operation timed out.", retryable: true });
}

function malformedResponse(): ServiceError {
  return new ServiceError({ code: "dependency_unavailable", message: "The provider response is invalid.", retryable: false });
}

function unavailableResponse(): ServiceError {
  return new ServiceError({ code: "dependency_unavailable", message: "The provider response is temporarily unavailable.", retryable: true });
}

function utcTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value);
  const parsed = Date.parse(value);
  if (match === null || !Number.isFinite(parsed)) return false;
  const date = new Date(parsed);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3])
    && date.getUTCHours() === Number(match[4])
    && date.getUTCMinutes() === Number(match[5])
    && date.getUTCSeconds() === Number(match[6]);
}

function timeoutFor(context: OperationContext, timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) invalid("AI operation timeout must be a positive integer.");
  if (context.deadline === undefined) return timeoutMs;
  if (!utcTimestamp(context.deadline)) invalid("AI operation deadline is invalid.");
  const deadline = Date.parse(context.deadline);
  return Math.min(timeoutMs, deadline - Date.now());
}

/** Bounds callers even when an underlying fetch or body stream ignores abort. */
export function withDeadline<T>(
  context: OperationContext,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  if (context.signal.aborted) return Promise.reject(cancelled());
  const timeout = timeoutFor(context, timeoutMs);
  if (timeout <= 0) return Promise.reject(timedOut());

  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      controller.abort();
      settle(() => reject(cancelled()));
    };
    const timer = setTimeout(() => {
      controller.abort();
      settle(() => reject(timedOut()));
    }, timeout);
    context.signal.addEventListener("abort", onAbort, { once: true });
    queueMicrotask(() => {
      if (settled) return;
      if (context.signal.aborted) {
        onAbort();
        return;
      }
      try {
        Promise.resolve(operation(controller.signal)).then(
          (value) => settle(() => resolve(value)),
          (error: unknown) => settle(() => reject(error)),
        );
      } catch (error) {
        settle(() => reject(error));
      }
    });
  });
}

export async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) invalid("Response byte limit is invalid.");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body?.getReader();
  } catch {
    throw unavailableResponse();
  }
  if (reader === undefined) return "";
  const cancel = async () => { try { await reader.cancel(); } catch {} };
  const onAbort = () => { void cancel(); };
  if (signal.aborted) {
    await cancel();
    throw cancelled();
  }
  signal.addEventListener("abort", onAbort, { once: true });
  let ownMalformed = false;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        ownMalformed = true;
        throw malformedResponse();
      }
      size += value.byteLength;
      if (size > maximumBytes) {
        ownMalformed = true;
        throw malformedResponse();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch (error) {
    await cancel();
    if (ownMalformed) throw error;
    throw unavailableResponse();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

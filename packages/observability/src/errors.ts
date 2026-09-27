import {
  httpStatusForError,
  toErrorEnvelope,
  type ErrorEnvelope,
  type ErrorResponseFactory,
  type OperationContext,
} from "@aic/contracts";

export function safeErrorEnvelope(context: OperationContext, error: unknown): ErrorEnvelope {
  return toErrorEnvelope(error, context.correlation.correlationId);
}

export const errorResponseFactory: ErrorResponseFactory = {
  fromUnknown: safeErrorEnvelope,
};

export function safeErrorResponse(context: OperationContext, error: unknown): Response {
  return new Response(JSON.stringify(safeErrorEnvelope(context, error)), {
    status: httpStatusForError(error),
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

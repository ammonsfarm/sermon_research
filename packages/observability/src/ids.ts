import type {
  CorrelationContext,
  CorrelationFactory,
  RequestId,
  TraceId,
} from "@aic/contracts";
import type { CorrelationId } from "@aic/contracts";

const MAX_ID_LENGTH = 128;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ID_LENGTH && SAFE_ID.test(value);
}

function generatedId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function correlation(value: string): CorrelationId {
  return value as CorrelationId;
}

export interface CorrelationInput {
  readonly incomingCorrelationId?: string;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
}

/** Validates forwarded IDs and creates distinct IDs when a value is absent or unsafe. */
export function createCorrelationContext(input: CorrelationInput = {}): CorrelationContext {
  return {
    correlationId: correlation(
      validId(input.incomingCorrelationId)
        ? input.incomingCorrelationId
        : generatedId("corr"),
    ),
    requestId: (validId(input.requestId) ? input.requestId : generatedId("req")) as RequestId,
    traceId: (validId(input.traceId) ? input.traceId : generatedId("trace")) as TraceId,
  };
}

export const correlationFactory: CorrelationFactory = {
  create: createCorrelationContext,
};

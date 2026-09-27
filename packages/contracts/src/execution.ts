import type {
  BackgroundJobId,
  CorrelationId,
  IdempotencyKey,
  RequestId,
  TraceId,
} from "./ids.ts";
import type { JsonValue } from "./errors.ts";

export interface CorrelationContext {
  readonly correlationId: CorrelationId;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
}

interface OperationContextBase {
  readonly correlation: CorrelationContext;
  readonly signal: AbortSignal;
  /** An absolute UTC ISO-8601 deadline when the caller has one. */
  readonly deadline?: string;
}

export interface RequestOperationContext extends OperationContextBase {
  readonly boundary: "request";
  readonly request: {
    readonly method: string;
    readonly path: string;
  };
}

export interface BackgroundOperationContext extends OperationContextBase {
  readonly boundary: "background";
  readonly job: {
    readonly id: BackgroundJobId;
    readonly kind: BackgroundJobKind;
    readonly attempt: number;
    readonly idempotencyKey: IdempotencyKey;
  };
}

export type OperationContext =
  | RequestOperationContext
  | BackgroundOperationContext;

export const BACKGROUND_JOB_KINDS = [
  "episode_ingest",
  "episode_transcription",
  "semantic_index_replace",
  "article_index_replace",
  "editorial_upload_verify",
  "pipeline_retry",
  "migration_reconcile",
  "provider_delivery",
] as const;

export type BackgroundJobKind = (typeof BACKGROUND_JOB_KINDS)[number];

interface BackgroundJobCommandBase {
  readonly idempotencyKey: IdempotencyKey;
  readonly correlation: CorrelationContext;
}

export interface EpisodeProcessingJobPayload {
  readonly target: "episode";
  readonly requestId: string;
  readonly revisionHash: `sha256:${string}`;
}

export interface ContentProcessingJobPayload {
  readonly target: "content";
  readonly requestId: string;
  readonly revisionHash: `sha256:${string}`;
}

type GenericBackgroundJobKind = Exclude<
  BackgroundJobKind,
  "episode_ingest" | "semantic_index_replace" | "article_index_replace"
>;

export type BackgroundJobCommand = BackgroundJobCommandBase & (
  | {
      readonly kind: "episode_ingest";
      readonly payload: EpisodeProcessingJobPayload;
    }
  | {
      readonly kind: "semantic_index_replace" | "article_index_replace";
      readonly payload: ContentProcessingJobPayload;
    }
  | {
      readonly kind: GenericBackgroundJobKind;
      readonly payload: Readonly<Record<string, JsonValue>>;
    }
);

export interface BackgroundJobReceipt {
  readonly jobId: BackgroundJobId;
  readonly acceptedAt: string;
  readonly duplicateOf?: BackgroundJobId;
}

/**
 * Current adapter: bounded PostgreSQL/systemd queue bridge.
 * Target adapter: Cloudflare Workflow or Queue producer.
 */
export interface BackgroundJobDispatcher {
  dispatch(
    context: RequestOperationContext | BackgroundOperationContext,
    command: BackgroundJobCommand,
  ): Promise<BackgroundJobReceipt>;
}

/** Only short, non-critical logging/cache work belongs on request waitUntil. */
export interface RequestLifetime {
  defer(task: Promise<unknown>): void;
}

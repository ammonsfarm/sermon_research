import { operationalResponse } from "@aic/observability";
import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createOpenAiEmbeddingProvider, type VectorizeWriteBinding } from "@aic/ai";
import type {
  BackgroundJobCommand,
  BackgroundJobReceipt,
  ProcessingOperatorActionInput,
  ProcessingOperatorActionReceipt,
} from "@aic/contracts";
import {
  D1ProcessingOperatorStore,
  D1ProcessingStateStore,
  ProcessingOperatorController,
  type D1Database as AicD1Database,
  type ProcessingWorkflowBindingPort,
} from "@aic/db";
import { ContentWorkflowDispatcher, type ContentWorkflowBindingPort } from "./dispatch.ts";
import { D1ContentIndexRepository } from "./repository.ts";
import {
  runContentIndexWorkflow,
  type ContentWorkflowEvent,
  type WorkflowStepPort,
} from "./workflow.ts";

export * from "./dispatch.ts";
export * from "./repository.ts";
export * from "./workflow.ts";

function dependencies(env: IndexerEnv) {
  const db = env.AIC_DB as unknown as AicD1Database;
  return {
    repository: new D1ContentIndexRepository({ db }),
    stateStore: new D1ProcessingStateStore({ db }),
    embeddings: createOpenAiEmbeddingProvider({ fetch, apiKey: env.OPENAI_API_KEY }),
    vectorize: env.AIC_CONTENT_INDEX as unknown as VectorizeWriteBinding,
  };
}

export function createContentWorkflowDispatcher(env: IndexerEnv): ContentWorkflowDispatcher {
  const db = env.AIC_DB as unknown as AicD1Database;
  return new ContentWorkflowDispatcher({
    db,
    stateStore: new D1ProcessingStateStore({ db }),
    workflow: env.AIC_CONTENT_INDEX_WORKFLOW as unknown as ContentWorkflowBindingPort,
  });
}

function processingOperator(env: IndexerEnv): ProcessingOperatorController {
  return new ProcessingOperatorController({
    db: env.AIC_DB as unknown as AicD1Database,
    workflow: env.AIC_CONTENT_INDEX_WORKFLOW as unknown as ProcessingWorkflowBindingPort,
    expectedWorkflow: "content",
  });
}

export class ContentIndexWorkflow extends WorkflowEntrypoint<IndexerEnv, ContentWorkflowEvent> {
  async run(event: WorkflowEvent<ContentWorkflowEvent>, step: WorkflowStep): Promise<void> {
    const operations = new D1ProcessingOperatorStore({ db: this.env.AIC_DB as unknown as AicD1Database });
    try {
      await runContentIndexWorkflow(step as unknown as WorkflowStepPort, event.payload, dependencies(this.env));
      await operations.markCurrentExecutionStatus(event.payload.requestId, "complete");
    } catch (error) {
      await operations.markCurrentExecutionStatus(event.payload.requestId, "errored").catch(() => undefined);
      throw error;
    }
  }
}

export interface ContentDispatchContext {
  readonly boundary: "request" | "background";
  readonly correlation: {
    readonly correlationId: string;
    readonly requestId?: string;
    readonly traceId?: string;
  };
  readonly request?: { readonly method: string; readonly path: string };
  readonly job?: {
    readonly id: string;
    readonly kind: BackgroundJobCommand["kind"];
    readonly attempt: number;
    readonly idempotencyKey: string;
  };
  readonly deadline?: string;
}

/** Private service-binding entrypoint used by the website's BackgroundJobDispatcher adapter. */
export class ContentIndexDispatcherEntrypoint extends WorkerEntrypoint<IndexerEnv> {
  async dispatch(context: ContentDispatchContext, command: BackgroundJobCommand): Promise<BackgroundJobReceipt> {
    const correlation = context.correlation as never;
    const operationContext = context.boundary === "request"
      ? {
          boundary: "request" as const,
          correlation,
          signal: new AbortController().signal,
          request: context.request ?? { method: "POST", path: "/internal/content-index" },
          ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
        }
      : {
          boundary: "background" as const,
          correlation,
          signal: new AbortController().signal,
          job: context.job as never,
          ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
        };
    return createContentWorkflowDispatcher(this.env).dispatch(operationContext, command);
  }

  cancelProcessing(input: ProcessingOperatorActionInput): Promise<ProcessingOperatorActionReceipt> {
    return processingOperator(this.env).cancel(input);
  }

  resumeProcessing(input: ProcessingOperatorActionInput): Promise<ProcessingOperatorActionReceipt> {
    return processingOperator(this.env).resume(input);
  }

  reconcileProcessing(input: ProcessingOperatorActionInput): Promise<ProcessingOperatorActionReceipt> {
    return processingOperator(this.env).reconcile(input);
  }
}

export default {
  async fetch(request: Request, env: IndexerEnv): Promise<Response> {
    const health = await operationalResponse(request, env);
    if (health) return health;
    return new Response("Service Unavailable", {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  },
};

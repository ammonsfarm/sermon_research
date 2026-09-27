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
import { createAudioTransport } from "./audio-transport.ts";
import { developmentAudioSource } from "./development-audio.ts";
import { requestEpisodePublication, type EpisodePublicationInput } from "./publication.ts";
import { createSoundCloudAudioSource } from "./audio-storage.ts";
import { createScheduledDiscoveryHandler, runEpisodeDiscovery, scheduleDailyDiscovery } from "./discovery.ts";
import { D1DiscoveryRunStore, type DiscoveryRunReceipt } from "./discovery-store.ts";
import { EpisodeWorkflowDispatcher, type EpisodeWorkflowBindingPort } from "./dispatch.ts";
import { createGeminiIntelligenceProvider, createSiloIntelligenceProvider } from "./intelligence.ts";
import { createR2AudioPresigner } from "./presign.ts";
import { D1EpisodeIngestRepository } from "./repository.ts";
import { createSoundCloudSource } from "./soundcloud.ts";
import { runEpisodeIngestWorkflow, type EpisodeWorkflowEvent, type EpisodeWorkflowStepPort } from "./workflow.ts";

export * from "./audio-storage.ts";
export * from "./audio-transport.ts";
export * from "./discovery-store.ts";
export * from "./dispatch.ts";
export * from "./discovery.ts";
export * from "./intelligence.ts";
export * from "./presign.ts";
export * from "./repository.ts";
export * from "./soundcloud.ts";
export * from "./workflow.ts";

function repository(env: IngestEnv): D1EpisodeIngestRepository {
  return new D1EpisodeIngestRepository({
    db: env.AIC_DB as unknown as AicD1Database,
    bucket: env.AIC_PODCAST_AUDIO,
    environment: env.AIC_ENVIRONMENT,
    ...developmentAudioSource(env.AIC_ENVIRONMENT, env.AIC_PODCAST_AUDIO, createSoundCloudAudioSource(fetch)),
  });
}

function dependencies(env: IngestEnv) {
  const repo = repository(env);
  const db = env.AIC_DB as unknown as AicD1Database;
  return {
    repository: repo,
    stateStore: new D1ProcessingStateStore({ db }),
    audioTransport: createAudioTransport({
      mintUrl: createR2AudioPresigner({
        endpoint: env.R2_AUDIO_S3_ENDPOINT,
        bucketName: env.AIC_ENVIRONMENT === "development" ? "aic-podcast-audio-dev" : "aic-podcast-audio",
        accessKeyId: env.R2_AUDIO_PRESIGN_ACCESS_KEY_ID,
        secretAccessKey: env.R2_AUDIO_PRESIGN_SECRET_ACCESS_KEY,
      }),
      mistralFetch: (request) => fetch(request),
      mistralUrl: env.MISTRAL_TRANSCRIPTION_URL,
      mistralModel: env.MISTRAL_TRANSCRIPTION_MODEL,
      mistralApiKey: env.MISTRAL_API_KEY,
      persistArtifact: (context, descriptor, artifact) => repo.persistTranscriptArtifact(context, descriptor, artifact),
    }),
    intelligence: env.GEMINI_API_KEY
      ? createGeminiIntelligenceProvider({
          fetch: (request) => fetch(request),
          url: env.GEMINI_INTELLIGENCE_URL,
          model: env.GEMINI_INTELLIGENCE_MODEL,
          maxTokens: env.GEMINI_INTELLIGENCE_MAX_TOKENS,
          apiKey: env.GEMINI_API_KEY,
        })
      : createSiloIntelligenceProvider({
          environment: env.AIC_ENVIRONMENT,
          fetch: (request) => fetch(request),
          url: env.SILO_INTELLIGENCE_URL ?? "",
          model: env.SILO_INTELLIGENCE_MODEL ?? "",
          backendMode: env.SILO_INTELLIGENCE_BACKEND_MODE ?? "",
          reasoning: env.SILO_INTELLIGENCE_REASONING ?? "",
          maxTokens: env.SILO_INTELLIGENCE_MAX_TOKENS ?? 4096,
          apiKey: env.SILO_TEMP_KEY ?? "",
        }),
    embeddings: createOpenAiEmbeddingProvider({ fetch, apiKey: env.OPENAI_API_KEY }),
    vectorize: env.AIC_CONTENT_INDEX as unknown as VectorizeWriteBinding,
  };
}

export function createEpisodeWorkflowDispatcher(env: IngestEnv): EpisodeWorkflowDispatcher {
  const db = env.AIC_DB as unknown as AicD1Database;
  return new EpisodeWorkflowDispatcher({
    db,
    stateStore: new D1ProcessingStateStore({ db }),
    workflow: env.AIC_EPISODE_INGEST_WORKFLOW as unknown as EpisodeWorkflowBindingPort,
    isMissingInstanceError: (error) => error instanceof Error && /not found|does not exist|404/iu.test(error.message),
  });
}

function processingOperator(env: IngestEnv): ProcessingOperatorController {
  return new ProcessingOperatorController({
    db: env.AIC_DB as unknown as AicD1Database,
    workflow: env.AIC_EPISODE_INGEST_WORKFLOW as unknown as ProcessingWorkflowBindingPort,
    expectedWorkflow: "episode",
  });
}

export class EpisodeIngestWorkflow extends WorkflowEntrypoint<IngestEnv, EpisodeWorkflowEvent> {
  override async run(event: WorkflowEvent<EpisodeWorkflowEvent>, step: WorkflowStep): Promise<void> {
    const operations = new D1ProcessingOperatorStore({ db: this.env.AIC_DB as unknown as AicD1Database });
    try {
      await runEpisodeIngestWorkflow(step as unknown as EpisodeWorkflowStepPort, event.payload, dependencies(this.env));
      await operations.markCurrentExecutionStatus(event.payload.requestId, "complete");
    } catch (error) {
      await operations.markCurrentExecutionStatus(event.payload.requestId, "errored").catch(() => undefined);
      throw error;
    }
  }
}

export interface EpisodeDispatchContext {
  readonly boundary: "request" | "background";
  readonly correlation: { readonly correlationId: string; readonly requestId?: string; readonly traceId?: string };
  readonly request?: { readonly method: string; readonly path: string };
  readonly job?: { readonly id: string; readonly kind: BackgroundJobCommand["kind"]; readonly attempt: number; readonly idempotencyKey: string };
  readonly deadline?: string;
}

/** Private service-binding entrypoint; the public fetch surface stays closed. */
export class EpisodeIngestDispatcherEntrypoint extends WorkerEntrypoint<IngestEnv> {
  async dispatch(context: EpisodeDispatchContext, command: BackgroundJobCommand): Promise<BackgroundJobReceipt> {
    const correlation = context.correlation as never;
    const operationContext = context.boundary === "request"
      ? {
          boundary: "request" as const,
          correlation,
          signal: new AbortController().signal,
          request: context.request ?? { method: "POST", path: "/internal/episode-ingest" },
          ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
        }
      : {
          boundary: "background" as const,
          correlation,
          signal: new AbortController().signal,
          job: context.job as never,
          ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
        };
    return createEpisodeWorkflowDispatcher(this.env).dispatch(operationContext, command);
  }

  publishEpisode(input: EpisodePublicationInput) {
    return requestEpisodePublication({
      db: this.env.AIC_DB as unknown as AicD1Database,
      stateStore: new D1ProcessingStateStore({ db: this.env.AIC_DB as unknown as AicD1Database }),
      dispatch: (requestId) => createEpisodeWorkflowDispatcher(this.env).dispatchRequestId(requestId),
    }, input);
  }

  /**
   * Administrator-requested discovery, identical to the 04:15 run but keyed to its own
   * `manual:<minute>` slot so repeated clicks within a minute are idempotent.
   */
  async runDiscoveryNow(input: { readonly requestedBy: string }): Promise<DiscoveryRunReceipt> {
    const requestedBy = typeof input?.requestedBy === "string" ? input.requestedBy.trim().slice(0, 200) : "";
    if (!requestedBy) throw new TypeError("A requester is required for manual discovery.");
    const now = new Date();
    now.setUTCSeconds(0, 0);
    const minute = now.toISOString();
    const db = this.env.AIC_DB as unknown as AicD1Database;
    const dispatcher = createEpisodeWorkflowDispatcher(this.env);
    return runEpisodeDiscovery({
      source: createSoundCloudSource({ feedUrl: this.env.SOUNDCLOUD_FEED_URL, fetch: (request) => fetch(request) }),
      stateStore: new D1ProcessingStateStore({ db }),
      discoveryStore: new D1DiscoveryRunStore({ db }),
      dispatch: (requestId) => dispatcher.dispatchRequestId(requestId),
      maxItems: 100,
      desiredPublication: this.env.AIC_INGEST_AUTO_PUBLISH === "true" ? "published" : "draft",
      scheduledSlot: `manual:${minute}`,
      scheduledUtcMinute: minute,
      requestedAt: new Date().toISOString(),
      requestedBy: `admin:${requestedBy}`,
    });
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
  async fetch(request: Request, env: IngestEnv): Promise<Response> {
    const health = await operationalResponse(request, env);
    if (health) return health;
    return new Response("Service Unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  },
  async scheduled(controller: ScheduledController, env: IngestEnv, context: ExecutionContext): Promise<void> {
    scheduleDailyDiscovery(controller, () => {
      const db = env.AIC_DB as unknown as AicD1Database;
      const dispatcher = createEpisodeWorkflowDispatcher(env);
      const handler = createScheduledDiscoveryHandler({
        source: createSoundCloudSource({ feedUrl: env.SOUNDCLOUD_FEED_URL, fetch: (request) => fetch(request) }),
        stateStore: new D1ProcessingStateStore({ db }),
        discoveryStore: new D1DiscoveryRunStore({ db }),
        dispatch: (requestId) => dispatcher.dispatchRequestId(requestId),
        maxItems: 100,
        desiredPublication: env.AIC_INGEST_AUTO_PUBLISH === "true" ? "published" : "draft",
      });
      context.waitUntil(handler(controller));
    });
  },
};

import {
  RoleAuthorizationService,
} from "@aic/auth";
import {
  createOpenAiEmbeddingProvider,
  createTextGenerationProvider,
  createVectorizeReader,
  decryptProviderApiKey,
  type RegistryGenerationEndpoint,
  type VectorizeQueryBinding,
} from "@aic/ai";
import {
  createD1RagInteractionRepository,
  createD1ResearchSourceRepository,
  createD1SearchRepositories,
  resolveD1LlmModelsForUser,
  type D1Database,
  type ResolvedLlmModel,
} from "@aic/db";
import {
  ServiceError,
  type AiModelRef,
  type AuthorizationService,
  type SearchDocument,
  type SessionReader,
  type UserId,
  type VectorId,
} from "@aic/contracts";
import { createConsoleLogger } from "@aic/observability";
import {
  createWorkerAdmissionSessionReader,
  readClerkWorkerConfiguration,
} from "./clerk-session.ts";
import { D1RagQuota } from "./quota.ts";
import {
  createEpisodeSearchService,
  createRagService,
  type RagRetrievalConfig,
} from "./service.ts";
import {
  createRagWorker,
  sanitizedRagHeaders,
  type RagModelCatalog,
  type RagSourceDetail,
  type RagWorkerDependencies,
  type RagWorkerServices,
} from "./worker.ts";

export { readClerkWorkerConfiguration };

export type RagRuntimeBindings = Record<string, unknown> & {
  readonly AIC_DB?: unknown;
  readonly AIC_CONTENT_INDEX?: unknown;
  readonly AIC_CANONICAL_ORIGIN?: unknown;
  readonly OPENAI_API_KEY?: unknown;
  readonly GEMINI_API_KEY?: unknown;
  readonly GEMINI_CHAT_MODEL?: unknown;
  readonly GEMINI_CHAT_URL?: unknown;
  readonly SILO_CHAT_URL?: unknown;
  readonly SILO_TEMP_KEY?: unknown;
  readonly SILO_CHAT_MODEL?: unknown;
  readonly OPENAI_CHAT_MODEL?: unknown;
  readonly AIC_RAG_ALLOW_OPENAI_FALLBACK?: unknown;
  /** Base64 32-byte AES key shared with aic-web for sealing provider API keys. */
  readonly AIC_PROVIDER_KEY_SECRET?: unknown;
  /** Temporary: "true" logs full generation request bodies for provider debugging. */
  readonly AIC_RAG_DEBUG_PAYLOAD?: unknown;
};

interface GenerationSelection {
  readonly primaryModel: AiModelRef;
  readonly registry: ReadonlyMap<string, RegistryGenerationEndpoint>;
}

export interface RuntimeOverrides {
  readonly sessions?: SessionReader;
  readonly authorize?: AuthorizationService;
}

function unavailable(cause?: unknown): ServiceError {
  return new ServiceError({
    code: "dependency_unavailable",
    message: "The RAG service is temporarily unavailable.",
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

function semanticDependency<T>(create: () => T): T {
  try { return create(); }
  catch (error) { throw unavailable(error); }
}

function requiredString(bindings: RagRuntimeBindings, name: string): string {
  const value = Reflect.get(bindings, name);
  if (typeof value !== "string" || !value.trim()) throw unavailable();
  return value.trim();
}

function database(bindings: RagRuntimeBindings): D1Database {
  const value = bindings.AIC_DB;
  if (!value || typeof value !== "object" || typeof Reflect.get(value, "prepare") !== "function") throw unavailable();
  return value as D1Database;
}

function vectorIndex(bindings: RagRuntimeBindings): VectorizeQueryBinding {
  const value = bindings.AIC_CONTENT_INDEX;
  if (!value || typeof value !== "object" || typeof Reflect.get(value, "query") !== "function") throw unavailable();
  return value as VectorizeQueryBinding;
}

function retrievalConfig(bindings: RagRuntimeBindings): RagRetrievalConfig {
  const geminiModel = typeof bindings.GEMINI_CHAT_MODEL === "string" && bindings.GEMINI_CHAT_MODEL.trim()
    ? bindings.GEMINI_CHAT_MODEL.trim() : undefined;
  const siloModel = typeof bindings.SILO_CHAT_MODEL === "string" && bindings.SILO_CHAT_MODEL.trim()
    ? bindings.SILO_CHAT_MODEL.trim() : undefined;
  const primary = geminiModel || bindings.GEMINI_API_KEY
    ? { provider: "gemini" as const, model: geminiModel || "gemini-3.8-flash" }
    : { provider: "silo" as const, model: siloModel || requiredString(bindings, "SILO_CHAT_MODEL") };
  const allowFallback = bindings.AIC_RAG_ALLOW_OPENAI_FALLBACK === "true";
  const fallbackModel = typeof bindings.OPENAI_CHAT_MODEL === "string" && bindings.OPENAI_CHAT_MODEL.trim()
    ? { provider: "openai" as const, model: bindings.OPENAI_CHAT_MODEL.trim() }
    : undefined;
  if (allowFallback && fallbackModel === undefined) throw unavailable();
  return {
    embeddingModel: { provider: "openai", model: "text-embedding-3-small" },
    primaryModel: primary,
    ...(fallbackModel === undefined ? {} : { fallbackModel }),
    allowFallback,
    archiveTopK: 10,
    archiveMaxSources: 16,
    researchSourceBudget: 24,
    researchCandidateEpisodes: 8,
    researchSummaryEpisodes: 6,
    researchDetailExcerpts: 30,
    researchMaxSources: 40,
    researchInterviewInventoryLimit: 60,
    researchInterviewMaxSources: 72,
    writingTopK: 8,
  };
}

function modelNotAvailable(): ServiceError {
  return new ServiceError({ code: "forbidden", message: "The requested model is not available to this account." });
}

/** Registry models for a user; an unmigrated or unreachable registry degrades to the environment default. */
async function registryModels(bindings: RagRuntimeBindings, userId: string): Promise<readonly ResolvedLlmModel[]> {
  try { return await resolveD1LlmModelsForUser(database(bindings), userId); }
  catch { return []; }
}

async function generationSelection(
  bindings: RagRuntimeBindings,
  userId: string,
  requestedModelId: string | undefined,
): Promise<GenerationSelection | null> {
  const models = await registryModels(bindings, userId);
  if (models.length === 0) {
    if (requestedModelId !== undefined) throw modelNotAvailable();
    return null;
  }
  const chosen = requestedModelId === undefined ? models[0]! : models.find((model) => model.modelId === requestedModelId);
  if (chosen === undefined) throw modelNotAvailable();
  const apiKey = await decryptProviderApiKey(requiredString(bindings, "AIC_PROVIDER_KEY_SECRET"), chosen.providerId, chosen.apiKeyCiphertext);
  return {
    primaryModel: { provider: "registry", model: chosen.modelId },
    registry: new Map([[chosen.modelId, { baseUrl: chosen.baseUrl, apiKey, remoteModel: chosen.remoteModel, apiStyle: chosen.apiStyle }]]),
  };
}

function services(bindings: RagRuntimeBindings): RagWorkerServices {
  const logger = createConsoleLogger();
  const serviceFor = (rawUserId: string, selection: GenerationSelection | null) => {
    try {
      const db = database(bindings);
      const userId = rawUserId as UserId;
      const access = { kind: "authenticated-corpus" as const, userId };
      const environmentConfig = retrievalConfig(bindings);
      const config = selection === null ? environmentConfig : (() => {
        const { fallbackModel: _unused, ...rest } = environmentConfig;
        void _unused;
        return { ...rest, primaryModel: selection.primaryModel, allowFallback: false };
      })();
      const openAiKey = requiredString(bindings, "OPENAI_API_KEY");
      const geminiKey = typeof bindings.GEMINI_API_KEY === "string" && bindings.GEMINI_API_KEY.trim()
        ? bindings.GEMINI_API_KEY.trim() : undefined;
      const geminiUrl = typeof bindings.GEMINI_CHAT_URL === "string" && bindings.GEMINI_CHAT_URL.trim()
        ? bindings.GEMINI_CHAT_URL.trim() : undefined;
      const siloKey = typeof bindings.SILO_TEMP_KEY === "string" && bindings.SILO_TEMP_KEY.trim()
        ? bindings.SILO_TEMP_KEY.trim() : undefined;
      const siloUrl = typeof bindings.SILO_CHAT_URL === "string" && bindings.SILO_CHAT_URL.trim()
        ? bindings.SILO_CHAT_URL.trim() : undefined;
      const allowedModels = [config.primaryModel, ...("fallbackModel" in config && config.fallbackModel !== undefined ? [config.fallbackModel] : [])];
      return createRagService({
        embeddings: createOpenAiEmbeddingProvider({ fetch: globalThis.fetch.bind(globalThis), apiKey: openAiKey }),
        generation: createTextGenerationProvider({
          fetch: globalThis.fetch.bind(globalThis),
          geminiKey,
          geminiUrl,
          siloUrl,
          siloKey,
          openAiKey,
          ...(selection === null ? {} : { registry: selection.registry }),
          debugLogPayload: bindings.AIC_RAG_DEBUG_PAYLOAD === "true",
          allowedModels,
        }),
        search: createVectorizeReader(vectorIndex(bindings)),
        hydration: createD1SearchRepositories({
          db,
          canonicalOrigin: requiredString(bindings, "AIC_CANONICAL_ORIGIN"),
          access,
        }).searchDocuments,
        history: createD1RagInteractionRepository({ db, userId }),
        researchSources: createD1ResearchSourceRepository({ db, access }),
        logger,
        clock: Date.now,
        config,
      });
    } catch (error) {
      throw unavailable(error);
    }
  };
  const episodeSearchServiceFor = (rawUserId: string) => {
    try {
      const db = database(bindings);
      const access = { kind: "authenticated-corpus" as const, userId: rawUserId as UserId };
      return createEpisodeSearchService({
        embeddings: {
          embedQuery(context, input) {
            const provider = semanticDependency(() => createOpenAiEmbeddingProvider({
              fetch: globalThis.fetch.bind(globalThis),
              apiKey: requiredString(bindings, "OPENAI_API_KEY"),
            }));
            return provider.embedQuery(context, input);
          },
        },
        search: {
          query(context, input) {
            const reader = semanticDependency(() => createVectorizeReader(vectorIndex(bindings)));
            return reader.query(context, input);
          },
        },
        hydration: {
          getByVectorIds(context, vectorIds) {
            const repository = semanticDependency(() => createD1SearchRepositories({
              db,
              canonicalOrigin: requiredString(bindings, "AIC_CANONICAL_ORIGIN"),
              access,
            }).searchDocuments);
            return repository.getByVectorIds(context, vectorIds);
          },
        },
        researchSources: createD1ResearchSourceRepository({ db, access }),
        logger,
        clock: Date.now,
        config: { embeddingModel: { provider: "openai", model: "text-embedding-3-small" } },
      });
    } catch (error) {
      throw unavailable(error);
    }
  };

  return {
    async answer(context, input) {
      try {
        const selection = await generationSelection(bindings, input.userId, input.modelId);
        return await serviceFor(input.userId, selection).answer(context, input);
      }
      catch (error) { if (error instanceof ServiceError) throw error; throw unavailable(error); }
    },
    async history(context, userId, page) {
      try {
        return await createD1RagInteractionRepository({ db: database(bindings), userId: userId as UserId }).listForUser(context, userId as UserId, page);
      } catch (error) { if (error instanceof ServiceError) throw error; throw unavailable(error); }
    },
    async searchEpisodes(context, userId, input) {
      try {
        return await episodeSearchServiceFor(userId).searchEpisodes(context, input);
      } catch (error) { if (error instanceof ServiceError) throw error; throw unavailable(error); }
    },
    async models(_context, userId): Promise<RagModelCatalog> {
      const models = await registryModels(bindings, userId);
      if (models.length > 0) {
        return {
          source: "registry",
          models: models.map((model) => ({
            id: model.modelId,
            displayName: model.displayName,
            providerId: model.providerId,
            providerName: model.providerDisplayName,
            isDefault: model === models[0],
          })),
        };
      }
      const primary = retrievalConfig(bindings).primaryModel;
      return { source: "environment", models: [{ id: "", displayName: primary.model, providerId: primary.provider, providerName: primary.provider, isDefault: true }] };
    },
    async source(context, userId, vectorId) {
      let repository;
      try {
        repository = createD1SearchRepositories({
          db: database(bindings),
          canonicalOrigin: requiredString(bindings, "AIC_CANONICAL_ORIGIN"),
          access: { kind: "authenticated-corpus", userId: userId as UserId },
        }).searchDocuments;
      } catch (error) {
        throw unavailable(error);
      }
      try {
        const result = await repository.getByVectorIds(context, [vectorId as VectorId]);
        return result[0] === undefined ? null : toRagSourceDetail(result[0]);
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw unavailable(error);
      }
    },
  };
}

const PUBLIC_SOURCE_EXCERPT_CHARACTERS = 720;

export function toRagSourceDetail(document: SearchDocument): RagSourceDetail {
  return {
    vectorId: document.vectorId,
    sourceType: document.sourceType,
    trackId: document.sourceId,
    title: document.title,
    text: [...document.text].slice(0, PUBLIC_SOURCE_EXCERPT_CHARACTERS).join(""),
    sourceUrl: document.canonicalUrl,
    ...(document.sourceLocation === undefined ? {} : { sourceLocation: document.sourceLocation }),
  };
}

function lazyQuota(bindings: RagRuntimeBindings): RagWorkerDependencies["quota"] {
  return {
    async consume(context, userId) {
      return new D1RagQuota({ db: database(bindings) }).consume(context, userId);
    },
  };
}

export function createRuntimeRagWorker(
  request: Request,
  bindings: RagRuntimeBindings,
  overrides: RuntimeOverrides = {},
) {
  const authenticationRequest = createRagAuthenticationRequest(request);
  return createRagWorker({
    sessions: overrides.sessions ?? createWorkerAdmissionSessionReader(authenticationRequest, bindings, { requireAccessRecord: true }),
    authorize: overrides.authorize ?? new RoleAuthorizationService(),
    services: services(bindings),
    quota: lazyQuota(bindings),
  });
}

export function createRagAuthenticationRequest(request: Request): Request {
  return new Request(request.url, {
    method: request.method,
    headers: sanitizedRagHeaders(request.headers),
    signal: request.signal,
  });
}

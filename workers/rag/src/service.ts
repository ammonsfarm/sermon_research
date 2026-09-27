import type { OperationContext } from "../../../packages/contracts/src/execution.ts";
import { stageContext } from "./context.ts";
import {
  createEpisodeSearchService as createCoreEpisodeSearchService,
  createRagService as createCoreRagService,
  type EpisodeSearchServiceDeps,
  type EpisodeHybridSearchInput,
  type RagAnswerInput,
  type RagServiceDeps,
} from "./service-core.ts";

export type {
  EpisodeSearchServiceDeps,
  EpisodeHybridSearchInput,
  EpisodeHybridSearchResult,
  RagAnswerInput,
  RagAnswerResult,
  RagResponseSource,
  RagRetrievalConfig,
  RagServiceDeps,
} from "./service-core.ts";

const SUPPLEMENTAL_TIMEOUT_MS = 5_000;

function scopedDependencies<T extends Pick<RagServiceDeps, "clock" | "researchSources" | "hydration">>(
  deps: T,
  parentContext: OperationContext,
  suppressEpisodeSummaries: boolean,
): T {
  let sharedSupplementalContext: OperationContext | undefined;
  const supplementalContext = (): OperationContext => {
    if (sharedSupplementalContext === undefined) {
      sharedSupplementalContext = stageContext(parentContext, deps.clock, SUPPLEMENTAL_TIMEOUT_MS);
    }
    return sharedSupplementalContext;
  };

  const researchSources: RagServiceDeps["researchSources"] = {
    searchStructured: (_context, query, limit) => deps.researchSources.searchStructured(supplementalContext(), query, limit),
    listInterviewInventory: (_context, limit) => deps.researchSources.listInterviewInventory(supplementalContext(), limit),
    getSummaries: (_context, episodeIds) => suppressEpisodeSummaries
      ? Promise.resolve([])
      : deps.researchSources.getSummaries(supplementalContext(), episodeIds),
    getTranscriptDetails: (_context, query, episodeIds, limit) => deps.researchSources.getTranscriptDetails(
      supplementalContext(),
      query,
      episodeIds,
      limit,
    ),
    searchEpisodes: (_context, input) => deps.researchSources.searchEpisodes(supplementalContext(), input),
    listEpisodes: (_context, input) => deps.researchSources.listEpisodes(supplementalContext(), input),
  };

  const hydration: RagServiceDeps["hydration"] = {
    getByVectorIds: (_context, vectorIds) => deps.hydration.getByVectorIds(supplementalContext(), vectorIds),
  };

  return { ...deps, researchSources, hydration };
}

export function createEpisodeSearchService(deps: EpisodeSearchServiceDeps) {
  createCoreEpisodeSearchService(deps);
  return {
    searchEpisodes(context: OperationContext, input: EpisodeHybridSearchInput) {
      return createCoreEpisodeSearchService(scopedDependencies(deps, context, false)).searchEpisodes(context, input);
    },
  };
}

export function createRagService(deps: RagServiceDeps) {
  const base = createCoreRagService(deps);
  return {
    answer(context: OperationContext, input: RagAnswerInput) {
      const suppressEpisodeSummaries = input.scope === "archive" || input.scope === "episode";
      return createCoreRagService(scopedDependencies(deps, context, suppressEpisodeSummaries)).answer(context, input);
    },
    history: base.history,
    searchEpisodes(context: OperationContext, input: EpisodeHybridSearchInput) {
      return createCoreRagService(scopedDependencies(deps, context, false)).searchEpisodes(context, input);
    },
  };
}

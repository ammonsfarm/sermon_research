import type {
  AiProviders,
  EmbeddingProvider,
  TextGenerationProvider,
} from "./ai.ts";
import type { AuthServices } from "./auth.ts";
import type { BackgroundJobDispatcher, RequestLifetime } from "./execution.ts";
import type { ObservabilityServices } from "./observability.ts";
import type { RelationalRepositories } from "./repositories.ts";
import type { SemanticSearch } from "./search.ts";
import type { DirectUploadCoordinator, ObjectReader, AudioObjectReader, ObjectWriter } from "./storage.ts";

/** Services allowed on a bounded HTTP request path. */
export interface RequestServices {
  readonly repositories: RelationalRepositories;
  readonly objectReader: ObjectReader;
  readonly audioReader: AudioObjectReader;
  readonly directUploads: DirectUploadCoordinator;
  readonly auth: AuthServices;
  readonly semanticSearch: Pick<SemanticSearch, "reader">;
  readonly ai: {
    readonly embeddings: Pick<EmbeddingProvider, "embedQuery">;
    readonly generation: TextGenerationProvider;
  };
  readonly jobs: BackgroundJobDispatcher;
  readonly observability: ObservabilityServices;
  readonly lifetime: RequestLifetime;
}

/** Services available only to durable scheduled/workflow/queue execution. */
export interface BackgroundServices {
  readonly repositories: RelationalRepositories;
  readonly objectReader: ObjectReader;
  readonly objectWriter: ObjectWriter;
  readonly semanticSearch: SemanticSearch;
  readonly ai: AiProviders;
  readonly jobs: BackgroundJobDispatcher;
  readonly observability: ObservabilityServices;
}

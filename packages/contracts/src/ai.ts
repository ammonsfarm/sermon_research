import type {
  BackgroundOperationContext,
  RequestOperationContext,
} from "./execution.ts";
import type { ContentHash, ObjectKey } from "./ids.ts";
import type { EmbeddingVector } from "./search.ts";

export type AiProviderId = "openai" | "mistral" | "gemini" | "silo" | "workers-ai" | "registry";

export interface AiModelRef {
  readonly provider: AiProviderId;
  readonly model: string;
  readonly revision?: string;
}

export interface QueryEmbeddingRequest {
  readonly text: string;
  readonly model: AiModelRef;
  readonly expectedDimensions: number;
}

export interface BatchEmbeddingInput {
  readonly customId: string;
  readonly text: string;
  readonly contentHash: ContentHash;
}

export interface EmbeddingProvider {
  embedQuery(
    context: RequestOperationContext | BackgroundOperationContext,
    request: QueryEmbeddingRequest,
  ): Promise<EmbeddingVector>;
  embedBatch(
    context: BackgroundOperationContext,
    request: {
      readonly model: AiModelRef;
      readonly expectedDimensions: number;
      readonly inputs: readonly BatchEmbeddingInput[];
    },
  ): Promise<readonly (EmbeddingVector & { readonly customId: string })[]>;
}

export interface CitationContext {
  readonly sourceId: string;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly text: string;
}

export interface TextGenerationProvider {
  generate(
    context: RequestOperationContext | BackgroundOperationContext,
    request: {
      readonly model: AiModelRef;
      readonly system: string;
      readonly prompt: string;
      readonly context: readonly CitationContext[];
      readonly maxOutputTokens: number;
    },
  ): Promise<{
    readonly text: string;
    readonly model: AiModelRef;
    readonly citedSourceIds: readonly string[];
  }>;
}

export interface TranscriptionProvider {
  transcribe(
    context: BackgroundOperationContext,
    request: {
      readonly model: AiModelRef;
      readonly audio: { readonly key: ObjectKey; readonly contentType: "audio/mpeg" };
      readonly language?: string;
      readonly diarize: boolean;
    },
  ): Promise<{
    readonly model: AiModelRef;
    readonly text: string;
    readonly segments: readonly {
      readonly startMs: number;
      readonly endMs: number;
      readonly speaker: string | null;
      readonly text: string;
    }[];
  }>;
}

export interface AiProviders {
  readonly embeddings: EmbeddingProvider;
  readonly generation: TextGenerationProvider;
  readonly transcription: TranscriptionProvider;
}

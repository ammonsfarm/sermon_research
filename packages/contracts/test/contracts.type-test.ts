import type {
  ArticleId,
  AudioObjectReader,
  BackgroundOperationContext,
  BackgroundJobCommand,
  DirectUploadCoordinator,
  EmbeddingProvider,
  EpisodeId,
  EditorialDocumentId,
  EditorialMutation,
  MigrationReport,
  ObjectWriter,
  PodcastUrlGenerator,
  RequestOperationContext,
  SemanticIndexWriter,
  TranscriptionProvider,
  UserId,
  ProcessingRequestInput,
  ProcessingStateStore,
  ProcessingRevisionHash,
  RagHistoryPageRequest,
  RagInteractionRecord,
  ResearchCitation,
  ResearchSourceRepository,
  RetrievalCitation,
  SemanticSearchFilter,
} from "../src/index.ts";

declare const article: ArticleId;
declare const episode: EpisodeId;
declare const migrationReport: MigrationReport;
declare const requestContext: RequestOperationContext;
declare const backgroundContext: BackgroundOperationContext;
declare const uploads: DirectUploadCoordinator;
declare const embeddings: EmbeddingProvider;
declare const objectWriter: ObjectWriter;
declare const indexWriter: SemanticIndexWriter;
declare const transcriber: TranscriptionProvider;
declare const audioReader: AudioObjectReader;
declare const podcastUrls: PodcastUrlGenerator;
declare const documentId: EditorialDocumentId;
declare const actorId: UserId;
declare const processingStore: ProcessingStateStore;
declare const processingInput: ProcessingRequestInput;
declare const processingRevision: ProcessingRevisionHash;
declare const retrievalCitation: RetrievalCitation;
declare const researchSources: ResearchSourceRepository;

function useResearchCitation(citation: ResearchCitation): void {
  if (citation.kind === "record") void citation.key;
  else void citation.citation.vectorId;
}

void article;
void episode;
void migrationReport.decision;
void uploads.initiate;

if (false) {
  // These calls compile and freeze background-only boundaries.
  void uploads.initiate(requestContext, {} as never);
  void embeddings.embedBatch(backgroundContext, {} as never);
  void objectWriter.delete(backgroundContext, {} as never);
  void indexWriter.delete(backgroundContext, []);
  void transcriber.transcribe(backgroundContext, {} as never);
  void audioReader.readAudio(requestContext, episode);
  void podcastUrls.publicAudioUrl(episode);

  const editorialMutation: EditorialMutation<Readonly<Record<string, string>>> = {
    documentId,
    entity: { kind: "episode", id: episode },
    expectedRevision: "revision" as never,
    actorId,
    payload: { title: "Draft" },
  };
  const backwardsCompatibleMutation: EditorialMutation<Readonly<Record<string, string>>> = {
    documentId,
    expectedRevision: "revision" as never,
    actorId,
    payload: { title: "Draft" },
  };
  void editorialMutation;
  void backwardsCompatibleMutation;

  const processingCommand: BackgroundJobCommand = {
    kind: "episode_ingest",
    idempotencyKey: processingInput.idempotencyKey,
    payload: {
      target: "episode",
      requestId: processingInput.requestId,
      revisionHash: processingRevision,
    },
    correlation: requestContext.correlation,
  };
  const contentCommand: BackgroundJobCommand = {
    kind: "semantic_index_replace",
    idempotencyKey: processingInput.idempotencyKey,
    payload: {
      target: "content",
      requestId: processingInput.requestId,
      revisionHash: processingRevision,
    },
    correlation: requestContext.correlation,
  };
  void processingCommand;
  void contentCommand;
  void processingStore.createOrGetRequest(processingInput);

  const previousHistoryCaller: RagInteractionRecord = {
    userId: actorId,
    question: "Synthetic question",
    answer: "Synthetic answer",
    citations: [retrievalCitation],
    createdAt: "2026-09-05T12:00:00.000Z" as never,
  };
  const extendedHistoryCaller: RagInteractionRecord = {
    ...previousHistoryCaller,
    id: "00000000-0000-4000-8000-000000000001",
    scope: "writing",
    articleId: article,
    provider: "silo",
    model: "synthetic-model",
    topK: 8,
    status: "completed",
    error: "",
    durationMs: 10,
    sources: [retrievalCitation],
    researchCitations: [{ kind: "vector", citation: retrievalCitation }],
    retrievalLanes: ["article"],
    topEpisodeIds: [],
    coverageNote: "synthetic",
    totalTokens: 3,
    inputTokens: 2,
    outputTokens: 1,
  };
  const historyPage: RagHistoryPageRequest = {
    limit: 10,
    scope: "writing",
    articleId: article,
  };
  const semanticFilter: SemanticSearchFilter = {
    sourceTypes: ["article"],
    contentSubtypes: ["pastorwood_devotional"],
  };
  const recordCitation: ResearchCitation = {
    kind: "record",
    key: "episode_intelligence_items:item-1",
    sourceId: episode,
    canonicalUrl: "https://example.test/podcast/episodes?trackId=sa_42",
  };
  void extendedHistoryCaller;
  void historyPage;
  void semanticFilter;
  useResearchCitation(recordCitation);
  void researchSources.searchEpisodes(requestContext, {
    query: "grace",
    limit: 20,
    scope: "theme",
    sort: "relevance",
  });

  // @ts-expect-error callers cannot pass provider or SQL filter expressions
  void ({ sql: "1=1" } satisfies SemanticSearchFilter);
  // @ts-expect-error subtype vocabulary is fixed
  void ({ contentSubtypes: ["caller_defined"] } satisfies SemanticSearchFilter);
  // @ts-expect-error record citations cannot masquerade as Vectorize citations
  const fakeVectorCitation: ResearchCitation = { kind: "vector", key: "row:1" };
  void fakeVectorCitation;

  // @ts-expect-error processing Workflow commands require the discriminant
  const missingTarget: BackgroundJobCommand = {
    kind: "episode_ingest",
    idempotencyKey: processingInput.idempotencyKey,
    payload: { requestId: processingInput.requestId, revisionHash: processingRevision },
    correlation: requestContext.correlation,
  };
  void missingTarget;

  // @ts-expect-error provider binding types do not belong in shared processing state
  void processingInput.cloudflareWorkflowBinding;
  // @ts-expect-error transcription SDK responses do not belong in shared processing state
  void processingInput.mistralResponse;
  // @ts-expect-error embedding SDK responses do not belong in shared processing state
  void processingInput.openaiResponse;
  // @ts-expect-error semantic-index SDK responses do not belong in shared processing state
  void processingInput.vectorizeMutation;

  // @ts-expect-error stable entity ID brands are not interchangeable
  const wrongId: ArticleId = episode;
  void wrongId;

  // @ts-expect-error durable object writes cannot execute on an HTTP request context
  void objectWriter.delete(requestContext, {} as never);

  // @ts-expect-error batch embeddings cannot execute on an HTTP request context
  void embeddings.embedBatch(requestContext, {} as never);

  // @ts-expect-error vector index mutations cannot execute on an HTTP request context
  void indexWriter.delete(requestContext, []);

  // @ts-expect-error transcription is a durable background operation
  void transcriber.transcribe(requestContext, {} as never);
}

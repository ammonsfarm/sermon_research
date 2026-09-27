import test from "node:test";
import assert from "node:assert/strict";

import { createRagService } from "../src/service.ts";

const vectorId = "t/2369479907:speech:0001";
const contentHash = "a".repeat(64);

function operation() {
  return {
    boundary: "request",
    request: { method: "POST", path: "/api/rag/chat" },
    correlation: { correlationId: "task7-supplemental-deadline" },
    signal: new AbortController().signal,
    deadline: "2026-09-07T23:59:59.000Z",
  };
}

function config() {
  return {
    embeddingModel: { provider: "openai", model: "text-embedding-3-small" },
    primaryModel: { provider: "silo", model: "openai-codex/gpt-5.6" },
    fallbackModel: { provider: "openai", model: "gpt-5.6" },
    allowFallback: true,
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

function commonDeps(overrides = {}) {
  return {
    embeddings: {
      embedQuery: async () => ({ values: Array(1536).fill(0.01), dimensions: 1536, model: "text-embedding-3-small" }),
      embedBatch: async () => [],
    },
    generation: {
      generate: async (_context, request) => ({
        text: request.context.map((source) => `Evidence [${source.sourceId}]`).join(" "),
        model: request.model,
        citedSourceIds: request.context.map((source) => source.sourceId),
      }),
    },
    search: { query: async () => [] },
    hydration: { getByVectorIds: async () => [] },
    history: { append: async () => {}, listForUser: async () => ({ items: [] }) },
    researchSources: {
      searchStructured: async () => [],
      listInterviewInventory: async () => [],
      getSummaries: async () => [],
      getTranscriptDetails: async () => [],
      searchEpisodes: async () => [],
      listEpisodes: async () => [],
    },
    logger: { write() {} },
    clock: () => new Date("2026-09-07T20:00:00.000Z"),
    config: config(),
    ...overrides,
  };
}

test("archive retrieval does not depend on the supplemental research projection", async () => {
  let summaryCalls = 0;
  const deps = commonDeps({
    search: {
      query: async () => [{
        vectorId,
        score: 0.91,
        sourceType: "episode_transcript",
        sourceId: "2369479907",
        contentHash,
        chunkIndex: 1,
      }],
    },
    hydration: {
      getByVectorIds: async () => [{
        vectorId,
        sourceType: "episode_transcript",
        sourceId: "2369479907",
        title: "SAS Chapel: Genesis 22:1-19",
        canonicalUrl: "/podcast/episodes?trackId=2369479907",
        text: "God tested Abraham and later provided a ram.",
        contentHash,
        chunkIndex: 1,
      }],
    },
    researchSources: {
      searchStructured: async () => [],
      listInterviewInventory: async () => [],
      getSummaries: async () => {
        summaryCalls += 1;
        throw new Error("archive retrieval must not require summaries");
      },
      getTranscriptDetails: async () => [],
      searchEpisodes: async () => [],
      listEpisodes: async () => [],
    },
  });

  const result = await createRagService(deps).answer(operation(), {
    userId: "user_a",
    scope: "archive",
    question: "What did Pastor Wood say about Abraham?",
    topK: 8,
  });

  assert.equal(summaryCalls, 0);
  assert.match(result.answer, /\[S1\]/u);
});

test("research supplemental reads share one absolute five-second deadline", async () => {
  const deadlines = [];
  const structured = {
    key: "episode_intelligence_items:9007199254740993",
    episodeId: "2369479907",
    sourceType: "structured.notable_quotes",
    title: "SAS Chapel: Genesis 22:1-19",
    publishDate: "2026-08-05",
    text: "Abraham obeyed despite uncertainty.",
    contentHash: "b".repeat(64),
    canonicalUrl: "/podcast/episodes?trackId=2369479907",
    speakers: ["Pastor Wood"],
    score: 0.8,
  };
  const deps = commonDeps({
    researchSources: {
      searchStructured: async (context) => {
        deadlines.push(context.deadline);
        return [structured];
      },
      listInterviewInventory: async () => [],
      getSummaries: async (context) => {
        deadlines.push(context.deadline);
        return [];
      },
      getTranscriptDetails: async (context) => {
        deadlines.push(context.deadline);
        return [];
      },
      searchEpisodes: async () => [],
      listEpisodes: async () => [],
    },
  });

  const result = await createRagService(deps).answer(operation(), {
    userId: "user_a",
    scope: "research",
    question: "How did Abraham obey?",
    topK: 16,
  });

  assert.match(result.answer, /\[S1\]/u);
  assert.deepEqual(deadlines, [
    "2026-09-07T20:00:05.000Z",
    "2026-09-07T20:00:05.000Z",
    "2026-09-07T20:00:05.000Z",
  ]);
});

import test from "node:test";
import assert from "node:assert/strict";

import { ServiceError } from "../../../packages/contracts/src/errors.ts";
import { buildCitationContext, validateCitations } from "../src/citations.ts";
import { createRequestContext } from "../src/context.ts";
import { createRagService } from "../src/service.ts";

const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const baselineVectorId = "t/2369479907:speech:0001";

function operation(overrides = {}) {
  return {
    boundary: "request",
    request: { method: "POST", path: "/api/rag/chat" },
    correlation: { correlationId: "synthetic-rag-service" },
    signal: new AbortController().signal,
    deadline: "2026-09-07T23:59:59.000Z",
    ...overrides,
  };
}

const vectorMatch = {
  vectorId: baselineVectorId,
  score: 0.91,
  sourceType: "episode_transcript",
  sourceId: "2369479907",
  contentHash: hash,
  chunkIndex: 1,
};

function documentFor(overrides = {}) {
  return {
    vectorId: baselineVectorId,
    sourceType: "episode_transcript",
    sourceId: "2369479907",
    title: "SAS Chapel: Genesis 22:1-19",
    canonicalUrl: "/podcast/episodes?trackId=2369479907",
    text: "God tested Abraham and later provided a ram.",
    contentHash: hash,
    chunkIndex: 1,
    sourceLocation: { startMs: 282000, endMs: 682000 },
    ...overrides,
  };
}

function episodeHit(overrides = {}) {
  return {
    trackId: "2369479907",
    title: "SAS Chapel: Genesis 22:1-19",
    publishDate: "2026-08-05",
    album: "SAS Chapel",
    category: "Sermon",
    detail: "Genesis 22",
    sourceFile: "2369479907.mp3",
    hasTranscript: true,
    hasIntelligence: true,
    hasVectors: true,
    hasPodtrac: true,
    hitTypes: ["transcript"],
    snippet: "God will provide the lamb",
    score: 0.42,
    ...overrides,
  };
}

function researchSource(overrides = {}) {
  return {
    key: "episode_intelligence_items:9007199254740993",
    episodeId: "2369479907",
    sourceType: "structured.notable_quotes",
    title: "SAS Chapel: Genesis 22:1-19",
    publishDate: "2026-08-05",
    text: "A structured source about Abraham's obedience.",
    contentHash: otherHash,
    canonicalUrl: "/podcast/episodes?trackId=2369479907",
    speakers: ["Pastor Wood"],
    score: 0.8,
    ...overrides,
  };
}

function config(overrides = {}) {
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
    ...overrides,
  };
}

function createDeps(options = {}) {
  const state = {
    embeddingCalls: 0,
    searchCalls: [],
    hydrationRequests: [],
    generationRequests: [],
    historyRecords: [],
    logs: [],
    listEpisodeCalls: [],
  };
  const repository = {
    searchStructured: options.researchSources?.searchStructured ?? (async () => []),
    listInterviewInventory: options.researchSources?.listInterviewInventory ?? (async () => []),
    getSummaries: options.researchSources?.getSummaries ?? (async () => []),
    getTranscriptDetails: options.researchSources?.getTranscriptDetails ?? (async () => []),
    searchEpisodes: options.researchSources?.searchEpisodes ?? (async () => []),
    listEpisodes: options.researchSources?.listEpisodes ?? (async (_context, input) => {
      state.listEpisodeCalls.push(input);
      return [];
    }),
  };
  const deps = {
    embeddings: {
      embedQuery: async (context, request) => {
        state.embeddingCalls += 1;
        if (options.embedQuery) return options.embedQuery(context, request, state);
        return { values: Array(1536).fill(0.01), dimensions: 1536, model: "text-embedding-3-small" };
      },
      embedBatch: async () => [],
    },
    generation: {
      generate: async (context, request) => {
        state.generationRequests.push(request);
        if (options.generate) return options.generate(context, request, state);
        const citedSourceIds = request.context.map((source) => source.sourceId);
        return {
          text: citedSourceIds.map((sourceId) => `Evidence [${sourceId}]`).join(" "),
          model: request.model,
          citedSourceIds,
        };
      },
    },
    search: {
      query: async (context, request) => {
        state.searchCalls.push(request);
        if (options.searchQuery) return options.searchQuery(context, request, state);
        return [vectorMatch];
      },
    },
    hydration: {
      getByVectorIds: async (context, ids) => {
        state.hydrationRequests.push([...ids]);
        if (options.hydrate) return options.hydrate(context, ids, state);
        return options.documents ?? [];
      },
    },
    history: {
      append: async (context, record) => {
        state.historyRecords.push(record);
        if (options.historyAppend) return options.historyAppend(context, record, state);
      },
      listForUser: options.historyList ?? (async () => ({ items: [] })),
    },
    researchSources: repository,
    logger: {
      write(context, record) {
        state.logs.push({ context, record });
      },
    },
    clock: options.clock ?? (() => new Date("2026-09-07T20:00:00.000Z")),
    config: config(options.config),
  };
  return { deps, state };
}

function vectorEvidence(overrides = {}) {
  return {
    kind: "vector",
    stableKey: baselineVectorId,
    vectorId: baselineVectorId,
    sourceType: "episode_transcript",
    sourceId: "2369479907",
    title: "SAS Chapel: Genesis 22:1-19",
    canonicalUrl: "/podcast/episodes?trackId=2369479907",
    text: "God tested Abraham and later provided a ram.",
    contentHash: hash,
    chunkIndex: 1,
    score: 0.91,
    speakers: [],
    ...overrides,
  };
}

test("RAG configuration preserves the retained route bounds", () => {
  for (const [key, minimum, maximum] of [
    ["archiveTopK", 1, 40],
    ["archiveMaxSources", 1, 40],
    ["researchSourceBudget", 8, 60],
    ["researchCandidateEpisodes", 1, 20],
    ["researchSummaryEpisodes", 0, 12],
    ["researchDetailExcerpts", 0, 60],
    ["researchMaxSources", 8, 80],
    ["researchInterviewInventoryLimit", 0, 120],
    ["researchInterviewMaxSources", 8, 120],
    ["writingTopK", 2, 12],
  ]) {
    for (const value of [minimum, maximum]) {
      const fixture = createDeps({ config: { [key]: value } });
      assert.doesNotThrow(() => createRagService(fixture.deps), `${key} should accept ${value}`);
    }
    for (const value of [minimum - 1, maximum + 1]) {
      const fixture = createDeps({ config: { [key]: value } });
      assert.throws(() => createRagService(fixture.deps), { code: "invalid_argument" }, `${key} should reject ${value}`);
    }
  }
});

test("zero-valued research lane limits disable those supplemental reads", async () => {
  const fixture = createDeps({
    config: {
      researchSummaryEpisodes: 0,
      researchDetailExcerpts: 0,
      researchInterviewInventoryLimit: 0,
    },
    researchSources: {
      searchStructured: async () => [researchSource()],
      listInterviewInventory: async () => { throw new Error("inventory lane must be disabled"); },
      getSummaries: async () => { throw new Error("summary lane must be disabled"); },
      getTranscriptDetails: async () => { throw new Error("detail lane must be disabled"); },
    },
  });

  const result = await createRagService(fixture.deps).answer(operation(), {
    userId: "user_a",
    scope: "research",
    question: "Who did Pastor Wood interview about Abraham?",
  });

  assert.match(result.answer, /\[S1\]/u);
  assert.equal(result.coverageNote, "Measured research coverage: structured=1, semanticEpisode=0, devotional=0, resource=0.");
  assert.equal("escalated" in result, false);
  assert.equal("detailEpisodeIds" in result, false);
});

test("answer requests retain scope-specific minimum topK values", async () => {
  const research = createDeps();
  await createRagService(research.deps).answer(operation(), {
    userId: "user_a",
    scope: "research",
    question: "How did Abraham obey?",
    topK: 1,
  });
  assert.deepEqual(research.state.searchCalls.map((request) => request.topK), [8, 8, 8]);

  const writing = createDeps();
  await createRagService(writing.deps).answer(operation(), {
    userId: "user_a",
    scope: "writing",
    articleId: "pastorwood:14238",
    question: "What does this writing say about faith?",
    topK: 1,
  });
  assert.equal(writing.state.searchCalls[0].topK, 2);
});

test("writing topK uses the configured default without reducing valid overrides", async () => {
  for (const [requested, expected] of [[undefined, 8], [2, 2], [12, 12]]) {
    const fixture = createDeps();
    await createRagService(fixture.deps).answer(operation(), {
      userId: "user_a",
      scope: "writing",
      articleId: "pastorwood:14238",
      question: "What does this writing say about faith?",
      ...(requested === undefined ? {} : { topK: requested }),
    });
    assert.equal(fixture.state.searchCalls[0].topK, expected);
  }
});

test("a semantic hit with no authoritative hydration never reaches generation", async () => {
  const fixture = createDeps();
  const service = createRagService(fixture.deps);
  const result = await service.answer(operation(), {
    userId: "user_a",
    scope: "archive",
    question: "What did Pastor Wood say about Abraham?",
    topK: 1,
  });

  assert.equal(fixture.state.generationRequests.length, 0);
  assert.equal(result.answer, "I could not find enough indexed sermon content to answer that question. Try a shorter phrasing or include a clearer topic reference.");
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.topEpisodeIds, []);
});

test("a hydration dependency failure remains an error and never becomes a no-source answer", async () => {
  const fixture = createDeps({
    hydrate: async () => {
      throw new ServiceError({ code: "dependency_unavailable", message: "Synthetic hydration unavailable.", retryable: true });
    },
  });
  const service = createRagService(fixture.deps);

  await assert.rejects(
    service.answer(operation(), {
      userId: "user_a",
      scope: "archive",
      question: "What did Pastor Wood say about Abraham?",
      topK: 1,
    }),
    { code: "dependency_unavailable" },
  );
  assert.equal(fixture.state.generationRequests.length, 0);
});

test("request context clamps the total service deadline to 55 seconds", () => {
  const clamped = createRequestContext({
    boundary: "request",
    request: { method: "POST", path: "/api/rag/chat" },
    correlation: { correlationId: "deadline-test" },
    signal: new AbortController().signal,
  }, () => new Date("2026-09-07T20:00:00.000Z"));
  assert.equal(clamped.deadline, "2026-09-07T20:00:55.000Z");
});

test("citation context keeps distinct chunks from one episode and validates exact label agreement", () => {
  const built = buildCitationContext([
    vectorEvidence(),
    vectorEvidence({ stableKey: "t/2369479907:speech:0003", vectorId: "t/2369479907:speech:0003", chunkIndex: 3, text: "God will provide the lamb." }),
  ], "archive");
  assert.deepEqual(built.context.map((source) => source.sourceId), ["S1", "S2"]);
  assert.equal(built.labelMap.get("S1").stableKey, baselineVectorId);
  assert.equal(built.labelMap.get("S2").stableKey, "t/2369479907:speech:0003");
  assert.deepEqual(validateCitations("Abraham obeyed [S1] and trusted provision [S2].", ["S1", "S2"], built.labelMap).map((source) => source.stableKey), [baselineVectorId, "t/2369479907:speech:0003"]);
  assert.throws(() => validateCitations("Unknown [S99].", ["S99"], built.labelMap), { code: "dependency_unavailable" });
  assert.throws(() => validateCitations("Only [S1].", [], built.labelMap), { code: "dependency_unavailable" });
  assert.throws(() => validateCitations("No citation.", ["S1"], built.labelMap), { code: "dependency_unavailable" });
});

test("non-vector evidence keeps its exact record key and multibyte context remains bounded", () => {
  const record = {
    kind: "record",
    stableKey: "transcript_segments:segment-7-10",
    researchKey: "transcript_segments:segment-7-10",
    sourceType: "detail.transcript",
    sourceId: "2369479907",
    title: "SAS Chapel: Genesis 22:1-19",
    canonicalUrl: "/podcast/episodes?trackId=2369479907",
    text: "God will provide the lamb.",
    contentHash: otherHash,
    score: 0.8,
    speakers: ["Pastor Wood"],
  };
  const built = buildCitationContext([record], "research");
  assert.equal(built.labelMap.get("S1").researchKey, record.researchKey);

  const many = Array.from({ length: 80 }, (_, index) => vectorEvidence({
    stableKey: `t/2369479907:speech:${String(index).padStart(4, "0")}`,
    vectorId: `t/2369479907:speech:${String(index).padStart(4, "0")}`,
    chunkIndex: index,
    text: "😀".repeat(1000),
  }));
  const bounded = buildCitationContext(many, "research");
  assert.ok(bounded.context.length > 0 && bounded.context.length <= 40);
  assert.ok(new TextEncoder().encode(JSON.stringify(bounded.context)).byteLength <= 48 * 1024);
});

test("archive answer uses one embedding, validates hydrated identity, cites stable sources, and appends history", async () => {
  const fixture = createDeps({ documents: [documentFor()] });
  const service = createRagService(fixture.deps);
  const result = await service.answer(operation(), {
    userId: "user_a",
    scope: "archive",
    question: "What did Pastor Wood say about Abraham?",
    topK: 8,
  });

  assert.equal(fixture.state.embeddingCalls, 1);
  assert.equal(fixture.state.searchCalls.length, 1);
  assert.equal(fixture.state.generationRequests.length, 1);
  assert.equal(result.sources[0].citationId, "S1");
  assert.equal(result.sources[0].segmentId, "2369479907:speech:0001");
  assert.deepEqual(result.topEpisodeIds, ["2369479907"]);
  assert.match(result.interactionId, /^[0-9a-f-]{36}$/u);
  assert.equal(fixture.state.historyRecords.length, 1);
  assert.equal(fixture.state.historyRecords[0].researchCitations[0].kind, "vector");
  assert.equal(fixture.state.historyRecords[0].researchCitations[0].citation.vectorId, baselineVectorId);
});

for (const [label, override] of [
  ["source type", { sourceType: "episode_intelligence" }],
  ["source identity", { sourceId: "123" }],
  ["content hash", { contentHash: otherHash }],
  ["chunk index", { chunkIndex: 3 }],
]) {
  test(`stale hydration ${label} mismatch is excluded before generation`, async () => {
    const fixture = createDeps({ documents: [documentFor(override)] });
    const result = await createRagService(fixture.deps).answer(operation(), {
      userId: "user_a",
      scope: "archive",
      question: "What did Pastor Wood say about Abraham?",
      topK: 8,
    });
    assert.equal(result.sources.length, 0);
    assert.equal(fixture.state.generationRequests.length, 0);
    assert.equal(fixture.state.historyRecords.length, 1);
    assert.equal(fixture.state.historyRecords[0].model, "no-source");
    assert.deepEqual(fixture.state.historyRecords[0].citations, []);
  });
}

test("service independently rejects provider citation mismatch and writes no history", async () => {
  const fixture = createDeps({
    documents: [documentFor()],
    generate: async (_context, request) => ({ text: "Unsupported [S99]", model: request.model, citedSourceIds: ["S99"] }),
  });
  await assert.rejects(createRagService(fixture.deps).answer(operation(), {
    userId: "user_a", scope: "archive", question: "Abraham?", topK: 8,
  }), { code: "dependency_unavailable" });
  assert.equal(fixture.state.historyRecords.length, 0);
});

test("one configured OpenAI fallback is used only for retryable failures with at least ten seconds remaining", async () => {
  const fixture = createDeps({
    documents: [documentFor()],
    generate: async (_context, request, state) => {
      if (state.generationRequests.length === 1) throw new ServiceError({ code: "dependency_unavailable", message: "Synthetic primary failure.", retryable: true });
      assert.equal(request.model.provider, "openai");
      return { text: "Fallback evidence [S1]", model: request.model, citedSourceIds: ["S1"] };
    },
  });
  const result = await createRagService(fixture.deps).answer(operation(), {
    userId: "user_a", scope: "archive", question: "Abraham?", topK: 8,
  });
  assert.equal(fixture.state.generationRequests.length, 2);
  assert.equal(result.provider, "openai");

  const short = createDeps({
    documents: [documentFor()],
    generate: async () => { throw new ServiceError({ code: "dependency_unavailable", message: "Synthetic primary failure.", retryable: true }); },
  });
  await assert.rejects(createRagService(short.deps).answer(operation({ deadline: "2026-09-07T20:00:09.000Z" }), {
    userId: "user_a", scope: "archive", question: "Abraham?", topK: 8,
  }), { code: "dependency_unavailable" });
  assert.equal(short.state.generationRequests.length, 1);
});

test("non-retryable generation errors never invoke fallback", async () => {
  const fixture = createDeps({
    documents: [documentFor()],
    generate: async () => { throw new ServiceError({ code: "forbidden", message: "Synthetic denial.", retryable: false }); },
  });
  await assert.rejects(createRagService(fixture.deps).answer(operation(), {
    userId: "user_a", scope: "archive", question: "Abraham?", topK: 8,
  }), { code: "forbidden" });
  assert.equal(fixture.state.generationRequests.length, 1);
});

test("history failure preserves a valid answer, returns empty interactionId, and logs no question or raw error", async () => {
  const question = "What did Pastor Wood say about Abraham?";
  const fixture = createDeps({
    documents: [documentFor()],
    historyAppend: async () => { throw new Error(`raw history failure: ${question}`); },
  });
  const result = await createRagService(fixture.deps).answer(operation(), {
    userId: "user_a", scope: "archive", question, topK: 8,
  });
  assert.match(result.answer, /\[S1\]/u);
  assert.equal(result.interactionId, "");
  assert.ok(fixture.state.logs.some(({ record }) => record.event === "rag.history_append_failed"));
  assert.doesNotMatch(JSON.stringify(fixture.state.logs), /What did Pastor Wood|raw history failure/u);
});

test("question byte and character bounds fail before embedding", async () => {
  for (const question of ["x".repeat(8001), "😀".repeat(3000)]) {
    const fixture = createDeps({ documents: [documentFor()] });
    await assert.rejects(createRagService(fixture.deps).answer(operation(), {
      userId: "user_a", scope: "archive", question, topK: 8,
    }), { code: "invalid_argument" });
    assert.equal(fixture.state.embeddingCalls, 0);
  }
});

test("text-only and title episode searches perform no embedding or semantic query", async () => {
  for (const input of [
    { query: "provide", limit: 10, scope: "all", sort: "relevance", mode: "text" },
    { query: "Genesis", limit: 10, scope: "title", sort: "relevance", mode: "hybrid" },
  ]) {
    const fixture = createDeps({ researchSources: { searchEpisodes: async () => [episodeHit()] } });
    const result = await createRagService(fixture.deps).searchEpisodes(operation(), input);
    assert.equal(result.results.length, 1);
    assert.equal(fixture.state.embeddingCalls, 0);
    assert.equal(fixture.state.searchCalls.length, 0);
  }
});

test("hybrid episode search merges semantic evidence into canonical text hits", async () => {
  const fixture = createDeps({
    documents: [documentFor({ text: "God will provide the lamb." })],
    researchSources: { searchEpisodes: async () => [episodeHit()] },
  });
  const result = await createRagService(fixture.deps).searchEpisodes(operation(), {
    query: "provide the lamb", limit: 10, scope: "all", sort: "relevance", mode: "hybrid",
  });
  assert.equal(fixture.state.embeddingCalls, 1);
  assert.equal(fixture.state.searchCalls.length, 1);
  assert.equal(result.results[0].trackId, "2369479907");
  assert.ok(result.results[0].hitTypes.includes("semantic.vector"));
  assert.equal(result.results[0].score, 0.91);
  assert.match(result.results[0].snippet, /provide the lamb/u);
});

test("hybrid semantic dependency failure retains text hits with safe degradation metadata", async () => {
  const fixture = createDeps({
    searchQuery: async () => { throw new ServiceError({ code: "dependency_unavailable", message: "raw vector failure", retryable: true }); },
    researchSources: { searchEpisodes: async () => [episodeHit()] },
  });
  const result = await createRagService(fixture.deps).searchEpisodes(operation(), {
    query: "provide", limit: 10, scope: "all", sort: "relevance", mode: "hybrid",
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.degraded, true);
  assert.equal(result.degradation, "semantic_unavailable");
  assert.doesNotMatch(JSON.stringify(result), /raw vector failure/u);
});

test("semantic-only episode hits resolve canonical archive fields instead of fabricating them", async () => {
  const canonical = episodeHit({ hitTypes: [], snippet: "", score: 0 });
  const fixture = createDeps({
    documents: [documentFor({ text: "Semantic Abraham evidence." })],
    researchSources: {
      searchEpisodes: async () => [],
      listEpisodes: async (_context, input) => input.episodeId === "2369479907" ? [canonical] : [],
    },
  });
  const result = await createRagService(fixture.deps).searchEpisodes(operation(), {
    query: "Abraham", limit: 10, scope: "all", sort: "relevance", mode: "hybrid",
  });
  assert.equal(result.results[0].album, canonical.album);
  assert.equal(result.results[0].sourceFile, canonical.sourceFile);
  assert.ok(result.results[0].hitTypes.includes("semantic.vector"));
});

test("research answer reuses one embedding across at most three semantic lanes and preserves cross-corpus stable citations", async () => {
  const episode = vectorMatch;
  const devotional = {
    vectorId: "a/pastorwood_devotional:14238:0002",
    score: 0.88,
    sourceType: "article",
    sourceId: "pastorwood:14238",
    contentHash: "c".repeat(64),
    chunkIndex: 2,
  };
  const resource = {
    vectorId: "a/pastorwood_resource:14239:0001",
    score: 0.7,
    sourceType: "article",
    sourceId: "pastorwood:14239",
    contentHash: "d".repeat(64),
    chunkIndex: 1,
  };
  const documents = [
    documentFor(),
    documentFor({ vectorId: devotional.vectorId, sourceType: "article", sourceId: devotional.sourceId, title: "Acting in Faith", canonicalUrl: "/writings/14238", text: "Fear of failure can create paralysis and indecision.", contentHash: devotional.contentHash, chunkIndex: 2 }),
    documentFor({ vectorId: resource.vectorId, sourceType: "article", sourceId: resource.sourceId, title: "Resource", canonicalUrl: "/writings/14239", text: "A resource about faith.", contentHash: resource.contentHash, chunkIndex: 1 }),
  ];
  const detail = researchSource({ key: "transcript_segments:segment-2369479907-1", sourceType: "detail.transcript", text: "Abraham obeyed despite uncertainty." });
  const fixture = createDeps({
    searchQuery: async (_context, request) => {
      const subtype = request.filter?.contentSubtypes?.[0];
      if (subtype === "pastorwood_devotional") return [devotional];
      if (subtype === "pastorwood_resource") return [resource];
      return [episode];
    },
    hydrate: async (_context, ids) => documents.filter((document) => ids.includes(document.vectorId)),
    researchSources: {
      searchStructured: async () => [researchSource()],
      getSummaries: async () => [researchSource({ key: "episode_intelligence:2369479907", sourceType: "structured.summary", text: "Episode orientation." })],
      getTranscriptDetails: async () => [detail],
    },
  });
  const result = await createRagService(fixture.deps).answer(operation(), {
    userId: "user_a",
    scope: "research",
    question: "How does Pastor Wood connect acting in faith despite fear of failure with Abraham's obedience in Genesis 22?",
    topK: 16,
  });
  assert.equal(fixture.state.embeddingCalls, 1);
  assert.equal(fixture.state.searchCalls.length, 3);
  assert.ok(fixture.state.hydrationRequests[0].length <= 100);
  assert.ok(result.sources.some((source) => source.segmentId === "2369479907:speech:0001"));
  assert.ok(result.sources.some((source) => source.segmentId === "pastorwood_devotional:14238:0002"));
  assert.equal(result.escalated, true);
  assert.deepEqual(result.detailEpisodeIds, ["2369479907"]);
  const persisted = fixture.state.historyRecords[0].researchCitations;
  assert.ok(persisted.some((citation) => citation.kind === "vector" && citation.citation.vectorId === baselineVectorId));
  assert.ok(persisted.some((citation) => citation.kind === "vector" && citation.citation.vectorId === devotional.vectorId));
  assert.ok(persisted.some((citation) => citation.kind === "record" && citation.key === detail.key));
});

test("research hydration reserves each semantic lane before dropping the lowest-ranked candidates", async () => {
  const matches = (family, sourceType, scoreBase) => Array.from({ length: 60 }, (_, index) => ({
    vectorId: sourceType === "article"
      ? `a/${family}:${10_000 + index}:0001`
      : `t/${10_000 + index}:speech:0001`,
    score: scoreBase - index / 1_000,
    sourceType,
    sourceId: sourceType === "article" ? `pastorwood:${10_000 + index}` : String(10_000 + index),
    contentHash: hash,
    chunkIndex: 1,
  }));
  const episode = matches("episode", "episode_transcript", 0.99);
  const devotional = matches("pastorwood_devotional", "article", 0.9);
  const resource = matches("pastorwood_resource", "article", 0.8);
  const fixture = createDeps({
    config: { researchSourceBudget: 60 },
    searchQuery: async (_context, request) => {
      const subtype = request.filter?.contentSubtypes?.[0];
      if (subtype === "pastorwood_devotional") return devotional;
      if (subtype === "pastorwood_resource") return resource;
      return episode;
    },
    researchSources: { searchStructured: async () => [researchSource()] },
  });

  await createRagService(fixture.deps).answer(operation(), {
    userId: "user_a",
    scope: "research",
    question: "How does faith connect these sources?",
    topK: 60,
  });

  const hydratedIds = fixture.state.hydrationRequests[0];
  assert.equal(hydratedIds.length, 100);
  assert.ok(hydratedIds.includes(episode[0].vectorId));
  assert.ok(hydratedIds.includes(devotional[0].vectorId));
  assert.ok(hydratedIds.includes(resource[0].vectorId));
  assert.equal(hydratedIds.includes(devotional[39].vectorId), false);
  assert.equal(hydratedIds.includes(resource[1].vectorId), false);
});

test("parent cancellation is never converted into semantic degradation or history", async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = createDeps({ researchSources: { searchEpisodes: async () => [episodeHit()] } });
  await assert.rejects(createRagService(fixture.deps).searchEpisodes(operation({ signal: controller.signal }), {
    query: "Abraham", limit: 10, scope: "all", sort: "relevance", mode: "hybrid",
  }), { code: "cancelled" });
  assert.equal(fixture.state.historyRecords.length, 0);
});

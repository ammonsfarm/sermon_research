export const VECTORIZE_METADATA_KEYS = [
  "source_type",
  "source_id",
  "content_subtype",
  "published_day",
  "content_hash",
  "chunk_index",
] as const;

export type IndexingSourceType = "episode_transcript" | "episode_intelligence" | "article";

export interface FrozenVectorizeMetadata {
  readonly source_type: IndexingSourceType;
  readonly source_id: string;
  readonly content_subtype: string;
  readonly published_day: number;
  readonly content_hash: string;
  readonly chunk_index: number;
}

export interface IndexingChunk {
  readonly id: string;
  readonly text: string;
  readonly contentHash: string;
  readonly metadata: FrozenVectorizeMetadata;
}

export interface CompleteIndexingManifest {
  readonly complete: true;
  readonly chunks: readonly IndexingChunk[];
  readonly ids: readonly string[];
  readonly idDigest: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const EPISODE_ID = /^(?:\d+|sa_\d+|wp-sermon:\d+|cms_[A-Za-z0-9_-]+)$/u;
const ARTICLE_ID = /^(?:pastorwood:[1-9]\d*|cms:[A-Za-z0-9._-]+)$/u;
const ARTICLE_SOURCE_TYPE = /^[a-z][a-z0-9_]{0,63}$/u;

function invalid(message: string): never {
  throw new Error(message);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertHash(value: string): void {
  if (!HASH.test(value)) invalid("Chunk content hashes must be unprefixed lowercase SHA-256 digests.");
}

function assertVectorId(value: string, family: "t/" | "i/" | "a/"): void {
  if (typeof value !== "string" || !value.startsWith(family) || value.length === family.length || utf8Bytes(value) > 64) {
    invalid("Vector IDs must have the correct family prefix and fit Vectorize's 64-byte limit.");
  }
}

function assertEpisodeId(value: string): void {
  if (!EPISODE_ID.test(value) || utf8Bytes(value) > 64) invalid("Episode IDs are invalid.");
}

function assertArticleId(value: string): void {
  if (!ARTICLE_ID.test(value) || utf8Bytes(value) > 64) invalid("Article IDs are invalid.");
}

function assertPublishedDay(value: number): void {
  if (!Number.isSafeInteger(value) || value < 10000101 || value > 99991231) invalid("published_day must be YYYYMMDD.");
  const year = Math.floor(value / 10_000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) invalid("published_day must be a calendar date.");
}

function assertChunkIndex(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid("Chunk indexes must be non-negative safe integers.");
}

function scalarLength(value: string): number {
  return Array.from(value).length;
}

function scalarSlice(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

const TRANSCRIPT_CONTEXT_TERMS = ["Wears Valley Ranch", "Jim Wood", "Susan Wood", "Clayton Wood", "St. Andrew's School", "Covenant Community Church", "Camp Arrowwood", "Legacy 145", "Abiding in Christ"] as const;
const WEARS_VALLEY = /\b(?:weir(?:['’]s|s)?|wear|ware|where(?:['’]s))\s+valley\b(?<ranch>\s+ranch\b)?|\bwhere\s+valley(?<whereRanch>\s+ranch\b)/giu;

function canonicalTranscriptTerminology(value: string): string {
  let normalized = value;
  for (const term of TRANSCRIPT_CONTEXT_TERMS) {
    const surface = term.replaceAll(" ", "_");
    normalized = normalized.replace(new RegExp(`\\b${surface.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "giu"), term);
  }
  return normalized.replace(WEARS_VALLEY, (...args: unknown[]) => {
    const groups = args.at(-1) as { ranch?: string; whereRanch?: string } | undefined;
    return groups?.ranch || groups?.whereRanch ? "Wears Valley Ranch" : "Wears Valley";
  });
}

function splitLongSpeechLine(line: string, maximum: number): readonly string[] {
  if (scalarLength(line) <= maximum) return [line];
  const parts: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const word of line.split(/\s+/u)) {
    const wordLength = scalarLength(word);
    if (wordLength > maximum) {
      if (current.length > 0) parts.push(current.join(" "));
      current = [];
      currentLength = 0;
      for (let start = 0; start < wordLength; start += maximum) parts.push(scalarSlice(word, start, start + maximum));
      continue;
    }
    const nextLength = currentLength + wordLength + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && nextLength > maximum) {
      parts.push(current.join(" "));
      current = [word];
      currentLength = wordLength;
    } else {
      current.push(word);
      currentLength = nextLength;
    }
  }
  if (current.length > 0) parts.push(current.join(" "));
  return parts;
}

export function materializeSpeechChunks(input: {
  readonly episode: { readonly trackId: string; readonly title: string; readonly publishedDate: string };
  readonly segments: readonly { readonly speakerName?: string; readonly speakerId?: string; readonly text?: string; readonly segmentType?: string; readonly startTime?: string; readonly endTime?: string }[];
  readonly maxCharacters: number;
}): readonly { readonly customId: string; readonly text: string }[] {
  assertEpisodeId(input.episode.trackId);
  if (!Number.isSafeInteger(input.maxCharacters) || input.maxCharacters < 500) invalid("Speech chunk maximum must be at least 500 characters.");
  const result: { customId: string; text: string }[] = [];
  let lines: string[] = [];
  let speakers = new Set<string>();
  let start = "";
  let end = "";
  const flush = () => {
    if (lines.length === 0) return;
    const customId = `${input.episode.trackId}:speech:${result.length.toString().padStart(4, "0")}`;
    const speakerList = speakers.size === 0 ? "Unknown" : [...speakers].sort().join(", ");
    result.push({ customId, text: [`Episode: ${input.episode.title.trim()}`, `Track ID: ${input.episode.trackId}`, `Publish Date: ${input.episode.publishedDate.trim()}`, `Time Range: ${start}-${end}`, `Speakers: ${speakerList}`, "", ...lines].join("\n") });
    lines = []; speakers = new Set(); start = ""; end = "";
  };
  const safeLineCharacters = Math.max(500, input.maxCharacters - 500);
  for (const segment of input.segments) {
    if (!["speech", "scripture_reading", "prayer"].includes(segment.segmentType ?? "")) continue;
    const speaker = (segment.speakerName || segment.speakerId || "Unknown").trim();
    const text = canonicalTranscriptTerminology((segment.text ?? "").split(/\s+/u).filter(Boolean).join(" "));
    const line = `${speaker}: ${text}`;
    if (line.endsWith(":")) continue;
    for (const part of splitLongSpeechLine(line, safeLineCharacters)) {
      if (lines.length > 0 && lines.reduce((sum, item) => sum + scalarLength(item) + 1, 0) + scalarLength(part) > input.maxCharacters) flush();
      if (lines.length === 0) start = segment.startTime ?? "";
      end = segment.endTime ?? "";
      speakers.add(speaker);
      lines.push(part);
    }
  }
  flush();
  return result;
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function articleHash(sourceType: string, postId: number, chunkIndex: number, text: string): Promise<string> {
  return sha256(`${sourceType}\0${postId.toString()}\0${chunkIndex.toString()}\0${text}\0`);
}

function splitLongParagraph(paragraph: string, maxCharacters: number): readonly string[] {
  if (scalarLength(paragraph) <= maxCharacters) return [paragraph];
  const sentences = paragraph.split(/(?<=[.!?])\s+/u);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (!sentence) continue;
    const candidate = `${current} ${sentence}`.trim();
    if (scalarLength(candidate) <= maxCharacters) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (scalarLength(sentence) <= maxCharacters) {
      current = sentence;
      continue;
    }
    for (let start = 0; start < scalarLength(sentence); start += maxCharacters) {
      const part = scalarSlice(sentence, start, start + maxCharacters).trim();
      if (part) chunks.push(part);
    }
    current = "";
  }
  if (current) chunks.push(current);
  return chunks;
}

export function sourceCompatibleArticleChunks(text: string, maxCharacters: number): readonly string[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 800) invalid("Article chunks must use a source-compatible maximum of at least 800 characters.");
  const paragraphs = text.split(/\n{2,}/u).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const paragraph of paragraphs) {
    for (const part of splitLongParagraph(paragraph, maxCharacters)) {
      const partLength = scalarLength(part);
      if (current.length > 0 && currentLength + partLength + 2 > maxCharacters) {
        chunks.push(current.join("\n\n").trim());
        current = [];
        currentLength = 0;
      }
      current.push(part);
      currentLength += partLength + 2;
    }
  }
  if (current.length > 0) chunks.push(current.join("\n\n").trim());
  return chunks;
}

function metadata(
  sourceType: IndexingSourceType,
  sourceId: string,
  contentSubtype: string,
  publishedDay: number,
  contentHash: string,
  chunkIndex: number,
): FrozenVectorizeMetadata {
  if (typeof contentSubtype !== "string" || contentSubtype.length === 0 || contentSubtype.trim() !== contentSubtype || utf8Bytes(contentSubtype) > 64) {
    invalid("content_subtype must be a non-empty normalized string.");
  }
  assertPublishedDay(publishedDay);
  assertHash(contentHash);
  assertChunkIndex(chunkIndex);
  return {
    source_type: sourceType,
    source_id: sourceId,
    content_subtype: contentSubtype,
    published_day: publishedDay,
    content_hash: contentHash,
    chunk_index: chunkIndex,
  };
}

export function assertFrozenVectorizeMetadata(value: unknown): asserts value is FrozenVectorizeMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Vectorize metadata must be an object.");
  const metadataValue = value as Record<string, unknown>;
  if (Object.keys(metadataValue).length !== VECTORIZE_METADATA_KEYS.length || !VECTORIZE_METADATA_KEYS.every((key) => key in metadataValue)) {
    invalid("Vectorize metadata must contain exactly the six frozen keys.");
  }
  if (metadataValue.source_type !== "episode_transcript" && metadataValue.source_type !== "episode_intelligence" && metadataValue.source_type !== "article") {
    invalid("Vectorize metadata source_type is invalid.");
  }
  if (typeof metadataValue.source_id !== "string") invalid("Vectorize metadata source_id is invalid.");
  if (metadataValue.source_type === "article") assertArticleId(metadataValue.source_id);
  else assertEpisodeId(metadataValue.source_id);
  if (typeof metadataValue.content_subtype !== "string" || metadataValue.content_subtype.length === 0 || metadataValue.content_subtype.trim() !== metadataValue.content_subtype || utf8Bytes(metadataValue.content_subtype) > 64) {
    invalid("Vectorize metadata content_subtype is invalid.");
  }
  assertPublishedDay(metadataValue.published_day as number);
  assertHash(metadataValue.content_hash as string);
  assertChunkIndex(metadataValue.chunk_index as number);
}

export async function createArticleManifest(input: {
  readonly sourceType: string;
  readonly postId: number;
  readonly contentSubtype: string;
  readonly publishedDay: number;
  readonly text: string;
  readonly maxCharacters: number;
}): Promise<CompleteIndexingManifest> {
  if (!ARTICLE_SOURCE_TYPE.test(input.sourceType) || !Number.isSafeInteger(input.postId) || input.postId < 1) {
    invalid("Article source type or post ID is invalid.");
  }
  const sourceId = `pastorwood:${input.postId}`;
  assertArticleId(sourceId);
  const chunks = await Promise.all(sourceCompatibleArticleChunks(input.text, input.maxCharacters).map(async (text, chunkIndex) => {
    const customId = `${input.sourceType}:${input.postId}:${chunkIndex.toString().padStart(4, "0")}`;
    const id = `a/${customId}`;
    assertVectorId(id, "a/");
    const contentHash = await articleHash(input.sourceType, input.postId, chunkIndex, text);
    return { id, text, contentHash, metadata: metadata("article", sourceId, input.contentSubtype, input.publishedDay, contentHash, chunkIndex) };
  }));
  return createCompleteIndexingManifest(chunks);
}

async function preserveChunks(
  family: "t/" | "i/",
  sourceType: "episode_transcript" | "episode_intelligence",
  input: {
    readonly episodeId: string;
    readonly contentSubtype: string;
    readonly publishedDay: number;
    readonly chunks: readonly { readonly customId: string; readonly text: string; readonly contentHash?: string; readonly chunkIndex?: number }[];
  },
): Promise<IndexingChunk[]> {
  assertEpisodeId(input.episodeId);
  const ids = new Set<string>();
  return Promise.all(input.chunks.map(async (chunk) => {
    if (typeof chunk.text !== "string" || chunk.text.length === 0) invalid("Preserved chunks must have exact non-empty text.");
    const id = `${family}${chunk.customId}`;
    assertVectorId(id, family);
    if (ids.has(id)) invalid("Chunk manifests cannot contain duplicate vector IDs.");
    ids.add(id);
    const contentHash = chunk.contentHash ?? (sourceType === "episode_transcript" ? await sha256(chunk.text) : invalid("Intelligence chunks must preserve a source-generated content hash."));
    const transcriptOrdinal = sourceType === "episode_transcript" ? /:(\d+)$/u.exec(chunk.customId)?.[1] : undefined;
    const sourceChunkIndex = sourceType === "episode_transcript"
      ? Number(transcriptOrdinal)
      : chunk.chunkIndex ?? 0;
    assertChunkIndex(sourceChunkIndex);
    assertHash(contentHash);
    return {
      id,
      text: chunk.text,
      contentHash,
      metadata: metadata(sourceType, input.episodeId, input.contentSubtype, input.publishedDay, contentHash, sourceChunkIndex),
    };
  }));
}

export async function createTranscriptManifest(input: {
  readonly episodeId: string;
  readonly contentSubtype: string;
  readonly publishedDay: number;
  readonly chunks: readonly { readonly customId: string; readonly text: string; readonly contentHash?: string; readonly chunkIndex?: number }[];
}): Promise<CompleteIndexingManifest> {
  return createCompleteIndexingManifest(await preserveChunks("t/", "episode_transcript", input));
}

export async function createIntelligenceManifest(input: {
  readonly episodeId: string;
  readonly contentSubtype: string;
  readonly publishedDay: number;
  readonly chunks: readonly { readonly customId: string; readonly text: string; readonly contentHash?: string; readonly chunkIndex?: number }[];
}): Promise<CompleteIndexingManifest> {
  return createCompleteIndexingManifest(await preserveChunks("i/", "episode_intelligence", input));
}

export async function createCompleteIndexingManifest(chunks: readonly IndexingChunk[]): Promise<CompleteIndexingManifest> {
  const sorted = [...chunks].sort((left, right) => left.id.localeCompare(right.id));
  const ids = sorted.map((chunk) => chunk.id);
  if (new Set(ids).size !== ids.length) invalid("Chunk manifests cannot contain duplicate vector IDs.");
  for (const chunk of sorted) {
    if (typeof chunk.text !== "string" || chunk.text.length === 0) invalid("Chunks must have non-empty text.");
    const family = chunk.metadata.source_type === "episode_transcript" ? "t/" : chunk.metadata.source_type === "episode_intelligence" ? "i/" : "a/";
    assertVectorId(chunk.id, family);
    assertFrozenVectorizeMetadata(chunk.metadata);
    assertHash(chunk.contentHash);
    if (chunk.metadata.content_hash !== chunk.contentHash) invalid("Chunk metadata must carry the exact chunk content hash.");
  }
  return { complete: true, chunks: sorted, ids, idDigest: await sha256(ids.join("\0")) };
}

export function selectStaleVectorIds(
  previous: Readonly<{ complete: boolean; ids: readonly string[] }> ,
  next: Readonly<{ complete: boolean; ids: readonly string[] }> ,
): readonly string[] {
  if (previous.complete !== true || next.complete !== true) invalid("Stale-vector deletion requires complete manifests.");
  const nextIds = new Set(next.ids);
  return [...new Set(previous.ids)].filter((id) => !nextIds.has(id)).sort((left, right) => left.localeCompare(right));
}

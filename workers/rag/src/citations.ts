import { ServiceError } from "../../../packages/contracts/src/errors.ts";
import type { CitationContext } from "../../../packages/contracts/src/ai.ts";

export type EvidenceMode = "archive" | "episode" | "research" | "writing";

export interface EvidenceSource {
  readonly kind: "vector" | "record";
  readonly stableKey: string;
  readonly vectorId?: string;
  readonly researchKey?: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly episodeId?: string;
  readonly articleId?: string;
  readonly title: string;
  readonly publishDate?: string;
  readonly canonicalUrl: string;
  readonly text: string;
  readonly contentHash: string;
  readonly chunkIndex?: number;
  readonly sourceLocation?: { readonly startMs?: number; readonly endMs?: number; readonly label?: string };
  readonly speakers: readonly string[];
  readonly score: number;
  readonly lane?: string;
}

export interface CitationBuildResult {
  readonly context: readonly CitationContext[];
  readonly labelMap: ReadonlyMap<string, EvidenceSource>;
  readonly sources: readonly EvidenceSource[];
}

const EVIDENCE_BYTES = 48 * 1024;
const MODE_MAX_SOURCES: Readonly<Record<EvidenceMode, number>> = {
  archive: 16,
  episode: 16,
  research: 40,
  writing: 16,
};
const MODE_EXCERPT_CHARS: Readonly<Record<EvidenceMode, number>> = {
  archive: 850,
  episode: 850,
  research: 720,
  writing: 720,
};

function unavailable(): never {
  throw new ServiceError({ code: "dependency_unavailable", message: "Generated citations could not be validated." });
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateCodePoints(value: string, maximum: number): string {
  const points = Array.from(value);
  if (points.length <= maximum) return value;
  return `${points.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function normalizedEvidence(source: EvidenceSource, mode: EvidenceMode): EvidenceSource | null {
  if (!source || typeof source !== "object" || (source.kind !== "vector" && source.kind !== "record")) unavailable();
  if (typeof source.stableKey !== "string" || !source.stableKey || typeof source.sourceId !== "string" || !source.sourceId) unavailable();
  if (typeof source.title !== "string" || typeof source.canonicalUrl !== "string" || !source.canonicalUrl || typeof source.text !== "string") unavailable();
  if (typeof source.contentHash !== "string" || !/^[0-9a-f]{64}$/u.test(source.contentHash)) unavailable();
  if (!Number.isFinite(source.score) || !Array.isArray(source.speakers) || source.speakers.some((speaker) => typeof speaker !== "string")) unavailable();
  if (source.kind === "vector" && (typeof source.vectorId !== "string" || source.vectorId !== source.stableKey)) unavailable();
  if (source.kind === "record" && (typeof source.researchKey !== "string" || source.researchKey !== source.stableKey)) unavailable();
  const text = truncateCodePoints(source.text.trim(), MODE_EXCERPT_CHARS[mode]);
  if (!text) return null;
  const title = truncateCodePoints(source.title.trim(), 2_048);
  if (bytes(source.canonicalUrl) > 2_048 || bytes(title) > 4_096) unavailable();
  return { ...source, title, text };
}

function dedupeKey(source: EvidenceSource): string {
  const location = source.sourceLocation === undefined ? ""
    : `${source.sourceLocation.startMs ?? ""}:${source.sourceLocation.endMs ?? ""}:${source.sourceLocation.label ?? ""}`;
  return `${source.kind}:${source.stableKey}:${source.contentHash}:${location}`;
}

export function buildCitationContext(
  sources: readonly EvidenceSource[],
  mode: EvidenceMode,
  options: { readonly maxSources?: number | undefined } = {},
): CitationBuildResult {
  if (!Array.isArray(sources) || !MODE_MAX_SOURCES[mode]) unavailable();
  const requestedMax = options.maxSources ?? MODE_MAX_SOURCES[mode];
  if (!Number.isSafeInteger(requestedMax) || requestedMax < 1 || requestedMax > 120) unavailable();
  const maximumSources = options.maxSources === undefined ? MODE_MAX_SOURCES[mode] : requestedMax;
  const context: CitationContext[] = [];
  const labelMap = new Map<string, EvidenceSource>();
  const selected: EvidenceSource[] = [];
  const seen = new Set<string>();
  for (const raw of sources) {
    if (selected.length >= maximumSources) break;
    const source = normalizedEvidence(raw, mode);
    if (source === null) continue;
    const key = dedupeKey(source);
    if (seen.has(key)) continue;
    const label = `S${selected.length + 1}`;
    const item: CitationContext = {
      sourceId: label,
      title: source.title,
      canonicalUrl: source.canonicalUrl,
      text: source.text,
    };
    if (bytes(JSON.stringify([...context, item])) > EVIDENCE_BYTES) break;
    seen.add(key);
    context.push(item);
    selected.push(source);
    labelMap.set(label, source);
  }
  return { context, labelMap, sources: selected };
}

export function validateCitations(
  text: string,
  citedSourceIds: readonly string[],
  labelMap: ReadonlyMap<string, EvidenceSource>,
): readonly EvidenceSource[] {
  if (typeof text !== "string" || !text.trim() || !Array.isArray(citedSourceIds) || citedSourceIds.length === 0 || labelMap.size === 0) unavailable();
  const provider = new Set<string>();
  for (const label of citedSourceIds) {
    if (typeof label !== "string" || provider.has(label) || !labelMap.has(label)) unavailable();
    provider.add(label);
  }
  const answer = new Set<string>();
  for (const match of text.matchAll(/\[(S[1-9]\d*)\]/gu)) {
    const label = match[1]!;
    if (!labelMap.has(label)) unavailable();
    answer.add(label);
  }
  if (answer.size === 0 || answer.size !== provider.size) unavailable();
  for (const label of answer) if (!provider.has(label)) unavailable();
  for (const label of provider) if (!answer.has(label)) unavailable();
  const validated: EvidenceSource[] = [];
  for (const [label, source] of labelMap) if (answer.has(label)) validated.push(source);
  return validated;
}

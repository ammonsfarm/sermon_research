import type { AppEnv } from "./env.ts";
import type { Segment } from "./pipeline.ts";
import { chat } from "./research.ts";
import type { Ministry } from "./settings.ts";

/** What the answers AI is told. The segments follow in the user message as JSON with their IDs. */
export const CLEANUP_PROMPT = `You are a transcript editor specializing in religious, historical, and biblical literature.
Your task is to correct errors in the provided ASR transcript while strictly preserving the speaker's original words.

Rules:
1. Fix misspelled historical, geographical, and biblical proper nouns.
2. Fix erroneous periods inserted during mid-sentence vocal pauses.
3. Capitalize proper nouns and reverential references appropriately.
4. Do NOT summarize, rewrite, or remove spoken content.
5. Return the result in the exact same JSON format with matching IDs.`;

/** Transcript characters per call, about 2,000 tokens each way: a 40-minute sermon is 4 or 5 calls. */
const BATCH_CHARS = 8_000;
const MAX_TOKENS = 8_000;
const TIMEOUT_MS = 4 * 60_000;

export interface CleanupItem { readonly id: number; readonly text: string }

/** Where the batch starting at `first` ends: at least one segment, then as many as fit in `budget` characters. */
export function batchEnd(segments: readonly Segment[], first: number, budget = BATCH_CHARS): number {
  let end = first + 1;
  let chars = segments[first]?.text.length ?? 0;
  while (end < segments.length && chars + segments[end]!.text.length <= budget) chars += segments[end++]!.text.length;
  return Math.min(end, segments.length);
}

/** Cleans one batch of segments. IDs count from 1 across the whole transcript. */
export async function cleanSegments(env: AppEnv, ministry: Ministry | null, title: string, segments: readonly Segment[], first: number): Promise<string[]> {
  const items: CleanupItem[] = segments.map((segment, offset) => ({ id: first + offset + 1, text: segment.text }));
  const context = [
    `Sermon: "${title}"`,
    ministry?.churchName ? `Church: ${ministry.churchName}` : "",
    ministry?.speakerNames.length ? `Speakers at this church include: ${ministry.speakerNames.join(", ")}` : "",
  ].filter(Boolean).join("\n");
  const reply = await chat(env, CLEANUP_PROMPT, `${context}\n\nSegments:\n${JSON.stringify(items)}`, { maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS, effort: "summaryEffort" });
  return mergeCleaned(items, reply);
}

/**
 * The cleaned text for each item, in order. An item keeps its draft text when
 * the reply isn't JSON, leaves it out, or changes more words than a correction
 * would, since rule 4 matters more than any one fix.
 */
export function mergeCleaned(items: readonly CleanupItem[], reply: string): string[] {
  const cleaned = new Map<number, string>();
  try {
    const parsed = JSON.parse(reply.slice(reply.indexOf("["), reply.lastIndexOf("]") + 1)) as unknown;
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      const { id, text } = (entry ?? {}) as { id?: unknown; text?: unknown };
      if (typeof text === "string" && text.trim()) cleaned.set(Number(id), text.replace(/\s+/gu, " ").trim());
    }
  } catch {
    console.error("transcript cleanup reply wasn't JSON; keeping the draft for this batch");
  }
  return items.map((item) => {
    const text = cleaned.get(item.id);
    return text !== undefined && looksLikeCorrection(item.text, text) ? text : item.text;
  });
}

/** Fixes keep about the same number of words: "a fusions" to "Ephesians" is fine, a dropped sentence isn't. */
function looksLikeCorrection(draft: string, cleaned: string): boolean {
  const words = (text: string) => text.split(/\s+/u).filter(Boolean).length;
  const before = words(draft);
  return Math.abs(words(cleaned) - before) <= Math.max(2, Math.ceil(before * 0.2));
}

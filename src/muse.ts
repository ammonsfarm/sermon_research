import type { Segment } from "./pipeline.ts";

/** Muse takes mono 16-bit PCM WAV at 16 or 24 kHz; 16 kHz keeps a 10-minute part at about 19 MB, under its 32 MB limit. */
export const MUSE_SAMPLE_RATE = 16_000;

export interface MuseLimits {
  /** Longest part sent at once. Muse allows 10 minutes; this leaves room to end at a pause. */
  readonly partSeconds: number;
  /** How far back from the end of a full part to look for the quietest moment to split at. */
  readonly searchSeconds: number;
}

export const MUSE_LIMITS: MuseLimits = { partSeconds: 570, searchSeconds: 30 };

/** One stretch of speech from Muse's ENDPOINTING mode, timed from the start of the part sent. */
export interface MuseTurn {
  readonly turnId?: unknown;
  readonly startMs?: unknown;
  readonly endMs?: unknown;
  readonly transcript?: unknown;
}

export const WAV_HEADER_BYTES = 44;

/** Writes a mono 16-bit PCM WAV header for `samples` samples into the first 44 bytes of `wav`. */
export function writeWavHeader(wav: Uint8Array, samples: number, rate = MUSE_SAMPLE_RATE): void {
  const view = new DataView(wav.buffer, wav.byteOffset, WAV_HEADER_BYTES);
  const ascii = (offset: number, text: string) => [...text].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
}

/** A whole WAV file from mono 16-bit samples. */
export function wavFile(samples: Int16Array, rate = MUSE_SAMPLE_RATE): Uint8Array {
  const wav = new Uint8Array(WAV_HEADER_BYTES + samples.byteLength);
  writeWavHeader(wav, samples.length, rate);
  new Int16Array(wav.buffer, WAV_HEADER_BYTES, samples.length).set(samples);
  return wav;
}

/**
 * Where to end a full part: the middle of the quietest quarter second in its
 * last `searchSeconds`, so a word is rarely cut in two between parts.
 */
export function quietestSplit(samples: Int16Array, length: number, rate: number, searchSeconds: number): number {
  const width = Math.max(1, Math.round(rate / 4));
  const hop = Math.max(1, Math.round(rate / 20));
  const start = Math.max(0, length - Math.round(searchSeconds * rate));
  if (length - start <= width) return length;
  const energy = new Float64Array(length - start + 1);
  for (let index = start; index < length; index++) energy[index - start + 1] = energy[index - start]! + samples[index]! * samples[index]!;
  let best = length;
  let quietest = Infinity;
  for (let left = start; left + width <= length; left += hop) {
    const loudness = energy[left - start + width]! - energy[left - start]!;
    if (loudness < quietest) {
      quietest = loudness;
      best = left + Math.floor(width / 2);
    }
  }
  return best;
}

/** Muse's turns as transcript segments in seconds from the start of the sermon. */
export function turnsToSegments(response: { turns?: unknown; transcript?: unknown }, offsetSeconds: number, partSeconds: number): Segment[] {
  const turns = Array.isArray(response.turns) ? response.turns as MuseTurn[] : [];
  const segments = turns.flatMap((turn): Segment[] => {
    const text = typeof turn.transcript === "string" ? turn.transcript.replace(/\s+/gu, " ").trim() : "";
    const start = Number(turn.startMs);
    const end = Number(turn.endMs);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return [];
    return [{ text, start: round(offsetSeconds + start / 1000), end: round(offsetSeconds + Math.max(start, end) / 1000) }];
  });
  // Without turns, the whole part is one segment.
  if (segments.length === 0 && typeof response.transcript === "string" && response.transcript.trim()) {
    return [{ text: response.transcript.replace(/\s+/gu, " ").trim(), start: round(offsetSeconds), end: round(offsetSeconds + partSeconds) }];
  }
  return segments.sort((a, b) => a.start - b.start);
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

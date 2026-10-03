import decoderModule from "./mp3.wasm";
import { ProviderError } from "./providers.ts";

/** What wasm/mp3.c exports. */
interface Decoder {
  readonly memory: WebAssembly.Memory;
  readonly __heap_base: WebAssembly.Global;
  reset(): void;
  pcm_buffer(): number;
  decode(pointer: number, length: number): number;
  frame_bytes(): number;
  channels(): number;
  sample_rate(): number;
}

/** MP3 bytes held in the decoder's memory at once. */
const WINDOW = 1 << 20;
/** minimp3 wants a few frames in view to find its place, 16 KB as its docs suggest. */
const LOOKAHEAD = 16_384;

/**
 * Decodes an MP3 stream to mono 16-bit samples at `rate`, keeping only output
 * samples `from` to `from + into.length` and writing them to `into`. Decoding
 * always starts at the beginning of the file, so every call counts samples the
 * same way and a part picks up exactly where the last one stopped. Stops
 * reading once `into` is full; `more` says whether audio carries on past it.
 */
export async function decodeMp3(stream: ReadableStream<Uint8Array>, rate: number, from: number, into: Int16Array): Promise<{ samples: number; more: boolean }> {
  const decoder = new WebAssembly.Instance(decoderModule, {}).exports as unknown as Decoder;
  const base = decoder.__heap_base.value as number;
  const missing = base + WINDOW - decoder.memory.buffer.byteLength;
  if (missing > 0) decoder.memory.grow(Math.ceil(missing / 65_536));
  const window = new Uint8Array(decoder.memory.buffer, base, WINDOW);
  const pcm = new Int16Array(decoder.memory.buffer, decoder.pcm_buffer(), 2 * 1152);
  decoder.reset();

  const reader = stream.getReader();
  let pending: Uint8Array | undefined;
  let filled = 0;
  let position = 0;
  let ended = false;
  const fill = async () => {
    window.copyWithin(0, position, filled);
    filled -= position;
    position = 0;
    while (filled < WINDOW && !ended) {
      if (!pending?.length) {
        const read = await reader.read();
        if (read.done) ended = true;
        else pending = read.value;
        continue;
      }
      const take = Math.min(pending.length, WINDOW - filled);
      window.set(pending.subarray(0, take), filled);
      filled += take;
      pending = pending.subarray(take);
    }
  };

  // Each output sample averages the source samples that fall in it, which also keeps out most aliasing.
  let sourceRate = 0;
  let source = 0;
  let current = -1;
  let sum = 0;
  let count = 0;
  let written = 0;
  const end = from + into.length;
  const emit = () => {
    if (current >= from && count > 0) into[current - from] = Math.round(sum / count);
    if (current >= from) written = current - from + 1;
  };

  try {
    for (;;) {
      if (!ended && filled - position < LOOKAHEAD) await fill();
      if (position >= filled) break;
      const samples = decoder.decode(base + position, filled - position);
      const used = decoder.frame_bytes();
      if (!used) {
        if (ended) break;
        await fill();
        continue;
      }
      position += used;
      if (!samples) continue;
      const hz = decoder.sample_rate();
      if (sourceRate && hz !== sourceRate) throw new ProviderError("This MP3 changes sample rate partway through, which Muse transcription can't follow. Use Mistral for it.");
      sourceRate = hz;
      // Skip whole frames before the part starts without averaging them.
      if (Math.floor((source + samples - 1) * rate / sourceRate) < from - 1) {
        source += samples;
        continue;
      }
      const channels = decoder.channels();
      for (let index = 0; index < samples; index++, source++) {
        const target = Math.floor(source * rate / sourceRate);
        if (target !== current) {
          emit();
          if (target >= end) return { samples: written, more: true };
          current = target;
          sum = 0;
          count = 0;
        }
        sum += channels === 2 ? (pcm[2 * index]! + pcm[2 * index + 1]!) / 2 : pcm[index]!;
        count++;
      }
    }
    emit();
    return { samples: written, more: false };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

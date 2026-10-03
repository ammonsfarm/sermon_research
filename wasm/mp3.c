/*
 * The MP3 decoder behind src/mp3.ts: minimp3 (public domain, vendor/minimp3)
 * with a few exports. Rebuild src/mp3.wasm with scripts/build-mp3-wasm.sh.
 *
 * The caller copies MP3 bytes into memory past __heap_base, then calls
 * decode() frame by frame; each call leaves one frame's 16-bit samples in
 * pcm_buffer() and says how many input bytes it used.
 */
#define MINIMP3_IMPLEMENTATION
#define MINIMP3_ONLY_MP3
#define MINIMP3_NO_SIMD
#include "../vendor/minimp3/minimp3.h"

static mp3dec_t decoder;
static mp3dec_frame_info_t info;
static mp3d_sample_t pcm[MINIMP3_MAX_SAMPLES_PER_FRAME];

void reset(void) { mp3dec_init(&decoder); }
mp3d_sample_t *pcm_buffer(void) { return pcm; }

/* Samples per channel from the first frame in mp3[0..length), or 0 for skipped data or a frame still filling its bit reservoir. */
int decode(const uint8_t *mp3, int length) { return mp3dec_decode_frame(&decoder, mp3, length, pcm, &info); }
int frame_bytes(void) { return info.frame_bytes; }
int channels(void) { return info.channels; }
int sample_rate(void) { return info.hz; }

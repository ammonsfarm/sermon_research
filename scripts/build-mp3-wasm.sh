#!/bin/sh
# Rebuilds src/mp3.wasm from wasm/mp3.c and vendor/minimp3. The .wasm is
# committed, so deploys don't need this; run it only after changing either.
# Needs Zig (https://ziglang.org, or `pip install ziglang` and ZIG="python3 -m ziglang").
set -eu
cd "$(dirname "$0")/.."
${ZIG:-zig} cc -target wasm32-freestanding -O2 -flto -fno-stack-protector -Iwasm/include \
  -Wl,--no-entry -Wl,--export=__heap_base -Wl,--export=reset -Wl,--export=pcm_buffer \
  -Wl,--export=decode -Wl,--export=frame_bytes -Wl,--export=channels -Wl,--export=sample_rate \
  -Wl,--strip-all -o src/mp3.wasm wasm/mp3.c
echo "built src/mp3.wasm ($(wc -c < src/mp3.wasm | tr -d ' ') bytes)"

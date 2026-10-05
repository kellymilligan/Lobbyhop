#!/usr/bin/env bash
# Builds box3d.wasm from a pinned Box3D commit and boxworld.c.
# Needs the Emscripten SDK on PATH (source emsdk_env.sh). The output is
# committed, so you only need this to change the bindings or update Box3D.
set -euo pipefail
cd "$(dirname "$0")"
BOX3D_COMMIT=e77352cd606dc1a34209094076199549a52ea0a1
SRC=.cache/box3d
if [ ! -d "$SRC/.git" ] || [ "$(git -C "$SRC" rev-parse HEAD)" != "$BOX3D_COMMIT" ]; then
  rm -rf "$SRC"
  git clone --quiet https://github.com/erincatto/box3d "$SRC"
  git -C "$SRC" checkout --quiet "$BOX3D_COMMIT"
fi
# Standalone (no JS glue), single-threaded (Workers have no threads), wasm SIMD.
emcc -O3 -DNDEBUG -msimd128 -msse2 \
  -I"$SRC/include" -I"$SRC/src" "$SRC"/src/*.c boxworld.c \
  -sSTANDALONE_WASM --no-entry -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=16MB \
  -o box3d.wasm
echo "box3d.wasm: $(wc -c < box3d.wasm) bytes (Box3D ${BOX3D_COMMIT:0:7})"

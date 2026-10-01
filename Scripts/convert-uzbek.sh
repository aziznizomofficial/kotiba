#!/bin/bash
# Rebuild the Uzbek engine the app ships — Kotib STT, `Kotib/uzbek_stt_v1` — from Hugging Face.
#
# Hugging Face carries the fine-tune as safetensors only; the ggml q5_0 the app loads is produced
# here: fetch the weights at a pinned revision, convert with whisper.cpp's convert-h5-to-ggml.py,
# quantise to q5_0 with whisper-quantize from the tag the app links. Anyone can run this; nothing
# needs credentials. It is also how to check a downloaded copy is the file that was measured:
#
#   ggml-uzbek-stt-v1-q5_0.bin   539,212,484 bytes
#   sha256 2891c1ca99f40a5519cd2e863e85b70b6cdc057b46fdbb5edbe6d9cead29c1b2
#
# That is the file D-08 and C2 measured (21.55% WER with the app's decode settings on the
# 344-clip harness) and the one Scripts/Manifest.json and ModelCatalogue.uzbekEngine name. The
# script ends by comparing against it and exits non-zero on a mismatch: a different hash means a
# different model than the one every number in docs/ describes.
#
#   bash Scripts/convert-uzbek.sh
#
# Environment (all optional):
#   KOTIBA_CONVERT_DIR  scratch directory                       (default ~/.cache/kotiba-convert)
#   UZ_HF_DIR          an existing local snapshot of the HF repo — skips the 3 GB download.
#                      Must be revision below; model.safetensors is checked against its sha256.
#   PYTHON             a python with torch + transformers + numpy (default: a venv made here)
#   WHISPER_CPP        a whisper.cpp v1.9.2 checkout with build/bin/whisper-quantize built
#
# Disk: ~3 GB for the snapshot (unless UZ_HF_DIR), 1.5 GB for the f16 intermediate, 0.5 GB out.
#
# History: until 2026-09-29 this script rebuilt `islomov/rubaistt_v2_medium` ("navoi-medium",
# sha256 3740210b…), the model D-08 replaced. That model is no longer shipped or listed.
set -euo pipefail

REPO="Kotib/uzbek_stt_v1"
REVISION="0e239511f65c1c7bbf426619a1ee9ea628411344"
SAFETENSORS_SHA256="a0175dcdc4e4249b3cc4294da5cd10151777cdb908403eee40696db5b67d609f"
EXPECTED_SHA256="2891c1ca99f40a5519cd2e863e85b70b6cdc057b46fdbb5edbe6d9cead29c1b2"
WHISPER_CPP_TAG="v1.9.2"   # Package.swift's xcframework; ggml layout and quantiser must match it

B="${KOTIBA_CONVERT_DIR:-$HOME/.cache/kotiba-convert}"
mkdir -p "$B/out"
step() { echo; echo "=== [$(date '+%H:%M:%S')] $* ==="; }

step "python"
if [ -z "${PYTHON:-}" ]; then
  if [ ! -x "$B/venv/bin/python" ]; then
    python3 -m venv "$B/venv"
    "$B/venv/bin/pip" install -q --upgrade pip
    "$B/venv/bin/pip" install -q torch numpy transformers safetensors huggingface_hub
  fi
  PYTHON="$B/venv/bin/python"
fi
"$PYTHON" -c "import torch, transformers; print('torch', torch.__version__, 'transformers', transformers.__version__)"

step "weights: $REPO @ ${REVISION:0:8}"
HF="${UZ_HF_DIR:-$B/hf}"
if [ -z "${UZ_HF_DIR:-}" ]; then
  "$PYTHON" - "$REPO" "$REVISION" "$HF" <<'PY'
import sys
from huggingface_hub import snapshot_download
repo, rev, dest = sys.argv[1:4]
snapshot_download(repo_id=repo, revision=rev, local_dir=dest,
                  allow_patterns=["*.json", "*.txt", "*.safetensors"])
PY
fi
got=$(shasum -a 256 "$HF/model.safetensors" | cut -d' ' -f1)
[ "$got" = "$SAFETENSORS_SHA256" ] || { echo "model.safetensors is $got, expected $SAFETENSORS_SHA256 — wrong revision"; exit 1; }
echo "model.safetensors verified"

step "whisper.cpp $WHISPER_CPP_TAG"
W="${WHISPER_CPP:-$B/whisper.cpp}"
if [ ! -x "$W/build/bin/whisper-quantize" ]; then
  [ -d "$W/.git" ] || git clone -q --depth 1 --branch "$WHISPER_CPP_TAG" \
      https://github.com/ggml-org/whisper.cpp "$W"
  cmake -S "$W" -B "$W/build" -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF \
        -DWHISPER_BUILD_EXAMPLES=ON > "$B/cmake.log"
  cmake --build "$W/build" -j 8 --target whisper-quantize >> "$B/cmake.log"
fi

step "openai/whisper assets (mel filters)"
# convert-h5-to-ggml.py reads <dir>/whisper/assets/mel_filters.npz. Only that file is needed, so
# fetch it at a pinned commit rather than cloning the repository.
A="$B/openai-whisper"
mkdir -p "$A/whisper/assets"
[ -f "$A/whisper/assets/mel_filters.npz" ] || curl -sfL -o "$A/whisper/assets/mel_filters.npz" \
  "https://raw.githubusercontent.com/openai/whisper/86098128c0b4f24f0e2aa2994de830614b474227/whisper/assets/mel_filters.npz"
got=$(shasum -a 256 "$A/whisper/assets/mel_filters.npz" | cut -d' ' -f1)
[ "$got" = "7450ae70723a5ef9d341e3cee628c7cb0177f36ce42c44b7ed2bf3325f0f6d4c" ] \
  || { echo "mel_filters.npz is $got — not the file the shipped build was made with"; exit 1; }

step "convert → ggml f16"
F16="$B/out/ggml-uzbek-stt-v1-f16.bin"
if [ ! -f "$F16" ]; then
  "$PYTHON" "$W/models/convert-h5-to-ggml.py" "$HF" "$A" "$B/out" > "$B/convert.log"
  mv "$B/out/ggml-model.bin" "$F16"
fi
ls -l "$F16"

step "quantise → q5_0"
Q5="$B/out/ggml-uzbek-stt-v1-q5_0.bin"
rm -f "$Q5"
"$W/build/bin/whisper-quantize" "$F16" "$Q5" q5_0 > "$B/quantize.log" 2>&1
got=$(shasum -a 256 "$Q5" | cut -d' ' -f1)
bytes=$(stat -f %z "$Q5" 2>/dev/null || stat -c %s "$Q5")

step "result"
echo "$Q5"
echo "bytes  $bytes"
echo "sha256 $got"
if [ "$got" = "$EXPECTED_SHA256" ]; then
  echo "IDENTICAL to the shipped and measured build."
else
  echo "DIFFERENT from the shipped build ($EXPECTED_SHA256)." >&2
  exit 1
fi

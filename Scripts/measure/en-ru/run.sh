#!/bin/bash
# Every run behind docs/research/C1-en-ru-engine-selection.md, in the order it was taken.
#
#   STT=~/code/kotib-lab/stt Scripts/measure/en-ru/run.sh [accuracy|stream|latency|windows|all]
#
# Needs README.md's setup first. Sequential on purpose: two engines timing at once measure
# each other. Latency groups should be run when `uptime` shows a 1-minute load under 4.
set -uo pipefail
cd "$(dirname "$0")/../../.."

STT=${STT:?set STT to the lab directory}
P=.build/release/kotiba-probe
M=$STT/models; S=$STT/sets; R=$STT/results; PY=$STT/venv/bin/python
HERE=Scripts/measure/en-ru
WHISPER=${WHISPER:-"$HOME/Library/Application Support/Kotiba/models/ggml-large-v3-turbo-q5_0.bin"}
SHERPA=${SHERPA:-$STT/sherpa}
mkdir -p "$R"

b() { local out=$1; shift; "$P" bench "$@" --out "$R/$out.jsonl" 2>&1 | grep -E "prepare|done|ERROR"; }

accuracy() {
  for L in en ru; do
    b ultra-short-$L --engine parakeet --variant ultra --models-root "$M" --manifest "$S/short/$L.jsonl"
    b ultrahint-short-$L --engine parakeet --variant ultra --models-root "$M" --hint --manifest "$S/short/$L.jsonl"
    b v3-short-$L --engine parakeet --variant v3 --models-root "$M" --manifest "$S/short/$L.jsonl"
    b whisper-short-$L --engine whisper --model "$WHISPER" --manifest "$S/short/$L.jsonl"
    b ultra-long-$L --engine parakeet --models-root "$M" --manifest "$S/long/$L.jsonl"
    b v3-long-$L --engine parakeet --variant v3 --models-root "$M" --manifest "$S/long/$L.jsonl"
  done
  b v2-short-en --engine parakeet --variant v2 --models-root "$M" --manifest "$S/short/en.jsonl"
  b v2-long-en --engine parakeet --variant v2 --models-root "$M" --manifest "$S/long/en.jsonl"
  b apple-short-en --engine apple --manifest "$S/short/en.jsonl"
  b appledt-short-en --engine apple-dt --locale en_US --manifest "$S/short/en.jsonl"
  b appledt-short-ru --engine apple-dt --locale ru_RU --manifest "$S/short/ru.jsonl"
  for e in ultra ultrahint v3 whisper appledt; do
    case $e in
      ultra) a=(--engine parakeet --models-root "$M");;
      ultrahint) a=(--engine parakeet --models-root "$M" --hint);;
      v3) a=(--engine parakeet --variant v3 --models-root "$M");;
      whisper) a=(--engine whisper --model "$WHISPER");;
      appledt) a=(--engine apple-dt --locale ru_RU);;
    esac
    b $e-cs-ru "${a[@]}" --manifest "$S/codeswitch/ru.jsonl"
  done
}

stream() {
  for L in en ru; do
    b ultra-stream-long-$L --engine parakeet --models-root "$M" --stream --pace 2 --manifest "$S/long/$L.jsonl"
    b ultra-stream-lat-$L --engine parakeet --models-root "$M" --stream --pace 2 --manifest "$S/latency/$L.jsonl"
  done
  b applest-stream-lat-en --engine apple-st --locale en_US --stream --pace 2 --manifest "$S/latency/en.jsonl"
}

latency() {
  for L in en ru; do
    b ultra-lat-$L --engine parakeet --models-root "$M" --manifest "$S/latency/$L.jsonl"
    b whisper-lat-$L --engine whisper --model "$WHISPER" --manifest "$S/latency/$L.jsonl"
  done
  b v2-lat-en --engine parakeet --variant v2 --models-root "$M" --manifest "$S/latency/en.jsonl"
  b apple-lat-en --engine apple --manifest "$S/latency/en.jsonl"
}

windows() {
  G=$SHERPA/sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16
  PK=$SHERPA/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
  T=$SHERPA/sherpa-onnx-streaming-t-one-russian-2025-09-08
  U=$STT/onnx/ultra-int8
  sb() { "$PY" "$HERE/sherpa_bench.py" "$@" 2>&1 | grep -v -E "resampler|_sample_rate|^$|features.cc" | tail -1; }
  sb --model gigaam-v3-punct --dir "$G" --manifest "$S/short/ru.jsonl" --out "$R/sherpa-gigaam-short-ru.jsonl"
  sb --model gigaam-v3-punct --dir "$G" --manifest "$S/codeswitch/ru.jsonl" --out "$R/sherpa-gigaam-cs-ru.jsonl"
  sb --model gigaam-v3-punct --dir "$G" --manifest "$S/long/ru.jsonl" --out "$R/sherpa-gigaam-long-ru.jsonl" --stream
  sb --model t-one --dir "$T" --manifest "$S/short/ru.jsonl" --out "$R/sherpa-tone-short-ru.jsonl"
  for L in en ru; do
    sb --model parakeet-v3-int8 --dir "$PK" --manifest "$S/short/$L.jsonl" --out "$R/sherpa-parakeet-short-$L.jsonl"
    sb --model parakeet-v3-int8 --dir "$PK" --manifest "$S/long/$L.jsonl" --out "$R/sherpa-parakeet-long-$L.jsonl" --stream
    sb --model onnx-asr-parakeet --dir "$U" --manifest "$S/short/$L.jsonl" --out "$R/onnx-ultra-short-$L.jsonl"
  done
  sb --model parakeet-v3-int8 --dir "$PK" --manifest "$S/codeswitch/ru.jsonl" --out "$R/sherpa-parakeet-cs-ru.jsonl"
  sb --model onnx-asr-parakeet --dir "$U" --manifest "$S/codeswitch/ru.jsonl" --out "$R/onnx-ultra-cs-ru.jsonl"
}

case "${1:-all}" in
  accuracy) accuracy;; stream) stream;; latency) latency;; windows) windows;;
  all) accuracy; windows; stream; latency;;
  *) echo "usage: $0 [accuracy|stream|latency|windows|all]"; exit 2;;
esac
"$PY" "$HERE/score.py" "$R"/*.jsonl

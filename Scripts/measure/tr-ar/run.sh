#!/bin/bash
# Every run behind docs/research/C4-turkish-arabic-engine-selection.md, grouped as taken.
#
#   LAB=~/code/kotib-lab/tr-ar Scripts/measure/tr-ar/run.sh <group>
#
# Needs README.md's setup first. Sequential on purpose: two engines timing at once measure each
# other. Each group writes results/<name>.jsonl; `score.py results/*.jsonl` tabulates them.
set -uo pipefail
HERE=${HERE:-$(cd "$(dirname "$0")" && pwd)}
LAB=${LAB:?set LAB to the lab directory}
PY=$LAB/venv/bin/python; S=$LAB/sets; R=$LAB/results; M=$LAB/models
TURBO=${TURBO:-"$HOME/Library/Application Support/Kotiba/models/ggml-large-v3-turbo-q5_0.bin"}
mkdir -p "$R"
b() { local out=$1; shift; echo "== $out  (uptime: $(uptime | sed 's/.*load/load/'))"
      "$PY" "$HERE/bench.py" "$@" --out "$R/$out.jsonl" 2>&1 | grep -E "load [0-9]+ ms|Error|error" | head -3; }

# name, engine args… for each candidate; `acc` runs the accuracy sets, `lat` the timing sets.
acc() { local n=$1; shift
  b $n-short-tr "$@" --manifest "$S/short/tr.jsonl"
  b $n-short-ar "$@" --manifest "$S/short/ar.jsonl"
  b $n-dia-ar "$@" --manifest "$S/dialect/ar.jsonl"
  b $n-long-tr "$@" --manifest "$S/long/tr.jsonl"
  b $n-long-ar "$@" --manifest "$S/long/ar.jsonl"; }
acc_ar() { local n=$1; shift
  b $n-short-ar "$@" --manifest "$S/short/ar.jsonl"
  b $n-dia-ar "$@" --manifest "$S/dialect/ar.jsonl"
  b $n-long-ar "$@" --manifest "$S/long/ar.jsonl"; }
acc_tr() { local n=$1; shift
  b $n-short-tr "$@" --manifest "$S/short/tr.jsonl"
  b $n-long-tr "$@" --manifest "$S/long/tr.jsonl"; }
lat() { local n=$1 L=$2; shift 2
  b $n-lat-$L "$@" --manifest "$S/latency/$L.jsonl"
  b $n-stream-lat-$L "$@" --stream --manifest "$S/latency/$L.jsonl"
  b $n-stream-long-$L "$@" --stream --manifest "$S/long/$L.jsonl"
  b $n-pstream-lat-$L "$@" --stream --pause-tail --manifest "$S/latency/$L.jsonl"
  b $n-pstream-long-$L "$@" --stream --pause-tail --manifest "$S/long/$L.jsonl"; }
plat() { local n=$1 L=$2; shift 2   # pause-cut streaming only
  b $n-pstream-lat-$L "$@" --stream --pause-tail --manifest "$S/latency/$L.jsonl"
  b $n-pstream-long-$L "$@" --stream --pause-tail --manifest "$S/long/$L.jsonl"; }

case "${1:-}" in
  turbo)    acc turbo --engine whisper --model "$TURBO";;
  turbo-prompt)  # whisper writes almost no Arabic punctuation unprompted; does a punctuated
                 # prompt (our own sentence) fix it, and at what cost?
    P='مرحبًا، هذه رسالة قصيرة. هل يمكنك مراجعتها؟ شكرًا.'
    b turbop-short-ar --engine whisper --model "$TURBO" --port 8792 --prompt "$P" --manifest "$S/short/ar.jsonl"
    b turbop-dia-ar --engine whisper --model "$TURBO" --port 8792 --prompt "$P" --manifest "$S/dialect/ar.jsonl";;
  v3)       # large-v3 q5_0: short sets + the release tail (the decoder is 32 layers to turbo's 4)
    V3="$M/ggml-large-v3-q5_0.bin"
    b v3-short-tr --engine whisper --model "$V3" --manifest "$S/short/tr.jsonl"
    b v3-short-ar --engine whisper --model "$V3" --manifest "$S/short/ar.jsonl"
    plat v3 tr --engine whisper --model "$V3" --no-flash --commit-after 20;;
  cohere)   acc_ar cohere --engine tcpp --model "$M/cohere-transcribe-arabic-07-2026-Q5_K_M.gguf";;
  nemotron)
    NM="$M/nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf"
    b nemo-short-tr --engine tcpp --model "$NM" --lang-tag tr-TR --manifest "$S/short/tr.jsonl"
    acc_ar nemo --engine tcpp --model "$NM" --lang-tag ar-AR;;
  fastconformer) acc_ar fcar --engine onnx --int8 --model "$M/fc-ar-pcd";;
  turkmed)  acc_tr turkmed --engine hf --model "$M/turkmed";;   # files of turkmedstt/whisper-large-v3-turkish-general
  oddadmix) acc_ar oddadmix --engine hf --model "$M/oddadmix";;  # files of oddadmix/whisper-large-v3-turbo-arabic-dialectal-v2
  lat-mac)
    for L in tr ar; do lat turbo $L --engine whisper --model "$TURBO" --no-flash --commit-after 20; done
    lat cohere ar --engine tcpp --model "$M/cohere-transcribe-arabic-07-2026-Q5_K_M.gguf"
    lat nemo ar --engine tcpp --lang-tag ar-AR --model "$M/nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf";;
  plat-mac)  # added after lat-mac: the app's release cut at the last pause
    for L in tr ar; do plat turbo $L --engine whisper --model "$TURBO" --no-flash --commit-after 20; done
    plat cohere ar --engine tcpp --model "$M/cohere-transcribe-arabic-07-2026-Q5_K_M.gguf";;
  lat-cpu)  # the Windows floor: this Mac's CPU, 4 threads, no Metal. Timing sets only.
    cl() { local n=$1 L=$2; shift 2
      b $n-lat-$L "$@" --manifest "$S/latency/$L.jsonl"
      b $n-pstream-lat-$L "$@" --stream --pause-tail --manifest "$S/latency/$L.jsonl"; }
    for L in tr ar; do cl turbo-cpu $L --engine whisper --model "$TURBO" --cpu --no-flash --commit-after 20; done
    cl fcar-cpu ar --engine onnx --int8 --model "$M/fc-ar-pcd"
    cl cohere-cpu ar --engine tcpp --cpu --model "$M/cohere-transcribe-arabic-07-2026-Q5_K_M.gguf";;
  *) echo "usage: $0 turbo|turbo-prompt|v3|cohere|nemotron|fastconformer|turkmed|oddadmix|lat-mac|plat-mac|lat-cpu"; exit 2;;
esac

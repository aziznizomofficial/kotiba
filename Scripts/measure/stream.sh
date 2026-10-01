#!/bin/bash
# Replay the 344-clip subset through the streaming Uzbek session (C2) and leave transcripts where
# sweep.py scores them.
#
#   swift build -c release --product kotiba-probe
#   bash stream.sh <tag> [kotiba-probe stream args…]
#   "$KOTIBA_WORK/venv/bin/python" sweep.py score <tag>
#
# Accelerated replay: chunks are fed as fast as the session takes them, but background decodes
# settle after every chunk ("the machine kept up with the speaker"). The text is what real time
# produces whenever the machine does keep up, so this is the WER to quote; the latency it prints is
# a floor — use `kotiba-probe stream --realtime` for latency. `rows.jsonl` per run carries every
# decode (kind, position, window, milliseconds, text).
#
# The C2 decision configuration is the default; the Silero model must be passed explicitly:
#
#   bash stream.sh c2 --vad "$KOTIBA_WORK/vad/ggml-silero-v6.2.0.bin" --trail-silence 300
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${KOTIBA_WORK:-$HOME/.cache/kotiba-measure}
tag=$1; shift
out=$WORK/gap01/runs/$tag
[ -f "$out/.done" ] && { echo "skip $tag (already decoded)"; exit 0; }
mkdir -p "$out"
MODEL=${KOTIBA_UZ_MODEL:-$HOME/Library/Application Support/Kotiba/models/ggml-uzbek-stt-v1-q5_0.bin}
PROBE=${PROBE:-$HERE/../../.build/release/kotiba-probe}
keys=$(python3 -c "import json,sys;print(' '.join('$WORK/gap01/sub/%s.wav'%k for k in json.load(open('$HERE/data/subset.json'))))")
echo "$tag start $(date +%T) load: $(uptime | sed 's/.*averages: //')"
t0=$(date +%s)
# shellcheck disable=SC2086
"$PROBE" stream --model "$MODEL" --out "$out" --jsonl "$out/rows.jsonl" "$@" $keys \
    > "$out/stdout.log" 2> "$out/stderr.log"
rc=$?
echo $(( $(date +%s) - t0 )) > "$out/.seconds"
[ $rc = 0 ] && touch "$out/.done"
echo "$tag rc=$rc end $(date +%T) load: $(uptime | sed 's/.*averages: //')"
exit $rc

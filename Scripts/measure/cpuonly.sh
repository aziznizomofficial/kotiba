#!/bin/bash
# Would Kotiba be usable on a Windows machine with no GPU?
#
# Windows has no Metal, so unless the machine has a supported Vulkan/CUDA GPU, whisper runs on the
# CPU. This measures the same models with Metal off on an M4 Pro — which is a BEST case for a
# Windows laptop, not a representative one, so anything already too slow here is hopeless there.
#
# And on Windows both English and Russian would go through whisper too, because there is no
# SpeechTranscriber off-Apple. So the English number matters as much as the Uzbek one.
set -uo pipefail
T=${KOTIBA_WORK:-$HOME/.cache/kotiba-measure}
CLI=$T/wcpp/build/bin/whisper-cli
M="$HOME/Library/Application Support/Kotiba/models"

echo "cores: $(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null) performance, $(sysctl -n hw.perflevel1.physicalcpu 2>/dev/null) efficiency"
echo

run() {
  local label="$1" model="$2" clip="$3" extra="${4:-}"
  local dur
  dur=$("$T/venv/bin/python" -c "
import json,os
G=os.path.join(os.path.dirname(os.path.abspath('$0')),'data') if False else '$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/data'
print(json.load(open(os.path.join(G,'meta.json')))['$clip']['dur'])")
  # Median of 3, warm.
  local times=()
  for i in 1 2 3; do
    local t0 t1
    t0=$(python3 -c 'import time;print(time.time())')
    "$CLI" -m "$M/$model" -l uz -nt -np $extra "$T/gap01/wav/$clip.wav" >/dev/null 2>&1
    t1=$(python3 -c 'import time;print(time.time())')
    times+=("$(python3 -c "print(round(($t1-$t0)*1000))")")
  done
  local med
  med=$(printf '%s\n' "${times[@]}" | sort -n | sed -n 2p)
  python3 -c "
d=$dur; m=$med
print(f'  {\"$label\":28} {d:5.2f}s audio -> {m:6d} ms   {d*1000/m:5.2f}x realtime')"
}

for clip in 0001 0072 0002; do
  echo "clip $clip"
  run "Uzbek  Metal (as shipped)" ggml-uzbek-stt-v1-q5_0.bin  "$clip"
  run "Uzbek  CPU only" ggml-uzbek-stt-v1-q5_0.bin  "$clip" "-ng"
  run "Russian/English CPU only" ggml-large-v3-turbo-q5_0.bin "$clip" "-ng"
  echo
done
echo CPUONLYDONE

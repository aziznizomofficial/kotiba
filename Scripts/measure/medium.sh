#!/bin/bash
# The shipping models under the SAME flags and the SAME metric as ratio.sh, so the hardware factor
# measured with the public models can legitimately be applied to them.
#
# Comparing a wall-clock baseline against a load-excluded ratio, or a fallback-enabled baseline
# against a fallback-disabled ratio, would be making the same class of mistake twice — and both were
# made once already. See ratio.sh for what each flag is protecting against.
#
# `comp` here is compute only. What a person actually WAITS is larger: the app leaves temperature
# fallback enabled, and cpuonly.sh measures that. Quote cpuonly.sh's numbers to people and these
# only to compare machines.
set -uo pipefail
T=${KOTIBA_WORK:-$HOME/.cache/kotiba-measure}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI=$T/wcpp/build/bin/whisper-cli
M="${KOTIBA_MODELS:-$HOME/Library/Application Support/Kotiba/models}"
REPEATS=5

echo "machine: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"
echo "whisper.cpp v1.9.2, -ng -nf -bs 1, median of $REPEATS, comp = total - load"
echo

printf '%-7s %-22s %-4s %9s %9s %s\n' clip model thr wall_ms comp_ms all_comp
for threads in 2 4; do
  for name in 0001 0072 0002; do
    for spec in "uzbek_stt_v1 q5_0:$M/ggml-uzbek-stt-v1-q5_0.bin" \
                "large-v3-turbo q5_0:$M/ggml-large-v3-turbo-q5_0.bin"; do
      label="${spec%%:*}"; model="${spec#*:}"
      [ -f "$model" ] || { echo "  MISSING $model"; continue; }
      walls=(); comps=()
      for i in $(seq 1 $REPEATS); do
        start=$(python3 -c 'import time;print(int(time.time()*1000))')
        out=$("$CLI" -m "$model" -t "$threads" -ng -nf -bs 1 -l uz -nt \
              "$HERE/fixtures/$name.wav" 2>&1 >/dev/null)
        end=$(python3 -c 'import time;print(int(time.time()*1000))')
        walls+=($(( end - start )))
        comps+=($(echo "$out" | awk '
          /load time/  { for (i=1;i<=NF;i++) if ($i=="=") l=$(i+1) }
          /total time/ { for (i=1;i<=NF;i++) if ($i=="=") t=$(i+1) }
          END { if (t>0) printf "%d", t - l; else print "0" }'))
      done
      mw=$(printf '%s\n' "${walls[@]}" | sort -n | sed -n 3p)
      mc=$(printf '%s\n' "${comps[@]}" | sort -n | sed -n 3p)
      printf '%-7s %-22s %-4s %9s %9s   %s\n' "$name" "$label" "$threads" "$mw" "$mc" "${comps[*]}"
    done
  done
done
echo MEDIUMDONE

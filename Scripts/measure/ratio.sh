#!/bin/bash
# The Mac half of the hardware-ratio measurement, for
# .github/workflows/windows-cpu-benchmark.yml.
#
# The question is what whisper costs on a CPU-only Windows machine, and that cannot be answered from
# a Mac with Metal switched off — that is an extrapolation across an architecture. So: run PUBLIC
# models a CI runner can fetch without credentials, on identical clips, CPU-only, and take the ratio
# between the two machines. The factor then applies to the medium Uzbek model, whose absolute cost is
# measured by medium.sh.
#
# Three things are load-bearing, and the first run of this got two of them wrong.
#
#   -nf -bs 1   One deterministic decode. With the temperature ladder on, a segment is re-decoded up
#               to six times whenever entropy or logprob trips, and base and small are hopeless at
#               Uzbek so they trip constantly at rates that differ per clip and per model. That run
#               produced 864 ms for an 8.8 s clip and 6422 ms for a 17.2 s one on the SAME model.
#
#   THREADS     Swept, and matched against whatever the runner reports, rather than hardcoded.
#               Hardcoding -t 4 to "the runner's vCPU count" was wrong twice over: windows-latest
#               has 2 logical processors, so Windows ran 4 threads on 2 while this Mac ran 4 on 8.
#               The oversubscription penalty falls hardest on the most compute-bound model, which is
#               exactly where the base-vs-small divergence appeared.
#
#   total-load  Model load is storage and memory bandwidth, not CPU, and small (~190 MB) carries far
#               more of it than base (~60 MB). Timing the whole process folded a storage ratio into a
#               CPU ratio, weighted differently per model. whisper prints its own breakdown, so
#               `total - load` is the compute-only number. This is why -np is absent: it suppresses
#               the timing block.
set -uo pipefail
T=${KOTIBA_WORK:-$HOME/.cache/kotiba-measure}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI=$T/wcpp/build/bin/whisper-cli
M="${KOTIBA_MODELS:-$HOME/Library/Application Support/Kotiba/models}"
SMALL=${KOTIBA_SMALL:-$T/ggml-small-q5_1.bin}
REPEATS=5

echo "machine: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"
echo "cores:   $(sysctl -n hw.perflevel0.physicalcpu) performance + $(sysctl -n hw.perflevel1.physicalcpu) efficiency"
echo "whisper.cpp v1.9.2, -nf -bs 1, median of $REPEATS, comp = total - load"
echo

printf '%-7s %-12s %-4s %9s %9s %s\n' clip model thr wall_ms comp_ms all_comp
for threads in 2 4; do
  for name in 0001 0072 0002; do
    for spec in "base q5_1:$M/ggml-base-q5_1.bin" "small q5_1:$SMALL"; do
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
      printf '%-7s %-12s %-4s %9s %9s   %s\n' "$name" "$label" "$threads" "$mw" "$mc" "${comps[*]}"
    done
  done
done
echo RATIODONE

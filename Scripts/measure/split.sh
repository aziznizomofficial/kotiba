#!/bin/bash
# Does the encode/decode mix shift with clip length? If it does, there is no single hardware factor
# — there is an encode ratio and a decode ratio, and the blend depends on utterance length. Which
# for a dictation app is the variable that matters, because real dictations are short.
#
# Mac side only, and cheap. Testing it properly needs the same breakdown from the Windows runner.
set -uo pipefail
T=${KOTIBA_WORK:-$HOME/.cache/kotiba-measure}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI=$T/wcpp/build/bin/whisper-cli
M="${KOTIBA_MODELS:-$HOME/Library/Application Support/Kotiba/models}"
SMALL=${KOTIBA_SMALL:-$T/ggml-small-q5_1.bin}

printf '%-7s %-12s %8s %8s %8s %8s %8s   %s\n' clip model load mel encode decode sample enc_share
for name in 0001 0072 0002; do
  for spec in "base q5_1:$M/ggml-base-q5_1.bin" "small q5_1:$SMALL"; do
    label="${spec%%:*}"; model="${spec#*:}"
    [ -f "$model" ] || continue
    # One discarded warm-up pass, then the measured one. The CI run showed the first pass of a block
    # inflated by up to 1.9x and settling monotonically afterwards — burst credits or first-touch
    # page faults. Any timing whose first sample is kept inherits that.
    "$CLI" -m "$model" -t 2 -ng -nf -bs 1 -l uz -nt "$HERE/fixtures/$name.wav" >/dev/null 2>&1
    out=$("$CLI" -m "$model" -t 2 -ng -nf -bs 1 -l uz -nt "$HERE/fixtures/$name.wav" 2>&1 >/dev/null)
    echo "$out" | awk -v c="$name" -v m="$label" '
      /load time/   { for(i=1;i<=NF;i++) if($i=="=") l=$(i+1) }
      /mel time/    { for(i=1;i<=NF;i++) if($i=="=") me=$(i+1) }
      /encode time/ { for(i=1;i<=NF;i++) if($i=="=") e=$(i+1) }
      /decode time/ { for(i=1;i<=NF;i++) if($i=="=") d=$(i+1) }
      /sample time/ { for(i=1;i<=NF;i++) if($i=="=") s=$(i+1) }
      END { comp = e + d + s + me
            printf "%-7s %-12s %7.0f %8.0f %8.0f %8.0f %8.0f   %5.1f%%\n",
                   c, m, l, me, e, d, s, (comp>0 ? 100*e/comp : 0) }'
  done
done
echo SPLITDONE

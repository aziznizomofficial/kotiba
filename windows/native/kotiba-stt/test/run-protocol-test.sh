#!/usr/bin/env bash
#
# Builds kotiba-stt against the STUB whisper and drives the real wire protocol through it.
#
#   bash windows/native/kotiba-stt/test/run-protocol-test.sh
#
# It needs a C++17 compiler and node, and nothing else — no cmake, no whisper.cpp, no
# 539 MB model. That is the point: the framing, the malformed-request handling and the
# whisper_full_params plumbing are testable on any machine on this project, and none of
# them needs a real decode to be wrong in a way that ships.
#
# It is NOT in windows/scripts/gate.sh, which must pass on a checkout with no compiler.
# CI runs this as its own step; see docs/windows/03-ENGINE-PARITY.md.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
out="${TMPDIR:-/tmp}/kotiba-stt-stub-$$"

CXX="${CXX:-c++}"

echo "building kotiba-stt against the stub whisper (${CXX})"
"$CXX" -std=c++17 -O1 -Wall -Wextra -pthread \
  -I "$here/stub" \
  -o "$out" \
  "$root/src/main.cpp" "$root/src/json.cpp" "$here/stub/whisper_stub.cpp"

trap 'rm -f "$out"' EXIT

echo "driving the protocol"
node "$here/protocol-test.mjs" "$out"

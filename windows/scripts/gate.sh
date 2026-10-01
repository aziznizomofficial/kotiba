#!/usr/bin/env bash
#
# The gate. `bash windows/scripts/gate.sh`, from the repository root.
#
# D-W10: TypeScript strict typecheck, lint, vitest including the golden-parity suite,
# and the layering grep. It must pass on a clean checkout with every module still a
# stub, and it must keep passing as the nine modules land one at a time — so an empty
# vitest run is not a failure, and a module nobody has written yet is not a failure.
#
# It exits non-zero on the FIRST failure and says which check failed and why. A gate
# whose output has to be read backwards from a stack trace is a gate people stop running.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here" || exit 1

failures=0

step() {
  printf '\n\033[1m── %s\033[0m\n' "$1"
}

fail() {
  printf '\033[31mFAIL\033[0m  %s\n' "$1"
  failures=$((failures + 1))
}

pass() {
  printf '\033[32mok\033[0m    %s\n' "$1"
}

# ---------------------------------------------------------------------------------
# 0. Dependencies
# ---------------------------------------------------------------------------------
# The Electron binary is ~100 MB and nothing in this gate runs it — the logic tests are
# the point, and they run headless on Linux. Skipping the download is what keeps a cold
# gate under a minute.
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
# The same for the on-device engines' install scripts. onnxruntime-node's fetches ~500 MB
# of CUDA provider libraries from NuGet on linux-x64 (the gate's CI runner), and
# node-llama-cpp's may try to build llama.cpp from source. The gate needs neither: its
# tests fake the runtimes, and both packages ship the prebuilt binaries the app loads.
export ONNXRUNTIME_NODE_INSTALL=skip
export NODE_LLAMA_CPP_SKIP_DOWNLOAD=true

step "dependencies"
if [ ! -d node_modules ]; then
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund || { fail "npm ci"; exit 1; }
  else
    npm install --no-audit --no-fund || { fail "npm install"; exit 1; }
  fi
  pass "installed"
else
  pass "node_modules present"
fi

# ---------------------------------------------------------------------------------
# 1. The layering rule
# ---------------------------------------------------------------------------------
# src/core/** and src/contracts/** are pure functions over plain data. This is what lets
# the golden-parity suite run on a Linux runner in seconds, and it is the same rule that
# made ai-balance/windows testable from a Mac.
#
# Run FIRST and cheapest: a layering break is an architecture bug, and finding it after
# four minutes of tests teaches people to skip the gate.

step "layering — src/core and src/contracts import no OS"

# Matches `from 'electron'`, `from "node:fs"`, `require('child_process')`, and the
# bare-specifier forms of every Node builtin these modules must never reach for.
forbidden='(from|require\()[[:space:]]*\(?["'"'"'](electron|node:[a-z_/]+|fs|fs/promises|path|os|child_process|worker_threads|crypto|http|https|net|dns|tls|stream|zlib|process|module|url|util|events|readline|perf_hooks|v8|vm|cluster|dgram|inspector|timers)["'"'"']'

pure_dirs=()
[ -d src/core ] && pure_dirs+=(src/core)
[ -d src/contracts ] && pure_dirs+=(src/contracts)

if [ ${#pure_dirs[@]} -eq 0 ]; then
  fail "neither src/core nor src/contracts exists — the tree is not what the gate expects"
else
  hits="$(grep -rEn --include='*.ts' --include='*.tsx' "$forbidden" "${pure_dirs[@]}" || true)"
  if [ -n "$hits" ]; then
    fail "pure code reached for an operating system:"
    printf '%s\n' "$hits" | sed 's/^/        /'
    printf '      Move it into src/engines, src/audio, src/platform or src/main.\n'
  else
    pass "no OS imports under ${pure_dirs[*]}"
  fi
fi

# The same rule one level out: only src/main and src/renderer may import electron.
if [ -d src ]; then
  electron_hits="$(grep -rEn --include='*.ts' --include='*.tsx' \
    "(from|require\()[[:space:]]*\(?[\"']electron[\"']" src \
    | grep -Ev '^src/(main|renderer)/' || true)"
  if [ -n "$electron_hits" ]; then
    fail "electron imported outside src/main and src/renderer:"
    printf '%s\n' "$electron_hits" | sed 's/^/        /'
  else
    pass "electron confined to src/main and src/renderer"
  fi
fi

# ---------------------------------------------------------------------------------
# 2. Typecheck
# ---------------------------------------------------------------------------------
step "typecheck — tsc --noEmit, strict, noUncheckedIndexedAccess"
if npx --no-install tsc --noEmit; then
  pass "no type errors"
else
  fail "tsc"
fi

# ---------------------------------------------------------------------------------
# 3. Lint
# ---------------------------------------------------------------------------------
step "lint — eslint"
if npx --no-install eslint .; then
  pass "no lint errors"
else
  fail "eslint"
fi

# ---------------------------------------------------------------------------------
# 4. Tests
# ---------------------------------------------------------------------------------
# Includes the golden-parity suite once t02 lands it. Until then this is the contract
# tests and whatever each module has written for itself; `passWithNoTests` is set in
# vitest.config.ts so a worktree holding only some modules still produces a green gate.
step "tests — vitest run"
if npx --no-install vitest run; then
  pass "tests"
else
  fail "vitest"
fi

# ---------------------------------------------------------------------------------
step "result"
if [ "$failures" -eq 0 ]; then
  printf '\033[32mgate passed\033[0m\n'
  exit 0
fi
printf '\033[31mgate failed: %d check(s)\033[0m\n' "$failures"
exit 1

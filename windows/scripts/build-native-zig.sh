#!/usr/bin/env bash
#
# windows/scripts/build-native-zig.sh — cross-compile the three Windows helpers
# (kotiba-hook, kotiba-input, kotiba-stt) for x86_64-windows from macOS or Linux, with zig's
# clang + mingw-w64. No Windows machine, no MSVC, no Visual C++ redistributable.
#
# THE MSVC BUILD (docs/windows/90-DELIVERY/WINDOWS-TEST-CHECKLIST.md, A3) REMAINS THE
# REFERENCE. This exists because GitHub Actions — the only Windows toolchain this project
# had — is billing-blocked, and an installer still has to be built. What differs:
#
#   * The C and C++ runtimes are STATIC. zig links libc++/libunwind into each binary and
#     the C runtime is the UCRT, which is part of Windows 10 and 11. So nothing here needs
#     VCRUNTIME140.dll or MSVCP140.dll — which the per-user, unelevated installer could not
#     install system-wide anyway. The script lists every import of every output and fails
#     on anything that is not a system DLL, the UCRT, or a file shipped beside it.
#   * kotiba-stt is built with KOTIBA_CPU_ALL_VARIANTS=ON (see its CMakeLists.txt): ggml's
#     CPU backend becomes one ggml-cpu-<variant>.dll per x86 level, and the best one this
#     CPU can execute is picked at startup. The MSVC build is a single AVX2 exe. Never
#     GGML_NATIVE, never -march=native: a shipped binary cannot target the build machine
#     (the SIGILL on the Xeon/EPYC runner fleet, D-W7).
#
# Usage:
#   windows/scripts/build-native-zig.sh [--prefix DIR] [--build-dir DIR] [--whisper-src DIR]
#
#   --prefix       where the .exe/.dll land, flat (default: windows/resources/native —
#                  what electron-builder.yml's extraResources ships)
#   --build-dir    scratch for the cmake trees (default: windows/build-native-zig)
#   --whisper-src  an existing whisper.cpp v1.9.2 checkout; default: CMake fetches the tag
#
# Needs: zig 0.14.x (ZIG=/path/to/zig, else `zig` on PATH), cmake >= 3.19, make.
# Optional: llvm-objdump or objdump (macOS ships one) for the import check.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
win="$(cd "$here/.." && pwd)"

prefix="$win/resources/native"
build="$win/build-native-zig"
whisper_src=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --build-dir) build="$2"; shift 2 ;;
    --whisper-src) whisper_src="$2"; shift 2 ;;
    *) echo "build-native-zig: unknown argument $1" >&2; exit 2 ;;
  esac
done

ZIG="${ZIG:-$(command -v zig || true)}"
if [ -z "$ZIG" ] || ! "$ZIG" version >/dev/null 2>&1; then
  echo "build-native-zig: zig not found — install zig 0.14.x or set ZIG=/path/to/zig" >&2
  exit 1
fi
case "$("$ZIG" version)" in
  0.14.*) ;;
  *) echo "build-native-zig: warning — tested with zig 0.14.1, found $("$ZIG" version)" >&2 ;;
esac

mkdir -p "$build/toolchain" "$prefix"
build="$(cd "$build" && pwd)"
prefix="$(cd "$prefix" && pwd)"
tc="$build/toolchain"

# CMake wants one executable per tool, not "zig cc -target …", so each is a tiny wrapper.
# `-target x86_64-windows-gnu` = mingw-w64 ABI; zig supplies the headers, import libraries
# and a static libc++. No -mcpu: zig's default for a cross target is the generic x86-64
# baseline, and every level above it is named explicitly by ggml's per-variant flags.
#
# `-mevex512`: zig passes clang an explicit feature list for that baseline, which includes
# "-evex512", so ggml's `-mavx512f` variants (skylakex, icelake, zen4, …) fail with
# "requires target feature 'evex512'". Re-enabling it is inert without AVX-512 itself.
#
# THE IMPORT-LIBRARY FIX (fix-implib.py, after every DLL link). ggml's GGML_API is
# `visibility("default")` on MinGW, not dllexport, so lld auto-exports every symbol of each
# DLL. lld leaves out the MinGW CRT startup objects by file name — `dllcrt2.o` — and zig
# names its copy `dllcrt2.obj`, so ggml-base.dll also exports `atexit`, `_CRT_INIT` and
# friends. Every DLL linked against it then sees `atexit` twice (its own CRT's and the
# import) and lld stops: "duplicate symbol: atexit". The fix rewrites the import library
# from the DLL's real export table minus the CRT/unwinder names, marking exports that live
# outside .text as DATA. The DLL is untouched; nobody can import the CRT names from it.
#
# `-ffile-prefix-map`: ggml's GGML_ASSERT prints __FILE__, so without it every ggml DLL carried
# the absolute path of this build directory — the builder's home folder included (17 files in
# 1.0.0's first installer). Mapped to ".", the binaries are the same wherever they are built.
# Written into the wrappers already quoted, so a directory with a space survives.
prefix_maps="\"-ffile-prefix-map=$build=.\" \"-ffile-prefix-map=$win=.\""
[ -z "$whisper_src" ] || prefix_maps="$prefix_maps \"-ffile-prefix-map=$(cd "$whisper_src" && pwd)=whisper.cpp\""
for tool in cc c++; do
  cat >"$tc/zig-$tool" <<EOF
#!/bin/sh
"$ZIG" $tool -target x86_64-windows-gnu -mevex512 $prefix_maps "\$@" || exit \$?
for a in "\$@"; do
  case "\$a" in -Wl,--out-implib,*) exec python3 "$tc/fix-implib.py" "$ZIG" "\$@" ;; esac
done
EOF
done
cat >"$tc/fix-implib.py" <<'EOF'
import os, re, subprocess, sys
zig, args = sys.argv[1], sys.argv[2:]
implib = next(a.split(',', 2)[2] for a in args if a.startswith('-Wl,--out-implib,'))
dll = args[args.index('-o') + 1]
objdump = next(t for t in ('llvm-objdump', 'objdump') if subprocess.run(
    ['sh', '-c', f'command -v {t}'], capture_output=True).returncode == 0)
heads = subprocess.run([objdump, '-h', dll], capture_output=True, text=True, check=True).stdout
secs = [(p[1], int(p[3], 16), int(p[2], 16)) for p in (l.split() for l in heads.splitlines())
        if len(p) >= 4 and p[1].startswith('.')]
base = min(v for _, v, _ in secs) & ~0xFFFF
table = subprocess.run([objdump, '-p', dll], capture_output=True, text=True, check=True).stdout
crt = re.compile(r'^(atexit|_onexit|_CRT_INIT|pcinit|__mingw_\w+|_?_?unw_\w+|__dyn_tls_\w+|'
                 r'_pei386\w*|DllMain\w*|_DllMainCRTStartup\w*)$')
lines, inside = ['LIBRARY ' + os.path.basename(dll), 'EXPORTS'], False
for l in table.splitlines():
    if 'Export Table' in l:
        inside = True
        continue
    m = re.match(r'\s+\d+\s+0x([0-9a-f]+)\s+(\S+)$', l) if inside else None
    if not m or crt.match(m.group(2)):
        continue
    rva = int(m.group(1), 16)
    sec = next((n for n, v, s in secs if v - base <= rva < v - base + s), '.text')
    lines.append(m.group(2) + ('' if sec == '.text' else ' DATA'))
deff = implib + '.def'
open(deff, 'w').write('\n'.join(lines) + '\n')
subprocess.run([zig, 'dlltool', '-m', 'i386:x86-64', '-d', deff, '-D', os.path.basename(dll),
                '-l', implib], check=True)
EOF
for tool in ar ranlib rc; do
  printf '#!/bin/sh\nexec "%s" %s "$@"\n' "$ZIG" "$tool" >"$tc/zig-$tool"
done
chmod +x "$tc"/zig-*

cat >"$tc/windows-x64.cmake" <<EOF
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER   "$tc/zig-cc")
set(CMAKE_CXX_COMPILER "$tc/zig-c++")
set(CMAKE_AR           "$tc/zig-ar" CACHE FILEPATH "")
set(CMAKE_RANLIB       "$tc/zig-ranlib" CACHE FILEPATH "")
set(CMAKE_RC_COMPILER  "$tc/zig-rc" CACHE FILEPATH "")
# whisper.cpp uses M_PI; mingw's <math.h> hides it under -std=c++17 (no GNU extensions,
# which kotiba-stt's CMakeLists turns off) unless asked. MSVC gets the same define upstream.
set(CMAKE_C_FLAGS_INIT   "-D_USE_MATH_DEFINES")
set(CMAKE_CXX_FLAGS_INIT "-D_USE_MATH_DEFINES")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
EOF

jobs="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"

build_one() {
  local name="$1"; shift
  echo "== $name"
  cmake -S "$win/native/$name" -B "$build/$name" \
    -DCMAKE_TOOLCHAIN_FILE="$tc/windows-x64.cmake" \
    -DCMAKE_BUILD_TYPE=Release "$@" >"$build/$name.configure.log" 2>&1 \
    || { tail -40 "$build/$name.configure.log"; exit 1; }
  cmake --build "$build/$name" -j "$jobs" >"$build/$name.build.log" 2>&1 \
    || { grep -E "error|Error" "$build/$name.build.log" | head -40; exit 1; }
  # Warnings are part of the result — for OUR sources; whisper.cpp's are upstream's.
  grep -E "warning:" "$build/$name.build.log" | grep -F "$win/native/" | sort -u || true
  # whisper.cpp's own install rules add bin/, lib/ and include/ trees beside ours; only
  # the flat top level is what ships, so install to a staging prefix and copy that.
  cmake --install "$build/$name" --prefix "$build/stage" >/dev/null
}

rm -rf "$build/stage"

build_one kotiba-hook
build_one kotiba-input
stt_args=(-DKOTIBA_CPU_ALL_VARIANTS=ON)
[ -n "$whisper_src" ] && stt_args+=(-DKOTIBA_WHISPER_SOURCE_DIR="$whisper_src")
build_one kotiba-stt "${stt_args[@]}"

# parakeet.dll is whisper.cpp v1.9.2's own Parakeet port, built beside whisper.dll and
# linked by nothing of ours (kotiba-stt imports whisper.dll and ggml.dll only; Parakeet runs
# on onnxruntime-node in the app, D-W18). Not shipped.
rm -f "$prefix"/*.exe "$prefix"/*.dll
for f in "$build/stage"/*.exe "$build/stage"/*.dll; do
  case "$(basename "$f")" in parakeet.dll) continue ;; esac
  cp "$f" "$prefix/"
done

# THE RUNTIME CHECK — the whole reason for static linking. Any MSVC runtime import, or a
# MinGW runtime DLL (libstdc++-6, libgcc_s, libwinpthread-1) that nothing would ship, fails
# the build here rather than on a user's clean Windows as "The code execution cannot
# proceed". Every import must be a system DLL, the UCRT's api-ms-win-crt-* set (in Windows
# 10 and 11), or one of the files beside it.
objdump="$(command -v llvm-objdump || command -v objdump || true)"
if [ -n "$objdump" ]; then
  bad=0
  for f in "$prefix"/*.exe "$prefix"/*.dll; do
    deps="$("$objdump" -p "$f" | awk '/DLL Name:/ {print $3}' | sort -uf)"
    echo "$(basename "$f"): $(echo $deps)"
    for d in $deps; do
      lower="$(echo "$d" | tr 'A-Z' 'a-z')"
      case "$lower" in
        api-ms-win-crt-*|kernel32.dll|user32.dll|advapi32.dll|ole32.dll|oleaut32.dll) ;;
        *) [ -e "$prefix/$d" ] || { echo "  FAIL: $d is neither a system DLL nor shipped beside it" >&2; bad=1; } ;;
      esac
    done
  done
  [ "$bad" = 0 ] || exit 1
else
  echo "build-native-zig: no objdump/llvm-objdump — import check skipped" >&2
fi

echo "build-native-zig: done → $prefix"
ls -l "$prefix"

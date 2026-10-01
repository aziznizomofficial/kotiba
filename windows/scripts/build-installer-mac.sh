#!/usr/bin/env bash
#
# windows/scripts/build-installer-mac.sh — build Kotiba-Setup-<version>.exe on a Mac, end to
# end, with no Windows machine and no GitHub Actions. The CI/MSVC route (checklist Part A)
# stays the reference; this is the route when neither is available.
#
#   1. native helpers   scripts/build-native-zig.sh → resources/native (static runtime, CPU
#                       dispatch; see that script)
#   2. JavaScript       npm ci (if node_modules is missing) + npm run build
#   3. win-x64 addons   npm on a Mac installs darwin prebuilts. The Windows ones are fetched
#                       with `npm pack` at the lockfile's exact version, checked against the
#                       lockfile's sha512 `integrity`, and unpacked beside them:
#                       @node-llama-cpp/win-x64, @node-llama-cpp/win-x64-vulkan (never the
#                       CUDA pair — electron-builder.yml excludes them), and
#                       @reflink/reflink-win32-x64-msvc; and for Arabic (C4) transcribe.cpp's
#                       @transcribe-cpp/win32-x64-cpu-vulkan (transcribe.dll + ggml DLLs) and
#                       koffi's @koromix/koffi-win32-x64 (koffi.node). onnxruntime-node already
#                       carries win32/x64 in its one package.
#   4. models           scripts/fetch-models.mjs --dest fixtures/models, after symlinking
#                       any model already on this Mac (KOTIBA_MODELS_DIR, default the Mac
#                       app's own folder) so nothing is downloaded twice. Every file is
#                       sha256-checked by fetch-models either way; electron-builder copies
#                       the symlinks' targets, not the links (verified: the Uzbek model's
#                       sha256 inside app-64.7z matches).
#   5. Electron         electron-builder's own download of electron-v<ver>-win32-x64.zip
#                       hangs from here. It is fetched once (or taken from ~/Library/Caches/
#                       electron), checked against Electron's SHASUMS256.txt, and served
#                       from 127.0.0.1 as ELECTRON_MIRROR.
#   6. package          electron-builder --win --x64 (about 1 minute on an M4 Pro)
#   7. verify           scripts/verify-installer.mjs, with 7zz standing in for 7z
#
# Usage: windows/scripts/build-installer-mac.sh      (ZIG=/path/to/zig if not on PATH)
# Scratch (mirror, npm tarballs, cmake trees): $KOTIBA_WIN_SCRATCH, default
# windows/build-native-zig. Output: windows/release/.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
win="$(cd "$here/.." && pwd)"
scratch="${KOTIBA_WIN_SCRATCH:-$win/build-native-zig}"
models_dir="${KOTIBA_MODELS_DIR:-$HOME/Library/Application Support/Kotiba/models}"
mkdir -p "$scratch"
cd "$win"

echo "== 1. native helpers"
bash "$here/build-native-zig.sh" --build-dir "$scratch/cmake" --prefix "$win/resources/native" \
  ${KOTIBA_WHISPER_SOURCE_DIR:+--whisper-src "$KOTIBA_WHISPER_SOURCE_DIR"}

echo "== 2. JavaScript"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run build >/dev/null

echo "== 3. win-x64 prebuilt addons"
for pkg in @node-llama-cpp/win-x64 @node-llama-cpp/win-x64-vulkan @reflink/reflink-win32-x64-msvc \
           @transcribe-cpp/win32-x64-cpu-vulkan @koromix/koffi-win32-x64; do
  read -r version integrity < <(node -e "
    const p = require('./package-lock.json').packages['node_modules/$pkg'];
    if (!p) { console.error('$pkg is not in package-lock.json'); process.exit(1); }
    console.log(p.version, p.integrity);")
  tgz="$scratch/npm/$(echo "${pkg#@}" | tr '/' '-')-$version.tgz"
  mkdir -p "$scratch/npm"
  [ -f "$tgz" ] || (cd "$scratch/npm" && npm pack "$pkg@$version" >/dev/null 2>&1)
  got="sha512-$(openssl dgst -sha512 -binary "$tgz" | base64 | tr -d '\n')"
  [ "$got" = "$integrity" ] || { echo "FAIL: $pkg@$version does not match the lockfile's integrity" >&2; exit 1; }
  rm -rf "node_modules/$pkg" && mkdir -p "node_modules/$pkg"
  tar -xzf "$tgz" -C "node_modules/$pkg" --strip-components=1
  echo "ok    $pkg@$version (integrity matches the lockfile)"
done

echo "== 3b. the Arabic speed-check clip"
[ -f fixtures/speed-check/arabic-speed-check.wav ] || { echo "FAIL: fixtures/speed-check/arabic-speed-check.wav is missing" >&2; exit 1; }

echo "== 4. models"
mkdir -p fixtures/models
# Only what the installer carries (D-W25): whisper turbo is a Turkish/Arabic download now, and
# a link left from an older build is removed so it cannot be staged (electron-builder.yml names
# the shipped files too; verify-installer.mjs fails a build that carries it).
rm -f fixtures/models/ggml-large-v3-turbo-q5_0.bin
for f in ggml-uzbek-stt-v1-q5_0.bin ggml-base-q5_1.bin; do
  [ -e "fixtures/models/$f" ] || [ ! -f "$models_dir/$f" ] || ln -s "$models_dir/$f" "fixtures/models/$f"
done
node scripts/fetch-models.mjs --dest fixtures/models

echo "== 5. Electron for win32-x64, from a local mirror"
ever="$(node -p "require('./node_modules/electron/package.json').version")"
zip="electron-v$ever-win32-x64.zip"
mirror="$scratch/mirror/v$ever"
mkdir -p "$mirror"
[ -f "$mirror/SHASUMS256.txt" ] || curl -fsSL -o "$mirror/SHASUMS256.txt" \
  "https://github.com/electron/electron/releases/download/v$ever/SHASUMS256.txt"
want="$(awk -v z="*$zip" '$2 == z {print $1}' "$mirror/SHASUMS256.txt")"
if [ ! -f "$mirror/$zip" ]; then
  cached="$(ls "$HOME"/Library/Caches/electron/*/"$zip" 2>/dev/null | head -1 || true)"
  if [ -n "$cached" ]; then cp "$cached" "$mirror/$zip"
  else curl -fL -o "$mirror/$zip" "https://github.com/electron/electron/releases/download/v$ever/$zip"; fi
fi
[ "$(shasum -a 256 "$mirror/$zip" | cut -d' ' -f1)" = "$want" ] || { echo "FAIL: $zip sha256" >&2; exit 1; }
port=8765
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$scratch/mirror" >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT
sleep 1

echo "== 6. electron-builder"
rm -rf release
ELECTRON_MIRROR="http://127.0.0.1:$port/" ELECTRON_BUILDER_OFFLINE=true \
  npx electron-builder --win --x64 --publish never

echo "== 7. verify"
mkdir -p "$scratch/shim"
command -v 7z >/dev/null || { [ -x /opt/homebrew/bin/7zz ] && ln -sf /opt/homebrew/bin/7zz "$scratch/shim/7z"; }
PATH="$scratch/shim:$PATH" node scripts/verify-installer.mjs "release/Kotiba-Setup-$(node -p "require('./package.json').version").exe"
# A public installer must not name the machine it was built on (see the prefix maps in
# build-native-zig.sh). The payload inside the .exe is compressed, so check the unpacked tree.
if LC_ALL=C grep -rlaF "$HOME/" release/win-unpacked >/dev/null; then
  echo "FAIL: the packaged app names this machine's home folder:" >&2
  LC_ALL=C grep -rlaF "$HOME/" release/win-unpacked >&2; exit 1
fi
echo "ok    no build-machine paths in release/win-unpacked"
shasum -a 256 release/*.exe

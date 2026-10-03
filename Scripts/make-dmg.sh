#!/bin/bash
# Build Kotiba.app and wrap it in a .dmg.
#
# Two kinds of image:
#
#   Scripts/make-dmg.sh [output-directory]
#       The app with the models Uzbek needs inside — Kotib STT (539 MB), Silero VAD (0.9 MB) and
#       the whisper-base language detector (60 MB) — so Uzbek dictation works offline from the
#       first launch. The rest of the core — Parakeet Ultra (English + Russian, 632 MB) and
#       Qwen3 1.7B (the modes, 1.28 GB) — downloads by itself once setup is finished, with no
#       step to accept it (owner, 2026-10-02): one "Getting Kotiba ready — 1.9 GB" card, each
#       file sha256-verified and resumable, Kotiba working meanwhile (English on Apple's engine,
#       the modes on their deterministic rules). It cannot all ride in the image: GitHub refuses
#       a release asset of 2 GiB or more, and the whole core is ~2.5 GB. Turkish and Arabic
#       (whisper turbo, Cohere, Gemma 4 E2B) are never in any image — they download when their
#       language is switched on. The Windows installer makes the same split.
#
#   Scripts/make-dmg.sh --with-models [output-directory]
#       All of the above plus Parakeet and Qwen inside the bundle (~2.5 GB), for a machine that
#       should never download anything — too big for a GitHub release asset, so never the
#       published image; the core card then never appears.
#
#   Scripts/make-dmg.sh --adhoc [--with-models] [output-directory]
#       The PUBLIC release build: signed ad hoc (`codesign --sign -`), so it carries no Apple ID,
#       no team and no certificate, and anyone can build the identical thing without an Apple
#       account. xcodebuild is told not to sign at all (no Team ID needed), the bundle is sealed
#       once at the end, and the app-group entitlement is left out: `$(TeamIdentifierPrefix)` has
#       nothing to expand to without a team, and nothing on macOS reads that group (grep
#       containerURL/suiteName). No hardened runtime either: it only matters for notarisation,
#       which an ad-hoc build cannot have, and its library validation would refuse the bundle's
#       own ad-hoc frameworks (no Team ID to match).
#       The cost, which the READ ME states: macOS keys Accessibility and Input Monitoring to an
#       ad-hoc app's code hash, so every update has to be granted again.
#
# The app finds bundled models in Contents/Resources/models — ggml files through
# `AppSettings.locate`, Parakeet's Core ML directory, Silero and the GGUF through
# `DictationController.bundledModels` — and always prefers a copy in
# ~/Library/Application Support/Kotiba/models, so a Mac that already has them (the owner's) uses
# those and the bundle's are never duplicated there.
#
# Two things this CANNOT fix, and they belong in the README beside the .dmg rather than in a
# reassuring sentence here:
#
#   * Without --adhoc it signs with the first Apple Development identity in the keychain. Distribution outside the App
#     Store needs a Developer ID Application certificate plus notarisation — decision D-03, still
#     open. Without it Gatekeeper refuses the app on every Mac but this one, and the user has to
#     clear the quarantine flag by hand.
#   * Accessibility and Input Monitoring cannot be granted programmatically and macOS does not
#     prompt for them. Two manual grants, always.
set -euo pipefail

WITH_MODELS=0
ADHOC=0
while [ $# -gt 0 ]; do
  case "$1" in
    --with-models) WITH_MODELS=1; shift ;;
    --adhoc) ADHOC=1; shift ;;
    *) break ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
STAGE="$(mktemp -d)"
MODELS="$HOME/Library/Application Support/Kotiba/models"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
    "$ROOT/Apps/macOS/Info.plist" 2>/dev/null || echo 0.1)"
SUFFIX=""
[ "$WITH_MODELS" -eq 1 ] && SUFFIX="-offline"
DMG="$OUT/Kotiba-$VERSION$SUFFIX.dmg"

# What goes inside. Keep in step with ModelCatalogue and `ModelDownloads.Item.core`. whisper
# large-v3-turbo is deliberately absent from both: Parakeet does Russian, and turbo belongs to
# Turkish and Arabic, which download it when they are switched on.
WANTED=(
  "ggml-uzbek-stt-v1-q5_0.bin"        # Uzbek — Kotib STT, D-08
  "ecapa-voxlingua107-lid-f16.mlmodel" # language ID (P4, D-14) — replaces whisper base
  "ggml-silero-v6.2.0.bin"            # pause detector for both streaming engines (C2 §4)
)
if [ "$WITH_MODELS" -eq 1 ]; then
  WANTED+=(
    "Qwen3-1.7B-Q4_K_M.gguf"          # the modes (C3)
    "parakeet-ultra-coreml"           # English + Russian, a Core ML directory with its stamp (C1)
  )
fi

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

echo "=== checking the models are here before spending ten minutes on a build ==="
missing=0
for m in "${WANTED[@]}"; do
  if [ -e "$MODELS/$m" ]; then
    printf '  %-34s %s\n' "$m" "$(du -sh "$MODELS/$m" | cut -f1)"
  else
    echo "  MISSING $m — expected at $MODELS/$m (fetch it with the app, or make bootstrap)"
    missing=1
  fi
done
if [ -d "$MODELS/parakeet-ultra-coreml" ] \
   && [ ! -f "$MODELS/parakeet-ultra-coreml/.kotiba-verified.json" ]; then
  echo "  parakeet-ultra-coreml has no verification stamp — let the app finish verifying it"
  missing=1
fi
[ "$missing" -eq 0 ] || { echo "cannot build the image without every model above"; exit 1; }

echo "=== build ==="
APP="$STAGE/xcode/Build/Products/Release/KotibaMac.app"
cd "$ROOT"
xcodegen generate >/dev/null
# NO COVERAGE. The KotibaMac scheme gathers coverage for its tests (project.yml), and
# xcodebuild applied that to this Release *build* as well (CLANG_COVERAGE_MAPPING=YES): every
# module compiled with profile counters — 9,084 in 1.0.0's first image — a counter bump on every
# branch, a default.profraw written on exit, and the builder's absolute source paths inside the
# binary. `-enableCodeCoverage NO` is refused outside `test`, so the settings go in directly.
NO_COVERAGE=(CLANG_COVERAGE_MAPPING=NO CLANG_ENABLE_CODE_COVERAGE=NO)
if [ "$ADHOC" -eq 1 ]; then
  # Command-line settings beat Config/Local.xcconfig, so a maintainer's own Team ID cannot leak
  # into the public build even when that file is present. DEPLOYMENT_POSTPROCESSING strips the
  # executable as an archive would (36.6 → 18.8 MB): the debug map otherwise carries the build
  # machine's source directories, home folder included.
  xcodebuild -project Kotiba.xcodeproj -scheme KotibaMac -configuration Release \
      -destination 'platform=macOS' -derivedDataPath "$STAGE/xcode" "${NO_COVERAGE[@]}" \
      DEPLOYMENT_POSTPROCESSING=YES \
      CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY= DEVELOPMENT_TEAM= build 2>&1 | tail -2
else
  # Not stripped: the maintainer's own build keeps its symbols for crash reports.
  xcodebuild -project Kotiba.xcodeproj -scheme KotibaMac -configuration Release \
      -destination 'platform=macOS' -derivedDataPath "$STAGE/xcode" "${NO_COVERAGE[@]}" \
      build 2>&1 | tail -2
fi
[ -d "$APP" ] || { echo "no app was produced"; exit 1; }
if nm "$APP/Contents/MacOS/KotibaMac" 2>/dev/null | grep -q '__llvm_profile'; then
  echo "the Release binary is coverage-instrumented — refusing to ship it"; exit 1
fi
if [ "$ADHOC" -eq 1 ] && LC_ALL=C grep -rqaF "$HOME/" "$APP"; then
  echo "the public build names this machine's home folder:"
  LC_ALL=C grep -rlaF "$HOME/" "$APP"; exit 1
fi

echo "=== embed the models ==="
mkdir -p "$APP/Contents/Resources/models"
for m in "${WANTED[@]}"; do
  # -R for Parakeet's directory; -L so a symlinked model is copied, not linked.
  cp -RL "$MODELS/$m" "$APP/Contents/Resources/models/$m"
done
du -sh "$APP"

echo "=== re-sign (adding files to the bundle invalidates the seal) ==="
# The same identity as `make install`, so the designated requirement is unchanged and an existing
# machine's Accessibility and Input Monitoring grants survive an update rather than being asked for
# again. --deep because the bundle carries a framework.
if [ "$ADHOC" -eq 1 ]; then
  IDENTITY="-"
  echo "  identity: ad hoc"
  cat > "$STAGE/adhoc.entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.app-sandbox</key>
	<false/>
</dict>
</plist>
PLIST
  codesign --force --deep --sign - --entitlements "$STAGE/adhoc.entitlements" "$APP" 2>&1 | tail -2
  # The point of --adhoc: nothing in the bundle may name a team or a certificate.
  if codesign -dv "$APP" 2>&1 | grep -E '^TeamIdentifier=' | grep -qv 'not set'; then
    echo "an ad-hoc build carries a Team ID:"; codesign -dv "$APP" 2>&1 | grep -E 'Team|Authority'; exit 1
  fi
else
  IDENTITY="$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/{print $2; exit}')"
  [ -n "$IDENTITY" ] || { echo "no codesigning identity found"; exit 1; }
  echo "  identity: $IDENTITY"
  codesign --force --deep --options runtime --sign "$IDENTITY" "$APP" 2>&1 | tail -2
fi
codesign --verify --deep --strict "$APP" && echo "  signature verifies"

echo "=== stage the disk image ==="
IMG="$STAGE/img"
mkdir -p "$IMG"
cp -R "$APP" "$IMG/Kotiba.app"
ln -s /Applications "$IMG/Applications"
cp "$ROOT/Scripts/dmg-README.txt" "$IMG/READ ME FIRST.txt"

echo "=== create $DMG ==="
mkdir -p "$OUT"
rm -f "$DMG"
# UDZO: the weights are already quantised so compression gains little, but it makes the image
# read-only, which is what stops someone dragging a stale model into it.
hdiutil create -volname "Kotiba" -srcfolder "$IMG" -ov -format UDZO -quiet "$DMG"
# An ad-hoc signature on the image adds nothing (Gatekeeper ignores it), so only a real identity
# signs it.
[ "$ADHOC" -eq 1 ] || codesign --force --sign "$IDENTITY" "$DMG" 2>&1 | tail -1

# GitHub refuses a release asset of 2 GiB or more. The default image is ~0.6 GB, so tripping this
# means a model was added to WANTED that belongs to the first-run core download instead.
BYTES="$(stat -f %z "$DMG")"
if [ "$BYTES" -ge 2147483648 ]; then
  if [ "$WITH_MODELS" -eq 1 ]; then
    echo "note: $DMG is $BYTES bytes — over GitHub's 2 GiB release-asset limit (fine for a local image)"
  else
    echo "$DMG is $BYTES bytes — over GitHub's 2 GiB release-asset limit"; exit 1
  fi
fi

echo
ls -lh "$DMG"
shasum -a 256 "$DMG"
echo "DMGDONE"

# Setting up Kotiba

For people who want to run it, and for people who want to build it. macOS first, Windows at the
end. The README has the short version; this is the long one.

## 1. Running a release build (macOS)

1. Get `Kotiba-<version>.dmg` from the Releases page, drag Kotiba to Applications.
2. The build is not notarised, so the first open is refused. In that dialog click **Done**
   (never "Move to Trash"), then **System Settings › Privacy & Security › Open Anyway**. Or run
   `xattr -dr com.apple.quarantine /Applications/Kotiba.app`.
3. Grant the permissions below, then **hold right ⌘**, talk, let go.

### Permissions

| Permission | Why | Without it |
| --- | --- | --- |
| **Input Monitoring** | To see you holding the hotkey | The hotkey silently never fires |
| **Accessibility** | To paste into the app you were using | Every dictation ends in "Could not paste" |
| **Microphone** | To hear you | Nothing is recorded |

macOS asks for the microphone by itself. For the other two it only offers to open System
Settings; add Kotiba by hand: **Privacy & Security › Input Monitoring** › `+` › `Kotiba.app`, and the
same under **Accessibility**. Settings › Permissions lists what is missing and opens the right
pane. Kotiba is not sandboxed, because those two permissions do not survive the sandbox.

### Upgrading from Kotib

Until 1.0 the app was called Kotib. On its first launch Kotiba moves the old data across by
itself — nothing to copy, and nothing is downloaded again:

- `~/Library/Application Support/Kotib` becomes `…/Kotiba` (models, history, diagnostics) in one
  rename. If a `Kotiba` folder already exists the two are merged; a clashing file of the new one
  is kept beside it as `<name>.before-rename`.
- The settings (defaults domain `uz.kotib.app`) are imported into `uz.kotiba.app`.
- A polish API key is copied from the Keychain item `uz.kotib.app` to `uz.kotiba.app`. macOS may
  ask once whether Kotiba may read it (the item belongs to the old app): **Always Allow**. If you
  refuse, enter the key again in Settings › Modes. The old item is left; remove it with
  `security delete-generic-password -s uz.kotib.app -a polish-default` if you like.

If the old Kotib is still running, nothing is moved and Home says so: quit it first (its menu ›
**Turn Off Always On & Quit**), then quit and reopen Kotiba. That quit saves Always on as off, and
Kotiba imports it that way, so switch **Always on** back on in Kotiba's Settings › General.

**The permissions do not move.** macOS grants Input Monitoring, Accessibility and the microphone
to an app's bundle id, and the new name is a new id (`uz.kotiba.app`). Once, by hand:

1. **System Settings › Privacy & Security › Input Monitoring**: select **Kotib**, click `−`. Then
   switch **Kotiba** on — or `+` › `/Applications/Kotiba.app` if it is not listed.
2. The same under **Accessibility**.
3. **Microphone**: allow Kotiba when it asks (or switch it on in that list; remove Kotib there too).
4. If you use always-on, macOS may notify you that Kotiba added a background item; allow it in
   **General › Login Items & Extensions**. A leftover **Kotib** entry there can be switched off.

Home shows a note with these steps until all three are granted; no restart is needed.

**The old always-on agent.** Kotib registered `uz.kotib.app.agent` with launchd from inside its
own bundle. Kotiba cannot unregister another app's agent, and does not need to: quit Kotib with
**Turn Off Always On & Quit** before deleting it (that unregisters the agent), and once
`/Applications/Kotib.app` is gone launchd has nothing left to start. Deleting the old app while
its agent is registered is harmless too — the login item fails to find it — but leaves a dead
**Kotib** row in Login Items until macOS prunes it.

**Windows.** `%APPDATA%\Kotib` and `%LOCALAPPDATA%\Kotib` become `…\Kotiba` the same way, and the
polish key is copied from the credential `uz.kotib.app:<account>` to `uz.kotiba.app:<account>`.
Kotiba installs beside Kotib rather than over it (new app id): uninstall **Kotib** from Settings ›
Apps afterwards, which also removes its autostart entry. There are no permissions to re-grant.

### Models

| Language | Model | Size | Delivered |
| --- | --- | --- | --- |
| English, Russian | Parakeet Ultra (Core ML, Neural Engine) | about 632 MB | Downloaded by the app on first launch, then cached |
| Uzbek | `Kotib/uzbek_stt_v1`, ggml q5_0 | 539 MB | Inside the DMG |
| Language detection | Whisper base q5_1 | 60 MB | Inside the DMG |
| Modes | Qwen3-1.7B Q4_K_M | 1.28 GB | Modes page › Download |

Until Parakeet finishes downloading, Apple's built-in recogniser answers English and Whisper
large-v3-turbo answers Russian. The first load of Parakeet after a fresh install or an update
compiles a Neural Engine plan and can take 15 to 25 seconds; after that it reloads in a fraction
of a second, unless macOS purges its cache under disk pressure.

Only the default language's Whisper model stays in memory; the others load when you press the
key. **Settings › Languages › Keep every language loaded** trades memory for that.

## 2. Using it

**Hold the hotkey. Talk. Let go.** The text is pasted where the cursor was. Change the key on the
**Hotkey** page (a single modifier such as right ⌥, or a function key such as F13).

| Mode | What it does | Runs on |
| --- | --- | --- |
| Super (default) | Your words; only clear slips are fixed (stutters, fillers, punctuation) | Rules, plus the on-device model for Uzbek punctuation |
| Message | A short chat message | On-device Qwen3-1.7B |
| Note | A short Markdown note | On-device Qwen3-1.7B |
| Raw | Exactly what was said | No model |

"Let the app I am in choose the mode" (Modes page) picks Message for chat apps and Note for note
apps. Everything runs on the device. The optional **cloud polish** (Settings, off by default)
sends the recognised text, never audio, to an endpoint and key you provide.

**Words Kotiba gets wrong** (Settings) are handed to the recogniser before it decodes.
**Replacements** are literal find-and-replace, applied once, left to right.

## 3. When something is wrong

**Settings › Diagnostics** records stage timings and outcomes on every dictation, never the
words; it is safe to paste into a bug report. Data lives in `~/Library/Application Support/Kotiba/`
(`history.sqlite`, `diagnostics.jsonl`, `models/`); settings are in `defaults read uz.kotiba.app`.

| What you see | Usual cause |
| --- | --- |
| The hotkey does nothing | Input Monitoring is not granted |
| "Could not paste" | Accessibility is not granted |
| "I did not hear anything" | Genuinely silent, or the wrong input device |
| First dictation after install is slow | Parakeet is downloading or compiling; fallbacks answer meanwhile |
| Uzbek comes out as gibberish | Pin Uzbek in the menu bar or Languages page instead of Automatic |
| A transcript is nonsense | Check the input peak in Diagnostics; at 1.00 the input is clipping |

## 4. Building from source (macOS)

Requirements: Xcode 26.2 or newer (Swift 6.2, macOS 26 SDK) and XcodeGen 2.45 or newer.

```
make doctor       # toolchain check
make bootstrap    # fetch models in Scripts/Manifest.json, verify sha256
make generate     # Kotiba.xcodeproj from project.yml (the project file is git-ignored)
make build        # swift build
make test         # bands 1 and 2: no signing, no models, no microphone
make lint         # KotibaCore must stay pure
make test-models  # band 3: needs the real models (KOTIBA_MODEL_DIR)
make app          # Release KotibaMac.app under build/xcode
make probe ARGS="--engine parakeet --language ru clip.wav"   # measure an engine on a clip
```

### Your Apple Team ID

Signing needs a Team ID, and the repository contains none. Create `Config/Local.xcconfig`
(git-ignored):

```
DEVELOPMENT_TEAM = ABCDE12345
```

The ten-character ID is under Xcode › Settings › Accounts; a free personal team works for macOS.
If you keep the same file at `~/.config/kotiba/Local.xcconfig`, `make generate` copies it into any
checkout or worktree that lacks one. The macOS app group is `$(TeamIdentifierPrefix)kotiba`, so it
follows your team automatically. The bundle identifier `uz.kotiba.app` is unchanged; if you want to
run your build next to a release build, change it in `project.yml`, and expect macOS to ask for the
permissions again, because permissions are tied to the bundle identifier and signing identity.

Never run two builds of the same bundle identifier at once: two menu-bar icons, two hotkey taps
and racing pastes.

### The Uzbek model

Upstream `Kotib/uzbek_stt_v1` ships safetensors only. Kotiba uses a ggml q5_0 conversion
(`ggml-uzbek-stt-v1-q5_0.bin`, 539,212,484 bytes) made with whisper.cpp's `convert-h5-to-ggml.py`
and `quantize`. Put the file in `~/Library/Application Support/Kotiba/models/`.
`Scripts/convert-uzbek.sh` documents the procedure (it still names an earlier model in places;
the steps are the same). A converted model is a modified work under Apache-2.0; keep the notice
in `THIRD_PARTY_NOTICES.md` if you redistribute it.

### Measuring

Every number in the README is reproducible with `make probe` and the scripts under
`Scripts/measure/`, on your own machine and your own clips.

## 5. Windows

Electron 43, TypeScript and a small C++ transcriber under `windows/`.

```
cd windows
npm ci
npm run gate      # layering check, typecheck, lint, tests
```

Release installers are built on Windows by CI (`.github/workflows/windows-port.yml`); NSIS does
not run on macOS. The default hotkey is right Ctrl. SmartScreen warns on the unsigned installer:
**More info › Run anyway**.

## 6. Not done

- **iOS.** The targets build; the app is not written.
- **Notarised, signed distribution.** Needs paid Apple and Windows programmes.
- **Windows latency** has not been measured on Windows hardware.

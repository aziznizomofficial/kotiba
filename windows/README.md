# Kotiba for Windows

A 1:1 functional port of the macOS dictation app: hold a key, speak, and the words land
in whatever you were typing into. Uzbek, Russian and English, all on-device.

Everything Windows lives under `windows/`. The Swift tree beside it is the truth this
port is measured against; `docs/windows/` holds the decisions, the module map and the
behaviour inventory, and they are the documents to read before touching anything here.

## The gate

```
bash windows/scripts/gate.sh        # from the repository root
```

Layering grep, `tsc --noEmit`, ESLint, Vitest. It installs dependencies itself if
`node_modules` is missing, and it passes on a clean checkout with every module still a
stub — so it stays green as the modules land one at a time. It exits non-zero on the
first failure and names the file.

CI runs exactly this, on `ubuntu-latest`, in `.github/workflows/windows-port.yml`.

## Layout

```
src/contracts/   every shared type and interface — no logic, no OS
src/core/        routing, text, settings, modes, stt — pure functions over plain data
src/engines/     model store, engine manager, STT host client, Parakeet (onnxruntime-node)
src/polish/      the modes' model half: incremental polish, Qwen3-1.7B (node-llama-cpp)
src/audio/       capture, resample, peak, silence
src/platform/    hotkey client, insertion, focus, history, diagnostics, stores
src/session/     the dictation state machine
src/main/        Electron main, tray, IPC, autostart, --check
src/renderer/    the app window (seven sections + onboarding) and the pill HUD
native/          three small C++ helpers: kotiba-stt, kotiba-hook, kotiba-input
```

### The layering rule, and why it is a build step

**`src/core/**` and `src/contracts/**` import nothing from Electron, no Node builtin,
and no OS API.** They are pure functions over plain data; everything that needs a file,
a device or a process arrives through an interface.

That is not tidiness. Kotiba's routing is not business logic, it is a detector with a
recall curve, and a reimplementation that is quietly 3% different produces "Uzbek
accuracy is awful" with every test still green. Keeping the decision logic pure is what
lets the golden-parity suite — the same inputs the Swift implementation was measured on,
asserted byte for byte — run on a Linux runner in seconds, on every commit. The
duplication is not trusted; it is checked.

`gate.sh` greps for violations and ESLint refuses them in the editor.

## What is different from the Mac, and why

| | macOS | Windows |
|---|---|---|
| push to talk | hold right ⌘ | **hold Right Ctrl**, configurable — there is no Command key, and Right Alt is AltGr on this audience's layouts |
| English, Russian | Parakeet Ultra on the Neural Engine | **the same Parakeet Ultra weights on ONNX Runtime (CPU)**, downloaded by itself after setup (668 MB); until they land English and Russian wait, and a press says how far the download has got (D-W25). Same accuracy on FLEURS (5.8 % / 7.3 %); Windows speed unmeasured — docs/windows/03-ENGINE-PARITY.md §10 |
| modes | Qwen3-1.7B on Metal | the same GGUF through node-llama-cpp (Vulkan or CPU), downloaded by itself after setup (1.28 GB); until then every mode runs its rule-based half |
| Turkish, Arabic | downloaded when turned on | the same: Turkish brings `large-v3-turbo` (574 MB); Arabic brings Cohere (1.77 GB), turbo and Gemma 4 E2B — none of it is in the installer |
| installer | DMG with Uzbek inside | **≈ 0.67 GB**: Kotib STT, the whisper-base detector and Silero, so Uzbek works offline from the first launch; then 1.95 GB downloads in the background (Parakeet + Qwen), resuming if interrupted |
| Uzbek beam width | 5 | **1** — measured at 0.03 WER points for +21% to +39% latency on the model that actually ships |
| history | `history.sqlite` + FTS5 | JSONL with an in-memory index — no native module for anyone here to rebuild |
| microphone | AVAudioEngine | a hidden renderer at `AudioContext({ sampleRate: 16000 })`, so the browser's own resampler does the conversion |
| permissions | three, two of them buried in System Settings | **one**: the microphone. Windows needs no Accessibility or Input Monitoring grant |
| first run | none | a window, because the gesture changed and a user who does not know the key has no app |

Everything else is parity, and the parity is asserted rather than hoped for.

## Windows will warn about this download

The installer is unsigned, so SmartScreen shows *"Windows protected your PC"*. Click
**More info → Run anyway**.

This is expected and it is stated first because a user who reads the warning as "the
download is broken" never gets to the app. A code-signing certificate is $200–400 a year
*and* has to accumulate reputation before the warning stops; the macOS trick of
downloading with `curl` does not transfer, because SmartScreen judges the certificate
rather than how the file arrived.

## Dependencies

Pinned once, in `package.json`, and **no task other than t01 edits that file**:

```
electron 43.4.0 · electron-builder 26.15.3 · typescript 5.9.3 · vitest 4.x
eslint + @typescript-eslint · zod
```

Deliberately absent: `better-sqlite3` (history is JSONL), `robotjs` / `@nut-tree`, and
any global-hotkey package — none of them can express press-and-hold on a bare modifier,
and the three C++ helpers replace them.

If you need something that is not on that list, record `REQUEST: <package> — <why>` in
your result and work around it.

> `@types/node` is not listed above and is not declared: it arrives as a real dependency
> of `electron` and is pinned by `package-lock.json`, so `npm ci` reproduces it exactly.
> Without it nothing under `src/platform` or `src/engines` would typecheck.

## Where things are at runtime

```
%APPDATA%\Kotiba\settings.v1.json          the whole settings blob, one file (roams)
%APPDATA%\Kotiba\models\                   downloaded models (Parakeet, Qwen) and any dropped in by
                                          hand — these WIN over the bundled ones
%LOCALAPPDATA%\Kotiba\history.jsonl         append-only, in-memory index (does not roam)
%LOCALAPPDATA%\Kotiba\diagnostics.jsonl     append-only, {environment, record} per line
%LOCALAPPDATA%\Kotiba\watchdog.json         the crash watchdog's relaunch record
<install dir>\resources\models\           the models the installer carries, and Silero
<install dir>\resources\native\           kotiba-stt / kotiba-hook / kotiba-input, and the C runtime
                                          DLLs kotiba-stt needs
```

The API key is never in any of those. It lives in Windows Credential Manager, because
anything in the settings file can end up in a support bundle.

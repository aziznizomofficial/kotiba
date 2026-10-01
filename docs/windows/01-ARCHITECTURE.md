# Kotiba for Windows — architecture and file ownership

Everything Windows lives under `windows/`. The Swift tree is touched by exactly one task
(t02, which adds a golden-fixture generator) and by nobody else.

```
windows/
  package.json  tsconfig.json  electron-builder.yml  .eslintrc.cjs   ← t01 only
  scripts/gate.sh  scripts/fetch-models.mjs                          ← t01 / t11
  src/
    contracts/        every shared type + interface, no logic        ← t01 only
    core/
      routing/        cluster mass, script check, route decision     ← t03
      text/           Uzbek delivery normaliser, capitaliser         ← t04
      settings/       schema, defaults, persistence, modes           ← t05
    engines/          model store, engine manager, stt host client   ← t06
    audio/            capture, resample, peak, silence               ← t08
    platform/         hotkey client, insertion, focus, history, diag ← t07
    session/          the dictation state machine                    ← t09
    main/             electron main, tray, IPC, autostart, --check   ← t10
    renderer/         settings window, onboarding                    ← t10
  native/
    kotiba-stt/        C++ persistent whisper host                    ← t06
    kotiba-hook/       C++ WH_KEYBOARD_LL push-to-talk reporter       ← t07
    kotiba-input/      C++ SendInput unicode + paste                  ← t07
  fixtures/
    golden/           generated from Swift — the parity contract     ← t02 writes, t03/t04 read
    audio/            committed WAV clips for --check                ← t08
  test/               vitest; each module owns its own test files
Sources/kotiba-golden/ Swift generator for fixtures/golden            ← t02 only
Package.swift                                                        ← t02 only
.github/workflows/windows-port.yml                                   ← t12 only
docs/windows/                                                        ← supervisor + t13
```

## The layering rule that makes this verifiable

**`src/core/**` and `src/contracts/**` must not import Electron, Node's `fs`, `child_process`,
or any Windows API.** They are pure functions over plain data. This is the same rule that made
`ai-balance/windows` testable from a Mac, and it is why the golden-parity suite can run on a
Linux runner in seconds.

`src/engines`, `src/audio`, `src/platform` may use Node. Only `src/main` and `src/renderer` may
import `electron`. `windows/scripts/gate.sh` enforces this with a grep, the same way
`make lint` enforces "KotibaCore stays pure" on the Swift side.

## Process shape at runtime

```
electron main  ──spawn──▶ kotiba-hook.exe    stdout: "DOWN 163" / "UP 163"
               ──spawn──▶ kotiba-input.exe   stdin:  JSON insert commands
               ──spawn──▶ kotiba-stt.exe     stdin:  f32 PCM frames + params
                                            stdout: JSON transcript
               ──hidden BrowserWindow──▶ getUserMedia → AudioWorklet @16 kHz
```

Three child processes, each replaceable, each independently testable from a shell. A crashed
helper is restarted by the main process and reported in the tray, never silently.

## Dependencies, pinned once, by t01 only

No other task edits `package.json`. If a task needs a dependency that is not below, it records
`REQUEST: <package> — <why>` in its result `notes` and works around it.

    electron 43.4.0 · electron-builder 26.15.3 · typescript 5.9.3 · vitest 4.x
    eslint + @typescript-eslint · zod (settings schema validation)

Deliberately absent: `better-sqlite3` (D-W5), `robotjs` / `@nut-tree` (D-W6, D-W7 — the native
helpers replace them), any global-hotkey npm package (they cannot express press-and-hold on a
bare modifier).

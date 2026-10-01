# Kotiba 1.0 for Windows — the one checklist

Nothing below has ever run on Windows. On the Mac, the TypeScript gate is green (2,275
tests). The two small helpers compile for `x86_64-windows-gnu` with zig 0.14.1 (mingw,
`-Wall -Wextra`, no warnings), and two probes ran against real code:

- the capture page and onboarding in Electron 32 on macOS;
- the watchdog and the helper protocols against stand-ins.

That proves the plumbing. It does not prove Windows: no MSVC build, no real key, no real
microphone, no real window.

**If you were handed a ready-made `Kotiba-Setup-1.0.0.exe`, skip Part A and start at Part B.**
That installer was built on the Mac (see "A7. Building the installer on a Mac" for exactly how,
and what was and was not checked there).

**Work top to bottom, and stop at the first step that does not match.** Each step says
what you should see. When something differs, write down the step number and what you saw,
and take a screenshot. Part A builds everything (about 1 hour, mostly waiting). Part B
installs. Part C tests each feature (about 2.5 hours).

Numbers marked **WRITE DOWN** are the measurements that only this PC can give.

---

## Part A — Build

### A1. Tools (once)

1. Install:
   - Node.js 22 LTS (x64);
   - Git for Windows, which provides Git Bash;
   - CMake 3.21 or newer;
   - "Visual Studio 2022 Build Tools" with the **Desktop development with C++** workload;
   - 7-Zip (optional: it lets step A6 look inside the installer).
2. Make sure there are **8 GB free** on the drive you build on: models, `node_modules`, the
   whisper.cpp build and the installer together take about 6 GB.

### A2. The source

1. `git clone` the repo, then `git checkout release/1.0`.
2. Copy the Uzbek model from the Mac to `windows\fixtures\models\`:
   - the file is `~/Library/Application Support/Kotiba/models/ggml-uzbek-stt-v1-q5_0.bin`
     (539,212,484 bytes);
   - the repo is private and the model host is not public yet, so step A4 cannot download
     this file unless `gh auth login` is done on this PC;
   - copying `ggml-large-v3-turbo-q5_0.bin` and `ggml-base-q5_1.bin` too saves about 630 MB
     of downloading. Step A4 fetches them otherwise.

### A3. The three native helpers, with MSVC

MSVC is the reference build. `windows/scripts/build-native-zig.sh` cross-compiles the same
three helpers with zig/mingw on a Mac or Linux (A7) — that build differs in two ways: no
`vcruntime140*.dll`/`msvcp140.dll` at all (static C++ runtime, the UCRT is part of Windows),
and `kotiba-stt` ships as `kotiba-stt.exe` + `whisper.dll`, `ggml.dll`, `ggml-base.dll` and
fourteen `ggml-cpu-<level>.dll`, one of which it picks for this CPU at startup instead of
requiring AVX2.

Open **"x64 Native Tools Command Prompt for VS 2022"** at the repository root, and run:

```
cmake -S windows/native/kotiba-hook  -B build/hook  -A x64
cmake --build build/hook  --config Release
cmake --install build/hook  --config Release --prefix windows/resources/native

cmake -S windows/native/kotiba-input -B build/input -A x64
cmake --build build/input --config Release
cmake --install build/input --config Release --prefix windows/resources/native

cmake -S windows/native/kotiba-stt   -B build/stt   -A x64
cmake --build build/stt   --config Release
cmake --install build/stt   --config Release --prefix windows/resources/native
```

`kotiba-stt` downloads whisper.cpp v1.9.2 itself and takes 5–15 minutes to build.

Expected:

1. No errors. **WRITE DOWN every MSVC warning**: this code has only ever been compiled with
   clang/mingw.
2. `dir windows\resources\native` lists:
   - `kotiba-hook.exe`, `kotiba-input.exe`, `kotiba-stt.exe`;
   - `vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll` (and possibly a few other
     `*140*.dll`).
3. `windows\resources\native\kotiba-hook.exe --version` prints `kotiba-hook 1.2.0`.
   `kotiba-input.exe --version` prints `kotiba-input 1.2.0`.
4. The C runtime check. Each helper must start on a PC without the Visual C++
   redistributable. Run:
   ```
   dumpbin /dependents windows\resources\native\kotiba-hook.exe
   dumpbin /dependents windows\resources\native\kotiba-input.exe
   dumpbin /dependents windows\resources\native\kotiba-stt.exe
   ```
   - `kotiba-hook` and `kotiba-input` must list **no** `VCRUNTIME140.dll` and no
     `MSVCP140.dll`. They are linked statically now.
   - `kotiba-stt` will list `VCRUNTIME140.dll`, and that DLL must be the one in the same
     folder (item 2).

### A4. JavaScript, the models, the gate

In **Git Bash**, from `windows/`:

```
npm ci
npm run build
node scripts/fetch-models.mjs --dest fixtures/models
bash scripts/gate.sh
```

Expected:

1. `npm ci` completes.
   - If it prints `allow-scripts` warnings, Electron's own download did not run. Run
     `node node_modules/electron/install.js` once.
2. `fetch-models` verifies a sha256 for each model, fetches whatever is missing, and stages
   `fixtures/models/silero-vad-v6.2.0/ggml-silero-v6.2.0.bin` (885,098 bytes).
3. The gate ends with `gate passed`, about 2,275 tests.
   - A test that fails ONLY here is a Windows difference the Mac cannot see, and that is
     news. **WRITE DOWN** its name and message.

### A5. A quick run from the source tree (optional, 5 min)

Run `npx electron .` from `windows/` in a terminal.

Expected:

1. A black window appears with "Talk. Let go. It's typed.".
2. The terminal prints the resource table with every helper and model **found**, and no
   error.
3. Close the window, then quit from the tray.

A source-tree run never registers itself to start at sign-in (it would register the bare
`electron.exe`). Task Manager › Startup apps must NOT show an "Electron" or "kotiba-win"
entry.

### A6. The installer

From `windows/` (Git Bash):

```
npx electron-builder --win --x64 --publish never --config.directories.output=release
node scripts/verify-installer.mjs release/Kotiba-Setup-1.0.0.exe
```

Expected:

1. electron-builder finishes in about 10–15 minutes and writes
   `release/Kotiba-Setup-1.0.0.exe` (about 1.2 GB) and a `.zip`.
2. `verify-installer` prints `ok` lines, including:
   - `native: … onnxruntime … unpacked`;
   - `node-llama-cpp prebuilts unpacked`;
   - no CUDA build.
3. `dir release\win-unpacked\resources\native` shows the three `.exe` files **and** the
   `*.dll` files from A3.
4. The headless end-to-end check on the packaged binary. In cmd, from `windows\`:
   ```
   release\win-unpacked\Kotiba.exe --check --fixtures "%CD%\fixtures\audio" --models "%CD%\fixtures\models" --json
   echo %ERRORLEVEL%
   ```
   - It prints JSON: the English pangram transcribed as English, the Uzbek fixture as
     Uzbek, and room tone as "heard nothing".
   - `ERRORLEVEL` is `0`.

### A7. Building the installer on a Mac (no Windows, no MSVC, no CI)

From `windows/` on the Mac, with zig 0.14.1 (`ZIG=/path/to/zig` if it is not on `PATH`):

```
bash scripts/build-installer-mac.sh
```

It runs `build-native-zig.sh` (helpers → `resources/native`), `npm ci`/`npm run build`,
fetches the win-x64 prebuilts npm skips on a Mac (`@node-llama-cpp/win-x64`, `-vulkan`,
`@reflink/reflink-win32-x64-msvc`, each checked against the lockfile's sha512), stages the
models through `fetch-models.mjs` (symlinking the Mac app's copies), serves Electron's
win32-x64 zip from a local mirror (electron-builder's own download hangs on this network), runs
`electron-builder --win --x64` (about a minute) and `verify-installer.mjs` (with `7zz`).

Checked on the Mac for the 1.0.0 build, and how:

- every `.exe`/`.dll` imports only Windows system DLLs, the UCRT (`api-ms-win-crt-*`) and
  each other — no `VCRUNTIME140`, `MSVCP140`, `libstdc++` or `libwinpthread` (the script's
  import check, `objdump -p`);
- under Wine 11.16 (x86-64 via Rosetta): `kotiba-hook` answers `POLL` with `STATE`,
  `kotiba-input` answers `hello`/`foreground`/`audioSessions` and survives a garbage line,
  `kotiba-stt` loads the real Uzbek model, transcribes `uzbek-0001.wav`, runs Silero VAD and
  language detection, refuses an unknown op, and exits when stdin closes. Rosetta reports
  only SSE4.2, so it loaded `ggml-cpu-sse42.dll` — the no-AVX fallback works; the AVX2 and
  AVX-512 variants were compiled but never executed. Wine timings mean nothing (emulated).
- the PACKAGED app, `release\win-unpacked\Kotiba.exe --check` (A6 step 4) under the same Wine:
  it found every helper and model, routed `uzbek-0001.wav` to Uzbek acoustically and delivered
  "Bu minusi oʻzgacha boʻladi.", and called room tone "heard nothing". The English pangram
  routed to English correctly but its whisper large-v3-turbo decode missed the app's 125 s
  deadline — SSE4.2 code under Rosetta is far slower than any real PC — so `--check` exited 1.
  **A6 step 4 on a real PC is still the check that counts for English.**

Not checked: anything interactive (real key, microphone, paste into a real app, tray,
windows), the AVX2 path, GPU/Vulkan, and onnxruntime-node/node-llama-cpp actually loading.

---

## Part B — Install

### B1. Upgrade, if Kotiba 0.2.0 is installed (skip otherwise)

1. Run `Kotiba-Setup-1.0.0.exe` over the old install.
   - SmartScreen appears: click **More info → Run anyway**.
2. Expected after install:
   - the installer does not ask for administrator rights;
   - Kotiba starts in the tray;
   - History still shows the old dictations;
   - your hotkey is unchanged;
   - English dictation works at once, on whisper;
   - Settings › Languages offers **Download** for Parakeet: an upgrader is never downloaded
     to without saying yes.
3. Quit with **Turn Off Always On & Quit** (tray).
4. Rename `%APPDATA%\Kotiba` to `Kotiba.old` and `%LOCALAPPDATA%\Kotiba` to `Kotiba.old`, so
   Part C starts as a first run.

### B2. Fresh install

1. Run `Kotiba-Setup-1.0.0.exe`.
   - SmartScreen: **More info → Run anyway**. The install is per-user, so there is no
     UAC prompt.
2. Kotiba starts, and the onboarding window appears.

### B3. Clean-machine check (optional, needs Windows 10/11 Pro: Windows Sandbox)

Windows Sandbox is a pristine Windows with **no Visual C++ runtime**, which is what a
stranger's PC may be.

1. Copy the installer into Sandbox, install, and walk onboarding.
2. Hold Right Ctrl in Notepad and speak.

Expected:

- the text lands, so kotiba-hook, kotiba-input and kotiba-stt all start;
- a missing-DLL dialog or a "hotkey is not being watched" row is a failure.

Also download Parakeet there (Languages › Download) and dictate English:

- **WRITE DOWN** whether it lands, or the error on Home;
- whether the onnxruntime and llama.cpp prebuilts need the VC runtime has not been
  verified.

---

## Part C — Feature tests (on the INSTALLED app)

Run these on the installed Kotiba, not on `npx electron .`: the watchdog and sign-in
start exist only in an installed build. The terminal lines quoted in C7/C8 are printed
only when Kotiba is started from a terminal. For those sections, quit Kotiba, then run
`"%LOCALAPPDATA%\Programs\Kotiba\Kotiba.exe"` from cmd.

### C1. Onboarding and the window (5 min)

1. Walk the steps with the mouse:
   - Get started → One permission → Hold to talk → Your languages;
   - → **Download models** → Always there (switch ON, marked RECOMMENDED) → You're set →
     Start dictating.

   Each step slides in and the dots grow. Nothing flickers or jumps.
2. **Enter moves exactly one step.**
   - Settings › Setup › restart onboarding (or delete `%APPDATA%\Kotiba` and relaunch).
   - Press Enter on each step instead of clicking.
   - Expected: one step per Enter. "Download models" is **shown**, never skipped. Nothing
     starts downloading before you press its button.
3. On "Download models":
   - there are three rows: English and Russian · Parakeet Ultra (668 MB), Uzbek · Kotiba
     STT ("Included"), and Super, Message and Note · Qwen3-1.7B (1.28 GB);
   - below them, "More languages (optional)": Turkish and Arabic, unticked (C11 covers them);
   - the button reads "Download 1.95 GB and continue";
   - untick Qwen and the button says 668 MB;
   - tick it again, then **double-click** the button. It advances ONE step.
4. The window:
   - drag it by the top strip;
   - double-click the strip to maximise;
   - hover the maximise button to see Snap Layouts;
   - Win+← / Win+→ snap it.
5. Make it narrower than ~860 px: the sidebar folds to an icon rail. Click the green logo:
   it unfolds.
6. Visit all seven sections (Home, History, Statistics, Modes, Languages, Hotkey,
   Settings). Expected: black background, green accent, nothing cut off.
7. **Drag any file from Explorer onto the Kotiba window.** Nothing happens, and the window
   keeps showing Kotiba. (Before 1.0 it would replace the page.)
8. Close the window with X. The tray icon stays. Left-click the tray: Home comes back.
   Right-click the tray: the first item is "Open Kotiba".

### C2. The pill and a first dictation (3 min)

1. Open Notepad, click into it, hold **Right Ctrl**, speak for five seconds, then let go.
   - While you hold:
     - a black 160 × 36 capsule drops in at the top centre of the monitor the mouse is
       on;
     - it shows AUTO (or the pinned language) on the left, green bars that move with your
       voice, and the mode glyph on the right;
     - Notepad keeps the caret.
   - When you let go:
     - the bars become dots, then a green check with the time in ms, then the capsule
       folds up;
     - the text is in Notepad.
2. Hold without speaking and let go. You see amber "Didn't catch that — hold while you
   speak", then it folds after ~2 s.
3. Full-screen a video (YouTube, then F) and dictate into a text box on another monitor,
   or into the address bar. The pill shows over the full-screen video.
4. Click exactly where the pill is drawn. The app underneath gets the click.

### C3. The hotkey (5 min)

1. Hold Right Ctrl and press C within a second. Nothing is dictated, and Ctrl+C copies as
   usual.
2. Hold Right Ctrl, speak 3 s, press Shift, keep speaking, let go. The dictation is kept:
   a modifier is never a chord.
3. Hold Right Ctrl, speak 2 s, tap a letter, keep speaking, let go. The dictation is kept:
   a key after 1.5 s is not a shortcut.
4. Hotkey page → "Record new key" → press and release Right Shift. It becomes the key, and
   no dictation starts while recording. Dictate with it.
5. Record F13. If the keyboard has none, choose the F13 preset and send F13 with an
   AutoHotkey script `F12::F13`.
   - Hold it in Notepad: it types nothing and dictates.
   - Ctrl+F13 does NOT dictate.
6. Presets: pick Caps Lock and hold it. It dictates, and Caps Lock does NOT toggle.
7. Record, then:
   - press A: amber "A types text…";
   - press Win: amber "The Windows key…";
   - Escape cancels.
8. **Lost key-up.**
   - Set Right Ctrl back.
   - Open an elevated app (Task Manager, or Notepad via "Run as administrator").
   - Hold Right Ctrl over a normal window, move the mouse to the elevated one and click
     (keep holding), and let go there.
   - Within about ¼ s the dictation finishes by itself; the microphone does not stay open.

### C4. Overlapping dictations and typing (5 min)

Pin Oʻzbekcha on Home, so each dictation takes long enough to overlap.

1. Say a long sentence (10 s), let go, and **immediately** hold again and say a short one.
   Expected:
   - the second press shows "Listening" at once;
   - both texts land, the long one FIRST;
   - the second one's **first word is there**: the microphone opens at the key, not after
     the first paste;
   - the second is **not cancelled** by the first one being typed while you hold.
2. Five quick press–speak–release cycles back to back. All five land, in order.
3. **Multi-line text into a chat box.**
   - Tray → Note, then click into a Telegram Desktop (or web.telegram.org) message box.
   - Dictate: "We need to fix the fence. First, buy nails. Second, borrow a hammer."
   - Expected: the whole checklist lands in the box as several lines, and **nothing is
     sent**. You press Enter yourself.
   - Before 1.0, each line break was typed as Enter.
4. **Clipboard kept.**
   - Copy a word (Ctrl+C), then do step 3 again.
   - Afterwards, Ctrl+V pastes YOUR word, not the dictation.
5. Uzbek letters: dictate an Uzbek sentence with oʻ/gʻ into Notepad. The okina (ʻ) appears
   correctly, not as `?` or a box.

### C5. Ducking (3 min)

1. Play music in Spotify or a browser. Open the Volume Mixer (right-click the speaker icon
   → Volume mixer).
2. Hold Right Ctrl.
   - After ~⅕ s the music dips smoothly to about a quarter, and that app's slider moves.
   - The master volume does NOT move, and apps that are silent do not move.
   - Let go: it comes back smoothly to exactly where it was.
3. Tap Right Ctrl then C quickly. The music does not dip.
4. Hold the key and drag the music app's slider in the mixer while holding. Let go: your
   new level stays.
5. Crash repair:
   - hold the key so the music is ducked, then end the main `Kotiba.exe` in Task Manager
     (Details, the one with the most memory);
   - the music stays low;
   - within ~3 s Kotiba is back, relaunched by the watchdog, and the music returns to its
     old level.
6. Settings › Sound › "Lower to" 50%, then repeat step 2. It dips to half.

### C6. Always on (8 min)

1. Settings › Always there: "Always on" is on after onboarding. "Open at login" shows on
   and greyed, "Included in Always on".
   - Task Manager › Startup apps lists **Kotiba**, enabled.
2. Ctrl+Q in the window, and the window's X: both only hide the window. The tray stays and
   Right Ctrl still dictates.
   - The tray menu's last item is "Turn Off Always On & Quit".
3. In Task Manager › Details, end the main `Kotiba.exe`.
   - Within ~3 s Kotiba is back in the tray (no window), and dictation works.
   - Do it four times within five minutes: the fourth time it stays gone.
   - `%LOCALAPPDATA%\Kotiba\watchdog.json` says `gaveUp`.
   - Start Kotiba from the Start menu again.
4. Sign out and back in. Kotiba starts in the tray with no window, and dictation works.
5. Restart Windows with Kotiba running. Shutdown is not held up, and Kotiba is in the tray
   after sign-in.
6. "Turn Off Always On & Quit" (tray, or Settings › "Quit Kotiba"): Kotiba exits for real.
   - Start it again: Always on is off, and the tray offers "Quit Kotiba".
   - Turn Always on back on.
7. **Settings survive rapid changes.**
   - Settings › Sound › "Lower to": click the slider, then hold → for two seconds.
   - Flip "Keep history" off and on quickly three times.
   - Quit for real and relaunch. Home shows **no** "Some settings could not be read" row,
     and the slider shows where you left it.

### C7. English and Russian on Parakeet, and the engine processes (25 min, 2 GB of downloads)

Start Kotiba from cmd for this section (see the top of Part C).

1. **Progress and resume.**
   - Settings › Languages › "Models on this PC" shows both rows with moving bars.
   - Pull the network (Wi-Fi off) half-way. The row says "Did not finish" with the reason.
     A stalled download can take up to ~5 min to say so.
   - Quit for real, reconnect, and launch. The terminal says
     `downloads: resuming parakeet_ultra, qwen3_1_7b`, and the bars continue from where
     they stopped. **WRITE DOWN** the percentage it resumed at.
2. **While Parakeet downloads**, dictate English in Notepad. It works, on whisper.
   - When Parakeet lands, the English card reads "Parakeet Ultra, on this PC…".
   - The terminal says `parakeet: loaded in N ms (K encoder threads)`. **WRITE DOWN** N
     and K.
3. **Separate processes.**
   - Task Manager › Details shows "Kotiba speech engine", and after one Message dictation
     also "Kotiba modes engine".
   - End "Kotiba modes engine", then dictate a Message. Kotiba keeps running and the text
     arrives.
   - End "Kotiba speech engine", then dictate English. The text arrives: this dictation may
     run on whisper, and it must NOT fail. The next English dictation starts a new speech
     engine.
   - Kotiba itself never disappears.
4. **Speed**, the number that matters.
   - Dictate a ~10 s English sentence, then a ~60 s one (read a page aloud).
   - Open Settings › Diagnostics › Show summary. The last two records' engine is
     `parakeet-ultra`.
   - **WRITE DOWN both `transcribing` times.** On the Mac's CPU they were ~220 ms and
     ~130–220 ms. 2–4× that is expected on a laptop. Past ~1 s for the 60 s one means
     streaming is not happening.
5. **Russian with English words**, language on Automatic: "Давай сделаем деплой сегодня
   вечером, после код-ревью". Cyrillic with punctuation.
6. **Memory.**
   - "Kotiba speech engine" holds about 1.3 GB with Parakeet loaded.
   - Leave the PC idle 20 min: the terminal says `parakeet: unloaded after 900 s idle`,
     and the memory drops.
   - The next dictation reloads it. **WRITE DOWN** how much slower that one was.

### C8. The modes (15 min)

1. After the first Message dictation, the terminal says `llama: loaded … on vulkan` or
   `on the CPU`. **WRITE DOWN** which, and the load time.
2. Hold the hotkey right after launch, with the model not yet loaded. The pill appears
   **immediately**.
3. Each mode once (tray → mode, then dictate into Notepad):
   - Super, English: "um so the plumber is coming on thursday i think". Fillers gone,
     capital and full stop, no word changed.
   - Message, English: "okay so basically I was wondering if you could pick up the cake on
     saturday". Something like "Could you pick up the cake on Saturday?".
   - Note: "We need to fix the fence. First, buy nails. Second, borrow a hammer." You get
     `- [ ] Fix the fence`, `- Buy nails`, `- Borrow a hammer`.
   - Super, Uzbek (pin Uzbek): an unpunctuated sentence gains commas and a capital, and no
     word changes.
4. In the diagnostics summary, **WRITE DOWN `polishing` for each of the four.**
   - The Mac measured 0 ms (Super), ~110–230 ms (Message) and ~50 ms (Note).
   - Past 1.5 s, the text goes in as spoken, with "sentence not polished within 1.5
     seconds" in the record.
5. A long Message (~45 s, several sentences). The text lands once, shortly after key-up.
6. On a PC with no discrete GPU, **WRITE DOWN** a Message `polishing` time.

### C9. Streaming Uzbek (10 min)

1. `…\Kotiba\resources\models\silero-vad-v6.2.0\ggml-silero-v6.2.0.bin` exists (885,098
   bytes). The terminal does NOT say `silero: not in the installed resources`.
2. Pin Uzbek. Dictate a ~5 s sentence, wait half a second, and let go. The text lands
   almost at once.
3. **WRITE DOWN `transcribing`** for three such dictations, and for one ~20 s dictation
   where you let go on the last word. The Mac's CPU at 2 threads did 0–100 ms and ~0.5 s.
   A 20 s one past ~2 s means this PC cannot keep up with the background decodes.
4. Language on Automatic, English as the default:
   - dictate an Uzbek sentence, then English, then Uzbek again;
   - each is written in its own language, and none is a phonetic English rendering of
     Uzbek.
5. **Detector recovery.**
   - In Task Manager › Details, `kotiba-stt.exe` appears two or three times: end ALL of
     them.
   - Dictate Uzbek on Automatic twice. The second one is still detected as Uzbek: the
     detector reloads after its process dies.

### C10. Long holds (15 min, mostly waiting)

1. Ducking off (Settings › Sound). Hold Right Ctrl for **10 minutes** while a podcast plays
   through the speakers, then let go.
   - The text covers the whole ten minutes: the last sentence you heard is in it.
   - History shows "~600 s spoken".
2. The last line of `%LOCALAPPDATA%\Kotiba\diagnostics.jsonl`:
   - `audioSeconds` is ~600;
   - `errors` does not mention dropped audio or "did not answer within".
   - **WRITE DOWN** `transcribing`.
3. (Optional, 30 min.) Hold past 30 minutes. At 30:00 the pill says the limit was reached,
   and the first 30 minutes are typed. The streamed text is kept: it is NOT re-decoded
   from the start (that would take minutes).

### C11. Turkish and Arabic (25 min, 1.9 GB of downloads)

Optional dictation languages (C4, D-W24). Start Kotiba from cmd for this section.

1. **Off by default.** On a fresh install (Windows not set to Turkish or Arabic):
   - onboarding's Download models step shows "More languages (optional)" with Turkish and
     Arabic **unticked**; the button's size does not change until you tick Arabic (+1.77 GB);
   - the tray's Language list and Home's language row show neither;
   - Settings › Languages shows a TR and an AR card, both "Off".
   If this PC's Windows display language IS Turkish or Arabic, that one is ticked instead.
   **WRITE DOWN** your Windows display language.
2. **Turkish.** Languages › TR card › "Dictate in Turkish" on.
   - The card says it runs on the whisper model already inside Kotiba — nothing downloads.
   - Turkish appears in the tray and in Home's row. Pin it.
   - Dictate "İstanbul'da yarın hava nasıl olacak?" into Notepad. Turkish letters (İ ı ş ğ ç
     ö ü) come out right, with a question mark.
   - Dictate a ~5 s sentence, wait half a second, let go. **WRITE DOWN `transcribing`** for
     three such dictations (Settings › Diagnostics › Show summary; engine
     `whisper-ggml-large-v3-turbo-q5_0-tr`). The same code on the Mac's CPU (4 threads) did
     0.38–0.61 s for a 3 s sentence let go 0.3 s after the last word; laptops are expected
     slower.
   - Task Manager › Details: one more `kotiba-stt.exe` than before (Turkish has its own).
   - **Unpinned** (Automatic), dictate a Turkish sentence of at least 6 seconds. It is written
     in Turkish; the summary's route says `turkishCheck`. **WRITE DOWN** its
     `turkishCheckWaitMillis` (the one turbo pass key-up waits for; ~2 s expected on a CPU).
     Then an Uzbek sentence of the same length: still Uzbek.
3. **Arabic before its download.** AR card › "Dictate in Arabic" on (do NOT press the
   download yet). Pin Arabic, dictate "مرحبا، كيف حالك اليوم؟". Arabic script arrives
   (whisper, with punctuation). In the History row the text reads right to left.
   Unpin (Automatic) and dictate the same: it should still come out Arabic (route `acoustic`,
   or `scriptCheck` when the detector missed it and the transcript's script gave it away).
4. **Arabic's download.** Press "Download Cohere (1770 MB)".
   - The bar moves; pull the network half-way, reconnect, quit for real and relaunch: the
     terminal says `downloads: resuming … cohere_arabic` and it continues.
   - When it lands the terminal says `arabic: cohere loaded in N ms on <device>`.
     **WRITE DOWN** N and the device (`Vulkan (…)` or `CPU`).
5. **The speed check.** Right after that load the terminal says
   `arabic: speed check: M ms for 3 s on <device> (threshold 300 ms) — …`.
   **WRITE DOWN M** and whether it said "Cohere stays" or "switching to FastConformer".
   - The AR card says the same in words, with the number.
   - If it switched: a 132 MB FastConformer download runs by itself, and afterwards the card
     reads "NVIDIA FastConformer Arabic · CPU".
   - `%APPDATA%\Kotiba\models\arabic-speed-check.json` holds the verdict; the check does NOT
     run again on the next launch.
6. **Speed.** Pinned to Arabic, dictate three ~5 s sentences (wait half a second before
   letting go) and one ~20 s one (let go on the last word). **WRITE DOWN `transcribing`**
   for each, and the engine in the summary. On the Mac's CPU Cohere took 0.25–0.31 s for a
   3 s dictation and 0.84–1.5 s for a ~10 s one at 4 threads (0.03–0.07 s and 0.4–1.0 s at 8),
   with a running pause decode no longer restarted at every pause (C4 §14.4), and FastConformer
   0–0.09 s for both (03-ENGINE-PARITY.md §16). Past ~1 s on Cohere, pick FastConformer in step 7
   and compare.
7. **The override.** AR card › Engine: pick the other one. The card changes within a few
   seconds (a download first if it is not here yet); dictate once and check the summary's
   engine. Pick Automatic again.
8. **Separate process.** Task Manager › Details shows "Kotiba Arabic engine". End it, then
   dictate Arabic: the text still arrives (this one may come from whisper) and Kotiba stays up.
   The next Arabic dictation starts a new engine process.
9. **GPU switch.** Settings › Languages › Use the GPU off. The AR card says "Not checked yet"
   until the next Cohere load re-runs the speed check on the CPU. **WRITE DOWN** that M too.
10. **Off again.** Turn Arabic off while it is pinned: the pin goes back to Automatic, and
    Arabic leaves the tray. Quit for real and relaunch: nothing Arabic downloads.
11. **Half-heard Arabic (C4 §14.1).** Automatic, Arabic and Turkish on. Dictate a 5–8 s Arabic
    sentence in a dialect if you can (Egyptian, Gulf, Levantine or Maghrebi), then a short
    (< 3 s) one. In the History summary the route reads `arabicCheck` when turbo's head settled
    it (or `acoustic` when the detector was sure); **WRITE DOWN** `turkishCheckWaitMillis` — the
    one turbo pass key-up waits for, which is also the Arabic check's (~1–2 s expected on a CPU,
    much less on Vulkan). A short dialect sentence may still go elsewhere: pin Arabic for those.
12. **Uzbek is never Arabic.** Still Automatic, dictate three Uzbek sentences full of Arabic
    loanwords or prayer formulas (`xatmi qur'on yakunida duoda qatnashdik`, `assalomu alaykum,
    inshaalloh ertaga boramiz`): each is Uzbek, never `ar`.
13. **Arabic as typed (C4 §14.3).** Pinned to Arabic, in Raw: dictate a question and a number
    ("هل وصلت الساعة ثلاثة؟"): the question mark is `؟`, a comma is `،`, digits are 0–9, and no
    stretched letters (ـ) appear. In Message, start with "يعني" or "طيب": it is dropped and the
    rest is word for word, punctuated (Arabic Message never changes or drops a content word). In
    Note, "لازم نشتري خبز. الجو حلو اليوم." gives one `- [ ]` task and one plain line.
14. **Arabic modes model (C4 §14.5).** AR card › "Download Arabic modes (3107 MB)". When it
    lands, dictate an Arabic sentence in Super, then one in English: Task Manager shows the
    Arabic model's engine process only after the Arabic one (it is never loaded for English).
    **WRITE DOWN** the release-to-text time of an Arabic Super, Message and Note dictation; on the
    Mac (Metal) the sentence tails were ~0.2–0.3 s p50 — expect several times that on a CPU.

### C12. About, and uninstall (3 min)

1. Settings › About shows:
   - "Kotiba 1.0.0";
   - Parakeet Ultra with its CC BY 4.0 attribution;
   - Kotib STT, Whisper, Qwen3-1.7B, Cohere Transcribe Arabic, NVIDIA FastConformer (with its
     CC BY 4.0 attribution), Silero, and the libraries (transcribe.cpp and koffi among them).
2. "Source", one "Model", and "THIRD_PARTY_NOTICES.md" each open in the browser. Nothing
   else on the page opens anything.
3. Uninstall from Settings › Apps while Kotiba runs with Always on.
   - The uninstaller closes it.
   - Kotiba does **not** come back within a minute: the watchdog does not resurrect a
     removed app.
   - Task Manager › Startup apps may still list a dead "Kotiba" entry. **WRITE DOWN** if it
     does; the uninstaller does not remove it yet.

---

## Part D — What to send back

For each step, send one of:

- pass;
- the step number, what you saw instead, and a screenshot.

Also send:

1. every **WRITE DOWN** number;
2. every MSVC warning from A3;
3. the diagnostics summary (Settings › Diagnostics › Show summary). It contains outcomes,
   engines and timings, and never dictated text.

Do **not** send `diagnostics.jsonl` itself: it contains what you said.

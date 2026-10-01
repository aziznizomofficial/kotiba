# Kotiba for Windows — decisions

Supervisor: Nozir session, 2026-08-19. These are settled. A worker that disagrees writes
`REQUEST:` in its STATUS file; it does not re-decide.

The owner's ask, verbatim: *"Fully clone… one to one, functionally, but for Windows… people
should be able to download the file from Telegram, install it and start using it without
problems."* Every decision below is derived from that sentence, and where it conflicts with
`~/.claude/notes/projects/kotiba/windows-port-spec.md` (written 2026-08-11), the owner wins and
the conflict is named.

---

## D-W1 — Electron + TypeScript, not Swift-for-Windows

The 2026-08-11 spec recommended Swift-for-Windows (its Option A) to avoid duplicating a
*measured* classifier. That objection is real and it is the only serious one: Kotiba's routing is
not business logic, it is a detector with a recall curve, and a reimplementation that is
quietly 3% different produces "Uzbek accuracy is awful" with every test still green.

**Overruled, because the objection can be converted into a build gate instead of a hope.**

- The Swift implementation emits **golden fixtures** — for every scoring, routing, normalising
  and capitalising input in a committed corpus, the exact output.
- The TypeScript port must reproduce them **byte for byte**. A mismatch fails the gate.
- So the duplication is no longer trusted; it is *asserted*, on every commit.

Against that, Option A's cost is decisive: a Swift + WinUI shell can be neither built nor
clicked by anyone on this project before it ships to strangers. Nobody here owns a Windows
machine. The only Windows execution available is a 1-core `windows-latest` runner, so the
architecture has to maximise what a headless process can prove. Electron does; a WinUI shell
does not.

## D-W2 — All three languages ship. English uses `large-v3-turbo`.

The spec recommended dropping English on Windows, since `SpeechTranscriber` (117 ms) has no
Windows equivalent and English would fall to the slowest whisper column. The owner asked for a
one-to-one clone, so **English ships**, and the honest cost is stated in the README rather than
hidden by narrowing the product.

- English → `ggml-large-v3-turbo-q5_0`, already in the bundle as the Russian engine. Costs
  nothing extra to ship and is the best-quality option available.
- A **Fast English** setting may switch to `ggml-small.en-q5_1`, fetched on demand from the
  public Hugging Face URL through the existing model-store path. Not bundled; not the default.
- English on Windows is therefore the *slowest* language, where on macOS it is the fastest.
  That inversion is a headline line in the README, not a footnote.

## D-W3 — One self-contained installer, models inside, ~1.2 GB (narrowed by D-W23 and D-W25)

"Download from Telegram, install, start using it without problems" forbids a first-run
download. Two independent reasons agree:

1. The Uzbek engine `ggml-uzbek-stt-v1-q5_0.bin` is not public and cannot be made a public GET
   for a shipped app.
2. A first-run download is a second chance to fail, on Uzbek mobile data, after the user has
   already committed.

Bundle: `uzbek_stt_v1` 539 MB + `large-v3-turbo` 574 MB + `base` detector 60 MB ≈ 1.17 GB.
Telegram allows 2 GB per file on a free account, so a ~1.2 GB installer fits with room.
NSIS compression is `store`: q5 weights do not compress, and LZMA over 1.2 GB on a 1-core
runner buys minutes of build time for nothing.

## D-W4 — Push-to-talk is **Right Ctrl**, configurable from v1

There is no Command key on Windows, so the app's central gesture changes on day one.

The 2026-08-11 spec suggested Right Alt. **Rejected:** Right Alt is AltGr on Central Asian and
European layouts, where it is a live modifier for typing characters. Right Ctrl is reachable by
the same thumb, is not a dead-key modifier on any layout the audience uses, and is almost never
pressed alone.

Two hard requirements on the hook, both of which are how this goes wrong:

- **Observe, never swallow.** The low-level hook must pass the key through. Eating Right Ctrl
  would break every Ctrl chord in every other app.
- **Any other key pressed during the hold cancels the dictation** and lets the chord be. Holding
  Right Ctrl and pressing V is the user copying something, not dictating.

Configurable from the first release, not the third — on macOS a fixed hotkey is a known gap; on
Windows it is not optional.

## D-W5 — History is JSONL, not SQLite

macOS keeps `history.sqlite`. A native SQLite module means `electron-rebuild` in a build nobody
can debug interactively. History's user-visible behaviour — list, search, copy, delete, export —
is identical over an append-only JSONL with an in-memory index, at the sizes this app produces
(505 records after weeks of real use). Diagnostics is already JSONL on macOS.

**Deliberate divergence, storage only.** Behaviour must not diverge.

## D-W6 — Microphone via a hidden renderer, not WASAPI

`getUserMedia` + an `AudioWorklet` in an offscreen `BrowserWindow`, with
`new AudioContext({ sampleRate: 16000 })` so the browser's own high-quality resampler produces
the 16 kHz mono float whisper wants.

This is the one place a native path was tempting and is wrong: the macOS resampler had a bug
that *threw away Uzbek sibilants* (`97272d7`), and hand-writing a resampler in a codebase nobody
can listen to is how that recurs. Windows also prompts properly for the microphone, so there is
no permission story to write.

## D-W7 — A persistent native STT host, not a CLI per dictation

`whisper-cli.exe` per dictation reloads 539 MB of weights every press. `kotiba-stt.exe` is a
small C++ host over whisper.cpp's C API that loads a model once, holds it, and answers frames
on stdin with JSON on stdout.

It exists rather than whisper.cpp's `server` example for one reason: **parameter parity**. The
engine must set every `whisper_full_params` field to the same value the Swift `WhisperEngine`
sets — beam size, the temperature fallback ladder, entropy and logprob thresholds, `no_context`,
`suppress_blank`, `audio_ctx`, the initial prompt, threads. The deliverable includes that table,
field by field, Swift value against Windows value.

whisper.cpp is pinned to **v1.9.2**, the tag the macOS app links, built `GGML_NATIVE=OFF` with
AVX2/FMA/F16C on and AVX-512 off. That recipe is already proven in this repo
(`.github/workflows/windows-cpu-benchmark.yml`) and the reason it is written that way is a
SIGILL — cmake defaults to compiling for the build host, and GitHub's runner fleet is
heterogeneous. A shipped binary cannot target the build machine's ISA.

## D-W8 — Unsigned. SmartScreen will warn, and the README says so first.

The Gatekeeper trick does not transfer: `curl` sidesteps macOS quarantine because the
*downloader* writes the flag, whereas SmartScreen judges the certificate's reputation and warns
however the file arrived. An OV certificate is ~$200–400/yr *and* has to accumulate reputation.

So the warning is expected behaviour and is documented as the first thing a user reads, with the
exact click path — **More info → Run anyway** — because a user who reads the download as broken
never gets to the app.

Windows repays this: it needs **no** Accessibility or Input Monitoring equivalent. `SendInput`
and a keyboard hook require no granted permission, so the worst step of macOS onboarding — two
toggles buried in System Settings that macOS never prompts for — does not exist here.

## D-W9 — Built and verified on `windows-latest`; delivered as a release asset

Nobody on this project owns a Windows machine, and that stopped being a blocker when free
runners existed. The runner is a **1 core / 2 logical processor** VM (measured here on
2026-08-11), so it is a *build and smoke* machine and never a latency oracle. No performance
number may be quoted from it.

The installer is published as an asset on a **private GitHub release**, not as a workflow
artifact: this account is on the Free plan, where Actions artifact storage is 500 MB and a
1.2 GB artifact would not survive, while release assets allow 2 GB each.

Models reach the runner from `models-v2` on this private repo (`GITHUB_TOKEN` can read its own
repo's assets) and from the public Hugging Face URLs already in `Scripts/Manifest.json`, each
checked against its recorded sha256 before it is packaged.

## D-W10 — The gate

Local, on every merge: `bash windows/scripts/gate.sh` — TypeScript strict typecheck, lint,
vitest including the golden-parity suite.
On CI, additionally: the same logic tests **again on Windows** (path building and local-day
bucketing are exactly where Windows differs and both are silent when wrong), a headless
`--check` that runs the whole pipeline over a committed WAV fixture and exits, and an assertion
that the installer is plausible — a 0-byte `.exe` passes build, upload and release without
complaint.

`--check` must distinguish **"models not installed"** from **"model file corrupt"** with a flag
set by the component that knows, never by matching on an error message. That exact bug shipped
once already in `ai-balance/windows`, where `no GONKA_API_KEY / GONKA_BASE_URL stored` failed the
regex `no [A-Z_]+ stored` and a healthy app exited non-zero.

---

# 1.0 — Windows shell parity (2026-09-29)

The Mac side of 1.0 landed a new app window, a pill HUD, unbounded capture, overlapping
dictations, a configurable hotkey, ducking and always-on. These are the Windows decisions
that follow from porting them. Everything not named here is parity.

## D-W12 — The Mac's app window, as plain DOM with the Mac's springs

One window (Home, History, Statistics, Modes, Languages, Hotkey, Settings) replaces the
seven-tab Settings window and the separate onboarding window; onboarding is an overlay in
it, as on the Mac. No UI framework: the five `Theme.Motion` springs are sampled into CSS
`linear()` easings (`src/main/motion.ts`), which Chromium has had since 113 — the same
(duration, bounce) numbers, overshoot included. The window is frameless with
`titleBarOverlay`, so the minimise/maximise/close buttons, Snap Layouts, drag and Aero
Shake are Windows' own; hand-drawn caption buttons would lose Snap Layouts. Always dark,
as the Mac is.

## D-W13 — The pill sits under the top of the WORK AREA of the monitor under the cursor

There is no notch. The capsule animates inside a fixed transparent canvas (400 × 110),
so no state change resizes a window; the canvas is `focusable:false`, click-through,
`showInactive`, `screen-saver` level, on every virtual desktop. The work area rather than
the bounds, so a taskbar docked at the top never covers it.

## D-W14 — The hotkey helper may swallow ONE ordinary key, and answers POLL

The Mac swallows an ordinary-key hotkey (F13…) with an active tap. A low-level hook must
answer "eat this key?" synchronously, so the one rule that needs it — swallow the bound
non-modifier key unless Ctrl, Alt or Windows is held — lives in `kotiba-hook` behind a
`SWALLOW <vk>` command. Modifiers are never swallowed, and the helper still has no other
policy. `POLL <vk>` (answered from `GetAsyncKeyState`) is the Mac's 250 ms resync while a
hold is open: it recovers a key-up lost to a removed hook or to an elevated window. The
recorder is fed by the hook itself, so it records exactly the code the hook reports.
The Windows key cannot be the hotkey (it opens Start on release).

## D-W15 — Ducking is per app session, not the master volume

The Mac moves the output device's volume because it is the only knob that ramps. On
Windows the master volume is shared by the app being dictated into; a session's
`ISimpleAudioVolume` is the per-app slider the user knows from the Volume Mixer. Only
sessions in `AudioSessionStateActive`, never Kotiba's own processes, never the system-sounds
session. The Mac's timing (200 ms delay, 160 ms smoothstep ramps), exact restore, "the
user moved it, leave it" (checked in the same helper call as the write), and a crash
marker. The COM half is two commands in `kotiba-input`, run as a second process so a ramp
never queues behind a paste.

## D-W16 — Relaunch after a crash is a detached watchdog, not Task Scheduler

The Mac's launchd agent (`KeepAlive {SuccessfulExit = false}`) has no admin-free Windows
twin. A Task Scheduler logon task needs elevation for a standard user, and its
restart-on-failure watches the task's action, not a process that crashes an hour later.
So: the same `Kotiba.exe` in Node mode (`ELECTRON_RUN_AS_NODE`), detached (outside libuv's
kill-on-close job object), joined by an IPC pipe. A deliberate exit says `stop` first; a
pipe that closes without it is a crash or End Task, and after a 2 s grace (so the
uninstaller's kill-everything is not undone) it runs `Kotiba.exe --background`. Three
relaunches in five minutes and it gives up. Only the installed app starts it. Login is
the existing HKCU Run entry, wanted by always-on OR open-at-login — one registration.

## D-W17 — Capture streams; the page keeps nothing

The capture page used to hold the whole recording in a 2^23-sample array — 524 s, the
Mac's 174.76 s truncation with a bigger number. It now streams ~100 ms chunks tagged with a
segment; main keeps one store per take with the Mac's 30-minute ceiling, reported, and
counts any shortfall against the page's own total. A second press seals the first take at
a block boundary on the same running capture. Each take's `onChunk` is the live 16 kHz
stream the streaming engines (Parakeet, Qwen polish, Uzbek whisper) will attach to.

# 1.0 — Windows engines (2026-09-30)

The Mac's 1.0 replaced English and Russian with Parakeet Ultra (C1, D-05) and made every
mode on-device (C3). These are the Windows decisions that follow. Numbers and method are
in 03-ENGINE-PARITY.md §10–§12.

## D-W18 — Parakeet Ultra on `onnxruntime-node`, in a worker thread of the main process (thread → process: D-W22)

English and Russian run the same weights as the Mac: `Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx`
int8 at a pinned commit, fetched on first use with sha256 (C1 §8). The decoder is a
TypeScript port of onnx-asr's greedy TDT (`src/core/stt/tdt.ts`), not sherpa-onnx's
Parakeet, which C1 measured 3–4 points worse. It streams with the Mac's `StreamSegmenter`
and heads the unified family, with the bundled whisper large-v3-turbo behind it for the
window before the download lands — so D-W2's "English is the slowest language" no longer
holds once Parakeet is on disk.

**A worker thread, not `kotiba-stt.exe`.** Linking ONNX Runtime into the C++ host means new
C++, a Windows toolchain build and a wire format, for nothing measurable. **A thread, not
the main thread:** `InferenceSession.run` is asynchronous (a 200 ms encoder pass stalled
the event loop 6.7 ms), but the model LOAD is synchronous — 760 ms of blocked main loop on
this Mac for the 650 MB encoder, 6 ms from a worker — and the key-down preload triggers it
while the user speaks. The worker's module graph is unpacked from `app.asar`. The cost,
stated: a native crash in ONNX Runtime still takes the process down (the D-W16 watchdog
relaunches); a worker that exits is noticed and reloaded.

**Idle unload after 15 minutes** (a Windows addition; the Mac unloads only under memory
pressure): resident Parakeet is ~1.3 GB, the reload ~1 s, and the key-down preload starts
it behind the user's speech.

## D-W19 — The modes on `node-llama-cpp` 3.22.1, the Mac's prompts byte for byte

Qwen3-1.7B Q4_K_M (the Mac's GGUF, pinned, sha256) through node-llama-cpp's prebuilt
llama.cpp — CPU with per-ISA dispatch, Vulkan, Metal on a Mac. CUDA builds are EXCLUDED
from the package (~545 MB for GPUs this audience does not have). The prompt is raw ChatML
built exactly as `LlamaEngine.chatML`/`.turn` build it, greedy, prompt-lookup drafting —
not node-llama-cpp's chat wrapper, whose Jinja rendering is a different byte sequence.

The deterministic half (`DictationCleanup`, projection, splitter, `NoteLayout`, the
sentence guard) is `src/core/modes`, pinned by `fixtures/golden/modes.json`. It runs for
every built-in mode but Raw even when the model is absent, which is the Modes pane's
"rules only" state. Every built-in mode now inserts ONCE, after its polish, as on the Mac.

## D-W20 — First-use downloads for Parakeet and Qwen, with the Mac's fallbacks (launch fetch superseded by D-W23)

D-W3 forbids a first-run download for what the app cannot work without. Neither of these
is that: English and Russian work from the bundled whisper model until Parakeet lands,
and every mode works on rules until the GGUF lands. Parakeet starts downloading at launch
(the Mac's behaviour); the GGUF only when the user presses Download in Settings › Modes,
because 1.28 GB on Uzbek mobile data must be a choice. Both are streamed to a temporary
file, hashed in the same pass, and renamed only when size and sha256 match the pin.

## D-W21 — Streaming Uzbek on the whisper host, one stream per press

C2's design ported to `kotiba-stt.exe` rather than re-decided: Silero through the same
`whisper_vad_*`, the same segmenter, speculation, prefix cut and fitted windows, flash
attention off on the Uzbek context. Two Windows choices:

* **The host became two threads (1.1).** Silero must answer chunk by chunk while a 20 s
  commit decodes, and an abort must reach a decode it is meant to stop — neither can wait
  in the one queue. The reader answers `abort` and `vad_*` at once; everything touching the
  whisper context stays strictly ordered on the worker.
* **A press streams into ONE family**: the pinned language's, else the default language's.
  The Mac speculates on Parakeet always, which costs the Neural Engine nothing. On a Windows
  CPU an Uzbek speculation beside Parakeet's commits would compete for the same cores, so an
  Uzbek-default user speculates on Uzbek and everyone else on Parakeet; the other family
  decodes in batch at key-up if the route goes there.


# 1.0 — Windows polish (2026-09-30)

## D-W22 — Parakeet and Qwen run in their own processes (supersedes D-W18's "worker thread")

Each on-device engine runs in an Electron `utilityProcess` (`dist/src/engines/engine-host.js
parakeet|llama`, launched by `src/main/utility-launcher.ts`); main holds a process-backed
`ParakeetRuntime` and a `RemoteLlamaPolisher` with the surfaces it had before.

* **Why a process, not a thread.** A native crash in ONNX Runtime or llama.cpp inside a
  `worker_threads` worker takes the whole main process — hotkey, tray, pill, the dictation in
  flight. In its own process it costs that engine's work in flight: the family falls back to
  whisper, the modes deliver their rules for the sentences in flight.
* **Why for llama too.** `LlamaPolisher.prepare` at key-down stalled the main loop: 92–95 ms
  on this Mac (M4 Pro, Metal; ~200 ms reported on Windows), against 0.4–0.7 ms with the model
  in a child. Numbers and method: 03-ENGINE-PARITY.md §15.
* **Restart.** Automatic, on the next use — up to 3 crashes in 5 minutes per engine; past that
  it stays down until Kotiba restarts, and the diagnostics say so.
* **A host that cannot START** (never says hello — a packaging fault, not a crash) falls back
  to the old in-app runtime (Parakeet's worker thread, the in-process `LlamaPolisher`), noted
  once. `--check` and the headless measurements keep the in-process path.
* **Cost.** IPC is structured clone: 0.27 ms median round trip for a 14 s Parakeet window of
  16 kHz float32, 0.05 ms for 1 s; one process spawn (~30 ms) per cold start.
* **Not verified here:** the utility process itself (no Electron binary on this Mac, and no
  Windows) — the measurements used `child_process.fork` with the same structured-clone
  serialisation. The host is started from inside `app.asar` because it must resolve
  node-llama-cpp's JavaScript; that a utility process loads it from the archive is Electron's
  documented behaviour, not something run here.

## D-W23 — First-run model downloads, accepted in onboarding (supersedes D-W3's rule for them, and D-W20's launch fetch; the checklist and the acceptance superseded by D-W25)

D-W3's "no first-run download" still holds for what Kotiba cannot work without — the Uzbek
model and whisper large-v3-turbo stay in the installer. For the three models that make Kotiba
fast and whose absence it works around — Parakeet Ultra (668 MB), Qwen3-1.7B (1.28 GB) and
Kotib STT (in the installer today, so "Included") — onboarding has a **Download models** step:

* every fetchable model ticked (recommended), with size, live progress, and what Kotiba does
  meanwhile (bundled whisper for English and Russian; the modes on their rules);
* "Download … and continue" persists the ticks as `Settings.acceptedDownloads` (Windows-only)
  and queues them one after another; the step moves on at once;
* downloads **resume** (`<file>.partial` + HTTP Range) and land only after size and sha256
  match the pin (the bundle store);
* **nothing large starts unseen**: no launch-time fetch before onboarding, none of anything
  not accepted; after onboarding a launch resumes exactly the accepted models not yet on disk.
  Parakeet's own fetch-on-dictation asks the same setting. A Download button on Languages or
  Modes counts as a yes.
* Uzbek, if missing, is offered only once `PUBLIC_MODELS_LIVE`; until then its row says
  "reinstall", never a button that 404s. Its download (then) goes through the model store,
  which is sha256-verified but buffers in memory and does not resume.

Silero VAD (885 KB) moves the other way: it ships in the installer
(`resources/models/silero-vad-v6.2.0/`), is hashed once per launch by the bundle store, and
is never downloaded. `verify-installer.mjs` sizes and hashes it.

## D-W24 — Turkish and Arabic: optional dictation languages, and Arabic's engine chosen per PC (C4)

Owner, 2026-09-30: Turkish and Arabic are optional **dictation** languages — never interface
languages (the UI stays en / ru / uz-Latn / uz-Cyrl). Both are off until the user turns them on
(`Settings.enabledLanguages`); off, a language is not pinnable, not in the tray, never routed to,
and never downloaded. Onboarding's Download models step offers them unticked, pre-ticked only
when Windows' first display language is tr/ar.

* **Turkish = whisper large-v3-turbo q5_0** — the file the installer already carries (0 bytes
  added), as its own family (`turkish`) with its own `kotiba-stt` host, greedy, streamed by the
  same `StreamingWhisperSession` as Uzbek (C4 §8: "nothing new"). Not in the eager preload: a
  second resident turbo for a language nobody may use is not a preload.
* **Arabic = Cohere Transcribe Arabic 07-2026 Q5_K_M through transcribe.cpp's npm binding**
  (`transcribe-cpp` 0.2.4, koffi FFI; win-x64 CPU + Vulkan build, `backend: 'auto'` takes
  Vulkan when there is a GPU, `cpu` when the user turned GPU off), heading the `arabic` family
  with whisper turbo + a punctuated Arabic prompt behind it — which is what serves Arabic from
  the moment it is switched on, before the 1.77 GB download lands (C4 §7.3.2).
* **The first-run speed check, and the automatic fallback.** The first time Cohere loads on a
  PC it decodes a shipped 3 s FLEURS ar_eg clip twice; if the faster run exceeds **300 ms** (tightened from 450 at merge: the 3 s check under-predicts long dictations),
  Arabic switches itself to **NVIDIA FastConformer-Hybrid ar pcd, int8 ONNX** (132 MB,
  CC-BY-4.0) on the onnxruntime-node the port already carries — fetched then, under the
  consent that fetched Cohere; Cohere serves until it lands. The verdict is stored beside the
  models (`arabic-speed-check.json`), keyed by the backend asked for, so it runs once per PC
  (again if GPU is switched). The Languages page names the active engine, the device, and why
  (the measured number against the threshold), with a manual override (Automatic / Cohere /
  FastConformer) that the check never overrules.
* **FastConformer's front end is TypeScript.** The export ships only the acoustic model; the
  80-bin NeMo log-mel that onnx-asr builds into `nemo80.onnx` at package time is not published
  at any pinnable URL, so `src/core/stt/nemo-ctc.ts` ports onnx-asr's own NumPy twin of it,
  plus greedy CTC. Checked: filterbank within 2e-9 of `fbanks.npz`, features within 2e-5, and
  the whole pipeline's text identical to onnx-asr's on 5/5 FLEURS clips.
* **C4's decoder rules.** Both decoders stream through `StreamingWhisperSession` (Silero from
  the whisper member's host, speculative decode at pauses, release cut at the last one) with
  commits at 14–18 s; no decoder is ever handed more than 28 s (Cohere's window is 35 s and it
  decodes only that — C4 §3.3); a Cohere segment that hits its generation cap
  (`OutputTruncated`, C4 §3.2) is re-decoded by the whisper member, never pasted empty.
* **Process.** Both run in an Electron utility process (`engine-host.js arabic`, "Kotiba Arabic
  engine") with D-W22's crash limiter; in-process only when the host cannot start. A superseded
  pause decode is aborted in the host (transcribe.cpp's cooperative cancel), so the tail never
  queues behind it.
* **Packaging.** koffi's `koffi.node` and transcribe.cpp's `transcribe.dll` + ggml DLLs are
  unpacked from app.asar; in the installed app `TRANSCRIBE_LIBRARY` is pointed at the unpacked
  DLL (LoadLibrary cannot read an archive; its directory is where ggml's backends load from).
  Other platforms' builds and koffi's C++ sources are excluded. `verify-installer.mjs` checks
  the DLLs, the contract version against the binding, the absence of other platforms, and the
  speed-check clip. `build-installer-mac.sh` fetches `@transcribe-cpp/win32-x64-cpu-vulkan` and
  `@koromix/koffi-win32-x64` at the lockfile's versions, checked against its sha512.
* **Cost.** Installer +~56 MB: transcribe.cpp's win-x64 build is 17.4 MB compressed but 54.1 MB
  on disk (one ggml CPU backend per x86 level, plus Vulkan), and the installer is `compression:
  store`; koffi ~1 MB; the clip 96 KB. Nothing more for a user who never turns Arabic on. Arabic on: +1.77 GB (Cohere) and, after a slow
  verdict, +132 MB. Resident while loaded (C4 §5, Mac): Cohere ~2.8–3.0 GB on a CPU,
  FastConformer ~0.75–1.7 GB; both give their memory back after 15 min idle.
* **Routing and text are the Mac's, byte for byte** (kotiba-golden, merged from the Mac's D-11):
  Arabic outright at an `ar` share ≥ 0.975; a Turkic recording with `tr` ≥ 0.9 and ≥ 5 s is a
  Turkish *candidate*, settled by turbo's own language head (`TurkishCheck`, ≥ 0.99), Uzbek
  otherwise; Arabic script is its own script class; Turkish casing through the `tr` locale;
  Arabic `، ؛ ؟`. One Windows difference: the Mac asks `TurkishCheck` during the hold, and
  Windows — which routes only at key-up — asks it there, through the Turkish engine's own
  `kotiba-stt` (the `detect` op on the turbo already loaded; no new model). That is one turbo
  encoder pass (~2 s on a 4-thread CPU, C4 §6) added to a Turkish candidate's key-up, bounded
  by the reroute deadline; Uzbek when it cannot answer. Only users with Turkish on ever pay it.
* **Arabic's second pass (C4 §14), byte for byte from the Mac:** an Arabic *candidate* (an `ar`
  share 0.05–0.975 on a recording ≥ 3.5 s, any base route) is settled by the same turbo head
  (`ArabicCheck`, ≥ 0.98, ≥ 0.95 once `arabicDictations` > 0) — at key-up here, through the
  Turkish engine's turbo or Arabic's own turbo member (`EngineManager.languageHead`); the base
  route when it cannot answer. Arabic delivery (`normaliseArabicForDelivery`: `، ؛ ؟` inside
  Arabic, Western digits, no tatweel or stray case endings), Message on rules for Arabic
  (`MESSAGE_BY_RULES`, `trimOpeners`), Note's Arabic prompt — all pinned by golden fixtures.
  Windows-only: Cohere on a CPU keeps a running pause decode instead of restarting it at every
  pause (`coalesceSpeculations`; 03-ENGINE-PARITY §16).
* **Not verified on Windows** — nothing here has run on Windows or in Electron's utility
  process; see 03-ENGINE-PARITY.md §16 for what was measured on this Mac, and the checklist's
  C11 for what only a Windows PC can say.

## D-W25 — A light installer: the core downloads by itself, Turkish and Arabic bring their own (supersedes D-W23's checklist; narrows D-W3)

Owner, 2026-10-02: a light app for general users, with no choices to make in setup.

* **The installer carries what Uzbek needs offline and nothing else**: Kotib STT (539 MB), the
  whisper-base detector (60 MB) and Silero VAD (0.9 MB) — ≈ 0.60 GB of models, **≈ 0.67 GB
  installer** (1.0.0's was 1,245,250,427 bytes; minus turbo's 574,041,195 ≈ 671 MB, estimated,
  not built). **whisper large-v3-turbo left it** (`bundled: false`): `fetch-models.mjs` no longer
  stages it, `electron-builder.yml` names the shipped files instead of `*.bin` (a stale staging
  directory cannot put it back), `build-installer-mac.sh` removes an old link, and
  `verify-installer.mjs` fails a build that carries it (size window 0.55–0.95 GB, plus a by-name
  check).
* **The core downloads after setup, with no question**: Parakeet Ultra (668 MB) and Qwen3-1.7B
  (1.28 GB) — **1.95 GB on first run**. It starts when "Your languages" is left (onboarding's
  Download models checklist is gone), or when onboarding is finished or skipped, and resumes at
  every launch until it is here (`launchResume` no longer reads `acceptedDownloads`; the setting
  stays so older files read). Parakeet's own fetch-on-dictation asks only `onboardingCompleted`.
  Onboarding's last pages and Home show one card, "Getting Kotiba ready — 1.95 GB", with one bar
  over the core and Try again on a failure (`coreReadiness`).
* **Turkish and Arabic bring everything they need, the moment they are turned on** (Languages
  page or onboarding): Turkish → whisper turbo (574 MB); Arabic → Cohere (1.77 GB) + turbo (its
  language head and fallback) + Gemma 4 E2B (its modes). The toggle says the size before
  ("Turning it on downloads …"), the models list shows the progress, and turning the language off
  offers to free the space — turbo only once neither Turkish nor Arabic is on
  (`removableModelFiles`; English and Russian no longer hold it). `arabicMayDownload` no longer
  needs an acceptance either. A download whose language was turned off while it waited in the
  queue is skipped.
* **English and Russian before Parakeet lands**: they wait for it. A press routed to them fails
  calmly with "The English model is still downloading (42 %). It works as soon as it lands." and
  the pill says "Still downloading — 42 %" (`SessionDeps.gettingReady` → `dictationError
  .gettingReady`, the same `noEngineReady` kind with a `percent`). The "No Russian model" blocker
  is held back while Parakeet downloads (`withoutHealing`, unchanged). Uzbek works throughout.
  If turbo happens to be on the PC (Turkish or Arabic brought it), it still stands behind
  Parakeet for English and Russian, as before — that path was kept, not removed. Fast English
  (`small.en`) is unchanged.
* **`--check`**: a broken install is now Uzbek or the detector missing/corrupt
  (`BUNDLED_MODEL_IDS`); turbo absent is normal. A fixture routed to a language whose engine is
  not downloaded yet reports `notDownloaded` (no error, exit 0); `corrupt` still fails. CI's
  `--check` over the committed fixtures therefore runs the Uzbek clips and reports the English
  one as not downloaded on a runner without Parakeet.

Not verified: an installer built and measured with this change (the size above is arithmetic);
a real first run on Windows (the downloads' order and resume are covered by unit tests over the
pure model, not by a run).


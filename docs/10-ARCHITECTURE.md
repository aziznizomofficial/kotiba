# Kotiba — Architecture & Specification (M3)

The single source of truth. Where this document and a dossier disagree, this document is
wrong and should be fixed — but until it is fixed, build what it says.

**Status: draft 1, 2026-08-05.** Written against the M2 research set
(`research/INDEX.md`, `decisions/ANSWERS.md`). Every number carries the evidence tag it was
measured under; `[MEASURED-HERE]` means on the user's own M4 Pro / iPad16,6 / iPhone17,2.

**No implementation code may be written until the M4 gate.** This document exists to make
M4 — the task graph — mechanical.

**What this is.** A full-fidelity a commercial dictation app equivalent for one person on three devices,
with five deliberate divergences (master plan §0): Kotiba's own brand; Uzbek, which
a commercial dictation app cannot do at all; self-renewing install on a free Apple team; single-user with
no accounts, licensing or telemetry; and speed parity as a hard gate rather than a goal.

**Zero code is carried over from `~/code/navo`.** It is read-only reference, mined for
lessons and brand values only. Those lessons enter here as requirements and test cases.

---

## 1. The shape of one dictation

```
             ┌──────────────────────────────────────────────────────────┐
 key down ──▶│ arm: start engine tap, page in the model, capture ctx-A  │
             └──────────────────────────────────────────────────────────┘
                                    │  user speaks (N seconds)
                                    ▼
             ┌──────────────────────────────────────────────────────────┐
   key up ──▶│ finalize buffer → VAD trim → route → ASR → normalise     │
             └──────────────────────────────────────────────────────────┘
                                    │
                                    ▼
             ┌──────────────────────────────────────────────────────────┐
             │ INSERT the raw transcript.  This is the end of the wait. │
             └──────────────────────────────────────────────────────────┘
                                    │
                                    ▼  (only if the mode asks for it)
             ┌──────────────────────────────────────────────────────────┐
             │ capture ctx-B → polish → REPLACE in place, or leave as-is│
             └──────────────────────────────────────────────────────────┘
```

Three properties of that diagram are load-bearing and are not negotiable downstream.

**Insertion happens before polish, always.** Polish costs 4–18× the transcription it
polishes in every configuration measured — a commercial dictation app's own history on this Mac is ASR p50
170 ms against LLM p50 1620 ms, never under 759 ms `[MEASURED-LOCAL]`. Kotiba's v1 is worse:
`rewriting` takes 8–25 s on every device `[MEASURED-HERE]`. Putting polish on the critical
path is the single largest self-inflicted latency error available, and v1 made it.

**Context capture is split in time, and the split is copied from a commercial dictation app deliberately.**
Selected text and clipboard at *recording start* (ctx-A); the active-application walk *after
transcription, before polish* (ctx-B). This keeps an Accessibility-tree walk out of the
latency-critical path and makes app context describe where the text will actually land.

**Nothing is inserted before the language is resolved.** GAP-04 §5: a mis-route is silent —
well-formed Latin text, no error, no low confidence — so insert-then-retract is not a
recovery strategy. Retraction across foreign apps is also entirely unresearched
(`[MEASURED-HERE, grep over C1 — no hits]`).

### 1.1 The latency budget

Every stage carries a number, per the M3 gate. Warm unless stated.

**macOS, English or Russian** — the path that must reach parity:

| Stage | Budget | Source |
|---|---|---|
| key down → capturing | ≤ 20 ms | `[INFERRED]` A4; app resident, non-sandboxed |
| key up → buffer finalised | ~5 ms | `[INFERRED]` A4 |
| VAD trim + normalise | 5–15 ms | `[INFERRED]` A4, Silero-VAD sized |
| route (manual pin) | **0 ms** | `[MEASURED-HERE]` GAP-04 — the pin is free |
| ASR, Parakeet TDT v3 on ANE, ≤15 s | **62–66 ms** | `[MEASURED-HERE]` B1, three passes |
| deterministic normalise + replacements | < 5 ms | `[INFERRED]` |
| insert (pasteboard + ⌘V) | **~33 ms** | `[MEASURED-HERE]` GAP-06, v1's own `delivering` |
| **total, key-up → text visible** | **≈ 110–145 ms** | composed |

a commercial dictation app on the same machine is ~150 ms best case and ~450 ms typical, because its
insertion path was ≥300 ms before v2.16.2 and the OS event path itself costs ~0.5 ms
`[MEASURED-HERE]` C1 — *"all visible paste latency in shipping competitors is self-inflicted
padding."* **Parity is not the hard part; not re-inflicting the padding is.**

**macOS, Uzbek** — no parity target exists, because a commercial dictation app cannot do Uzbek at all:

| Stage | Budget | Source |
|---|---|---|
| arm + finalise + VAD | ~40 ms | as above |
| route (acoustic, if not pinned) | **+35 ms** | `[MEASURED, third-party, M1]` B4 — **borrowed, unverified on M4 Pro** |
| ASR, whisper.cpp `navoi-medium` q5_0, Metal, greedy, 10.7 s | **~438 ms** | `[MEASURED-HERE]` A4 |
| insert | ~33 ms | as above |
| **total** | **≈ 510–550 ms** | composed |

**iOS** — two ratios, not one, and this inverts a design decision `[MEASURED-HERE]` GAP-06:

| Path | A18 Pro vs M4 Pro | Consequence |
|---|---|---|
| Core ML / ANE | **~1.0×** (n=1, thin — re-measure) | English and Russian are already at Mac parity on the phone |
| whisper.cpp / Metal | **3.3×** | Uzbek costs ~1.45 s on the phone, because it exists only as ggml |

Two iOS budget items are v1 implementation debt, not platform floors, and the rebuild must
attack them: `toRecording` is **302 ms** on the iPhone against 103 ms on the Mac, and
`identifying` is **291 ms** — a third of a second each, before a single sample is captured
`[MEASURED-HERE]`. Insertion is the one stage that is *faster* on device: 16.5 ms.

**The single highest-leverage iOS speed work is converting the Uzbek model to Core ML**, and
no amount of whisper.cpp tuning substitutes for it.

### 1.2 Budget rules

1. **Cold is a UI state, not a number in this table.** The Core ML/ANE compile is *recurring*,
   not first-run — three ~47–53 s WhisperKit compiles in one afternoon with no reinstall, plus
   a 14,344 ms cold ANE encoder load `[MEASURED-HERE]`. Warm at launch, warm again on every
   foreground, and when cold, say so.
2. **Parakeet latency is constant, not proportional** — `maxModelSamples = 240_000`, a fixed
   15 s window, so 0.5 s and 15 s cost the same 25.8 ms of encoder `[MEASURED]`. Budget per
   *chunk*, not per second.
3. **Never put Whisper-family LID in the path.** 133–141 ms for `small`, 545–718 ms for
   `large-v3-turbo`, and `--audio-ctx` does not reduce it `[MEASURED-HERE]`.
4. Any stage that exceeds its budget by 3× in the field must appear in diagnostics, not in a log
   nobody reads.

---

## 2. Module graph

One repo, one root `Package.swift` (swift-tools-version 6.2), all non-UI logic in SPM library
targets, apps thin. `.xcodeproj` generated by **XcodeGen 2.45.4** from a checked-in
`project.yml` and gitignored. D3.

```
Sources/
  KotibaCore/          pure Swift. NO AVFoundation, NO CoreML, NO SwiftUI, NO #if os(...)
    Contracts/        AudioSource · TranscriptionEngine · TextSink · PolishEngine · LanguageRouter
    Modes/            mode model, registry, prompt assembly
    Text/             normalisation, replacements, vocabulary, script checks
    History/          record model, FTS query construction
    Routing/          cluster-mass + pin + script-check decision logic (no ML)
  KotibaAudio/         AVAudioEngine, AVAudioSinkNode, VAD, ring buffer
  KotibaParakeet/      FluidAudio / Core ML — the EN+RU engine
  KotibaWhisper/       whisper.cpp + Metal — the Uzbek engine
  KotibaLID/           ECAPA Core ML + the linear probe + mel front-end
  KotibaModels/        download, verify, compile, cache, residency
  KotibaPolish/        optional post-processing, local and remote
  KotibaUI/            SwiftUI HUD, settings, history browser  (@MainActor by default)
  KotibaPlatform/      the three genuinely per-platform seams
Apps/
  macOS/              menu-bar app, hotkey, panel
  iOS/                ONE target, TARGETED_DEVICE_FAMILY = "1,2"
  iOS/Keyboard/       thin insertion client
  Shared/
```

**The dependency rule.** `KotibaCore` is pure Swift and imports nothing from Apple's media or
ML stacks. Everything platform-shaped enters through a protocol in `Contracts/`. This is what
makes Band-1 tests run in milliseconds on every push with no signing, no models and no
microphone — and D3 is explicit that this is where the bulk of the tests should live.

**Only three things are genuinely per-platform:** the activation gesture, the presentation
shell, and the delivery mechanism (`TextSink`). *"If a fourth thing shows up in `Apps/`, it is
misplaced."*

**One iOS target, not two.** iPhone and iPad differ by `TARGETED_DEVICE_FAMILY`, because two
targets would double the bundle-ID count against a quota of 10 App IDs per 7 days.

**Swift 6 language mode package-wide from commit one**, `.defaultIsolation(MainActor.self)` on
`KotibaUI`, `nonisolated` on audio and ML. Exactly **one** `@unchecked Sendable` is sanctioned:
the lock-free SPSC ring buffer written from the real-time audio render callback. Every other
one is a bug. Do not enable `SWIFT_STRICT_MEMORY_SAFETY` initially. Do not use `unsafeFlags` —
it poisons a package for remote consumption.

**Models and `.xcframework`s never enter git.** GitHub Releases (2 GiB/asset) with a single
`Scripts/Manifest.json` of `{name, url, sha256, dest}`; fetch with `curl` + `shasum -a 256`.
Clean clone is `mise install && make bootstrap && make generate`. **Never ship `.mlpackage` in
the bundle** — download, `MLModel.compileModel(at:)` on first launch, cache the `.mlmodelc`.

---

## 3. Engines and the router

### 3.1 Two engines, and why exactly two

| Engine | Languages | Runtime | Measured |
|---|---|---|---|
| **Parakeet TDT 0.6B v3** | English **and** Russian | Core ML on ANE, via FluidAudio | 62 ms EN / 66 ms RU per 5 s, 84 MB RSS, 461 MB disk `[MEASURED-HERE]` |
| **`islomov/rubaistt_v2_medium`** ("Navoi", Apache-2.0) | Uzbek | whisper.cpp + Metal | ~438 ms for 10.7 s; **25.19 % WER** on real-world audio `[MEASURED-HERE]` |

Apple's `SpeechTranscriber` is an *optional* English-only fast path with a zero-byte bundle
(100–120 ms warm). It is never the only path: it has no Russian, and Uzbek hard-errors with
`SFSpeechErrorDomain Code=15`. Treat it as an engine behind the same protocol, off by default.

**Why not one engine.** Two independent forcings, either sufficient: the only Uzbek
Parakeet-class checkpoint is pure CTC with a 1024-token vocabulary containing **zero Cyrillic**
— Russian is architecturally impossible, not degraded — and its decoder topology
(`ctcGreedyDecode`) differs from v3's (`TdtDecoderV3`) `[MEASURED]` GAP-03.

### 3.2 The router is one bit

**Not a 3-way language decision. A binary engine-family decision: Uzbek engine, or the other
one.** Parakeet v3's unified 8192-token vocabulary decides English↔Russian *inside the decoder,
at 0 ms* — a commercial dictation app's own history proves it, 60/60 records pinned to `"en"`, one of which
emitted correct Cyrillic in 98 ms `[MEASURED-HERE]` GAP-04.

Decision order, cheapest first:

| Tier | Mechanism | Cost | When |
|---|---|---|---|
| **P1** | **Manual per-mode pin** | **0 ms** | Absolute. If the mode pins a language, nothing else runs |
| **P4** | ECAPA over the **full utterance at key-release**, masked to `{turkic-mass, everything-else}` | +35 ms `[borrowed M1 number]` | Default when unpinned |
| **P5** | Output **script check** | ~0 ms | Always, after ASR, as a verifier |

Never prefix LID: wrong prefix answers are *high* confidence (a Russian clip scored `en`
p=0.640 at 0.5 s) and accuracy is non-monotonic in prefix length. Never Whisper LID: it gets
*more confidently wrong* with model size — `large-v3-turbo` labelled a Russian clip `kk` at
**p=0.962** `[MEASURED-HERE]`.

**Cluster mass, not argmax.** A clean Uzbek sample scores `tr 0.63 / az 0.17 / uz 0.00`. Sum
probability across Uzbek and the languages it is misheard as, then pick within that group. A
rule that waits for `uz` to win never fires.

**The probe cannot lose to the fallback**, because the fallback is a point inside the probe's
own hypothesis class: initialise `W` at the cluster-mass matrix `C`, regularise `‖W − C‖²`, and
one λ runs continuously from fallback to free probe. λ = ∞ *is* cluster-mass. There is no
separate fallback code path. Probe the **107-d probability vector** (`exp` of the shipped
model's log-probs) — the shipped artefact emits nothing else. GAP-05.

**Enrollment: 10–20 utterances per language, not 200–500.** Three stages: build-time base probe
(0 owner utterances, ships in the bundle) → a 12-prompt onboarding wizard (~5 min, skippable) →
implicit harvest from confirmed dictations, capped ~40/language, oldest-first eviction.
**Keep the raw audio, never only the features** — a 107-d vector is meaningless the instant the
backbone or any mel parameter changes, and 36 clips is ~9 MB.

**The mel front-end is excluded from the Core ML package and must be computed on-device:**
16 kHz, n_fft **400**, hop 160, win 400, n_mels 60, **periodic** Hamming, center pad,
SpeechBrain symmetric triangular filterbank, `10*log10(clamp(x,1e-10))`, top_db 80, CMVN
identity. **DFT size 400 is not a power of two — `vDSP_fft_zrip` silently computes wrong
results.** Python↔Swift mel bit-parity to ~1e-4 is a hard gate and the first assertion in the
test suite.

**Residency.** Both engines stay compiled and resident. A router that can select either engine
and pays a cold load on the second one has not routed, it has stalled: WhisperKit `small` cold
is **21.28 s** `[MEASURED-HERE]`. Estimated dual-engine footprint ≈ **1.12 GB** — free on a
24 GB Mac, **untested on an 8 GB phone**.

**Intra-utterance uz↔ru code-switching has no solution and no dataset.** arXiv returns zero
papers; it is in no public corpus. The engineering answer is to **log every routing decision
from day one** — `{pin, posterior, engine, output script, verdict, re-run, wall}` — because the
owner's own logged utterances are the only uz-ru corpus that will ever exist for this app.

---

## 4. Modes

Adopt a commercial dictation app's storage shape — one flat JSON file per mode, filename stem equal to `key`,
registry in settings — and **reject its prompt design**.

a commercial dictation app has **no template variables at all**: 0 of 60 rendered prompts on disk contain
`{{`, and the docs page has no interpolation syntax `[MEASURED]` A3, "the strongest claim in the
dossier". The transcript can therefore only ever be appended last, and correctness rests on the
LLM resolving English prose references to uppercase section headers — which its own docs concede
weak models fail at.

**Kotiba ships real interpolation.** `{{transcript}}`, `{{selection}}`, `{{clipboard}}`,
`{{app}}`, `{{window}}`, `{{datetime}}`, `{{locale}}`, `{{language}}`. A missing variable is an
error at mode-save time, not a silent empty string at dictation time.

Fields to carry across (A3's 27-field v2.11.0 schema is a **floor, not a current schema**):
`key`, `name`, `type`, `version`, `prompt`, `promptExamples`, `voiceModelID`, `polishModelID`,
`language`, `contextFromSelection`, `contextFromClipboard`, `contextFromActiveApplication`,
`activationApps`, `autocapitalizeInsert`, `literalPunctuation`, `realtimeOutput`.

`language` is the **P1 pin** from §3.2 — mode *is* an (engine, language) pair, exactly as
a commercial dictation app's already is.

**Do not copy the vocabulary-hint mechanism.** It is a Whisper-decoder hack that breaks on
precisely the fast engines Kotiba wants — a commercial dictation app's own docs say it works "with all voice
models except Nova or Parakeet" — and it degrades punctuation and formatting. Keep **vocabulary**
(an ASR-stage hint) and **replacements** (deterministic post-transcription substitution) as
separate mechanisms, and make vocabulary **per-language**, or Uzbek hints will corrupt English.

---

## 5. Text delivery

### 5.1 macOS

`NSPasteboard` + synthesised ⌘V as the primary path, with a keystroke-simulation fallback.
A non-activating `NSPanel` so focus is never lost. Hotkey via a `CGEvent.tapCreate` session tap
(hold right-⌘, a commercial dictation app's own gesture).

TCC: **Accessibility** and **Input Monitoring**. The bundle ID is inside the designated
requirement and TCC stores it verbatim — **a rename is free, a bundle-ID change re-grants every
permission** `[MEASURED]` C1. Pin the requirement to `certificate leaf[subject.OU] = "YOURTEAMID"`.

**macOS has no 7-day clock.** No restricted entitlements ⇒ no provisioning profile ⇒ no expiry
(TN3125, confirmed twice plus demonstrated locally). Anyone quoting the 7-day problem as a
project-wide constraint is wrong; it binds iOS only.

Uzbek note: macOS 26.5.1 ships **no Uzbek Latin keyboard layout**, so U+02BB cannot be produced
by keycode retranslation — the keystroke fallback is unusable for Uzbek and the paste path is
mandatory there.

### 5.2 iOS

Containing app owns the microphone and the models under a time-boxed warm session. The keyboard
extension is a thin insertion client calling `textDocumentProxy.insertText(_:)` and nothing else.

This shape is forced, not chosen: only a keyboard extension can insert into an arbitrary app —
App Intents, Shortcuts, Action Button, Control Center and the share sheet are trigger-or-clipboard
surfaces, never insertion surfaces — and **the extension cannot open the microphone**: error
561145187 `'!rec'`, FB16791704.

**That is one reason, not two, and the second one is dead.** Measured on the iPhone 2026-08-05,
two cold summonings agreeing to within 0.1 MB `[MEASURED-HERE]`, GAP-06: the extension starts
with `os_proc_available_memory()` = **171.6 MB** and is killed at `phys_footprint` = **176.8 MB**,
with `MEMORY WARNING` arriving while ~32 MB of headroom remains. Published guesses spanned
30 / 48 / 60 / 70 / 77 MB — the real ceiling is **2.5× to 5.9× larger**, and a 57 MB
`ggml-base-q5_1` would fit inside it comfortably.

So **do not write "no model fits in the keyboard" anywhere — write "the keyboard cannot open the
microphone."** And size against `os_proc_available_memory()` at runtime, which tracked allocation
exactly and is trustworthy, never against a constant.

**Transport: App Group `group.uz.kotiba.shared` — registered and verified, not assumed.**
`spikes/gap08` ran on 2026-08-05: the issued profile carries
`com.apple.security.application-groups = ['group.uz.kotiba.shared']` and so does the signed
binary `[MEASURED-HERE]`. This **deletes** C2 §0.5/§7.3's Darwin-notification + loopback-TCP
design rather than merely demoting it. Inside the group you also get Mach IPC, POSIX shared
memory and UNIX domain sockets. Keep Darwin notifications only as a tier-2 "transcript ready"
signal so the keyboard need not poll. **On macOS use `YOURTEAMID.kotiba`** — no `group.` prefix,
no portal registration, no team-type question.

The same run confirmed `com.apple.developer.kernel.increased-memory-limit` provisions on this
free team. Take it for the containing app, where the models live — but size against
`os_proc_available_memory()` at runtime regardless, because it is advisory, and note it cannot
be applied to the keyboard extension at all (`supportedProductTypes` is `application` only).

**The cost that cannot be designed away:** iOS 26.4 nulled `hostApplicationBundleId`
(FB22247647), so the hop back to the originating field is a **manual swipe** and per-app modes
cannot be automatic. There is no replacement API.

### 5.3 Insertion confirmation

The HUD dismisses on **observable** paste success with a timeout fallback — never on a fixed
delay. a commercial dictation app's paste confirmation was still breaking per-app at v2.17.0 (2026-07-29), and
its changelog documents paste bugs in Safari, Discord, Obsidian, Slack and Superhuman. D4.

---

## 6. Storage

| What | macOS | iOS |
|---|---|---|
| Models (~1.1 GB) | `~/Library/Application Support/Kotiba/models/` | `Library/Application Support/<bundle>/models/`, `create: true` |
| Compiled `.mlmodelc` | same tree | same tree — **not `Caches`** |
| LID probe + raw enrollment audio | `…/lid/` | `…/lid/`, **not** excluded from backup |
| History DB + audio | `…/history/` | `…/history/` |
| Mode JSON | `…/modes/<key>.json` | same, synced by hand |

**`Library/Caches` is wrong for weights** even though v1 was forced there: iOS may purge it.
`Application Support` works provided the directory is created with `create: true` — C4's leading
explanation of v1's `NSFileWriteNoPermissionError` 513 is that the iOS installer does not create
`Library/Application Support` itself.

**The data container survives the weekly re-sign** — six rebuild+re-sign+reinstall cycles on both
devices, including an executable rename `[MEASURED-HERE]` GAP-06. A 1.1 GB model download is
**not** part of the 7-day problem. But it is keyed to the app id, so a bundle-ID change forces a
full re-download.

**The ANE bundle cache is keyed by OS build** (`…/e5bundlecache/23F77/…`): an iOS update
invalidates every compiled model and forces a full recompile; a re-sign does not.

**History: three persisted text stages** — `rawResult` → `result` → `polishResult` — with mono
16 kHz Int16 WAV, copied from a commercial dictation app. But **use `unicode61` or `trigram` for FTS5, never
`porter`** — a commercial dictation app's choice mangles Russian and Uzbek stems.

---

## 7. Post-processing policy

**Off by default. Never on the critical path. Always time-boxed. And the user brings their
own key** — Kotiba hosts no inference and stores no credential of its own (D-07, 2026-08-06).

The endpoint is a **setting**, not a constant. A Gonka key is meaningless without knowing which
broker issued it; the same is true of any OpenAI-compatible proxy. So the settings pane takes a
base URL, a key, and a model name, and the key goes to the Keychain — never to a plist, never to
the shared App Group container, and never into `diagnostics.json`.

Because someone else's key failing will look like a Kotiba bug, a polish failure must name the
endpoint and the actual error. This is why the deadline outcome distinguishes a throw from a
timeout: an earlier version conflated them and reported a bad API key as an eight-second
overrun.

Apple's Foundation Models framework is not an option: no Russian, no Uzbek, confirmed twice, and
WWDC26 session 241 announces no new languages through OS 27.

Uzbek orthography is fixed **deterministically** with NavAI's `uzbek_text_norm` v0.3.0
(Apache-2.0), not by a model. The two Uzbek lineages disagree about apostrophes — navai emits
okina U+02BB, rubaistt emits ASCII — so this folding is load-bearing, not cosmetic.

**Build a capitalisation restorer, not a punctuation restorer.** The shipping Uzbek model already
emits punctuation in **68.3 %** of transcripts and capitals in **0.0 %** `[MEASURED-HERE]` GAP-01.

`islomov/rubai-corrector-transcript-uz` does the whole job well — 8/8 on its author's examples,
0.36 s on a short utterance — and **carries no licence**, so it cannot ship until the author
grants one. If he does, run it exactly where §1 puts polish. Two guards are mandatory: the
`correct: ` task prefix (omitting it silently deletes clauses — 25 % of outputs lost >50 % of
content) and a length-ratio check.

Any LLM polish path needs an **output script/language check**. A ≤2B model translated English
into Russian and changed "Tuesday" to "Monday" at a length ratio of 0.72 — invisible to a
length guard alone.

---

## 8. Renewal protocol (iOS only)

Design requirements, all of them earned from v1's measured failures:

1. **Per device, one state file each.** A shared file silently starves the second device.
2. **Force a *new* profile.** Xcode will not re-issue one that is still valid, so the old profile
   must be moved aside — and rebuilding early otherwise reports success while the expiry never
   moves.
3. **Never enter the stash window without an Apple Account in Xcode.** Check for an `@` address in
   `DVTDeveloperAccountManagerAppleIDLists`; the key can exist with an empty array. Free personal
   teams have no App Store Connect key, so the GUI login is the only path.
4. **Guard the stash window with a trap on EXIT/INT/TERM/HUP.** An interrupt inside it leaves the
   only profile in a temp directory and ends iOS builds immediately. The launchd job has been
   measured not to survive sleep.
5. **Detect real on-device expiry**, never assume it from a successful build.
6. **Its own launchd label and state files**, distinct from v1's, or the two fight over Xcode's
   profile cache.
7. **Notifications must not be over-rationed.** v1's `once_today` means one dismissed banner burns
   a third of the warning budget.

Budget: 10 App IDs per 7 days, 3 devices per platform, and **free-team bundle IDs can never be
reused** — every throwaway burns a name permanently.

---

## 9. Observability — the anti-silence rules

v1's most expensive defects were all silent. These are requirements, not nice-to-haves:

1. **Engine selection is observable at runtime.** Parakeet never once loaded on iOS and nothing
   anywhere said so; every dictation silently fell back to Whisper at 1.05–3.67 s.
2. **Warm-up retries on every foreground**, never once from `init`. One bad moment at launch
   killed the ANE for the process lifetime, and a suspended-then-resumed app never runs `init`.
3. **Record which directory won, and every refusal with its errno.**
4. **A dictation that heard nothing says so — and there are two ways to hear nothing.**
   About a third of v1's recordings were near-silence (median peak amplitude 0.0018 against
   0.1326) and returned an empty result instead of a message. But the amplitude gate catches
   only the first way: a fan, a door slam or mic hum clears the 0.012 threshold while
   containing no speech, and whisper.cpp answers those with `""`, `" "` or `"[BLANK_AUDIO]"`.
   Normalisation is a third source — a raw string of punctuation can reduce to nothing. **So
   the text is checked as well as the audio, and an engine that produced no words is
   `.heardNothing` with the engine, duration and peak recorded.** Adversarial review found this
   missing from the first implementation on 2026-08-06, in the very seam built to prevent it.
5. **A key-up that arrives while the engine is still starting is not dropped.** `audio.start()`
   is a nonisolated async call, so arming releases the actor for the 103 ms (Mac) to 302 ms
   (iPhone) it takes — and a hold-to-talk hotkey delivers key-down and key-up as two unordered
   tasks. Returning early there would leave the tap open and hand the abandoned audio to the
   *next* dictation, inserting the wrong text. The key-up waits instead.
6. **Every routing decision is logged** (§3.2).
7. **`diagnostics.json` in the store root** is how any device is inspected; on iOS it is the only
   channel, because `log stream` has no device option and `devicectl` will not attach to stdout.

---

## 9b. Distribution — decided 2026-08-06

Kotiba ships to a handful of other people (~5–50). Not the App Store, not a public launch, but
also not just this Mac. That middle ground sets four things.

**macOS: Developer ID, notarized, direct download. Not the Mac App Store.** This is forced, not
preferred. The App Store requires sandboxing, and both of Kotiba's load-bearing capabilities are
outside the sandbox: `kTCCServiceAccessibility` for reading selected text and the focused app,
and Input Monitoring for the global hotkey. A sandboxed Kotiba is a record-and-copy-to-clipboard
tool, which is a different product. a commercial dictation app ships outside the App Store for the same
reason. So `com.apple.security.app-sandbox` stays `false` and that is a decision, not an
oversight.

**iOS: TestFlight.** Up to 100 internal testers with no review, which comfortably covers the
audience and avoids App Store review entirely.

**The $99 program is required, and it deletes work.** A free personal team cannot mint
distribution certificates at all. Buying it also gives year-long profiles, which demotes the
whole 7-day renewal apparatus (§8, tasks N-01…N-06) from a shipping feature to dev scaffolding
for this Mac. Keep the scripts; stop treating them as product.

**No backend, no accounts, no telemetry.** Crash and diagnostic reports are exported by the user
from within the app and sent by hand. `diagnostics.json` was already the only inspection channel
on iOS; it now needs a share sheet in front of it, because the person holding the failing device
is no longer the person who wrote the code.

### 9c. Licences — what shipping to others turns on

Today's obligation is genuinely zero because CC BY defines *Share* as providing material **to
the public**, and a single-user install is not Sharing. Shipping to other people ends that.

| Component | Licence | What shipping requires |
|---|---|---|
| Parakeet TDT v3 weights | **CC-BY-4.0** (NVIDIA) | Attribution, licence notice, no added restrictions. **A converted `.mlmodelc` is still the Licensed Material** — format conversion never produces Adapted Material, so it cannot be relabelled |
| FluidAudio SDK | Apache-2.0 | NOTICE file |
| `islomov/rubaistt_v2_medium` | Apache-2.0 | NOTICE file |
| NavAI `uzbek_text_norm` (ported to Swift) | Apache-2.0 | NOTICE file + attribution in the source, which is already there |
| whisper.cpp | MIT | Licence text |
| Silero VAD | MIT | Licence text |
| ECAPA / SpeechBrain | Apache-2.0 | NOTICE file |
| `islomov/rubai-corrector-transcript-uz` | **none at all** | **Cannot ship.** Was already unshippable; the scope change removes any remaining ambiguity |

Keep weights and code licences in **separate columns of the same table** and do not mirror
FluidInference's own repo, which carries `cc-by-4.0` in its front-matter and "Apache 2.0" in its
README body — a live contradiction inside one file.

**Also flagged, not decided:** `kotib.ai` is a real Uzbek STT company. Irrelevant for a personal
tool; a trademark question the moment the name is on a download page.

---

## 10. Decided vs pending

| Area | Decided | Pending, and on what |
|---|---|---|
| EN/RU engine | Parakeet TDT v3 / FluidAudio, ANE | iPhone ANE figure is **n=1** — re-measure before betting |
| Uzbek engine | `rubaistt_v2_medium` via whisper.cpp | Execute `nvidia/stt_uz_fastconformer_hybrid_large_pc` — it could replace both this and §7 |
| Router | Binary, pin > ECAPA > script check | ECAPA's 35 ms is a borrowed M1 number; owner-voice accuracy unmeasured |
| iOS insertion | Host app + keyboard over App Group — **App Group verified end to end 2026-08-05** | Keyboard memory ceiling and cold start — `spikes/GAP06`, now **unblocked** |
| macOS insertion | Pasteboard + ⌘V | Does dev-signed `CGEventPost(⌘V)` land on 26.5.1? *"If it fails, the whole insertion design changes"* |
| Polish | Off by default, off the path | Corrector licence — author request |
| Storage | Application Support, `create: true` | Are Core ML weights clean pages? Decides the memory case |
| Bundle IDs | `uz.kotiba.app`, `.keyboard`, `group.uz.kotiba.shared`, `YOURTEAMID.kotiba` | — |
| Team | Free, with hardened renewal | $99 on any of C3's four triggers |

**Both M4 blockers cleared 2026-08-05.**

- **Apple ID** signed back in; both devices renewed to 2026-08-12; `spikes/gap08` run, so the
  App Group transport in §5.2 is verified end to end rather than assumed; `spikes/GAP06` built
  and installed, and the containing app reports **`os_proc_available_memory` = 3371 MB** on the
  iPhone — the ~1.1 GB dual-engine resident set fits with room to spare `[MEASURED-HERE]`.
- **`nvidia/stt_uz_fastconformer_hybrid_large_pc` executed.** It emits capitals (96.2 %),
  punctuation (72.1 %) and the okina (68.3 %) exactly as B3 predicted, and runs at 39.6×
  realtime on CPU — but its WER is **55.16 %** against `rubaistt`'s **25.19 %**, and it loses at
  every utterance length including 0–5 s. **It does not replace the Uzbek engine and it does not
  delete the capitalisation stage.** §3.1 and §7 stand as written. GAP-02 §6.

- **`spikes/GAP06` run on the iPhone.** The keyboard-extension memory ceiling is **~177 MB**,
  not the ~60 MB everyone assumed, and the extension **reads and writes the shared App Group
  container at runtime**. §5.2 is corrected accordingly: the design stands, but on the microphone
  prohibition alone. GAP-06.

**One measurement still outstanding**, and it is the last thing that could change §5.2: the
extension's **cold-start time** — summon to first pixel — against a budget where `toRecording`
alone costs 302 ms on this phone. The probe logs `viewDidLoad` but has no process-start
timestamp; adding a `kinfo_proc` read is a ten-line change to a spike that is already installed.

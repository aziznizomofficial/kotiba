# Engine parity — is Windows decoding the same way?

This file answers that question without anyone re-reading two codebases. One row per
`whisper_full_params` field the Swift `WhisperEngine` sets, its Swift value, its Windows
value, and where each is set. Where they differ there is a written reason.

**Sources.** Swift: `Sources/KotibaEngines/WhisperEngine.swift` and
`Sources/KotibaEngines/LanguageDetector.swift`, both linking whisper.cpp **v1.9.2** as the
project's released xcframework (`Package.swift:51`). Windows: `windows/src/engines/params.ts`
(builds the values) and `windows/native/kotiba-stt/src/main.cpp` (assigns them to the struct),
linking whisper.cpp **v1.9.2** from source (`windows/native/kotiba-stt/CMakeLists.txt`).

**The same tag on both sides is load-bearing.** Nine of the rows below are whisper's own
defaults, which Kotiba deliberately does not touch. A different whisper build moves decode
quality with no change in either codebase.

---

## 1. The strategy, and the two struct arms

`whisper_full_default_params(strategy)` fills **only the arm for the strategy it was
given**. That single fact is behind two of the three most likely ways this port goes
wrong, so it comes first.

| field | Swift | Windows | where |
|---|---|---|---|
| `strategy` | `BEAM_SEARCH` when `beamSize > 1`, else `GREEDY` | same rule, on a **per-model** beam size | Swift `WhisperEngine.swift:219-220` · Win `params.ts:whisperParamsFor` → `main.cpp:buildParams` |
| `beam_search.beam_size` | `Int32(options.beamSize)`, **set only when `beamSize > 1`** | same: set only in the beam branch, `null` on the wire otherwise | Swift `:235-237` · Win `params.ts` (`beamSearchBeamSize`), `main.cpp` (`if (beam)`) |
| `greedy.best_of` | **`5`, unconditionally, in BOTH branches** | **`5`, unconditionally, in BOTH branches** | Swift `:258` · Win `params.ts` (`greedyBestOf`), `main.cpp` (assigned outside the `if`) |
| `beam_search.patience` | untouched → `-1.0f` | untouched → `-1.0f` | whisper v1.9.2 default |

### Why `greedy.best_of` is not the greedy-path knob its name suggests

Read from the v1.9.2 source both sides link:

- At temperature 0 it does nothing measurable — greedy decoding is deterministic.
- **Above** temperature 0 it *is* the fallback's sample count: `n_decoders_cur =
  params.greedy.best_of` (`src/whisper.cpp:7062-7068`), and the decoder switches from
  argmax to a single draw from `std::discrete_distribution` (`:7234-7239` → `:6511-6517`).
  So `best_of = 1` makes every fallback rung one unranked random sample.
- That path is reached often and does not stop early: raising the temperature divides the
  logits *before* `avg_logprobs` is recorded (`:6201-6204`), so recorded confidence *falls*
  as the ladder climbs, and the last rung at t = 1.0 is accepted unconditionally
  (`:7571-7581`). A 25% aggregate WER can hide a tail of clips that came back as
  temperature-1.0 noise, and that tail is what "awful" feels like in use.
- The beam branch never touched it, so it kept the struct literal `-1` (`:5981`) —
  `whisper_full_default_params` fills only `beam_search` for the beam strategy — and
  `max(1, -1)` is 1. **Beam 5 degenerated to a single sample on fallback exactly like
  greedy did.** That shipped.

Pinned by three tests: `params.test.ts` asserts it in both branches, and
`native/kotiba-stt/test/protocol-test.mjs` asserts it against a compiled binary whose stub
whisper reproduces v1.9.2's one-arm-only fill. Deleting the line fails all three.

### Why `beam_size` is never sent in the greedy branch

`beam_size = 1` with a beam strategy is a *different decoder*, not a faster one. Both
sides leave whisper's own `-1` standing.

---

## 2. THE THREE VALUES THAT ARE NOT COPIED BLINDLY

### 2.1 Beam size — **DIFFERENT ON PURPOSE** (D-W11)

| | Swift | Windows |
|---|---|---|
| Uzbek model (`uzbek_stt_v1`) | **5** | **1** |
| `large-v3-turbo` (en + ru) | 5 | 5 |

**Reason.** Decision **D-08** (`docs/decisions/REGISTER.md`) measured beam 5 on the
344-clip evaluation subset against the model that actually ships: **21.65% WER against
greedy's 21.68%** — noise — for **+21% latency on a 2.8 s clip and +39% on an 8.8 s clip**.
The register says outright that `whisperBeamSize` "should go back to 1 with this swap" and
that the shipped 5 is inherited from the superseded `navoi-medium` model.

macOS still ships 5. On a CPU-only Windows laptop, beam 1 is the cheapest latency win in
the app and it costs nothing measurable in accuracy, so Windows takes it.

`large-v3-turbo` **keeps beam 5**: D-08 measured Uzbek only, and nothing licenses changing
a model that was not measured.

Implementation: `BEAM_SIZE_BY_FAMILY` in `src/contracts/transcript.ts` is the authority;
`beamSizeFor` in `params.ts` applies it. The `whisperBeamSize` setting moves the **unified**
number only and cannot raise the Uzbek one — three tests assert that at 1, 5 and 8.

### 2.2 Thread count — **SAME FORMULA, DIFFERENT INPUT**

| | Swift | Windows |
|---|---|---|
| formula | `max(1, min(8, activeProcessorCount − 2))` | `max(1, min(8, decodeCores − 2))` — **identical** |
| the input | `ProcessInfo.activeProcessorCount` (logical == physical on Apple silicon) | `decodeCores = logical <= 2 ? logical : floor(logical / 2)` |
| where | `WhisperEngine.swift:232-234` | `params.ts:resolveThreadCount` / `resolveDecodeCores` |

**Reason, and this is the deliberate choice the brief asked for.** The macOS formula was
chosen against an M4 Pro, where every core `activeProcessorCount` reports is a physical
core with its own vector units. `os.cpus().length` on Windows counts something else:
hyperthreads on any SMT part, and E-cores on every Intel 12th-gen-or-later laptop the
audience actually owns. ggml's matmul threads spin rather than sleep, so oversubscribing
them costs latency instead of buying it.

**The rule: halve the logical count before the macOS formula sees it.** `n <= 2` passes
through, because the CI runner is a 1-core / 2-logical VM and halving it to 1 would make
the smoke test representative of nothing.

| machine | logical | decodeCores | threads |
|---|---|---|---|
| GitHub `windows-latest` runner | 2 | 2 | **1** |
| 4C/8T i5 laptop (the audience) | 8 | 4 | **2** |
| 6C/12T | 12 | 6 | **4** |
| 8P+16E i9 | 24 | 12 | **8** (capped) |
| 16C/32T desktop | 32 | 16 | **8** (capped) |

A test asserts threads never exceed the physical core count on any of these.

**Known imprecision, stated rather than hidden.** Halving is a heuristic: it is exactly
right for SMT and conservative for hybrid parts, where 8P+16E has 24 physical cores and
this rule assumes 12. The *correct* source is already in place and unused —
`kotiba-stt.exe` reports true `physicalCores` and `performanceCores` from
`GetLogicalProcessorInformationEx` in its `hello` response (`main.cpp:detectCores`). It is
not consumed because `WhisperParams` is fixed when the engine is constructed and the host
has not spoken yet. If this rule is ever measured and found wanting, feeding that number
in is the fix, and the number is already on the wire.

### 2.3 `n_threads` is never 0 on the wire

macOS `Options.threads = 0` means "decide from the machine" and nothing in Kotiba ever sets
it. Windows honours the same sentinel but always resolves it before sending, so the host
receives a real count. Tested across `cpuCount` 0, 1, 2, 3, 4 and 100.

---

## 3. The fields Kotiba sets

| field | Swift | Windows | where | note |
|---|---|---|---|---|
| `print_realtime` | `false` | `false` | Swift `:222` · `params.ts`, `main.cpp` | |
| `print_progress` | `false` | `false` | Swift `:223` | whisper's own default is **TRUE** — changed |
| `print_timestamps` | `false` | `false` | Swift `:224` | whisper's own default is **TRUE** — changed |
| `print_special` | `false` | `false` | Swift `:225` | |
| `no_timestamps` | `true` | `true` | Swift `:226` | whisper's default is `false` — changed |
| `translate` | `false` | `false` | Swift `:227` | **NEVER** true. A live test asserts Uzbek does not come back as English |
| `single_segment` | `false` | `false` | Swift `:229` | |
| `suppress_blank` | `true` | `true` | Swift `:230` | |
| `no_speech_thold` | `0.6f` | `0.6` | Swift `:231` · `params.ts` | permanently 0.6; no settings control exists on either side |
| `n_threads` | see §2.2 | see §2.2 | Swift `:232-234` | overrides whisper's `min(4, hardware_concurrency)` |
| `language` | `Language.rawValue` — `en`/`ru`/`uz` | identical strings | Swift `:263-264` · `stt-engine.ts` | **always pinned**, see §5 |
| `detect_language` | `false` | `false` | Swift `:265` | **NEVER** true. The router already decided |
| `initial_prompt` | the prompt when non-nil **and non-empty**, else `nullptr` | identical; `""` is normalised to `null` so only one form crosses the wire | Swift `:268-272` · `params.ts`, `main.cpp` | `null` and `""` are different instructions to a decoder |

### Where `initial_prompt`'s value comes from, and why the two sides differ in shape

The **value** is `Vocabulary.hint(for:)` on both sides — terms joined by `", "` plus a
full stop, then the language's style exemplar; Uzbek gets the exemplar even with no terms
configured, English gets nothing without them. Its measured effect on the 344-clip Uzbek
set is in `TextPipeline.swift:112-145` and 02-BEHAVIOUR §4; the punctuation swing is 68.3%
→ 91.0%, and punctuation is also every capital after the first, because the capitaliser
finds sentence starts by looking for `.`, `!` and `?`.

**Where it is bound is a deliberate divergence.** macOS builds a whole
`WhisperEngine.Options` per language (`DictationController.swift:426-432`) and each of its
whisper engines is constructed with `supportedLanguages: [language]`
(`DictationController.swift:330-336`), so a fixed per-engine prompt is always the right
one. Windows cannot copy that: D-W2 puts **English and Russian on the same
`large-v3-turbo`**, because `SpeechTranscriber` has no Windows equivalent — so one engine
spans two languages with two different hints. The prompt is therefore resolved **per
decode**, from the live settings, by `SttEngineOptions.initialPromptFor` (`stt-engine.ts`),
which the engine manager supplies.

Two consequences worth stating:

* A Russian exemplar sentence must never precede English audio. The prompt is decoder
  *context*, so a sentence in the wrong language biases the decoder toward that language —
  for Uzbek that is the failure the whole app is built around. A per-engine prompt on the
  unified slot would have done exactly this to every English dictation.
* Editing the vocabulary does **not** rebuild an engine, and deliberately so: a rebuild
  re-reads 539 MB off disk (~7.8 s on the macOS measurement) and the vocabulary is not in
  the manager's rebuild fingerprint. The next dictation picks the new terms up on its own.

`params.initialPrompt` is still set at construction, to the engine's primary language's
hint, so a parameter dump in the diagnostics pane is not a lie about what a decode uses.

### The C-string lifetime, on both sides

`whisper_full_params.language` and `.initial_prompt` are `const char *` and the C API
**does not copy them**. Swift holds them alive with nested `withCString` scopes
(`:263`, `:269`). The C++ host holds the owning `std::string`s in the caller's scope for
the whole `whisper_full` call and stores only `c_str()` (`main.cpp:handleTranscribe`). A
dangling pointer here reads as a garbage language code, not as a crash.

---

## 4. The fields Kotiba does NOT set

Behaviour depends on every one of these. Both sides leave them at the v1.9.2 default, and
the port would move silently if a different whisper build changed them. Recorded in
`WHISPER_V192_DEFAULTS` (`src/contracts/transcript.ts`) and asserted by `params.test.ts`.

| field | v1.9.2 default | why it matters |
|---|---|---|
| `no_context` | **`true`** | past transcription is never reused as decoder context — each dictation is independent |
| `audio_ctx` | **`0`** (full 1500-frame context) | Kotiba never truncates the audio context |
| `temperature` | `0.0f` | the first rung of the fallback ladder |
| `temperature_inc` | `0.2f` | the ladder's step |
| `entropy_thold` | `2.4f` | a decoder with `result_len > 32` and entropy below this is marked failed |
| `logprob_thold` | `-1.0f` | a rung fails when `avg_logprobs < -1.0` **AND** `no_speech_prob < no_speech_thold` |
| `n_max_text_ctx` | `16384` | |
| `offset_ms` / `duration_ms` | `0` / `0` | the whole buffer, always |
| `token_timestamps` | `false` | |
| `thold_pt` / `thold_ptsum` | `0.01f` / `0.01f` | |
| `max_len` / `split_on_word` / `max_tokens` | `0` / `false` / `0` | no segment splitting |
| `debug_mode` | `false` | |
| `tdrz_enable` | `false` | no diarisation |
| `suppress_regex` | `nullptr` | |
| `carry_initial_prompt` | `false` | the prompt conditions the first window only |
| `prompt_tokens` / `prompt_n_tokens` | `nullptr` / `0` | the prompt is text, tokenised by whisper |
| `suppress_nst` | `false` | |
| `max_initial_ts` | `1.0f` | |
| `length_penalty` | `-1.0f` | |
| all six callbacks | `nullptr` | |
| grammar (`rules`/`n_rules`/`i_start_rule`/`penalty`) | `nullptr` / `0` / `0` / `100.0f` | |
| `vad` / `vad_model_path` / `vad_params` | `false` / `nullptr` / defaults | Kotiba's silence gate is upstream, on the buffer peak |

### The derived fallback ladder

From `temperature 0.0` + `temperature_inc 0.2`: **`[0.0, 0.2, 0.4, 0.6, 0.8, 1.0]`** — six
rungs, and **the last is accepted unconditionally**. Decoders per rung:

- **GREEDY** — 1 at t=0, `greedy.best_of` (= 5) at every t > 0.
- **BEAM** — `beam_search.beam_size` at t=0, `greedy.best_of` (= 5) at every t > 0.

Identical on both sides, because every input to it is identical.

## 4b. `whisper_context_params` — the load, not the decode

| field | Swift | Windows | note |
|---|---|---|---|
| `use_gpu` | `options.useGPU` (default **true**; Metal) | `settings.whisperUseGPU`, but the host links a **CPU-only** whisper.cpp, so the flag is inert | **DIFFERENT, unavoidably.** There is no Metal on Windows and D-W7's build is CPU-only. This is a hardware fact, not a decode-parity divergence: `use_gpu` changes where the tensors are multiplied, not what is decoded |
| `flash_attn` | `= options.useGPU` — tied, no separate control | tied identically | Swift `:109-110` |
| `gpu_device` | untouched → `0` | untouched → `0` | |
| DTW alignment heads | untouched → off | untouched → off | never enabled on either side |

---

## 5. The four invariants a port loses silently

Each of these is behaviour, not a struct field, and each is pinned by a named test.

### 5.1 The language is ALWAYS pinned on the transcription call

The engine never lets whisper auto-detect. Detection is a **separate pass on a separate
model** (`ggml-base-q5_1`, 59 MB), and its output goes to cluster mass, not to whisper's
own decoder.

This is not caution. A multilingual model given clean Uzbek answers **`tr 0.63 / az 0.17 /
uz 0.00`** — `uz` never wins on argmax. Letting whisper choose is how Uzbek silently
becomes Turkish, and it looks correct in every unit test that does not use real audio.

Windows: `detectLanguage` is typed `false` in the contract, sent `false` on every frame, and
the host defaults it to `false` and **refuses a `transcribe` with no language** rather than
guessing (`main.cpp`, `bad_request`). Tests: `params.test.ts` ("pins the language on every
call"), `stt-engine.test.ts`, `protocol-test.mjs`.

### 5.2 Short audio is zero-padded to one second

whisper.cpp returns **SUCCESS with zero segments** for anything under 10 mel frames, so a
short utterance becomes a silent empty transcript — the exact v1 defect this project
exists to eliminate. Pad rather than refuse: a one-word dictation is a legitimate
dictation.

Swift `WhisperEngine.swift:158-162` (and `LanguageDetector.swift:92-95`). Windows:
`padForDecode` in `params.ts`, applied by both the engine and the classifier, **and again
in the host** (`main.cpp:padForDecode`) as a backstop — a caller that forgets must still
get a transcript rather than a plausible-looking empty string.

### 5.3 Every decode is serialised through one chain per model

`whisper_full` mutates the KV cache, `state->result_all` and the logits buffers of the
context it was given. whisper.h says so in as many words: *"Not thread safe for same
context"*. Two concurrent calls are **heap corruption that presents as intermittent
garbled text, never as a crash**. A worker pool over a single context is that bug.

Swift does NOT get this from actor isolation — the heavy calls go through `Task.detached`,
which leaves the actor, and the `await` on the result is a suspension point a second caller
can enter through. The `inFlight` task chain is the guarantee (`WhisperEngine.swift:37-46`).

Windows has the same hazard for the same reason: `await` in an `async` method is the same
kind of hole, and "JavaScript is single-threaded" does not serialise anything across one.
`host-client.ts` keeps one promise chain per host, assigned before the first suspension
point so two callers cannot read the same predecessor. The host itself is a single loop, so
it cannot overlap two decodes even if a client tried.

Tested against a real child process that counts how many handlers are live at once: ten
concurrent requests, `maxInFlight=1` on every response.

### 5.4 Segments are concatenated with NO separator

whisper's segment texts carry their own leading space; joining with `' '` double-spaces
every boundary. Swift `WhisperEngine.swift:292` (`text += String(cString: segment)`).
Windows `main.cpp:handleTranscribe` (`text += segment`). The caller trims the result on
both sides.

---

## 6. Build flags — D-W7, and they are not tunable

```
GGML_NATIVE  OFF     do not compile for the build host
GGML_AVX     ON      the audience's floor
GGML_AVX2    ON      what a Tashkent i5 laptop has
GGML_AVX512  OFF     what a cloud server has and the audience does not
GGML_FMA     ON
GGML_F16C    ON
```

`GGML_NATIVE` **defaults ON**, which compiles for the CPU doing the building. This
repository has already paid for that once, as a **SIGILL (exit 132)** on a runner fleet
that served a Xeon 8573C and an AMD EPYC 7763 on consecutive runs. A shipped binary cannot
target the build machine's instruction set.

`windows/native/kotiba-stt/CMakeLists.txt` sets all six as `CACHE ... FORCE` **before**
whisper.cpp is added, because ggml reads them at configure time and a plain `set()` after
the fact is silently ignored. The recipe matches the one already proven in
`.github/workflows/windows-cpu-benchmark.yml:87-91`.

On a non-x86 target the AVX flags mean nothing and ggml ignores them; `GGML_NATIVE=OFF`
still applies, and cmake says so at configure time.

---

## 7. The wire protocol, and why a bad request cannot kill the host

```
"KSTT" <8 hex headerBytes> <8 hex payloadBytes> "\n"     — 21 bytes, fixed
<headerBytes of UTF-8 JSON>
<payloadBytes of float32, little-endian, 16 kHz mono>
```

One line of JSON comes back per request, `id` echoed, `ok` a boolean, and every failure
carrying a machine-readable `code` — **never a sentence to be matched** (D-W10).

**The length prefix is outside the JSON on purpose.** With the sample count inside the
header, a header that does not parse leaves the host unable to know how many audio bytes
follow, so it cannot resynchronise and dying is the only honest option left. Twenty-one
fixed bytes in front make "report the error and stay alive" something the code can actually
do: the declared bytes always leave the pipe, so the next frame starts where it said it
would whatever the header turned out to be.

**A crash is distinguishable from a refusal.** A refusal is a response line with
`"ok": false` from a process that is still running. A crash is the absence of any line plus
a non-zero exit, and the exit codes are enumerated:

| exit | meaning |
|---|---|
| `0` | clean shutdown, or stdin closed (the parent went away) |
| `2` | stdio could not be put into binary mode |
| `3` | the byte stream is not this protocol — unrecoverable by construction, never reached by a bad request |

Nineteen checks in `native/kotiba-stt/test/protocol-test.mjs` drive a **compiled binary**
through this, including malformed JSON mid-stream (one error line, and the *next* frame
still lands correctly), an unknown op, a payload that is not a whole number of float32
samples, and a stream that is not the protocol at all.

`_setmode(_O_BINARY)` on both stdio handles is not cosmetic on Windows: without it the CRT
translates `\n` on the way out and **eats `0x1A` in the float payload on the way in**. A
model whose weights are fine and whose audio silently truncates at the first EOF byte is a
bug that presents as bad accuracy.

---

## 8. Behaviour that is a Windows ADDITION, labelled as such

**Idle unload.** The wiring audit found `WhisperEngine.unload()` has **NO CALLER** — the
macOS app never unloads a model once loaded. So this is not parity. It is worth having
(1.1 GB of resident weights on a low-RAM laptop is not the situation an M4 Pro is in), and
it **DEFAULTS OFF**: the cost of getting it wrong is a slow dictation for a user who never
asked for the memory back.

It frees weights with `unload`, not `dispose`. Disposing shuts the member's host down for
good, so a model unloaded to reclaim memory could never come back and the press after the
timeout would *fail* rather than be slow — the opposite of the trade. A test asserts an
unloaded model transcribes again.

Not exposed as a setting: `Settings` is t05's file and adding a key is out of this task's
scope. It is configured through `createEngineManagerWith({ idleUnload })` and the
composition root (t10) can surface it when a settings key exists.

**Also not ported, because the audit found them dead:** `ModelStore.isInstalled`, `.remove`,
`.installedBytes`, `WhisperLanguageDetector.isReady` and `.unload`.

---

## 9. How to re-check any of this

```bash
bash windows/scripts/gate.sh                              # typecheck, lint, layering, every vitest suite
bash windows/native/kotiba-stt/test/run-protocol-test.sh   # 19 checks against a compiled host
# The 1.0 engines (§10–§11), from windows/, after `npm run build`:
node scripts/measure/parakeet-bench.mjs --models <dir> --manifest <set.jsonl> --out r.jsonl [--stream --pace 2]
python ../Scripts/measure/en-ru/score.py r.jsonl --sets short         # C1's scorer, unchanged
node scripts/measure/modes-compare.mjs --model <gguf> --mode message --language en scripts/measure/modes-sample.json
```

The protocol test needs only a C++17 compiler and node — no cmake, no whisper.cpp, no
539 MB model. It builds `kotiba-stt` against a **stub** whisper whose
`whisper_full_default_params` reproduces v1.9.2's one-arm-only fill, so the `best_of = 5`
assertions genuinely fail if that line is ever dropped. It is deliberately not in
`gate.sh`, which must pass on a checkout with no compiler.

**What neither of these proves:** that a real decode produces the same text. That needs the
real weights on a real Windows machine, and no one on this project has one. The first
`--check` run on a `windows-latest` runner over the committed WAV fixture is where that is
answered; this table is what makes it debuggable when the answer is no.

---

## 10. Parakeet Ultra — English and Russian (1.0)

The Mac's unified engine (C1, `ParakeetEngine.swift`) on ONNX Runtime: same weights, same
decoder, same streaming policy. Decision D-W18.

### 10.1 What is the same, and where

| piece | Mac | Windows | where (Windows) |
|---|---|---|---|
| weights | Parakeet Ultra, Core ML (FluidAudio 0.17.4) | Parakeet Ultra, **int8 ONNX** `Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx` @ `dd203225…` — C1 §8's pin, five files, sha256 each | `src/contracts/bundles.ts` `PARAKEET_ULTRA` |
| runtime | Core ML, Neural Engine | `onnxruntime-node` **1.30.0** (the ONNX Runtime C1's harness measured), CPU provider, in a **worker thread** (a load blocks its thread for ~0.8 s; the main loop stalls 6 ms) | `src/engines/parakeet-runtime.ts`, `parakeet-worker.ts` |
| front end | FluidAudio's mel | the export's own `nemo128.onnx` (128-bin log-mel) | `loadParakeetRuntime` |
| decoder | FluidAudio TDT greedy | onnx-asr 0.12's greedy TDT, ported line for line: token argmax over 8193, duration argmax over 5, blank = `<blk>`, state kept only on a non-blank, ≤ 10 symbols per frame | `src/core/stt/tdt.ts` `greedyTdt` |
| text | FluidAudio | onnx-asr's `\A\s\|\s\B\|(\s)\b` spacing, written out with Python's Unicode `\w` (JavaScript's `\b` is ASCII-only) | `piecesToText` |
| language hint | off | none exists — the decoder picks per token | — |
| written language | majority of ASCII letters vs U+0400–U+04FF | identical | `writtenLanguage` |
| short audio | padded to 1 s | padded to 1 s | `ParakeetEngine.decode` |
| decode queue | serialised | serialised (one promise chain, assigned before the first await) | `ParakeetEngine.decode` |
| streaming | `StreamSegmenter` 14 s / 6 s / 20 ms / 200 ms, latest-quietest cut | identical, pinned by tests on synthetic audio | `src/core/stt/segmenter.ts`, `ParakeetStream` |
| stream fallback | batch when a commit failed, samples were dropped, or the recording is shorter than what was committed | identical | `ParakeetStream.finish` |
| tail floor | < 0.3 s of tail is not decoded | identical | same |
| family | first in `.unified`, whisper behind it (`CompositeEngine`) | first in `unified`, whisper large-v3-turbo behind it | `manager.ts` `unifiedLead` |
| 4a relabel | written language beats the router's en/ru guess; a pin wins | identical | `session.ts` step 4a |
| first use | background download through `ModelStore`, `prepare()` throws "downloading" | identical; streamed to a temp file, hashed in the same pass | `src/engines/bundle-store.ts` |
| load budget | 1 s (a first load compiles a Neural Engine plan for ~20 s) | 15 s: an ONNX Runtime load is ~1 s every time, so waiting beats falling back to a slower whisper | `DEFAULT_PARAKEET_LOAD_BUDGET_MS` |
| idle | unloads on memory pressure only | **unloads after 15 min idle** (Windows addition) | `DEFAULT_PARAKEET_IDLE_UNLOAD_MS` |

**Two deliberate differences from onnx-asr**: `<unk>`, `<pad>` and `<|…|>` control tokens
are dropped from the text (the decoder emitted `<unk>` once in 400 FLEURS utterances,
where a comma belonged: "exhale<unk> that is"); and ONNX Runtime's pool does not spin
after a run (`session.intra_op.allow_spinning = 0`: a background app on a laptop battery).

### 10.2 Measured on this Mac (M4 Pro, CPU provider, 4 encoder threads)

Method: `windows/scripts/measure/parakeet-bench.mjs` runs the app's own compiled classes
over C1's sets (`~/code/kotib-lab/stt/sets`) and writes the rows `Scripts/measure/en-ru/score.py`
scores; the same scorer produced C1's table.

| set | engine | WER | WER-nd | punct F1 | p50 / p90 ms | load1 max |
|---|---|---|---|---|---|---|
| FLEURS en, 200 | **Windows TS engine** | **5.8** | 5.3 | 73.6 | 218 / 416 | 21.6 |
| FLEURS en, 200 | onnx-asr harness (C1 §8) | 5.8 | 5.2 | 73.8 | 500 / 935 | 46.5 |
| FLEURS ru, 200 | **Windows TS engine** | **7.3** | 6.4 | 92.5 | 246 / 478 | 16.9 |
| FLEURS ru, 200 | onnx-asr harness (C1 §8) | 7.3 | 6.5 | 92.5 | 484 / 985 | 40.8 |

Identical hypotheses to the harness: 186 of 200 (en), 189 of 200 (ru); the rest differ by
a comma or a split word — the harness ran onnx-asr 0.12's own mel front end with the Core ML
provider first in ONNX Runtime's list (partial offload), this runs the export's
`nemo128.onnx` on the CPU. Load and warm-up: 0.7–1.1 s. Resident memory with the model
loaded: ~1.1 GB after load, ~1.35 GB after a 10 s decode (prepacked int8 weights; turning
prepacking off saves ~400 MB and costs ~60 % more encoder time, so it stays on).

**Latency, same machine, quiet (load 1.6–12), 4 encoder threads, runtime in its worker thread**
(`ts-lat-*` batch, `ts-stream-*` fed in 100 ms pieces at 2× real time; `tail` = key-release →
text, the number the user waits for). Mac Core ML figures from C1 §5–§6 for comparison.

| audio | batch p50 (Windows TS, CPU) | streamed tail p50 / p90 (Windows TS, CPU) | streamed tail, Mac Core ML (C1) |
|---|---|---|---|
| 3 s | 72 ms (en), 73 ms (ru) | 82 / 96 (en), 77 / 95 (ru) | — |
| 10 s | 201 ms (en), 205 ms (ru) | 227 / 252 (en), 228 / 237 (ru) | — |
| 30–39 s | 883 ms (en), 831 ms (ru) | 200 / 221 (en), 241 / 254 (ru) | 49–169 (en), 31–178 (ru) |
| 60–70 s | 1.43 s (en), 2.35 s (ru) | 171 / 234 (en), 210 / 239 (ru) | 42–100 (en), 33–91 (ru) |
| 180–190 s | — | 256 / 288 (en), 216 / 224 (ru) | 86–140 (en), 47–71 (ru) |

The tail does not grow with the hold — the point of streaming — and stays ~2× the Mac's
Neural Engine. Streamed WER on the long sets: en 5.5 / 11.7 / 7.0 (30/60/180 s), ru 8.2 /
8.4 / 7.9, against C1's streamed Core ML 4.0 / 11.0 / 7.0 and 6.8 / 8.4 / 8.1 — n = 3 per
cell, read as "no damage". One first run of the Russian 10 s batch clips read 0.7–1.1 s
while another agent's Metal job ran; re-run quiet, 200–207 ms (the figure above).

### 10.3 Windows x64 speed — NOT measured

No Windows machine was available. The estimate, with its reasoning: the encoder is int8
`MatMulNBits`, which ONNX Runtime runs with AVX2/AVX-VNNI kernels on x86; an M4 Pro
performance core does this kind of GEMM roughly 1.5–2× faster than a Tiger Lake / Zen 3
laptop core, and `resolveOrtThreads` gives a 4C/8T laptop 4 threads, as measured here. So
**expect 2–4× the Mac figures**: ~0.4–0.9 s for a 10 s dictation in batch, and a streamed
key-release tail of ~0.3–0.8 s whatever the length (the tail is at most one ≤ 14 s window,
plus a commit in flight). A 2-core machine would be worse again. `WINDOWS-TEST-CHECKLIST.md`
§8 asks for the two numbers that settle it.

## 11. The modes on Windows (1.0)

C3 §7's recipe. Decision D-W19.

| piece | Mac | Windows | pinned by |
|---|---|---|---|
| clean-up | `DictationCleanup` | `src/core/modes/cleanup.ts` | `modes.json` — **154 of 154 rows × 2 (closed / open) byte-identical** |
| projection | `PunctuationProjection` | `src/core/modes/projection.ts` | `modes.json` 5/5 |
| splitter | `SentenceSplitter` | `src/core/modes/sentences.ts` | `modes.json` 3/3 |
| sentence guard | `SentenceGuard` over the current `PolishGuard` (refusal, echo, 0.3–1.6, overlap 0.4) | same file — its own port of the Mac's CURRENT guard; `src/core/text`'s `checkPolishGuard` predates refusal/echo/overlap | `modes.json` 5/5 |
| note layout | `NoteLayout` + model-free Note | `src/core/modes/note-layout.ts`, `src/polish/incremental.ts` | `modes.json` 4/4 |
| prompts | `OnDeviceModes` | `src/core/modes/on-device.ts` | `modes.json` → `prompts`: all 12 (4 kinds × 3 languages) — system, examples, rendered text and the ChatML head — byte-identical to what `kotiba-golden` gets by CALLING `OnDeviceModes`, plus the droppable sets and Super's model languages (`test/modes/prompts.test.ts`) |
| whole-dictation templates | `BuiltInModes` (rewritten in the project's own words, 39ef0eb) | `src/core/settings/prompts.ts` | `settings.json` → `modes[].prompt`, byte for byte (`test/settings/modes.test.ts`); the retired wording is asserted absent |
| orchestration | `IncrementalPolish`, `ModePolisher` (2 s whole-text deadline, 1.5 s tail) | `src/polish/incremental.ts` | `test/polish/incremental.test.ts` |
| model | Qwen3-1.7B Q4_K_M via llama.cpp b11249, Metal | the same GGUF (pinned, sha256) via `node-llama-cpp` 3.22.1 — Metal here, Vulkan or the CPU on Windows — in its own utility process (D-W22, §15) | `src/polish/llama.ts`, `src/polish/remote-llama.ts` |
| prompt bytes | ChatML, examples as turns, empty `<think>` block, head and turn tokenised separately, no BOS | identical — node-llama-cpp's chat wrapper is NOT used | `chatML`, `turn` |
| decoding | greedy, prompt-lookup draft 16, q8_0 K/V, 4096 context, 4 cached sequences LRU | greedy (`temperature: 0`), `InputLookupTokenPredictor` max 16, q8_0 K/V, 4096, 4 sequences LRU | — |
| idle | unload after 180 s | unload after 180 s | — |
| session | `normalise` runs clean-up for every mode but Raw; built-in modes insert once | identical (`controller.normaliserFor`, `polishPolicyFor`) | controller tests |
| incremental | IncrementalPolish exists; the Mac session does not yet feed it during capture | **fed during capture**: text the Parakeet stream commits is normalised with an open final sentence and committed; key-up hands the tail over only if the finished transcript's normalised form still starts with what was committed, else polishes the whole | `test/session/streaming.test.ts` |

**Model outputs against the Mac's** (`windows/scripts/measure/modes-compare.mjs` against
`kotiba-probe modes`, same GGUF, same inputs, commit-then-tail as the probe does it):

| corpus | rows (mode × language) | output identical | model output used in |
|---|---|---|---|
| invented sample, `scripts/measure/modes-sample.json` | 96 | **95** (the miss: one Uzbek Note heading) | 45 rows |
| the owner's real dictations, local only, never committed | 378 | **364** (super 125/126, message 125/126, note 115/126) | 181 rows |

Every miss is a near-tie broken the other way — a heading ("Bayram, zalni, tolov" against
"Bayram va zalni, oshpaz, musiqa"), one word in a Message rewrite, one comma in Super/uz.
The same Windows engine produces the Mac's heading on a second, cache-warm call: batch
composition flips it, which C3 §5 also saw between two runs on one Mac. node-llama-cpp
ships its own llama.cpp build, not b11249, so byte identity is not attainable; the guards
make either answer safe.

**Tail latency on this Mac (Metal, load 9–21)**, Windows engine / Mac engine, p50 / p90 ms:
Message en 111/289 vs 75/168, ru 149/345 vs 85/248, uz 145/427 vs 86/199; Note en 54/130
vs 54/168; Super uz 160/473 vs 78/177. The Windows path is ~1.5–2× the Mac's on the same
GPU (prompt-lookup verification batches differ); **Windows CPU/Vulkan unmeasured** — C3 §7
expects "several hundred ms" on a CPU, and the 1.5 s tail deadline bounds it: a slow
sentence goes in as spoken.

## 12. The streaming seam

`SessionDeps.audio.onChunk` (the take's live 16 kHz stream, D-W17) now feeds
`TranscriptionStream.append` for the family the press speculates on: the pinned
language's family, or — unpinned — the unified one, as on the Mac. Any engine that
implements `StreamingSttEngine.openStream` is fed with no change to the session, which is
how a streaming Uzbek engine plugs in; Uzbek is batch whisper on Windows today, so an Uzbek
pin opens nothing and costs nothing.

## 13. Streaming Uzbek (C2) on the whisper host — host 1.1

The Mac's `StreamingWhisperSession` (docs/research/C2-uzbek-latency.md) on `kotiba-stt.exe`,
decision for decision: Silero VAD cuts, 20 s minimum segments committed behind the speaker
with the full window, a speculative decode at every 0.2 s pause with a window fitted to the
audio plus 256 positions (×256), the prefix cut at release, loop retry without the carried
prompt, batch fallback whenever the stream cannot vouch for the recording.

| piece | Mac | Windows | where |
|---|---|---|---|
| segmenter + energy fallback | `SpeechSegmenter`, `EnergyFrameClassifier` | ported; the Mac's Band 1 suite ported with the same synthetic audio and the same expected cut points (19 checks) — plus one showing probabilities fed separately (the async Silero path) decide exactly as one call does | `src/core/stt/speech-segmenter.ts` |
| Silero | `whisper_vad_*` in-process, one context per dictation | the same `whisper_vad_*` and the same `ggml-silero-v6.2.0.bin` (pinned, sha256, fetched once at launch, 885 KB), in the Uzbek engine's own host, answered by its READER thread while a decode runs | `main.cpp` `vad_*`, `stt-engine.ts` `openSpeechDetector` |
| abort | `WhisperAbort`, polled by whisper | an `abort` message answered at once by the reader thread; the worker's `abort_callback` polls the flag; a queued target is dropped before it starts | `main.cpp` `handleAbort`, `AbortBook` |
| encoder window | `AudioContext.fitted(256)` / `.full` | `fittedAudioContext` → `audioCtx` on the wire → `params.audio_ctx` | `speech-segmenter.ts`, `main.cpp` `buildParams` |
| flash attention | off on the Uzbek context | off on the Uzbek context (`flashAttention: false` at load); the unified whisper keeps the GPU tie | `engine-wiring.ts` |
| beam | tail greedy, background = engine's | greedy everywhere (D-W11 already made Uzbek beam 1) | — |
| session | `StreamingWhisperSession` | `StreamingWhisperSession`; the Mac's scheduling suite ported (18 checks) | `src/engines/streaming-whisper.ts` |
| family slot | `StreamingWhisperEngine` wraps the Uzbek engine (not yet wired on the Mac) | wrapped and wired: the Uzbek family streams whenever the Silero path is known | `engine-wiring.ts`, `compose.ts` |
| which stream a press opens | unified, always | the pinned language's family, else the DEFAULT language's — one stream per press, because on a CPU a speculative Uzbek decode beside Parakeet's commits competes for the same cores | `session.ts` `openLiveStream` |

**The host is now two threads (1.1.0).** The reader handles `abort` and `vad_*` at once; the
worker runs `hello`, `load`, `unload`, `transcribe`, `detect` in arrival order, and even a
reader-level refusal (`bad_json`, `unknown_op`) is answered in order through the worker, so
every existing guarantee of §7 holds — the protocol test's 19 original checks pass unchanged,
plus 4 new ones (audioCtx, abort running, abort queued, VAD answered mid-decode). A 1.0 host
still works with the 1.1 client: `vad_open` and `abort` come back `unknown_op`, the stream
falls back to the energy gate and the full window. **Compile-checked** for
`x86_64-windows-gnu` with zig 0.14.1 against the real v1.9.2 `whisper.h` (0 warnings,
`-Wall -Wextra`), and with clang on macOS; **MSVC not verified**.

**Run on real weights, this Mac, the CPU (2 decode threads — what `resolveThreadCount` gives an
8-logical machine), host 1.1 linked against whisper.cpp v1.9.2, the real Silero**
(`windows/scripts/measure/uzbek-stream.mjs`, the app's own classes from `dist/`, chunks at real
time, load 3.6–4.3; C2's three committed fixtures):

| clip | whole decode after release | release → text, let go 0.3 s after the last word | let go on the last word |
|---|---|---|---|
| 0001 · 2.77 s | 1.33–1.60 s | 0–57 ms (speculation adopted) | 287 ms |
| 0072 · 8.81 s | 1.37–1.67 s | 96 ms (speculation adopted) | 391 ms |
| 0002 · 17.2 s | 1.70–1.74 s | 1.18–1.22 s (a speculation over 17 s still decoding at release) | 513 ms (prefix + rest) |

Texts differ from the whole decode by a word or two where the window differs (fitted vs full);
C2 §5 measured the aggregate at +0.09 to +0.40 WER on 344 clips. **On a Windows laptop CPU the
background decodes may not keep up with speech** (C2 §11): then the speculation lags and release
pays the backlog, as the 17 s row already shows at 2 threads. Measure before promising.


## 14. Packaging the engines — verified with a `--dir` pack

`electron-builder --win --x64 --dir` run on this Mac (Electron 43.4.0 win32-x64 from a local
mirror, the win-x64 node-llama-cpp prebuilts unpacked beside the Mac's), then
`scripts/verify-installer.mjs`'s native checks over `release/win-unpacked`: every one passed —
`onnxruntime.dll` (28.8 MB) and `onnxruntime_binding.node` outside `app.asar`, all of
onnxruntime-node and onnxruntime-common unpacked, the Parakeet worker's script and the pure
decoder it imports unpacked, `llama-addon.node` for the CPU and Vulkan builds unpacked, no
darwin/linux ONNX Runtime, no CUDA llama.cpp. `app.asar.unpacked` is 166 MB (ONNX Runtime
64 MB, llama.cpp CPU 29 MB + Vulkan 71 MB), `app.asar` 15 MB. Not run: the NSIS installer, and
the app itself on Windows — nothing here proves the addons LOAD on a Windows machine.

## 15. The engines in their own processes (D-W22)

`scripts/measure/engine-stall.mjs` (npm run build first), this Mac (M4 Pro, 24 GB, Metal,
Node 24.19), the pinned Qwen3-1.7B GGUF, 4 threads, three runs of each in a fresh process.
"Stall" is the longest gap between ticks of a 1 ms interval in the MAIN process while the
work ran, minus the period — what a key-up, the pill or a paste would have waited behind.

| step | in main (before) | in a child process (after) |
|---|---|---|
| key-down `prepare` of 4 prompts, cold (addon load, GGUF map, prefill) | stall **92.3 / 94.4 / 95.1 ms**, wall 1.12–1.75 s | stall **0.4 / 0.5 / 0.7 ms**, wall 1.15–1.16 s |
| first sentence (Message, 32 tokens max) | stall 0.5–0.9 ms, 82–84 ms | stall 0.3 ms, 81–84 ms |
| warm sentence | stall 0.4–1.1 ms, 83–86 ms | stall 0.3 ms, 83–87 ms |

So the process boundary removes the key-down stall and costs the warm path nothing
measurable; a cold start pays one spawn (~30 ms on this Mac) inside a load that takes a
second anyway. The ~200 ms stall reported on Windows is the same synchronous addon/backend
load on a slower CPU; **not re-measured on Windows**.

IPC for Parakeet (`--ipc`): round trip of a 16 kHz Float32Array through a forked child with
structured-clone serialisation, 40 trials each — 0.1 s: 0.036 ms median / 0.126 p90;
1 s: 0.053 / 0.065; 14 s (one streamed window): 0.273 / 0.504; 30 s: 0.373 / 0.867.

Crash isolation is tested with real processes and SIGKILL (`test/engines/engine-process.test.ts`):
a crash fails only the work in flight, the next use starts a new process (a different pid),
three crashes in five minutes keep it down, and a host that never says hello hands the work to
the in-process fallback. **Not run:** Electron's `utilityProcess` itself — no Electron binary on
this Mac (`ELECTRON_SKIP_BINARY_DOWNLOAD`) — so the app path is exercised only through the same
`EngineChannel` contract with `child_process.fork`.

## 16. Turkish and Arabic (C4, D-W24)

All numbers below: **this Mac's CPU** (M4 Pro, macOS 26.5.1, shared with other agents — 1-min load
quoted), **the Windows code path from `dist/`** (the app's own classes; decoders in a forked
engine process with the app's structured-clone channel), clips fed in 100 ms chunks at real time.
C4's sets (`Scripts/measure/tr-ar/prep.py`): 3 s cuts of FLEURS utterances, the five FLEURS
utterances nearest 10 s, and three 34–44 s joined recordings. "Release" = key-up → text, with
the user letting go 0.3 s after the last word, or ON it (trail 0). **Nothing here ran on
Windows**; CPU rows are the floor C4 §6 set (a Windows laptop without a usable GPU is expected
slower), and Vulkan was not measured.

**Arabic** — `scripts/measure/arabic-stream.mjs` (`ArabicEngine` + `StreamingWhisperSession`,
pauses from the energy gate: Silero runs in `kotiba-stt.exe`, not built for the Arabic run).

| engine, CPU threads | speed check (the app's clip, 3 runs) | release, 3 s | release, ~10 s | release, 34–44 s | load |
|---|---|---|---|---|---|
| FastConformer, 4 | — | 0 ms (trail 0: 44–61) | 0 ms (trail 0: 0–86) | 0 ms | 1.6–3.2 |
| Cohere, 4 | 673 / 685 / 673 ms; 594 / 584 / 584 → **slow** | 295–385 (trail 0: 540–598) | 1.21–2.99 s (trail 0: 1.38–3.37) | 2.16–3.88 s | 1.5–3.4 |
| Cohere, 8 | 501 / 461 / 453 ms; 540 / 526 / 522 → **slow** (by 3–72 ms) | 65–126 (trail 0: 435–521) | 0.52–1.18 s (trail 0: 0.83–1.51) | 0.71–1.58 s | 1.8–4.4 |

* **What the speed check buys.** On this CPU, at either thread count, Cohere cannot keep up with
  real-time speech: the pause decodes during the hold are ~0.15–0.2 s per second of audio, so at
  release the last one is still running and the user waits for it (1–4 s on a 10–40 s
  dictation). FastConformer finishes every pause decode inside the 0.3 s before release. Both CPU
  configurations here are demoted by the 450 ms threshold — the 8-thread one only just, and
  load-dependently (453 ms in one run, 522 in another).
* **C4 §6's CPU tails (591–628 ms) timed only the audio after the release cut** and assumed
  everything before it was decoded during the hold. With the stream fed in real time that
  assumption does not hold for Cohere on a CPU. The 3 s clip the check times therefore
  UNDER-predicts a long dictation's release on a CPU: a PC that just passes 450 ms will still
  wait ~1 s on a 10 s dictation. A lower threshold (~250–300 ms) is the orchestrator's call.
* **Accuracy on this path**, streamed text vs FLEURS references with C4's normaliser, the 8
  non-3 s clips (≈155 s of speech): Cohere **3.0 % WER / 2.9 % CER** (the three Cohere runs differed in one
  punctuation mark), FastConformer **9.3 % / 5.0 %** — the same ordering C4 §3.2 measured on 200
  utterances (7.0 vs 12.9), on far too few clips to quote as a rate.
* **FastConformer's front end** (`src/core/stt/nemo-ctc.ts`) against onnx-asr 0.12: filterbank
  within 1.5e-9 of `fbanks.npz['nemo80']`, features within 1.1e-5 of `NemoPreprocessorNumpy`, and
  the full TS pipeline's text identical to `onnx_asr.recognize` on 5/5 FLEURS clips (3–15 s).
  Mel costs 9–60 ms for 3–15 s on the main thread of the engine process.
* **Load**: Cohere 0.86–1.39 s (CPU, warm file cache), FastConformer 0.44 s. Metal was measured
  in-process only (133–158 ms for a 3 s clip, the probe in C4's numbers' range); it is not a
  Windows backend and says nothing about Vulkan.

**Arabic, second pass (C4 §14.4, wip/arabic-best)** — the same harness and clips (5 × 3 s,
5 × ~10 s, 3 × 34–45 s, trail 0.3 s), Cohere on this Mac's CPU, before (every pause restarts the
pause decode of the whole uncommitted region) and after (`coalesceSpeculations`, on exactly when
Cohere runs on the CPU: a running pause decode is never thrown away for a newer pause):

| Cohere, threads | pause decodes | speed check (faster of two) | release, 3 s | release, ~10 s | release, 34–45 s | load |
|---|---|---|---|---|---|---|
| 4 | restarted (before) | 580–596 ms → slow | 241–375 (p50 301) | 1066–2408 (p50 1751) | 2818–3355 (p50 2938) | 1.4–5.1 |
| 4 | **coalesced** | 581 ms → slow | 248–323 (p50 314) | **923–1545 (p50 1135)** | **2302–2703 (p50 2397)** | 3.5–4.5 |
| 8 | restarted | 357 ms → slow | 22–56 (p50 45) | 419–910 (p50 698) | 42–1254 (p50 1080) | 4.1–7.1 |
| 8 | coalesced | 361 ms → slow | 29–69 (p50 58) | 402–964 (p50 677) | 46–1256 (p50 1121) | 3.4–7.1 |
| FastConformer, 4 | — | — | 0 (all five) | 0 (all five) | 0 (all three) | 3.0–4.4 |

* **Coalescing is what 4 slow cores need** (~10 s: −35 % at p50; 34–45 s: −18 %); at 8 threads the
  decodes keep up either way and it changes nothing. Shorter commits were measured on the Mac
  first (§14.2: 6 s commits +1.1 WER on MSA) and on this path at 4 threads (6 s: ~10 s clips no
  better, 1086–2330 ms; long ones 221–1346 ms) — not taken: accuracy is what Cohere is for.
* **The speed check, reconsidered and kept at 300 ms.** On a CPU the release after a ~10 s
  dictation is ~1.9× the check's 3 s time (581 → 1135 ms; 357–361 → 677–698 ms), and a 3 s dictation's is
  far below it (decoded in the hold). 300 ms therefore means "about half a second after a 10 s
  dictation" — the owner's bar; both CPU configurations here stay on FastConformer. The GPU is
  already the preferred route: `whisperUseGPU` (default on) hands transcribe.cpp `auto`, which
  takes a discrete GPU, then an integrated one, before the CPU, and the verdict is kept per
  backend. Vulkan was not measured (no Windows PC, no Vulkan on macOS): the vendor's 2020 Ryzen
  4750U figure (11 s clip: 1.3 s Vulkan, 2.4 s CPU) puts an integrated GPU at ~0.35 s on the 3 s
  clip — just over the line; a discrete GPU should pass.
* **The Arabic check at key-up** (an Arabic candidate, ≥ 3.5 s, any base route) is one turbo
  encoder pass over a fitted window: 461–741 ms (p50 477) on this Mac's CPU at 4 threads and the
  same with 8 asked for (not verified that the head's own state takes the thread count; Metal
  182–286 ms, p50 183),
  for 20 candidate clips of 3.6–9 s. Only recordings that half-sound Arabic pay it — 9 % of
  Uzbek dictations of 3.5 s or more, no English or Russian.

**Turkish** — `scripts/measure/uzbek-stream.mjs --language tr` (`createSttEngineWithHost` +
`createStreamingWhisperEngine`, the real Silero), against **`kotiba-stt` compiled for macOS**
with clang against whisper.cpp v1.9.2 (the lab's build; the Windows binary itself is zig/MSVC),
turbo q5_0, greedy, flash attention off, 4 decode threads, the CPU.

| clips | whole decode after release | release, trail 0.3 s | release, trail 0 | load |
|---|---|---|---|---|
| 5 × 3 s (speech to the last sample) | 2.41–2.61 s | 383–607 ms (one 2.35 s) | 582–708 ms | 1.9–7.4 |
| 5 × ~10 s FLEURS (ending in their own silence) | 2.46–3.11 s | 0–342 ms | 0–675 ms | 2.3–6.9 |

The streamed text matched the whole-utterance decode exactly on 5 of 10 runs at trail 0.3, and
by 67–100 % of words otherwise (the fitted window, as C2 §5 found for Uzbek). C4 §6's CPU tail for
turbo on Turkish was 537–924 ms; the same order here, with the second run at load 5–7.

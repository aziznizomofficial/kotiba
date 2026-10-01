# Measuring Uzbek accuracy

Every Uzbek number this project quotes should be reproducible with a command from this directory.
That was not true before: the harness that produced the 25.19 % WER figure lived in `/tmp` on a
machine that has since been wiped, and only its *outputs* survived, in
`~/code/_archive/navo-models-evidence/`. This is that harness, rebuilt, with the ground truth
committed so it cannot be lost again.

## What it measures against

`OvozifyLabs/asr_evaluate_set` — 745 clips of real-world Uzbek, 99.9 minutes, Apache-2.0. The
medium models are scored on a deterministic 344-clip stratified subset (every digit-bearing clip
plus a seeded sample of the rest), which is 54 minutes and finishes in about four minutes per
configuration on an M4 Pro.

`data/` holds the ground truth: `refs.json` (745 reference transcripts), `meta.json` (per-clip
duration and the digit / Cyrillic / Russian-code-switch / proper-noun tags the WER is sliced by)
and `subset.json` (the 344 keys). The audio itself is not committed — `prep.py` rebuilds the WAVs
from the dataset and cross-checks all 745 references against `data/refs.json`.

Scoring goes through `uznorm.py`, a Python re-port of NavAI's `uzbek_text_norm` v0.3.0 — the
normaliser the public Uzbek leaderboard scores with, so these numbers are comparable to published
ones rather than merely internally consistent. It is not on PyPI, so it is ported here and
validated against `Tests/KotibaCoreTests/Fixtures/uzbek-normaliser-parity.json`, the same 318-pair
fixture that gates the Swift port:

```
python3 uznorm.py          # -> parity: 318/318 pass, 0 fail
```

If that does not say 318/318, nothing below means anything.

## Setup

```bash
export KOTIBA_WORK=~/.cache/kotiba-measure          # where audio, binaries and decodes live
mkdir -p "$KOTIBA_WORK"

python3 -m venv "$KOTIBA_WORK/venv"
"$KOTIBA_WORK/venv/bin/pip" install pyarrow jiwer

# The corpus, as HF save_to_disk Arrow IPC.
mkdir -p "$KOTIBA_WORK/gap01"
for f in data-00000-of-00002.arrow data-00001-of-00002.arrow; do
  curl -sL -o "$KOTIBA_WORK/gap01/$f" \
    "https://huggingface.co/datasets/OvozifyLabs/asr_evaluate_set/resolve/main/$f"
done

# whisper.cpp pinned to the version the app links (Package.swift), so decode results transfer.
git clone --depth 1 --branch v1.9.2 https://github.com/ggml-org/whisper.cpp "$KOTIBA_WORK/wcpp"
cmake -S "$KOTIBA_WORK/wcpp" -B "$KOTIBA_WORK/wcpp/build" -DCMAKE_BUILD_TYPE=Release \
      -DGGML_METAL=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
cmake --build "$KOTIBA_WORK/wcpp/build" -j 10 --target whisper-cli whisper-quantize

"$KOTIBA_WORK/venv/bin/python" prep.py             # 745 WAVs + the 344-clip subset
```

`prep.py` must print `refs match archive: 745/745`. Anything less means the corpus changed
upstream and the numbers below describe a different test set.

## The control

```bash
"$KOTIBA_WORK/venv/bin/python" sweep.py run arch
"$KOTIBA_WORK/venv/bin/python" sweep.py score arch
```

`arch` reproduces the archived measurement exactly — greedy, no prompt, `-t 8`. It must come back
at **25.19 %**. That number is the harness's own self-test; if it drifts, fix the harness before
reading anything else.

## What has been measured

All on the 344-clip subset, `ggml-navoi-medium-q5_0`, whisper.cpp v1.9.2, Metal, M4 Pro,
2026-08-11. `punc` is the share of transcripts containing `. , ? ! ; :` before any
post-processing — it matters because `Capitaliser` finds sentence boundaries by looking for it.

| variant | args | WER % | punc | decode |
|---|---|---|---|---|
| `arch` | `-bs 1` | 25.19 | 68.3 % | 243 s |
| `app` | `-bs 1 -bo 1 --prompt "Kotiba, Toshkent"` | 24.79 | 61.0 % | 237 s |
| `app-noprompt` | `-bs 1 -bo 1` | 25.19 | 68.3 % | 230 s |
| `beam5` | `-bs 5` | **24.11** | 68.6 % | 341 s |
| `beam5-prompt` | `-bs 5 --prompt "Kotiba, Toshkent"` | 23.87 | 61.3 % | 349 s |

Two conclusions, both acted on in the app:

* **`best_of` is inert.** `app-noprompt` is identical to `arch` to two decimals, because at
  temperature 0 greedy decoding is deterministic and `best_of` only bites in the temperature
  fallback passes.
* **The vocabulary hint costs punctuation.** It is the *only* difference between `app` and the
  control, and it moves punctuation emission by −7.3 points at both beam widths while moving WER
  by less than half a point. whisper conditions on `initial_prompt` as preceding text, so a bare
  comma-separated fragment is a model of unpunctuated writing.
* **Beam 5 is worth it for Uzbek.** 1.08 points, 4.3 % relative, for 1.40× the time, and it does
  not cost punctuation. `Settings.whisperBeamSize` now defaults to 5.

## The prompt's shape

The vocabulary hint reaches whisper as `initial_prompt`, which the decoder reads as *the text that
just preceded this audio* — a sample of what the transcript should look like, not a keyword list.
So the shape of the hint is a setting in its own right, and it is worth more than its contents:

| hint | WER % | punc |
|---|---|---|
| none | 25.19 | 68.3 % |
| `"Kotiba, Toshkent"` — what shipped | 24.79 | 61.0 % |
| `"Kotiba, Toshkent."` | 25.05 | 91.0 % |
| terms + one full sentence | 24.79 | **91.0 %** |
| the sentence alone, no terms | 24.95 | 88.4 % |

An unterminated fragment cost 7.3 points of punctuation against sending nothing at all; a
punctuated one gains 23. `Vocabulary.hint(for:)` builds the punctuated form now, and sends the
exemplar even when no vocabulary is set, because it earns 20 of those points on its own.

## Quantisation

```bash
"$KOTIBA_WORK/venv/bin/python" models.py
```

Needs f16 and q8_0 builds in `$KOTIBA_WORK/conv/out`. `Scripts/convert-uzbek.sh` makes the f16 from
upstream safetensors; `whisper-quantize` does the rest.

| model | build | WER % | size |
|---|---|---|---|
| `rubaistt_v2_medium` | q5_0 — as shipped | 25.19 | 539 MB |
| `rubaistt_v2_medium` | q8_0 | 24.34 | 823 MB |
| `rubaistt_v2_medium` | f16 | 24.47 | 1.53 GB |
| `Kotib/uzbek_stt_v1` | q5_0 | **21.68** | 539 MB |
| `Kotib/uzbek_stt_v1` | q8_0 | 22.28 | 823 MB |
| `Kotib/uzbek_stt_v1` + beam 5 | q8_0 | **21.58** | 823 MB |
| `Kotib/uzbek_stt_v1` + beam 5 | q5_0 | 21.65 | 539 MB |

Note what beam 5 is worth on each: 1.08 points on the shipping model, 0.03 on the candidate. Beam
search is not a free accuracy lever, it is a way of recovering from a model that is unsure — so it
pays on the weaker model and stops paying on the better one. `kotiba-probe transcribe --beam N`
measures the per-utterance cost, which is +21% on a 2.8 s clip and +39% on an 8.8 s one.

**Read the whole table before concluding anything about quantisation.** On the shipping model q8_0
looks like a clear 0.85-point win over q5_0 and is level with f16. On the candidate it is 0.60
points *worse*. The sign flips between two models on the same corpus with the same decoder, which
is what a difference below the resolution of a 344-clip test looks like — not two models with
opposite quantisation behaviour. Treat q5_0-vs-q8_0 as unresolved and do not pay 284 MB for it.

The model difference, by contrast, is 3.5 points and holds at both quantisations.

Rebuilding from upstream safetensors at the pinned revision and re-quantising to q5_0 reproduces
the shipped file's sha256 (`3740210b…`) byte for byte, which is how we know the model on disk is
not the problem.

## Input level

```bash
"$KOTIBA_WORK/venv/bin/python" levels.py    # uniform gain, and mild clipping
"$KOTIBA_WORK/venv/bin/python" crush.py     # severe flattening
```

The app warns that a peak at or above full scale means "a flattened waveform transcribes badly",
and whisper.cpp's log-mel normalisation turned out not to remove absolute level the way this
project assumed — the per-utterance maximum only sets a clamp floor at `max − 8`, it is never
subtracted. So it was worth measuring rather than asserting.

| condition | flattened samples | WER % | ru code-switch |
|---|---|---|---|
| baseline | 0 % | 25.19 | 17.31 |
| every clip × 0.1 (peak ≈ 0.08) | 0 % | 25.17 | 15.38 |
| every clip × 1.33, clamped | ~0.6 % | 25.14 | 14.42 |
| every clip × 1.72, clamped | 1.1 % | 25.20 | 16.35 |
| normalise, then × 3, clamped | 8.3 % | **26.77** | 21.15 |
| normalise, then × 8, clamped | 28.6 % | **33.54** | 26.92 |

Three things fall out:

* **A uniform gain change costs nothing.** 20 dB down is 25.17 against 25.19, which retires "the
  input was too quiet" as an explanation for anything — worth knowing, because there is a real
  dictation on record at peak 0.05.
* **Flattening is sharply non-linear.** Nothing at all up to about 1% of samples, +1.6 points at
  8%, +8.4 points at 29%. So the warning is real and was firing an order of magnitude too early:
  `DictationSession.flatteningFraction` is 2%, between the highest measured no-op and the lowest
  measured harm.
* **The first two clamped rows are not evidence about clipping**, and it took a second pass to
  notice. Multiplying by a constant only saturates clips whose peak already exceeded `1/gain`, so
  ×1.72 flattened just 1.1% of samples. `crush.py` normalises each clip to full scale *first* and
  then overdrives, which is the honest version of the test.

## Language routing

This is where the real damage was.

```bash
swift build -c release --product kotiba-probe
KOTIBA_TERSE=1 .build/release/kotiba-probe detect \
    --model "$HOME/Library/Application Support/Kotiba/models/ggml-base-q5_1.bin" \
    "$KOTIBA_WORK/gap01/wav"/*.wav > "$KOTIBA_WORK/detect/base.stdout" 2> "$KOTIBA_WORK/detect/base.stderr"
grep '^MASS' "$KOTIBA_WORK/detect/base.stderr" > "$KOTIBA_WORK/detect/base.tsv"

"$KOTIBA_WORK/venv/bin/python" detscore.py base turbo    # recall at every threshold
"$KOTIBA_WORK/venv/bin/python" misroute.py base          # and where the misses land
```

Every clip in the corpus is Uzbek, so any clip whose Turkic cluster mass falls below the
threshold is a dictation that would never reach the Uzbek model. `Scripts/Manifest.json` claimed
88 % recall at 0.05 for `ggml-base`. Measured:

| detector | recall @ 0.05 | under 2 s | @ 0.5 (the code's own default) |
|---|---|---|---|
| `ggml-base-q5_1` | **83.1 %** | **58.4 %** | 40.8 % |
| `ggml-large-v3-turbo-q5_0` | 84.4 % | 71.3 % | 48.6 % |

So one Uzbek dictation in six never reached the Uzbek model, and among clips under two seconds —
which is most dictation — two in five did not. Of those misroutes only **16 %** went to the
Russian engine, where the output is Cyrillic and `ScriptCheck.looksLikeUzbekInCyrillic` can catch
it and rerun; the other 84 % went to Apple's English engine, which answers Uzbek with plausible
Latin that no script check can tell from a real transcript.

**No threshold fixes this, because the classes overlap.** From the app's own diagnostics: English
scored cluster mass 0.230 and 0.119; real Uzbek scored 0.183 and 0.0122. Any threshold low enough
to keep the 0.0122 Uzbek also accepts both English clips, and any threshold high enough to reject
the 0.230 English also rejects the 0.183 Uzbek. Upgrading the detector to `large-v3-turbo` buys
1.3 points of recall for ~565 ms on the critical path, which is not a trade worth making.

That is why the menu bar has a language picker now, and why `LanguageProbe` — a per-speaker probe
over the same posterior, already written and tested but wired to nothing — is the next real fix.

## Would it work on Windows, with no GPU?

```bash
"$KOTIBA_WORK/venv/bin/python" ../../Scripts/measure/cpuonly.sh   # or just: bash cpuonly.sh
```

Windows has no Metal, so unless the machine has a Vulkan or CUDA GPU, whisper runs on the CPU. And
Windows has no `SpeechTranscriber`, so English would have to go through whisper too — it is the
fastest language on macOS (~0.12 s) precisely because it does not.

Measured on an M4 Pro with Metal off, which is a **best case** for a Windows laptop rather than a
representative one, with the app's own decode settings:

| clip | Uzbek, Metal | Uzbek, CPU | large-v3-turbo, CPU |
|---|---|---|---|
| 2.8 s | 785 ms | 1843 ms | 2535 ms |
| 8.8 s | 1004 ms | 2311 ms | 2841 ms |
| 17.2 s | 1848 ms | 4174 ms | 11388 ms |

A mid-range Windows laptop with no discrete GPU is another 2–4× slower again, so a three-second
Uzbek phrase lands around 4–8 seconds. That is a different product from push-to-talk, not a slower
one, and it is the number the Windows decision rests on.

### Replacing the extrapolation with a measurement

The table above crosses an architecture, which is the weakest thing in this whole directory.
`.github/workflows/windows-cpu-benchmark.yml` fixes that: it runs `base` and `small` — public models
a runner can fetch without credentials — on real Windows hardware, against the three clips in
`fixtures/`. The ratio to the same command on this Mac is the hardware factor, and it applies to the
medium models whose absolute cost is measured here. One modelling assumption instead of three, and
it needs nothing from the private model release.

Mac half, `-ng -t 4 -nf -bs 1`, median of 5, whisper.cpp v1.9.2:

| clip | audio | base q5_1 | small q5_1 | uzbek_stt_v1 q5_0 | large-v3-turbo q5_0 |
|---|---|---|---|---|---|
| 0001 | 2.77 s | 264 ms | 623 ms | 1573 ms | 2349 ms |
| 0072 | 8.81 s | 294 ms | 1288 ms | 1687 ms | 2839 ms |
| 0002 | 17.20 s | 508 ms | 1292 ms | 2146 ms | 2795 ms |

Two things about that command, both learned the hard way:

* **`-nf` is not optional.** With the temperature-fallback ladder left on, a segment is re-decoded up
  to six times whenever the entropy or logprob threshold trips — and `base` and `small` are hopeless
  at Uzbek, so they trip constantly and at rates that differ per clip and per model. The first
  attempt at this produced 864 ms for an 8.8 s clip and 6422 ms for a 17.2 s one *on the same
  model*. That measures how confused the model was, not how fast the machine is.
* **These absolutes are a floor, not a promise.** The shipping app leaves fallback enabled, so real
  dictations cost more than the `-nf` figures — the same Uzbek clips ran 1843/2311/4174 ms with it
  on. Use the `-nf` numbers for the ratio and the fallback-on numbers when quoting latency to a
  person.

Check the factor against both model sizes before trusting it. If `base` and `small` disagree
materially, it is not size-independent and that is a finding rather than a failed job.

### What it took, and what it settled

Three runs, three confounds, each invisible until the previous one was removed. Every one was an
*uncontrolled variable inside a ratio*, and two of the three were defaults nobody chose:

| # | confound | how it showed up | fix |
|---|---|---|---|
| 1 | `-t 4` on a 2-processor runner | base 10.7× vs small 14.7× — the size check failed | take threads from the machine, sweep past it |
| 2 | model load inside the timing | Windows base nearly flat at 3255/3189/4548 ms | `total - load` from whisper's own breakdown |
| 3 | ISA drift between runs | exit 132, SIGILL — AVX-512 binary on Zen 3 | `GGML_NATIVE=OFF`, AVX2 pinned, CPU in cache key |

The fleet served an Intel Xeon 8573C, an AMD EPYC 7763 and an AMD EPYC 9V74 on three consecutive
runs, which is why (3) is a standing hazard rather than a one-off.

**After the fixes, the method works.** Matched threads, compute-only, against run 31516535907
(AMD EPYC 9V74, 1 core / 2 logical):

| model | factor range | mean |
|---|---|---|
| base q5_1 | 10.5–14.4× | 12.8× |
| small q5_1 | 11.8–18.5× | 14.1× |

Divergence is now **1.11×**, down from 1.37×. The size check passes within 10%, so the confounds
were real and removing them was the whole job.

**But the platform still cannot answer the question, and no amount of method fixes that.** Two
numbers, never multiplied together:

* **The factor blends per-core speed with core count.** At `-t 2` the Mac uses two physical cores
  and the runner uses one core's two SMT threads. So "12.8×" is not "an x86 core is 12.8× slower".
* **Thread count alone is worth 1.67× on the Mac and 0.99× on the runner** — the runner gains
  nothing from a fourth thread because there is no fourth thread to gain from. A Tashkent i5 laptop
  has four physical cores; this runner has one.

So the runner is wrong in three directions at once: fewer cores than the target, a faster server
core than the target, and an ISA deliberately held down to AVX2 to match the target. Only the third
is deliberate. **It brackets the bad end — Uzbek at ~30–45 s of compute on a 1-core VM, unusable and
correctly so — and it does not estimate a laptop.**

The laptop answer needs a laptop. Until then `cpuonly.sh` on this Mac is the closest honest figure,
and it is the one to quote.

### Two things wrong with the committed numbers, on record rather than latent

**The `-t 2` medians are inflated, and that is the column the factor uses.** The two thread blocks
ran in sequence, and every unstable cell is in the first one. `0002 small` went
`44828 32979 24986 23836 23629` — settling monotonically, which is warm-up (burst credits, or
first-touch page faults on the working set), not jitter. Spreads were up to 1.90× in the `-t 2`
block and uniformly ~1.01× in the `-t 4` block that followed. So 12.8× is a slight *over*-estimate,
and the trustworthy number from that run is the within-machine thread comparison
(1.67× Mac, 0.99× runner), which is consistent across all six cells on both machines. `split.sh`
discards a warm-up pass for this reason; the workflow now does too.

**The residual 1.76× span is clip length, not model size — and it points the wrong way for
dictation.** base at `-t 2`: 14.38× at 2.77 s, 13.38× at 8.81 s, 10.52× at 17.20 s. Monotonic, and
`small` does the same. `split.sh` explains it — run it and the cause is unmissable:

| clip | audio | encode | decode | encode share of compute |
|---|---|---|---|---|
| 0001 | 2.77 s | 248 ms | 17 ms | **92.2 %** |
| 0072 | 8.81 s | 265 ms | 54 ms | 80.3 % |
| 0002 | 17.20 s | 256 ms | 358 ms | 38.4 % |

**Encode is a constant** — 248/265/256 ms for base, 754/761/772 ms for small — because whisper always
encodes a full 30-second window no matter how little audio it was given. Decode is what scales. So a
short utterance is almost entirely encode, a long one is mostly decode, and the two phases do not
share a Windows/Mac ratio. There is no single factor: there is an encode ratio and a decode ratio,
and the blend depends on utterance length. **The factor is worst for short utterances, which is what
dictation is** — so 12.8× understates the penalty for the real workload. This one survives every
caveat about the proxy, because it is a within-machine shape rather than a cross-machine ratio.

### The lead this opens, not yet taken

A 2.8-second dictation spends **92% of its compute encoding a 30-second window that is 90%
silence.** That is why Uzbek costs 1573 ms for 2.77 s of audio and only 2146 ms for 17.20 s — six
times the speech for 1.4× the time.

`audio_ctx` (`-ac N`) shrinks the encoder's mel input, and on that arithmetic it is the largest
single latency lever available for short dictation — potentially most of that 92%. It was
*previously ruled out* on the grounds that a truncated mel is out-of-distribution for the encoder
and worse for a fine-tune than for base Whisper, which is a real objection. But it was ruled out
without measurement, and the prize is now quantified rather than guessed.

The experiment is one command per setting with everything already in this directory:

```bash
"$KOTIBA_WORK/venv/bin/python" sweep.py run arch          # the 25.19% control
# then the same with -ac 500 / -ac 750 / -ac 1000 added, and compare WER against latency
```

Do not ship a reduced `audio_ctx` on the strength of the latency alone — the whole point of this
directory is that the WER has to be measured too. Two things to get right when someone does:

**Measure it per model, not in general.** `uzbek_stt_v1` is a fine-tune and is the one most likely to
degrade on a truncated context, because it has never seen one; `large-v3-turbo` is stock and most
likely to tolerate it. So this question has two different answers in this app, and the plausible
awkward outcome is that Russian benefits while Uzbek does not — which is the wrong way round, since
Uzbek is the reason the app exists. Anticipate it rather than discovering it.

**The prize is bounded by decode, so establish the ceiling before chasing it.** Encode is ~250 ms of
base's 265 ms short-clip compute, so even a perfect `audio_ctx` cannot go below the decode floor plus
whatever encode survives. For `0001` that floor was 17 ms for base and 56 ms for small. The headroom
is enormous on paper, which is exactly why the WER number decides this and the latency number does
not.

## Streaming (C2)

`stream.sh` replays the subset through `kotiba-probe stream` — the real `StreamingWhisperSession` —
and leaves transcripts where `sweep.py score` reads them; `kotiba-probe stream --realtime` measures
key-release → text. Results, method and the decisions they drove are in
`docs/research/C2-uzbek-latency.md`. Two findings change how *every* run in this directory must be
read:

* **`audio_ctx` needs a margin.** Window = audio + 0 is 30.70 %; audio + 256 positions is free.
* **Never mix encoder windows on one context with flash attention on.** whisper.cpp v1.9.2 reads
  unmasked cross-attention padding that a previous call with another window filled with the wrong
  layer's keys. A single whisper-cli process per window (as `lab` runs did) is safe; the app is not.

## Other scripts

| script | question |
|---|---|
| `models.py` | how much does q5_0 quantisation cost against q8_0 and f16? |
| `levels.py` | does clipped or very quiet input actually cost accuracy, or is the warning cosmetic? |
| `detscore.py` | detector recall at every threshold, sliced by clip duration |
| `misroute.py` | of the misroutes, which are recoverable by the script check and which are not |

`models.py` needs f16 and q8_0 builds of the Uzbek model. `Scripts/convert-uzbek.sh` produces the
f16 from upstream safetensors; `whisper-quantize` makes the rest. Rebuilding at the pinned
revision `af4601176140501f8ffbced420f6e2e23c9bb071` and re-quantising to q5_0 reproduces the
shipped file's sha256 (`3740210b…`) byte for byte, which is how we know the model on disk is not
the problem.

## Running two waves at once

`whisper-cli` writes `<input>.txt` next to each input, so two concurrent runs sharing an input
directory clobber each other. Point the second one at its own symlink farm with `SWEEP_SUB`, and
remember that the `secs` column stops being comparable across concurrent waves — they contend for
one GPU. WER does not care.

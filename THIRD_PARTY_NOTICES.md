# Third-party notices

Kotiba's own source code is released under the [MIT licence](LICENSE), Copyright (c) 2026 Aziz Nizom.
That licence covers **this repository's code only**. Everything below is somebody else's work,
distributed under its own terms, and none of it is relicensed by being listed here.

Kotiba is an independent project. It is **not affiliated with, endorsed by, or sponsored by**
KotibAI (kotib.ai), OpenAI, NVIDIA, moondream, FluidInference, Alibaba, Apple, Microsoft or any
model author named below. Product and company names are used only to say where a component
comes from.

Every licence below was read from its source (the Hugging Face model card / API or the GitHub
licence file) on 2026-09-30; the "checked" column says which. Model cards are the uploaders' own
claim: where a card and another source disagree, both are given.

How to read the tables: **Shipped** means it is inside the installer or a Kotiba-built binary.
**Downloaded** means Kotiba (or `make bootstrap`) fetches it from the source URL on first use;
it is never committed to this repository. **Modified** means the bytes are not the upstream
file.

Contents: 1 Speech and language models · 2 Native libraries · 3 Windows runtime · 4 Derived code ·
5 Data · 6 Build-time-only tooling · 7 Licence texts · 8 Adding something new

---

## 1. Speech and language models

### 1.1 Parakeet Ultra: English and Russian (CC BY 4.0, attribution required)

| | |
|---|---|
| What | Parakeet Ultra, a post-training of NVIDIA `parakeet-tdt-0.6b-v3` |
| Used for | English and Russian dictation (both macOS and Windows) |
| Licence | **Creative Commons Attribution 4.0 International (CC BY 4.0)**, <https://creativecommons.org/licenses/by/4.0/> |
| Original | NVIDIA, `nvidia/parakeet-tdt-0.6b-v3`, <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3> (card: `cc-by-4.0`) |
| Post-training | moondream, `moondream/parakeet-ultra`, <https://huggingface.co/moondream/parakeet-ultra> (card: `cc-by-4.0`) |
| macOS build (downloaded) | Core ML conversion by FluidInference, `FluidInference/parakeet-ultra-coreml`, <https://huggingface.co/FluidInference/parakeet-ultra-coreml>, pinned to revision `95eaa59a39d4394f047a4dc5cce480388a60d1b6` (card: `cc-by-4.0`) |
| Windows build (downloaded) | ONNX int8 export by Olicorne, `Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx`, <https://huggingface.co/Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx> (card: `cc-by-4.0`, base `moondream/parakeet-ultra`) |
| Modified | Yes, by others and unchanged by Kotiba: post-training (moondream), conversion to Core ML with an int8 encoder (FluidInference), export to ONNX int8 (Olicorne). Kotiba downloads these files byte for byte and verifies their sha256 (`Scripts/Manifest.json`). |

Attribution, as CC BY 4.0 section 3(a) asks: *"Parakeet Ultra" is a post-training by moondream
of NVIDIA's parakeet-tdt-0.6b-v3, licensed under CC BY 4.0. It is used here in a Core ML build
by FluidInference and an ONNX int8 export by Olicorne. Changes were made to the original
model by those parties; Kotiba makes none. No endorsement by NVIDIA, moondream, FluidInference or
Olicorne is implied.* The same line is shown in the app under Settings, About.

### 1.1a Language identification: SpeechBrain VoxLingua107 ECAPA-TDNN (Apache-2.0, modified)

| | |
|---|---|
| What | `speechbrain/lang-id-voxlingua107-ecapa`, an ECAPA-TDNN spoken-language classifier over 107 languages, by the SpeechBrain project (Jörgen Valk and Tanel Alumäe's VoxLingua107 recipe) |
| Source | <https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa>, revision `0253049ae131d6a4be1c4f0d8b0ff483a0f8c8e9` |
| Licence | **Apache License 2.0** (card: `apache-2.0`); text in [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) |
| Training data | VoxLingua107 (Valk & Alumäe, 2021), **CC BY 4.0**, <https://bark.phon.ioc.ee/voxlingua107/> |
| Used for | Which language a dictation is in (P4, D-14), both platforms |
| Shipped / downloaded | `ecapa-voxlingua107-lid-f16.mlmodel` (macOS, in the DMG) and `ecapa-voxlingua107-lid.onnx` (Windows), both from this project's model release |
| **Modified** | **Yes.** Exported by `Scripts/export-ecapa.py` into one graph from waveform to log-posteriors: SpeechBrain's STFT rewritten as a convolution with the same window and DFT basis, attentive pooling without its (all-ones) length mask, the classifier ending in log-softmax; the macOS file stores its weights as Float16. Outputs agree with SpeechBrain's own to 1e-4 (ONNX) and 2e-3 (Core ML) in probability. |

### 1.2 Uzbek: Kotib/uzbek_stt_v1 (Apache-2.0, modified)

| | |
|---|---|
| What | `Kotib/uzbek_stt_v1`, "Whisper Medium Uzbek v1 by **Kotibai & Rubai Team**" |
| Source | <https://huggingface.co/Kotib/uzbek_stt_v1> |
| Licence | **Apache License 2.0** (card: `apache-2.0`); text in [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) |
| Base model | `openai/whisper-medium` (Apache-2.0 on its Hugging Face card; MIT in OpenAI's GitHub repository) |
| Shipped / downloaded | Shipped in the macOS DMG and the Windows installer; the source weights are on Hugging Face |
| **Modified** | **Yes.** The upstream safetensors weights are converted to whisper.cpp's ggml format and quantised to q5_0 (file `ggml-uzbek-stt-v1-q5_0.bin`). The model's behaviour is not otherwise changed. |

Notes the licence does not require but a reader deserves: the card says training data is
"custom" (about 1,600 hours, not disclosed), and the accuracy figures on it (16.7 % overall WER)
are the authors' own claim. Kotiba has not verified the licence of the undisclosed training data;
the Apache-2.0 grant is the uploaders' declaration.

**Not affiliated with KotibAI (kotib.ai).** The company KotibAI is a separate organisation; this
project merely uses the model that the Kotibai & Rubai team published under Apache-2.0, and
credits them for it.

### 1.3 Language detection: Whisper base (MIT)

| | |
|---|---|
| What | `ggml-base-q5_1.bin`, OpenAI Whisper base in ggml format, q5_1 |
| Source | <https://huggingface.co/ggerganov/whisper.cpp> (card: `mit`); original <https://github.com/openai/whisper> (MIT, Copyright (c) 2022 OpenAI) |
| Note | The `openai/whisper-base` card on Hugging Face lists `apache-2.0`; the upstream GitHub repository and the ggml conversion list MIT. Both are permissive; the MIT notice below is kept. |
| Downloaded | Yes, from the URL above (sha256 in `Scripts/Manifest.json`) |
| Modified | Converted and quantised by the ggml authors, not by Kotiba |

### 1.4 Fallback engine: Whisper large-v3-turbo (MIT)

`ggml-large-v3-turbo-q5_0.bin` from <https://huggingface.co/ggerganov/whisper.cpp> (card: `mit`);
original `openai/whisper-large-v3-turbo` (card: `mit`), Copyright (c) 2022 OpenAI. Shipped in
neither installer: downloaded only when the user turns Turkish or Arabic on (D-11), as the Turkish
engine and the Arabic language check and fallback; while it is on disk it also answers Russian
if Parakeet cannot load. Its own language head settles Turkish against Uzbek (`TurkishCheck`).
Converted and quantised (q5_0) by the ggml authors.

### 1.5 On-device modes: Qwen3-1.7B (Apache-2.0)

| | |
|---|---|
| What | `Qwen3-1.7B-Q4_K_M.gguf`, the model behind Super, Message and Note |
| Source | <https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF>, pinned to revision `daeb8e2d528a760970442092f6bf1e55c3b659eb` (card: `apache-2.0`) |
| Original | Alibaba Qwen team, `Qwen/Qwen3-1.7B` (card: `apache-2.0`) |
| Downloaded | Yes (1.28 GB, automatically after setup as part of the core, or `make bootstrap`) |
| Modified | GGUF conversion and Q4_K_M quantisation by ggml-org; unchanged by Kotiba |

Apache-2.0 text: [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt). Copyright belongs to the
Qwen team; the model card names no separate NOTICE file.

### 1.6 Voice-activity detection: Silero VAD (MIT)

| | |
|---|---|
| What | `ggml-silero-v6.2.0.bin` (885 KB), Silero VAD in whisper.cpp's ggml format; the Uzbek streaming path uses it to decide where to cut and what to trim |
| Source | <https://huggingface.co/ggml-org/whisper-vad> (card: `mit`), pinned to revision `9ffd54a1e1ee413ddf265af9913beaf518d1639b`; original <https://github.com/snakers4/silero-vad> (MIT, Copyright (c) 2020-present Silero Team) |
| Shipped / downloaded | Shipped inside the macOS DMG (`Contents/Resources/models/`) and the Windows installer (`resources/models/silero-vad-v6.2.0/`); fetched again only if missing. sha256 pinned in the model catalogue on both |
| Modified | Converted by the ggml authors; unchanged by Kotiba |

### 1.7 Arabic (optional): Cohere Transcribe Arabic 07-2026 (Apache-2.0)

| | |
|---|---|
| What | `cohere-transcribe-arabic-07-2026-Q5_K_M.gguf` (1.77 GB), Arabic dictation through transcribe.cpp — only for a user who turns Arabic on |
| Source | <https://huggingface.co/handy-computer/cohere-transcribe-arabic-07-2026-gguf>, pinned to revision `5e6b33c211458ac69347d297abb6d47a250c328f` (card: `apache-2.0`), sha256 pinned in the bundle catalogue |
| Original | Cohere, `CohereLabs/cohere-transcribe-arabic-07-2026` (Apache-2.0) |
| Downloaded | Only when the user turns Arabic on (Languages page or onboarding), macOS and Windows; `make bootstrap OPTIONAL=1` |
| Modified | GGUF conversion and Q5_K_M quantisation by handy-computer; unchanged by Kotiba |

Attribution: Cohere Transcribe Arabic 07-2026, © Cohere, licensed under the Apache License 2.0
([`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)).

### 1.8 Arabic on a slower PC: NVIDIA FastConformer-Hybrid Arabic (CC BY 4.0, attribution required)

| | |
|---|---|
| What | `model.int8.onnx`, `vocab.txt`, `config.json` (132 MB), Arabic dictation on a PC whose first-run speed check finds Cohere too slow, or by the user's pick |
| Source | <https://huggingface.co/OpenVoiceOS/stt_ar_fastconformer_hybrid_large_pcd_v1.0_onnx>, pinned to revision `c5f78db4d5a8da706ab74cad73481c18b8d736b9` |
| Original | NVIDIA `stt_ar_fastconformer_hybrid_large_pcd_v1.0` (CC BY 4.0) |
| Downloaded | Yes, under the Arabic consent above, Windows |
| Modified | ONNX export and int8 quantisation by OpenVoiceOS; unchanged by Kotiba. Its log-mel front end is Kotiba's TypeScript port of onnx-asr's (MIT, section 4) |

Attribution as CC BY 4.0 §3(a) asks: "stt_ar_fastconformer_hybrid_large_pcd_v1.0" by NVIDIA,
licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0); ONNX int8 export by OpenVoiceOS.
Changes were made by those parties; Kotiba makes none. No endorsement by NVIDIA or OpenVoiceOS
is implied.

### 1.9 Arabic modes (optional): Gemma 4 E2B (Apache-2.0)

| | |
|---|---|
| What | `gemma-4-E2B-it-Q4_K_M.gguf` (3.11 GB), the model behind Super, Message and Note for **Arabic dictations only** (C4 §14.5); every other language keeps Qwen3-1.7B |
| Source | <https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF>, pinned to revision `0314792d7f1f7e229411f620751375812bb9faf2` (card: `license: apache-2.0`, `license_link: https://ai.google.dev/gemma/docs/gemma_4_license`), sha256 `740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8` pinned in the catalogues |
| Original | Google DeepMind, `google/gemma-4-E2B-it` (card: `license: apache-2.0`). Licence verified at the primary source on 2026-10-01: Google's "Gemma 4 license" page (<https://ai.google.dev/gemma/docs/gemma_4_license>) is the Apache License, Version 2.0 text, with no additional terms — unlike Gemma 1–3, which used the Gemma Terms of Use and its Prohibited Use Policy |
| Downloaded | Only when the user turns Arabic on (Languages page or onboarding), together with Arabic's engine, macOS and Windows; `make bootstrap OPTIONAL=1` |
| Modified | GGUF conversion and Q4_K_M quantisation by unsloth; unchanged by Kotiba |

Attribution: Gemma 4 E2B, © Google DeepMind, licensed under the Apache License 2.0
([`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)).

### 1.10 Considered and not shipped

Recorded so nobody assumes otherwise: Kotiba does **not** ship or download Gemma 1–3 or Gemma 4
E4B, Qwen3-4B, Qwen3.5, LFM2, GigaAM,
T-one, sherpa-onnx models, `islomov/rubaistt_v2_medium` (Apache-2.0, superseded; still named in
the legacy `Scripts/convert-uzbek.sh`), or `islomov/rubai-corrector-transcript-uz` (no licence
declared, never used).

---

## 2. Native libraries

| Component | Version | Licence | Copyright | Source |
|---|---|---|---|---|
| whisper.cpp (includes ggml) | v1.9.2 | MIT | (c) 2023-2026 The ggml authors | <https://github.com/ggml-org/whisper.cpp> |
| llama.cpp (includes ggml) | b11249 | MIT | (c) 2023-2026 The ggml authors | <https://github.com/ggml-org/llama.cpp> |
| transcribe.cpp (includes ggml, miniz) | v0.2.4 | MIT | (c) 2026 The transcribe.cpp authors; ggml (c) 2023-2026 The ggml authors; miniz (c) 2010-2014 Rich Geldreich and Tenacious Software LLC, 2013-2014 RAD Game Tools and Valve Software | <https://github.com/handy-computer/transcribe.cpp> |
| FluidAudio | 0.17.4 | Apache-2.0 | FluidInference | <https://github.com/FluidInference/FluidAudio> |
| ONNX Runtime | via `onnxruntime-node` (Windows) | MIT | (c) Microsoft Corporation | <https://github.com/microsoft/onnxruntime> |
| node-llama-cpp | (Windows) | MIT | (c) 2023 Gilad S. | <https://github.com/withcatai/node-llama-cpp> |
| transcribe.cpp (includes ggml) | 0.2.4 via `transcribe-cpp` (Windows) | MIT | (c) The transcribe.cpp authors; ggml (c) The ggml authors | <https://github.com/handy-computer/transcribe.cpp> |
| koffi | 3.3.2 (Windows) | MIT | (c) Niels Martignène | <https://github.com/Koromix/koffi> |

whisper.cpp, llama.cpp and transcribe.cpp reach the macOS app as their projects' own binary
xcframeworks (pinned in `Package.swift` with checksums; transcribe.cpp's carries its licence and
`LICENSE.ggml`, `LICENSE.miniz` inside the framework) and reach the Windows app compiled from source
(`windows/native/kotiba-stt`, whisper.cpp fetched at a pinned tag). Their MIT notice
(section 7) travels with the binaries in the installer. FluidAudio is linked into the macOS app
under Apache-2.0 ([`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)); Kotiba does not modify
it and FluidAudio's repository lists no NOTICE file.

## 3. Windows runtime

| Component | Version | Licence | Note |
|---|---|---|---|
| Electron | 43.4.0 | MIT, (c) Electron contributors, (c) 2013-2020 GitHub Inc. | <https://github.com/electron/electron> |
| Chromium and its third-party libraries | bundled in Electron | BSD-style and others, per component | Electron's distribution carries `LICENSE` and `LICENSES.chromium.html`; the installer must keep both next to the executable |
| zod | 4.1.12 | MIT | the only runtime npm dependency of the renderer/main code |

`LICENSES.chromium.html` is produced by Electron, not by Kotiba. **Not verified here:** that the
NSIS installer built by electron-builder keeps it (this build cannot run on macOS). Check that
file exists in the installed folder before publishing a Windows release.

## 4. Derived code

**onnx-asr's NeMo front end and CTC decoding.** `windows/src/core/stt/nemo-ctc.ts` (and
`tdt.ts`, for Parakeet) port parts of **onnx-asr** 0.12, <https://github.com/istupakov/onnx-asr>,
MIT, (c) Ilya Stupakov — the NumPy NeMo log-mel preprocessor and the greedy CTC decode.

**Uzbek text normaliser.** `Sources/KotibaCore/UzbekNormaliser.swift`, its Python twin
`Scripts/measure/uznorm.py` and the TypeScript port under `windows/src` are ports of
**NavAI `uzbek_text_norm` v0.3.0**, <https://github.com/NavAI-pro/uzbek-text-norm>, licensed **MIT**
(licence file read on 2026-09-30; an earlier comment in this repository said Apache-2.0, which
was wrong). The 318-pair parity fixture `Tests/KotibaCoreTests/Fixtures/uzbek-normaliser-parity.json`
is the reference implementation's output over real Uzbek text and is kept under the same terms.
Notice, reproduced as the licence requires:

> MIT License. Copyright (c) 2026 NavAI. Permission is hereby granted, free of charge, to any
> person obtaining a copy of this software and associated documentation files (the "Software"),
> to deal in the Software without restriction ... (full text in section 7.1, with this
> copyright line.)

The NavAI project asks that work using its normaliser cite "NavAI Whisper: Open Uzbek Speech
Recognition"; Kotiba's WER numbers that go through it say so.

## 5. Data

**OvozifyLabs/asr_evaluate_set**, <https://huggingface.co/datasets/OvozifyLabs/asr_evaluate_set>,
licence `apache-2.0` (dataset card). Kotiba's test suite contains one clip of it,
`Scripts/measure/fixtures/0001.wav` (also `windows/fixtures/audio/uzbek-0001.wav`), its reference
transcript, and Windows golden files derived from the corpus. These are used only to test the
software. Licence text: [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt). The English test
clip is synthesised by the macOS `say` command and the silence clip is generated; neither
contains a person's voice.

**SCOWL (Spell Checker Oriented Word Lists) 2020.12.07**, Kevin Atkinson,
<http://wordlist.aspell.net/>, shipped in the app (both platforms) as the English word list
`TranscriptCheck` reads Parakeet's transcript against: `Sources/KotibaCore/EnglishWords.swift` and
`windows/src/core/routing/english-words.ts`. **Modified:** a selection — levels 10, 20 and 35 of
the English and American word lists and the contractions, lowercase entries only, possessives
dropped, plus the word `i` — regenerated by `Scripts/english-words.py` from the release tarball
(sha256 `5587667c…`). Licence: SCOWL's own permission notice ("Permission to use, copy, modify,
distribute and sell these word lists … is hereby granted without fee, provided that the above
copyright notice appears in all copies and that both that copyright notice and this permission
notice appear in supporting documentation"). Levels 10–35 are built from Moby Words II and
Brian Kelk's UK word list (both public domain), 12dicts (public domain) and WordNet 1.6
(Princeton's notice, which requires its copyright and disclaimer on all copies) — all reproduced
in full in [`LICENSES/SCOWL.txt`](LICENSES/SCOWL.txt).

**Common Voice sentence collector** (Mozilla Common Voice), <https://github.com/common-voice/common-voice>,
`server/data/{uz,tr,ru,ar}/sentence-collector.txt` at commit `ff32a0e4ce70`, every sentence
contributed under **CC0 1.0** (public-domain dedication). Shipped in the app (both platforms) as
the Uzbek, Turkish, Russian and Arabic word lists the language decision reads transcripts against:
`Sources/KotibaCore/{Uzbek,Turkish,Russian,Arabic}Words.swift` and
`windows/src/core/routing/{uzbek,turkish,russian,arabic}-words.ts`. **Modified:** every word form,
folded (`Scripts/lexicons.py`); no sentence is shipped. No notice is required; this is a courtesy.

**FLEURS** (Google), <https://huggingface.co/datasets/google/fleurs>, **CC BY 4.0**. The Windows
installer carries a 3 s cut of one `ar_eg` test utterance, `windows/fixtures/speed-check/
arabic-speed-check.wav`, which the Arabic engine decodes once per PC to time it
(`fixtures/speed-check/README.md` names the utterance). Unmodified audio, cut to 3 s.

## 6. Build-time and test-time tooling (not distributed in the app)

The Windows app is built with npm packages listed in `windows/package-lock.json`. An audit on
2026-09-29 (`license-checker` over 423 packages) found MIT (299), ISC (39), Apache-2.0 (21),
BSD-2-Clause (12), BSD-3-Clause (11), BlueOak-1.0.0 (8), MPL-2.0 (2: `lightningcss` and its
platform binary, dev dependencies of the test runner and not part of the app), 0BSD, Python-2.0
and WTFPL. There was no GPL, AGPL or LGPL. Regenerate the list with
`cd windows && npx license-checker --production --csv` (production dependencies) or without
`--production` for everything.

macOS builds use XcodeGen (MIT) and the Swift toolchain; nothing from either ends up in the app.

## 7. Licence texts

### 7.1 MIT (whisper.cpp, llama.cpp, transcribe.cpp, ONNX Runtime, node-llama-cpp, Electron, zod, Silero VAD, OpenAI Whisper, NavAI uzbek_text_norm)

```
MIT License

Copyright (c) 2023-2026 The ggml authors          (whisper.cpp, llama.cpp, ggml)
Copyright (c) 2026 The transcribe.cpp authors     (transcribe.cpp)
Copyright (c) Microsoft Corporation               (ONNX Runtime)
Copyright (c) 2023 Gilad S.                       (node-llama-cpp)
Copyright (c) Electron contributors               (Electron)
Copyright (c) 2013-2020 GitHub Inc.               (Electron)
Copyright (c) 2020-present Silero Team            (Silero VAD)
Copyright (c) 2022 OpenAI                         (Whisper, model weights)
Copyright (c) 2026 NavAI                          (uzbek_text_norm)
Copyright (c) 2025 Colin McDonnell                (zod)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 7.2 Apache License 2.0

Full text: [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt). Applies to `Kotib/uzbek_stt_v1`,
Qwen3-1.7B, FluidAudio and the OvozifyLabs data.

### 7.3 Creative Commons Attribution 4.0 International

Applies to Parakeet Ultra (section 1.1). Full text: <https://creativecommons.org/licenses/by/4.0/legalcode>.
The attribution line to reproduce is in section 1.1.

## 8. Adding something new

Any new model, library or data file gets a row here **before it ships**: name, source URL,
licence read from the source (not from memory), whether it is modified, and what the licence
obliges. If the licence is CC BY, GPL-family, or has use restrictions (Gemma Terms, LFM Open
License), stop and decide first. Update the short form in
`Sources/KotibaUI/Panes/AboutPane.swift` and `windows/src/renderer/pages/control.ts`.

# Measuring Turkish and Arabic engines

Every number in `docs/research/C4-turkish-arabic-engine-selection.md` comes from this directory.
It is C1's method (`../en-ru/`) with the languages swapped and the engines the app cannot load
yet: `kotiba-probe`'s `Language` is en/ru/uz, so the candidates run through `bench.py`, which
drives the same runtimes the app would link — whisper.cpp v1.9.2 (the app's pin), transcribe.cpp
(GGUF, Metal or CPU) and ONNX Runtime — and writes the same JSONL rows `score.py` reads.

## Setup

```bash
export LAB=~/code/kotib-lab/tr-ar            # ~1 GB + whichever models are being measured
uv venv "$LAB/venv" --python 3.12
VIRTUAL_ENV="$LAB/venv" uv pip install transcribe-cpp soundfile numpy jiwer whisper-normalizer \
    "onnx-asr[cpu]"
# only for the fine-tunes that exist as transformers checkpoints and nothing else (engine hf):
VIRTUAL_ENV="$LAB/venv" uv pip install torch "transformers<5"

# whisper.cpp at the app's tag, for its server (keeps the model resident between clips)
git clone --depth 1 --branch v1.9.2 https://github.com/ggml-org/whisper.cpp "$LAB/wcpp"
cmake -S "$LAB/wcpp" -B "$LAB/wcpp/build" -DWHISPER_SDL2=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build "$LAB/wcpp/build" -j 8 --target whisper-server

# FLEURS test for tr_tr and ar_eg (~700 MB of tarballs; delete after prep)
for L in tr_tr ar_eg; do
  mkdir -p "$LAB/data/fleurs/$L"
  curl -sL -o "$LAB/data/fleurs/$L/test.tsv" \
    "https://huggingface.co/datasets/google/fleurs/resolve/main/data/$L/test.tsv"
  curl -sL "https://huggingface.co/datasets/google/fleurs/resolve/main/data/$L/audio/test.tar.gz" \
    | tar xz -C "$LAB/data/fleurs/$L"
done
"$LAB/venv/bin/python" prep.py --fleurs "$LAB/data/fleurs" --out "$LAB/sets" --casablanca
```

Models go in `$LAB/models` (C4 §8 lists every file with its URL, size and sha256). The baseline,
whisper large-v3-turbo q5_0, is read in place from the app's model directory.

## Running

```bash
LAB=$LAB ./run.sh turbo            # accuracy: short tr/ar, dialect ar, long tr/ar
LAB=$LAB ./run.sh cohere           # … one group per candidate (see the case list in run.sh)
LAB=$LAB ./run.sh lat-mac          # warm latency by length + streamed tail, Metal
LAB=$LAB ./run.sh lat-cpu          # the same on 4 CPU threads, no Metal: the Windows floor
"$LAB/venv/bin/python" score.py "$LAB"/results/*.jsonl --sets short,dia-egy,dia-gulf,dia-lev,dia-mag
"$LAB/venv/bin/python" compare.py "$LAB"/results/turbo-short-ar.jsonl "$LAB"/results/cohere-short-ar.jsonl
```

Do not edit `run.sh` while it runs (bash reads a script as it goes); copy it and run the copy
with `HERE=<this directory>` set.

## What makes a number valid here

* **Load travels with every latency.** Each row carries `load1`; `score.py` reports the maximum
  per group, and `run.sh` prints `uptime` before every run. The Mac is shared with other agents.
* **Warm means warm**: the model is loaded, two warm-up decodes are discarded, then each clip is
  timed. whisper numbers include one loopback HTTP round trip (~1–2 ms).
* **`--stream` is an emulation on file audio**, not a microphone: C1's segmenter cuts the clip
  where the app would commit while the key is held; only the part after the last commit is
  timed (`tail_ms`). Natively streaming models are fed 100 ms chunks and `tail_ms` is the last
  chunk plus `finalize`. Decoding keeps up with real time for every engine timed here, which is
  what makes feeding faster than real time equivalent.
* **Arabic has no case**; the case columns are blank for it. Punctuation marks include ، ؛ ؟.
* **Casablanca** (dialect set) is CC BY-NC-ND 4.0: evaluated locally, never committed or shipped.

## Arabic, the second pass (C4 §14)

Everything §14 measures runs through `kotiba-probe` (the app's own code), not `bench.py`:

```bash
python prep.py --out "$LAB/sets" --casablanca-dev           # the 8-country validation dialect set
kotiba-probe head --model ggml-large-v3-turbo-q5_0.bin --windows fit:128 --prefixes 3,0 \
             --trim-pad 300 --peak 0.3 --list clips.list --jsonl head.jsonl   # turbo's `ar` share (`av`)
kotiba-probe route-eval rows.jsonl --optional tr,ar --unfamiliar [--arabic-familiar] --matrix
kotiba-probe stream --language ar --cohere cohere.gguf --model turbo.bin [--whole] \
             [--min-segment S --max-segment S+4 --relax-after S+2] [--cohere-pnc on|off] …
kotiba-probe modes --model Qwen3-1.7B-Q4_K_M.gguf --mode super|message|note --language ar \
             [--model-everywhere] [--no-model] [--raw] corpus.json
kotiba-probe e2e --optional tr,ar [--arabic-segment S] [--arabic-familiar|--arabic-unfamiliar] \
             [--no-ar-prime-last] …
node windows/scripts/measure/arabic-stream.mjs --kind cohere --backend cpu --threads 4 \
             [--segment S] [--coalesce on|off] clip.wav …      # the Windows path, this Mac's CPU
```

Route-eval rows gain `av` (turbo's `ar` share over the clip, as the session hears it). The
Casablanca validation set is under the same licence as the test set: evaluation only, never
committed.

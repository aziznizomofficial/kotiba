# Measuring English and Russian engines

Every number in `docs/research/C1-en-ru-engine-selection.md` comes from this directory. The
Swift engines are driven by `kotiba-probe bench` (the app's own engine classes, not a copy);
the Windows candidates by `sherpa_bench.py` (sherpa-onnx and ONNX Runtime on the CPU, the
libraries the Electron port would link). Both write the same JSONL rows, and `score.py`
scores both the same way.

## Setup

```bash
export STT=~/code/kotib-lab/stt            # anywhere with ~3 GB free
mkdir -p "$STT"/{data/fleurs,results}
uv venv "$STT/venv" --python 3.12
VIRTUAL_ENV="$STT/venv" uv pip install sherpa-onnx soundfile numpy jiwer whisper-normalizer \
    "onnx-asr[cpu,hub]"

# FLEURS test, exactly as Google publishes it (~680 MB of tarballs; delete after prep).
for L in en_us ru_ru; do
  mkdir -p "$STT/data/fleurs/$L"
  curl -sL -o "$STT/data/fleurs/$L/test.tsv" \
    "https://huggingface.co/datasets/google/fleurs/resolve/main/data/$L/test.tsv"
  curl -sL "https://huggingface.co/datasets/google/fleurs/resolve/main/data/$L/audio/test.tar.gz" \
    | tar xz -C "$STT/data/fleurs/$L"
done
"$STT/venv/bin/python" prep.py --fleurs "$STT/data/fleurs" --out "$STT/sets"
```

`prep.py` builds four sets (its docstring has the details): `short` (200 distinct FLEURS
sentences per language), `long` (3 × 30 s / 60 s / 180 s per language, held-out sentences
joined with 0.4 s gaps), `latency` (3 s / 10 s / 30 s / 60 s clips), and `codeswitch` (20
Russian sentences with English terms, synthesised with `say -v Milena` — TTS, and labelled so).

## Running

```bash
swift build -c release --product kotiba-probe
P=.build/release/kotiba-probe; M="$STT/models"; S="$STT/sets"; R="$STT/results"

# The shipped engine. Downloads its 632 MB bundle into $M on first use.
$P bench --engine parakeet --variant ultra --models-root "$M" \
    --manifest "$S/short/ru.jsonl" --out "$R/ultra-short-ru.jsonl"
# The same, fed at real-time pace in 100 ms pieces as a microphone would; `tail_ms` is
# key-release → text. --pace 2 feeds twice as fast, which is equivalent while decoding keeps up.
$P bench --engine parakeet --models-root "$M" --stream --pace 2 \
    --manifest "$S/long/en.jsonl" --out "$R/ultra-stream-long-en.jsonl"
# Others: --engine apple (shipped SpeechTranscriber, en), --engine apple-dt --locale ru_RU,
# --engine whisper --model <ggml.bin>, --variant v3|v2, --hint (script filter on).

# Windows path, on the CPU:
"$STT/venv/bin/python" sherpa_bench.py --model gigaam-v3-punct --dir <sherpa model dir> \
    --manifest "$S/short/ru.jsonl" --out "$R/sherpa-gigaam-short-ru.jsonl" --threads 4

"$STT/venv/bin/python" score.py "$R"/*.jsonl --sets short,codeswitch
```

`hf_manifest.py` pins a Hugging Face Core ML directory file by file (sha256 + size at one
commit) — it generated `ModelCatalogue.parakeetUltra` and the `bundles` in
`Scripts/Manifest.json`.

## What makes a number valid here

* **Load average travels with every latency.** Every row carries `load1`; `score.py` reports
  the maximum per group. Other work on the machine moves every latency figure — this Mac was
  shared with four compiling agents while C1 was measured — and a latency without its load is
  not comparable with anything.
* **Warm means warm.** `bench` loads the model, discards two warm-up decodes, then times.
  Cold start (first load, Neural Engine plan compile) is measured separately, by deleting the
  probe's own `~/Library/Caches/kotiba-probe` and timing `prepare`.
* **FLEURS references are sometimes shorter than the audio.** A few clips carry a clause the
  transcription omits; every engine hears it and is charged the same insertions, so it raises
  every WER equally and changes no ranking. `score.py --errors N` shows the worst clips.

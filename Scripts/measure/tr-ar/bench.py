#!/usr/bin/env python3
"""Run one Turkish/Arabic candidate over a manifest and write C1-format JSONL rows.

    python bench.py --engine whisper --model ggml-large-v3-turbo-q5_0.bin \
        --manifest $LAB/sets/short/tr.jsonl --out $LAB/results/turbo-short-tr.jsonl
    python bench.py --engine tcpp --model cohere-transcribe-arabic-07-2026-Q5_K_M.gguf ...
    python bench.py --engine hf --model turkmedstt/whisper-large-v3-turkish-general ...

The rows are the ones `kotiba-probe bench` writes ({id, engine, lang, set, dur, hyp, ms,
tail_ms?, load1, rss_mb}), so `score.py` / `compare.py` read them unchanged. `kotiba-probe`
itself cannot run these: its `Language` is en/ru/uz, and adding tr/ar to it is integration,
which this slice does not do.

Engines
  whisper  whisper.cpp — the app's runtime (Package.swift pins v1.9.2; build that tag's
           `whisper-server` and pass it as --server). The model stays resident in the server; each
           clip is one POST, timed wall-clock around the request (so ~1-2 ms of loopback HTTP is in
           every number). Parameters mirror `WhisperEngine.run`: greedy, best_of 5, no timestamps,
           temperature fallback on. --cpu runs it without Metal, -t 4: the Windows floor.
  tcpp     transcribe.cpp (handy-computer, MIT) through its Python binding, GGUF weights —
           Cohere Transcribe, Nemotron streaming, Qwen3-ASR, ... Metal, or --cpu.
  onnx     onnx-asr on ONNX Runtime CPU (NeMo FastConformer exports) — the Windows path as is.
  hf       transformers on MPS, fp16 — ACCURACY ONLY, for fine-tunes with no GGUF/ggml build.
           Its latency is not the app's and is not reported.

--stream  What the app does while the key is held, emulated on file audio:
           * a model that streams natively (Nemotron, Voxtral-RT: `supports_streaming`) is fed
             100 ms chunks; `tail_ms` = last chunk + finalize — key-release to final text;
           * any other model gets C1's segmenter (the Python twin of StreamSegmenter.swift:
             commit when --commit-after seconds are pending, cut at the quietest 200 ms after
             6 s). Committed pieces are decoded "during the hold" and not timed; `tail_ms` is the
             decode of what is left at key-up. For whisper the tail uses the app's fitted encoder
             window (audio_ctx = positions + 256, rounded to 256; `WhisperEngine.AudioContext`)
             and commits use the full window, as `StreamingWhisperSession` does.
           * --pause-tail adds the app's release cut: the part up to the last >= 0.2 s pause is
             decoded "during the hold" too (as the app's speculation at that pause is), and only
             the rest is timed. `tail_s` records how much audio the tail was.
"""
import argparse
import io
import json
import os
import resource
import subprocess
import sys
import time
import urllib.request
import uuid

import numpy as np
import soundfile as sf

SR = 16_000


def segmenter_cut(pending, commit_after=14.0, earliest=6.0, frame=0.02, quiet=0.2):
    """Python twin of Sources/KotibaCore/StreamSegmenter.swift (copied from en-ru/sherpa_bench)."""
    limit = int(commit_after * SR)
    if len(pending) < limit:
        return None
    fl = max(1, int(frame * SR))
    first, last = int(earliest * SR) // fl, limit // fl
    run = max(1, int(round(quiet / frame)))
    if last - first < run:
        return first * fl
    frames = pending[first * fl: last * fl].astype(np.float64).reshape(-1, fl)
    energy = (frames ** 2).mean(axis=1)
    sums = np.convolve(energy, np.ones(run), mode="valid")
    best = len(sums) - 1 - int(np.argmin(sums[::-1]))
    return (first + best + run // 2) * fl


def last_pause(pending, min_pause=0.2, frame=0.02, earliest=1.0, min_tail=0.3):
    """Where the app's release cut would fall: the end of the last pause of at least `min_pause`
    seconds that leaves `min_tail` seconds after it. `StreamingWhisperSession` (cutAtLastPause,
    cutPause = 0.2) keeps the speculation it decoded at that pause while the key was still held
    and decodes only what follows at release. The app finds pauses with Silero VAD; this finds
    them by energy (a frame is quiet under max(-45 dBFS, the clip's 10th-percentile level + 6
    dB)), which on read FLEURS speech lands on the same word gaps. None: no usable pause."""
    fl = int(frame * SR)
    n = len(pending) // fl
    if n < 10:
        return None
    rms = np.sqrt((pending[: n * fl].astype(np.float64).reshape(n, fl) ** 2).mean(axis=1)) + 1e-9
    db = 20 * np.log10(rms)
    quiet = db < max(-45.0, np.percentile(db, 10) + 6.0)
    need = int(round(min_pause / frame))
    run, best = 0, None
    for i in range(n):
        run = run + 1 if quiet[i] else 0
        end = (i + 1) * fl
        if run >= need and end >= earliest * SR and len(pending) - end >= min_tail * SR:
            best = end - (run * fl) // 2      # cut in the middle of the pause
    return best


def trim_trailing_silence(samples, keep=0.2, frame=0.02):
    """The app never decodes the silence after the last word: Silero ends the speech 0.2 s after
    it (P2). FLEURS clips carry ~1 s of it, on which whisper writes "Altyazı M.K." — a subtitle
    credit — so an emulation that decodes it measures a failure the app does not have."""
    fl = int(frame * SR)
    n = len(samples) // fl
    if n < 10:
        return samples
    rms = np.sqrt((samples[: n * fl].astype(np.float64).reshape(n, fl) ** 2).mean(axis=1)) + 1e-9
    db = 20 * np.log10(rms)
    loud = np.nonzero(db >= max(-45.0, np.percentile(db, 10) + 6.0))[0]
    if not len(loud):
        return samples
    return samples[: min(len(samples), (loud[-1] + 1) * fl + int(keep * SR))]


def fitted_ctx(n_samples, margin=256, quantum=256, window=1500):
    """`WhisperEngine.AudioContext.fitted(margin:)`, exactly."""
    needed = (n_samples + 319) // 320 + margin
    rounded = ((needed + quantum - 1) // quantum) * quantum
    return 0 if rounded >= window else rounded


class Whisper:
    def __init__(self, a):
        self.lang = a.language
        self.port = a.port
        self.prompt = a.prompt
        args = [a.server, "-m", a.model, "--port", str(a.port), "-bo", "5", "-nt",
                "-t", str(a.threads or (4 if a.cpu else 8))]
        if a.cpu:
            args.append("-ng")
        if a.no_flash:
            args.append("-nfa")
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(600):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{a.port}/", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        self.label = ("whisper-cpu-" if a.cpu else "whisper-") + os.path.basename(a.model)

    def decode(self, samples, audio_ctx=0):
        buf = io.BytesIO()
        sf.write(buf, samples, SR, format="WAV", subtype="PCM_16")
        b = uuid.uuid4().hex
        fields = {"language": self.lang, "response_format": "json", "temperature": "0.0",
                  "temperature_inc": "0.2", "audio_ctx": str(audio_ctx)}
        if self.prompt:
            fields["prompt"] = self.prompt
        body = b"".join(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n"
                        .encode() for k, v in fields.items())
        body += (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\n"
                 f"Content-Type: audio/wav\r\n\r\n").encode() + buf.getvalue()
        body += f"\r\n--{b}--\r\n".encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/inference", data=body,
                                     headers={"Content-Type": f"multipart/form-data; boundary={b}"})
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.load(r)["text"].strip()

    def rss(self):
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(self.proc.pid)],
                             capture_output=True, text=True).stdout.strip()
        return round(int(out) / 1024) if out else -1

    def close(self):
        self.proc.terminate()


class Tcpp:
    def __init__(self, a):
        import transcribe_cpp as t
        self.t = t
        self.model = t.Model(a.model, backend="cpu" if a.cpu else "auto")
        self.session = self.model.session(n_threads=a.threads or (4 if a.cpu else 0))
        self.lang = a.lang_tag or a.language
        self.streams = self.model.capabilities.supports_streaming
        self.label = ("tcpp-cpu-" if a.cpu else "tcpp-") + os.path.basename(a.model)

    def decode(self, samples, audio_ctx=0):
        return self.session.run(samples.astype(np.float32), language=self.lang).text.strip()

    def native_stream(self, samples):
        chunk = SR // 10
        with self.session.stream(language=self.lang) as s:
            for off in range(0, len(samples) - chunk, chunk):
                s.feed(samples[off: off + chunk].astype(np.float32))
            t = time.perf_counter()
            s.feed(samples[len(samples) - chunk:].astype(np.float32)
                   if len(samples) >= chunk else samples.astype(np.float32))
            s.finalize()
            tail = 1000 * (time.perf_counter() - t)
            return s.text().full.strip(), tail

    def rss(self):
        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20)

    def close(self):
        self.session.close()
        self.model.close()


class Onnx:
    """onnx-asr (istupakov, MIT) on ONNX Runtime's CPU provider — what `onnxruntime-node` would
    run on Windows. For NeMo CTC/TDT exports in onnx-asr's layout (model*.onnx, vocab.txt,
    config.json)."""

    def __init__(self, a):
        import onnx_asr
        import onnxruntime as ort
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = a.threads or 4
        opts.inter_op_num_threads = 1
        kind = json.load(open(os.path.join(a.model, "config.json")))["model_type"]
        quant = "int8" if a.int8 else None
        self.model = onnx_asr.load_model(kind, a.model, quantization=quant, sess_options=opts)
        self.label = f"onnx-{os.path.basename(os.path.normpath(a.model))}{'-int8' if a.int8 else ''}"

    def decode(self, samples, audio_ctx=0):
        return self.model.recognize(samples, sample_rate=SR).strip()

    def rss(self):
        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20)

    def close(self):
        pass


class HF:
    def __init__(self, a):
        import torch
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor
        self.torch = torch
        self.proc = AutoProcessor.from_pretrained(a.model)
        self.model = AutoModelForSpeechSeq2Seq.from_pretrained(
            a.model, torch_dtype=torch.float16).to("mps").eval()
        self.lang = {"tr": "turkish", "ar": "arabic"}[a.language]
        self.label = "hf-" + a.model.split("/")[-1]

    def decode(self, samples, audio_ctx=0):
        # transformers' Whisper input is one 30 s window: longer audio is cut with the same
        # segmenter the streaming emulation uses (commit at 25 s pending), never truncated.
        if len(samples) > 29 * SR:
            parts, pending = [], samples
            while (cut := segmenter_cut(pending, 25.0)) is not None:
                parts.append(self.decode(pending[:cut]))
                pending = pending[cut:]
            parts.append(self.decode(pending))
            return " ".join(p for p in parts if p)
        feats = self.proc(samples, sampling_rate=SR, return_tensors="pt").input_features
        with self.torch.no_grad():
            ids = self.model.generate(feats.to("mps", self.torch.float16), language=self.lang,
                                      task="transcribe", num_beams=1, max_new_tokens=440)
        return self.proc.batch_decode(ids, skip_special_tokens=True)[0].strip()

    def rss(self):
        return -1

    def close(self):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, choices=["whisper", "tcpp", "hf", "onnx"])
    ap.add_argument("--model", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--language", help="tr / ar (default: the manifest's)")
    ap.add_argument("--lang-tag", help="the engine's own tag when it is not the ISO code "
                    "(Nemotron: tr-TR, ar-AR)")
    ap.add_argument("--server", default=os.path.expanduser(
        "~/code/kotib-lab/tr-ar/wcpp/build/bin/whisper-server"))
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--no-flash", action="store_true")
    ap.add_argument("--int8", action="store_true", help="onnx: the int8 export")
    ap.add_argument("--prompt", help="whisper: initial prompt (a punctuated sentence in the "
                    "language nudges whisper to punctuate; see C4 §3)")
    ap.add_argument("--stream", action="store_true")
    ap.add_argument("--commit-after", type=float, default=14.0)
    ap.add_argument("--pause-tail", action="store_true",
                    help="--stream: also decode up to the last >=0.2 s pause during the hold, so "
                    "the timed tail is only what follows it (the app's cutAtLastPause)")
    ap.add_argument("--label")
    ap.add_argument("--limit", type=int, default=10**9)
    a = ap.parse_args()

    items = [json.loads(l) for l in open(a.manifest, encoding="utf-8")][: a.limit]
    a.language = a.language or items[0]["lang"]
    t0 = time.perf_counter()
    eng = {"whisper": Whisper, "tcpp": Tcpp, "hf": HF, "onnx": Onnx}[a.engine](a)
    load_ms = 1000 * (time.perf_counter() - t0)
    label = a.label or eng.label
    print(f"{label}: load {load_ms:.0f} ms", file=sys.stderr)

    def read(path):
        audio, sr = sf.read(path, dtype="float32", always_2d=True)
        assert sr == SR
        return audio.mean(axis=1)

    warm = read(items[0]["wav"])
    for _ in range(2):
        eng.decode(warm)

    native = a.stream and getattr(eng, "streams", False)
    with open(a.out, "w", encoding="utf-8") as out:
        for i, item in enumerate(items):
            samples = read(item["wav"])
            row = {"id": item["id"], "engine": label, "lang": item["lang"],
                   "set": item.get("set"), "dur": len(samples) / SR,
                   "load1": round(os.getloadavg()[0], 2)}
            t = time.perf_counter()
            try:
                if native:
                    text, row["tail_ms"] = eng.native_stream(samples)
                elif a.stream:
                    parts, pending = [], samples
                    if a.pause_tail:
                        pending = trim_trailing_silence(samples)
                    while (cut := segmenter_cut(pending, a.commit_after)) is not None:
                        parts.append(eng.decode(pending[:cut]))
                        pending = pending[cut:]
                    if a.pause_tail and (cut := last_pause(pending)) is not None:
                        parts.append(eng.decode(pending[:cut],
                                                audio_ctx=fitted_ctx(cut)))  # the speculation
                        pending = pending[cut:]
                    row["tail_s"] = round(len(pending) / SR, 2)
                    t_tail = time.perf_counter()
                    if len(pending) >= int(0.3 * SR):
                        parts.append(eng.decode(pending, audio_ctx=fitted_ctx(len(pending))))
                    row["tail_ms"] = 1000 * (time.perf_counter() - t_tail)
                    text = " ".join(p for p in parts if p)
                else:
                    text = eng.decode(samples)
            except Exception as e:  # a failed clip is a row with an error, never a skipped one
                text, row["error"] = "", repr(e)[:200]
            row["ms"] = 1000 * (time.perf_counter() - t)
            row["hyp"] = text
            row["rss_mb"] = eng.rss()
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            out.flush()
            if i % 25 == 0 or a.stream:
                print(f"{label} [{i + 1}/{len(items)}] {row['dur']:.1f}s → {row['ms']:.0f} ms"
                      + (f" tail {row['tail_ms']:.0f}" if "tail_ms" in row else "")
                      + f" load {row['load1']}  {text[:60]}", file=sys.stderr)
    eng.close()


if __name__ == "__main__":
    main()

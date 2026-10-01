#!/usr/bin/env python3
"""The Windows path, measured on this Mac: sherpa-onnx on the CPU.

    python sherpa_bench.py --model parakeet-v3-int8 --dir $STT/sherpa/<model dir> \
        --manifest $STT/sets/short/ru.jsonl --out results/sherpa-parakeet-short-ru.jsonl \
        [--threads 4] [--stream]

Writes the same JSONL rows as `kotiba-probe bench`, so `score.py` reads both.

The Electron port runs `sherpa-onnx-node` (prebuilt win-x64, ONNX Runtime CPU underneath); this
runs the same C++ library through its Python binding, same model files, same greedy search. An
M4 Pro's performance cores are faster than a typical Windows laptop's, so the latency here is a
*floor* for Windows, not an estimate of it — the accuracy, on the other hand, transfers exactly.

--stream reproduces what the Swift `ParakeetStream` does, on the CPU: the recording is cut with
the same `StreamSegmenter` rule (commit at 14 s pending, quietest 200 ms between 6 s and 14 s),
committed pieces are decoded "during the hold" and not timed, and `tail_ms` is the decode of
what is left at key-up. For T-one, which is a true streaming model, `tail_ms` is the last
100 ms chunk plus the final flush.
"""
import argparse
import json
import os
import time

import numpy as np
import sherpa_onnx
import soundfile as sf

SR = 16_000


def segmenter_cut(pending, commit_after=14.0, earliest=6.0, frame=0.02, quiet=0.2):
    """Python twin of Sources/KotibaCore/StreamSegmenter.swift. Keep them identical."""
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
    # Latest minimum wins, as in Swift.
    best = len(sums) - 1 - int(np.argmin(sums[::-1]))
    return (first + best + run // 2) * fl


def offline(kind, d, threads):
    if kind in ("parakeet-v3-int8", "gigaam-v3-punct"):
        enc = next(f for f in ("encoder.int8.onnx", "encoder.onnx")
                   if os.path.exists(os.path.join(d, f)))
        dec = next(f for f in ("decoder.int8.onnx", "decoder.onnx")
                   if os.path.exists(os.path.join(d, f)))
        joi = next(f for f in ("joiner.int8.onnx", "joiner.onnx")
                   if os.path.exists(os.path.join(d, f)))
        return sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=os.path.join(d, enc), decoder=os.path.join(d, dec),
            joiner=os.path.join(d, joi), tokens=os.path.join(d, "tokens.txt"),
            num_threads=threads, model_type="nemo_transducer", decoding_method="greedy_search")
    raise SystemExit(f"unknown offline model {kind}")


class OnnxAsr:
    """istupakov's onnx-asr layout (encoder-model*.onnx, decoder_joint-model*.onnx, vocab.txt,
    config.json) — the layout community exports of Parakeet Ultra ship in. Plain ONNX Runtime,
    so it is what `onnxruntime-node` would run on Windows."""

    def __init__(self, d, threads):
        import onnx_asr
        import onnxruntime as ort
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        quant = "int8" if any("int8" in f for f in os.listdir(d)) else None
        self.model = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", d, quantization=quant,
                                         sess_options=opts)

    def decode(self, samples):
        return self.model.recognize(samples, sample_rate=SR).strip()


def decode_offline(rec, samples):
    if isinstance(rec, OnnxAsr):
        return rec.decode(samples)
    s = rec.create_stream()
    s.accept_waveform(SR, samples)
    rec.decode_stream(s)
    return s.result.text.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True,
                    choices=["parakeet-v3-int8", "gigaam-v3-punct", "t-one",
                             "onnx-asr-parakeet"])
    ap.add_argument("--dir", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--stream", action="store_true")
    ap.add_argument("--limit", type=int, default=10**9)
    args = ap.parse_args()

    label = f"sherpa-{args.model}-t{args.threads}"
    t0 = time.perf_counter()
    if args.model == "t-one":
        rec = sherpa_onnx.OnlineRecognizer.from_t_one_ctc(
            tokens=os.path.join(args.dir, "tokens.txt"),
            model=os.path.join(args.dir, "model.onnx"),
            num_threads=args.threads, sample_rate=8000)
    elif args.model == "onnx-asr-parakeet":
        rec = OnnxAsr(args.dir, args.threads)
        label = f"onnx-asr-{os.path.basename(os.path.normpath(args.dir))}-t{args.threads}"
    else:
        rec = offline(args.model, args.dir, args.threads)
    load_ms = 1000 * (time.perf_counter() - t0)
    print(f"{label}: load {load_ms:.0f} ms")

    items = [json.loads(l) for l in open(args.manifest, encoding="utf-8")][: args.limit]

    def read(path):
        audio, sr = sf.read(path, dtype="float32", always_2d=True)
        assert sr == SR
        return audio.mean(axis=1)

    def run_tone(samples, time_tail):
        s = rec.create_stream()
        chunk = SR // 10
        tail_start = None
        for off in range(0, len(samples), chunk):
            if off + chunk >= len(samples):
                tail_start = time.perf_counter()
            s.accept_waveform(SR, samples[off: off + chunk])
            while rec.is_ready(s):
                rec.decode_stream(s)
        if tail_start is None:
            tail_start = time.perf_counter()
        s.accept_waveform(SR, np.zeros(int(0.3 * SR), dtype=np.float32))
        s.input_finished()
        while rec.is_ready(s):
            rec.decode_stream(s)
        return rec.get_result(s).strip(), 1000 * (time.perf_counter() - tail_start)

    # Warm-up, discarded.
    warm = read(items[0]["wav"])
    for _ in range(2):
        run_tone(warm, False) if args.model == "t-one" else decode_offline(rec, warm)

    with open(args.out, "w", encoding="utf-8") as out:
        for i, item in enumerate(items):
            samples = read(item["wav"])
            row = {"id": item["id"], "engine": label, "lang": item["lang"],
                   "set": item.get("set"), "dur": len(samples) / SR,
                   "load1": round(os.getloadavg()[0], 2), "rss_mb": -1}
            t = time.perf_counter()
            if args.model == "t-one":
                text, tail = run_tone(samples, True)
                row["ms"] = 1000 * (time.perf_counter() - t)
                if args.stream:
                    row["tail_ms"] = tail
            elif args.stream:
                parts, pending = [], samples
                while (cut := segmenter_cut(pending)) is not None:
                    parts.append(decode_offline(rec, pending[:cut]))
                    pending = pending[cut:]
                t_tail = time.perf_counter()
                if len(pending) >= int(0.3 * SR):
                    parts.append(decode_offline(rec, pending))
                row["tail_ms"] = 1000 * (time.perf_counter() - t_tail)
                row["ms"] = 1000 * (time.perf_counter() - t)
                text = " ".join(p for p in parts if p)
            else:
                text = decode_offline(rec, samples)
                row["ms"] = 1000 * (time.perf_counter() - t)
            row["hyp"] = text
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            if i % 25 == 0 or args.stream:
                print(f"{label} [{i + 1}/{len(items)}] {row['dur']:.1f}s → {row['ms']:.0f} ms"
                      + (f" tail {row['tail_ms']:.0f} ms" if "tail_ms" in row else "")
                      + f"  {text[:70]}")


if __name__ == "__main__":
    main()

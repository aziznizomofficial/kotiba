#!/usr/bin/env python3
"""Build the Turkish/Arabic test sets every C4 number is measured on.

    python prep.py --fleurs "$LAB/data/fleurs" --out "$LAB/sets" [--casablanca]

The method is C1's (`Scripts/measure/en-ru/prep.py`), with the languages swapped:

  short/<lang>.jsonl   200 FLEURS test utterances per language (tr_tr, ar_eg), one recording
                       per *sentence*, chosen by a seeded hash of the filename. `ref` is FLEURS'
                       raw transcription with its own punctuation and capitals.
  long/<lang>.jsonl    3 files each at 30 s, 60 s and 180 s of held-out FLEURS utterances joined
                       with 0.4 s of silence.
  latency/<lang>.jsonl 5 clips each at 3 s, 10 s, 30 s and 60 s, timing only.
  dialect/ar.jsonl     (--casablanca) 50 utterances each of Egyptian, Gulf (UAE), Levantine
                       (Jordan) and Maghrebi (Morocco) Arabic from the Casablanca test split
                       (UBC-NLP/Casablanca, CC BY-NC-ND 4.0: evaluation only, never
                       redistributed — the audio stays in the lab directory). Fetched clip by
                       clip through the Hugging Face datasets-server, so no 300 MB parquet shard
                       is downloaded. `set` is `dia-<dialect>`.

  dialect2/ar.jsonl    (--casablanca-dev) a second, never-tuned dialect set for the Arabic
                       detection work (C4 §14): 40 utterances from each of the EIGHT Casablanca
                       countries' *validation* split (disjoint from the test split above) —
                       Egypt; UAE and Yemen (Gulf); Jordan and Palestine (Levantine); Morocco,
                       Algeria and Mauritania (Maghrebi). Same licence, same rules.

FLEURS' Arabic is `ar_eg`: Modern Standard Arabic (Wikipedia sentences) read by Egyptian
speakers. It measures MSA dictation; the Casablanca set is what measures dialect.

Deterministic: the same inputs give the same manifests and audio (Casablanca: the same rows,
as long as the dataset revision does not change; the revision is recorded in each row).
"""
import argparse
import hashlib
import io
import json
import os
import subprocess
import urllib.request

import numpy as np
import soundfile as sf

SR = 16_000
SHORT_N = 200
DIALECTS = (("egy", "Egypt"), ("gulf", "UAE"), ("lev", "Jordan"), ("mag", "Morocco"))
DIALECT_N = 50
ROWS_API = "https://datasets-server.huggingface.co/rows?dataset=UBC-NLP/Casablanca"


def key(text):
    return hashlib.sha256(text.encode()).hexdigest()


def read_tsv(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            cols = line.rstrip("\n").split("\t")
            rows.append({"sid": cols[0], "file": cols[1], "raw": cols[2]})
    return rows


def load(path):
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    assert sr == SR, f"{path}: {sr} Hz"
    return audio.mean(axis=1)


def write(path, samples):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sf.write(path, samples, SR, subtype="PCM_16")


def dump(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"  wrote {len(rows):4d} -> {path}")


def fleurs(args):
    for lang, code in (("tr", "tr_tr"), ("ar", "ar_eg")):
        rows = read_tsv(os.path.join(args.fleurs, code, "test.tsv"))
        present = [r for r in rows
                   if os.path.exists(os.path.join(args.fleurs, code, "test", r["file"]))]
        by_sentence = {}
        for r in present:
            best = by_sentence.get(r["sid"])
            if best is None or key(r["file"]) < key(best["file"]):
                by_sentence[r["sid"]] = r
        sentences = sorted(by_sentence.values(), key=lambda r: key(r["sid"]))
        short, rest = sentences[:SHORT_N], sentences[SHORT_N:]
        print(f"{lang}: {len(rows)} rows, {len(present)} with audio, "
              f"{len(by_sentence)} sentences -> {len(short)} short, {len(rest)} held out")

        manifest = []
        for r in short:
            samples = load(os.path.join(args.fleurs, code, "test", r["file"]))
            wav = os.path.join(args.out, "short", lang, r["file"])
            write(wav, samples)
            manifest.append({"id": f"{lang}-{r['sid']}", "wav": wav, "lang": lang,
                             "ref": r["raw"], "dur": round(len(samples) / SR, 3),
                             "set": "short"})
        dump(os.path.join(args.out, "short", f"{lang}.jsonl"), manifest)

        gap = np.zeros(int(0.4 * SR), dtype=np.float32)
        pool = iter(rest)
        long_manifest = []
        for target in (30, 60, 180):
            for n in range(3):
                parts, refs, total = [], [], 0.0
                while total < target:
                    r = next(pool, None)
                    if r is None:          # Arabic has fewer held-out sentences: wrap around.
                        pool = iter(rest)
                        r = next(pool)
                    samples = load(os.path.join(args.fleurs, code, "test", r["file"]))
                    parts += [samples, gap]
                    refs.append(r["raw"])
                    total += len(samples) / SR + 0.4
                joined = np.concatenate(parts[:-1])
                wav = os.path.join(args.out, "long", lang, f"{target}s-{n}.wav")
                write(wav, joined)
                long_manifest.append({"id": f"{lang}-long{target}-{n}", "wav": wav,
                                      "lang": lang, "ref": " ".join(refs),
                                      "dur": round(len(joined) / SR, 3), "set": f"long{target}"})
        dump(os.path.join(args.out, "long", f"{lang}.jsonl"), long_manifest)

        lat = []
        for i, m in enumerate(manifest[:5]):
            samples = load(m["wav"])[: 3 * SR]
            wav = os.path.join(args.out, "latency", lang, f"3s-{i}.wav")
            write(wav, samples)
            lat.append({"id": f"{lang}-lat3-{i}", "wav": wav, "lang": lang, "ref": "",
                        "dur": 3.0, "set": "lat3"})
        near10 = sorted(manifest, key=lambda m: abs(m["dur"] - 10))[:5]
        lat += [dict(m, id=m["id"] + "-lat10", set="lat10") for m in near10]
        for target in (30, 60):
            lat += [dict(m, set=f"lat{target}") for m in long_manifest
                    if m["set"] == f"long{target}"][:5]
        dump(os.path.join(args.out, "latency", f"{lang}.jsonl"), lat)


def casablanca(args):
    out = []
    for tag, config in DIALECTS:
        # The first 300 test rows are plenty to draw 50 from; the hash picks, not the order.
        rows = []
        for offset in (0, 100, 200):
            with urllib.request.urlopen(f"{ROWS_API}&config={config}&split=test"
                                        f"&offset={offset}&length=100") as r:
                rows += json.load(r)["rows"]
        pick = [r["row"] for r in rows if 2.0 <= r["row"]["duration"] <= 20.0
                and r["row"]["transcription"].strip()]
        pick = sorted(pick, key=lambda r: key(config + r["seg_id"]))[:DIALECT_N]
        for r in pick:
            with urllib.request.urlopen(r["audio"][0]["src"]) as a:
                blob = a.read()
            pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-ac", "1",
                                  "-ar", str(SR), "-f", "wav", "pipe:1"], input=blob,
                                 capture_output=True, check=True).stdout
            samples, _ = sf.read(io.BytesIO(pcm), dtype="float32")
            wav = os.path.join(args.out, "dialect", "ar", f"{tag}-{r['seg_id']}.wav")
            write(wav, samples)
            out.append({"id": f"ar-{tag}-{r['seg_id']}", "wav": wav, "lang": "ar",
                        "ref": r["transcription"].strip(), "dur": round(len(samples) / SR, 3),
                        "set": f"dia-{tag}", "source": f"UBC-NLP/Casablanca {config} test"})
        print(f"casablanca {config}: {len(pick)} clips")
    dump(os.path.join(args.out, "dialect", "ar.jsonl"), out)


DEV_COUNTRIES = (("egy", "Egypt"), ("gulf", "UAE"), ("yem", "Yemen"), ("lev", "Jordan"),
                 ("pal", "Palestine"), ("mag", "Morocco"), ("alg", "Algeria"),
                 ("mau", "Mauritania"))
DEV_N = 40


def casablanca_dev(args):
    out = []
    for tag, config in DEV_COUNTRIES:
        rows = []
        for offset in (0, 100, 200):
            with urllib.request.urlopen(f"{ROWS_API}&config={config}&split=validation"
                                        f"&offset={offset}&length=100") as r:
                rows += json.load(r)["rows"]
        pick = [r["row"] for r in rows if 2.0 <= r["row"]["duration"] <= 20.0
                and r["row"]["transcription"].strip()]
        pick = sorted(pick, key=lambda r: key("dev" + config + r["seg_id"]))[:DEV_N]
        for r in pick:
            with urllib.request.urlopen(r["audio"][0]["src"]) as a:
                blob = a.read()
            pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-ac", "1",
                                  "-ar", str(SR), "-f", "wav", "pipe:1"], input=blob,
                                 capture_output=True, check=True).stdout
            samples, _ = sf.read(io.BytesIO(pcm), dtype="float32")
            wav = os.path.join(args.out, "dialect2", "ar", f"{tag}-{r['seg_id']}.wav")
            write(wav, samples)
            out.append({"id": f"ar2-{tag}-{r['seg_id']}", "wav": wav, "lang": "ar",
                        "ref": r["transcription"].strip(), "dur": round(len(samples) / SR, 3),
                        "set": f"dia2-{tag}",
                        "source": f"UBC-NLP/Casablanca {config} validation"})
        print(f"casablanca {config} validation: {len(pick)} clips")
    dump(os.path.join(args.out, "dialect2", "ar.jsonl"), out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fleurs")
    ap.add_argument("--out", required=True)
    ap.add_argument("--casablanca", action="store_true")
    ap.add_argument("--casablanca-dev", action="store_true")
    args = ap.parse_args()
    args.out = os.path.abspath(args.out)
    if args.fleurs:
        fleurs(args)
    if args.casablanca:
        casablanca(args)
    if args.casablanca_dev:
        casablanca_dev(args)


if __name__ == "__main__":
    main()

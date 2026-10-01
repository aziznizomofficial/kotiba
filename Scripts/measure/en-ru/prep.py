#!/usr/bin/env python3
"""Build the English/Russian test sets every C1 number is measured on.

    python prep.py --fleurs "$STT/data/fleurs" --out "$STT/sets"

`--fleurs` is a directory holding FLEURS' own test split, exactly as Google publishes it:

    <fleurs>/en_us/test.tsv   <fleurs>/en_us/test/*.wav      (data/en_us/audio/test.tar.gz)
    <fleurs>/ru_ru/test.tsv   <fleurs>/ru_ru/test/*.wav      (data/ru_ru/audio/test.tar.gz)

Four sets come out, each a JSONL manifest of {id, wav, lang, ref, dur, set}:

  short/<lang>.jsonl   200 utterances per language. FLEURS records each sentence 2-3 times by
                       different speakers; one recording per *sentence* is taken, chosen by a
                       seeded hash of the filename, so the set has 200 different texts rather
                       than 70 texts read three times. `ref` is FLEURS' raw transcription —
                       with its own punctuation and capitals, which is what lets the scorer
                       grade those too.
  long/<lang>.jsonl    3 files each at 30 s, 60 s and 180 s: consecutive held-out FLEURS
                       utterances (none of them in `short`) joined with 0.4 s of silence, and
                       their references joined with a space. Long-form WER, and the only input
                       where a 15 s-window engine has to stitch.
  latency/<lang>.jsonl 5 clips each at 3 s, 10 s, 30 s and 60 s for timing only. 3 s is the
                       first 3 s of a real utterance (its `ref` is empty: the cut lands mid-word).
  codeswitch/ru.jsonl  Russian sentences carrying English words, synthesised with macOS `say -v
                       Milena`. Synthetic speech, a Russian voice reading English words with a
                       Russian accent — which is how a Russian speaker says them, but it is still
                       TTS and is labelled so everywhere it is quoted.

Deterministic: the same inputs give byte-identical manifests and audio.
"""
import argparse
import hashlib
import json
import os
import subprocess
import tempfile

import numpy as np
import soundfile as sf

SR = 16_000
SHORT_N = 200

# Russian with English inside it, the way it is actually spoken in an office. The English words
# are the point: does the engine keep them Latin ("deploy"), transliterate them ("деплой"), or
# drop them? The reference keeps them Latin, which is what the owner wants to read.
CODESWITCH = [
    "Давай сделаем deploy сегодня вечером, после code review.",
    "Я отправил pull request, посмотри его, пожалуйста.",
    "У нас сломался backend, и frontend не получает данные.",
    "Скинь мне ссылку на Google Docs с планом на неделю.",
    "Мне нужен feedback по новому дизайну до пятницы.",
    "Открой Slack и напиши в канал про deadline.",
    "Этот баг воспроизводится только в Safari на iPhone.",
    "Давай созвонимся в Zoom в три часа и обсудим roadmap.",
    "Проверь, пожалуйста, логи на staging сервере.",
    "Мы запускаем marketing campaign в Instagram на следующей неделе.",
    "Нужно обновить README и добавить changelog.",
    "Я поставил задачу в Jira и назначил её на тебя.",
    "Клиент попросил demo нашего продукта в понедельник.",
    "Давай сделаем A/B test для новой landing page.",
    "Сохрани файл в Dropbox и дай мне доступ.",
    "Мне кажется, этот feature нужно выкатить позже.",
    "Посмотри dashboard, там упал conversion rate.",
    "Отправь invoice клиенту до конца месяца.",
    "Напиши prompt для ChatGPT, чтобы он сделал summary.",
    "Я забыл пароль от admin panel, сбрось его, пожалуйста.",
]


def read_tsv(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            cols = line.rstrip("\n").split("\t")
            rows.append({"sid": cols[0], "file": cols[1], "raw": cols[2]})
    return rows


def key(text):
    return hashlib.sha256(text.encode()).hexdigest()


def load(path):
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    assert sr == SR, f"{path}: {sr} Hz"
    return audio.mean(axis=1)


def write(path, samples):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sf.write(path, samples, SR, subtype="PCM_16")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fleurs", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    args.out = os.path.abspath(args.out)   # manifests carry absolute paths

    for lang, code in (("en", "en_us"), ("ru", "ru_ru")):
        rows = read_tsv(os.path.join(args.fleurs, code, "test.tsv"))
        present = [r for r in rows
                   if os.path.exists(os.path.join(args.fleurs, code, "test", r["file"]))]
        # One recording per sentence, the lowest seeded hash wins.
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

        # Long-form: walk the held-out sentences in order, joining until the target is passed.
        gap = np.zeros(int(0.4 * SR), dtype=np.float32)
        pool = iter(rest)
        long_manifest = []
        for target in (30, 60, 180):
            for n in range(3):
                parts, refs, total = [], [], 0.0
                while total < target:
                    r = next(pool)
                    samples = load(os.path.join(args.fleurs, code, "test", r["file"]))
                    parts += [samples, gap]
                    refs.append(r["raw"])
                    total += len(samples) / SR + 0.4
                joined = np.concatenate(parts[:-1])
                wav = os.path.join(args.out, "long", lang, f"{target}s-{n}.wav")
                write(wav, joined)
                long_manifest.append({"id": f"{lang}-long{target}-{n}", "wav": wav, "lang": lang,
                                      "ref": " ".join(refs), "dur": round(len(joined) / SR, 3),
                                      "set": f"long{target}"})
        dump(os.path.join(args.out, "long", f"{lang}.jsonl"), long_manifest)

        # Latency clips. Reuse what is already built rather than cut new audio.
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

    # Code-switched Russian, synthesised.
    cs = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, text in enumerate(CODESWITCH):
            aiff = os.path.join(tmp, f"{i}.aiff")
            subprocess.run(["say", "-v", "Milena", "-o", aiff, text], check=True)
            wav = os.path.join(args.out, "codeswitch", "ru", f"cs-{i:02d}.wav")
            os.makedirs(os.path.dirname(wav), exist_ok=True)
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", aiff, "-ac", "1",
                            "-ar", str(SR), "-c:a", "pcm_s16le", wav], check=True)
            cs.append({"id": f"ru-cs-{i:02d}", "wav": wav, "lang": "ru", "ref": text,
                       "dur": round(sf.info(wav).duration, 3), "set": "codeswitch"})
    dump(os.path.join(args.out, "codeswitch", "ru.jsonl"), cs)


def dump(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"  wrote {len(rows):4d} -> {path}")


if __name__ == "__main__":
    main()

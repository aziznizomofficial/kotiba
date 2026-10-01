#!/usr/bin/env python3
"""Is engine A really better than engine B on this set, or is it noise?

    python compare.py results/ultra-short-en.jsonl results/v2-short-en.jsonl

Paired bootstrap over utterances (both engines scored on the same resampled clips each round,
10 000 rounds, seeded): the corpus-WER difference B − A with a 95 % interval. An interval that
contains 0 means the 200-utterance set cannot tell the two apart, and the table in C1 says so
rather than ranking them.
"""
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))
import jiwer  # noqa: E402
from score import normalise  # noqa: E402

MANIFESTS = os.path.expanduser("~/code/kotib-lab/stt/sets")


def load(path, refs):
    rows = {}
    for line in open(path, encoding="utf-8"):
        r = json.loads(line)
        if r["id"] in refs and refs[r["id"]]["ref"]:
            rows[r["id"]] = normalise(r.get("hyp", ""), r["lang"])
    return rows


def counts(ref, hyp):
    out = jiwer.process_words(ref, hyp)
    return out.substitutions + out.deletions + out.insertions, len(ref.split())


def main():
    a_path, b_path = sys.argv[1:3]
    refs = {}
    for root, _, files in os.walk(os.environ.get("MANIFESTS", MANIFESTS)):
        for f in files:
            if f.endswith(".jsonl"):
                for line in open(os.path.join(root, f), encoding="utf-8"):
                    row = json.loads(line)
                    refs[row["id"]] = row
    a, b = load(a_path, refs), load(b_path, refs)
    ids = sorted(set(a) & set(b))
    lang = refs[ids[0]]["lang"]
    per = []
    for i in ids:
        ref = normalise(refs[i]["ref"], lang)
        ea, n = counts(ref, a[i])
        eb, _ = counts(ref, b[i])
        per.append((ea, eb, n))
    total = sum(n for *_, n in per)
    wa = 100 * sum(e for e, _, _ in per) / total
    wb = 100 * sum(e for _, e, _ in per) / total
    rng = random.Random(1)
    diffs = []
    for _ in range(10_000):
        sample = [per[rng.randrange(len(per))] for _ in per]
        n = sum(s[2] for s in sample)
        diffs.append(100 * (sum(s[1] for s in sample) - sum(s[0] for s in sample)) / n)
    diffs.sort()
    lo, hi = diffs[250], diffs[9750]
    verdict = "A better" if lo > 0 else "B better" if hi < 0 else "indistinguishable"
    print(f"n={len(ids)}  A={os.path.basename(a_path)} {wa:.2f}%  "
          f"B={os.path.basename(b_path)} {wb:.2f}%  B−A={wb - wa:+.2f} "
          f"[95% {lo:+.2f}, {hi:+.2f}]  → {verdict}")


if __name__ == "__main__":
    main()

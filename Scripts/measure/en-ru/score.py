#!/usr/bin/env python3
"""Score `kotiba-probe bench` / `sherpa_bench.py` output against the manifests' references.

    python score.py results/*.jsonl [--sets short,long30,...] [--csv out.csv]

Every hypothesis is scored three ways, all from the same text:

WER      Case and punctuation removed, then the *same* normaliser for every engine: Whisper's
         EnglishTextNormalizer for English (spellings, contractions, numbers-as-digits), and for
         Russian the Basic normaliser plus lowercasing and ё→е (FLEURS writes е where speakers
         and engines write ё). Corpus-level: total edits over total reference words.
WER-nd   The same, over only the utterances whose reference contains no digit. FLEURS writes
         "1980" in some references and "тысяча девятьсот" in others; an engine that is
         consistent either way is penalised on whichever form the reference did not use, and
         this column removes that noise. GigaAM's own paper scores this way.
Punct    Punctuation against the reference, *position by position*: reference and hypothesis
         words are aligned on their normalised forms, and at every aligned word pair the mark
         that follows each is compared, in three classes — none, pause (, ; : –) and stop
         (. ? !). Precision / recall / F1 of "a mark belongs here" (P/R/F1), and how often the
         class matched where both had one. Positions where the words themselves disagree are
         skipped: a misheard word says nothing about punctuation.
Case     At aligned word pairs, how often the first letter's case matches the reference
         (capitalisation accuracy), plus two whole-utterance checks a user notices at once:
         starts with a capital, ends with a stop.

Latency  p50 / p90 of `ms` (warm, model resident) and, for streamed runs, of `tail_ms`.
"""
import argparse
import collections
import glob
import json
import os
import re
import statistics
import sys
import warnings

warnings.filterwarnings("ignore", category=SyntaxWarning)
import jiwer  # noqa: E402
from whisper_normalizer.basic import BasicTextNormalizer  # noqa: E402
from whisper_normalizer.english import EnglishTextNormalizer  # noqa: E402

EN = EnglishTextNormalizer()
BASIC = BasicTextNormalizer()
STOP = set(".?!…")
PAUSE = set(",;:–—")
WORD = re.compile(r"[\w'’-]+", re.UNICODE)


def normalise(text, lang):
    if lang == "en":
        return EN(text)
    text = BASIC(text.lower()).replace("ё", "е")
    return re.sub(r"\s+", " ", text).strip()


def tokens(text):
    """(core, mark, capitalised) per word. `mark` is the class of what follows the word."""
    out = []
    for raw in text.split():
        core = "".join(WORD.findall(raw)).lower().replace("ё", "е").strip("-'’")
        tail = raw[len(raw.rstrip(".,?!;:–—…\"»)")):] if raw else ""
        mark = "stop" if any(c in STOP for c in tail) else (
            "pause" if any(c in PAUSE for c in tail) else "none")
        if not core:
            # A free-standing dash or quote: attach it to the previous word.
            if out and raw.strip() in ("–", "—", "-"):
                out[-1] = (out[-1][0], "pause" if out[-1][1] == "none" else out[-1][1],
                           out[-1][2])
            continue
        first = next((c for c in raw if c.isalpha()), "")
        out.append((core, mark, first.isupper()))
    return out


def punct_case(ref, hyp):
    r, h = tokens(ref), tokens(hyp)
    stats = collections.Counter()
    if not r or not h:
        return stats
    out = jiwer.process_words(" ".join(t[0] for t in r), " ".join(t[0] for t in h))
    for chunk in out.alignments[0]:
        if chunk.type != "equal":
            continue
        for k in range(chunk.ref_end_idx - chunk.ref_start_idx):
            rt, ht = r[chunk.ref_start_idx + k], h[chunk.hyp_start_idx + k]
            last = chunk.ref_start_idx + k == len(r) - 1
            # The final word's mark is scored separately ("ends with a stop"); here it would
            # double-count the easiest mark in every sentence.
            if not last:
                if rt[1] != "none":
                    stats["ref_marks"] += 1
                if ht[1] != "none":
                    stats["hyp_marks"] += 1
                if rt[1] != "none" and ht[1] != "none":
                    stats["hit"] += 1
                    stats["class_match"] += rt[1] == ht[1]
            stats["case_n"] += 1
            stats["case_ok"] += rt[2] == ht[2]
    stats["utts"] += 1
    stripped = hyp.strip()
    stats["starts_cap"] += bool(stripped) and next(
        (c for c in stripped if c.isalpha()), "a").isupper()
    stats["ends_stop"] += bool(stripped) and stripped.rstrip("\"»)")[-1:] in STOP
    return stats


def pct(n, d):
    return 100.0 * n / d if d else float("nan")


def p(values, q):
    if not values:
        return float("nan")
    values = sorted(values)
    return values[min(len(values) - 1, int(q * len(values)))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results", nargs="+")
    ap.add_argument("--manifests", default=os.path.expanduser("~/code/kotib-lab/stt/sets"))
    ap.add_argument("--sets", default="")
    ap.add_argument("--csv")
    ap.add_argument("--errors", type=int, default=0, help="print N worst utterances per run")
    args = ap.parse_args()

    refs = {}
    for path in glob.glob(os.path.join(args.manifests, "*", "*.jsonl")):
        for line in open(path, encoding="utf-8"):
            row = json.loads(line)
            refs[row["id"]] = row
    wanted = set(filter(None, args.sets.split(",")))

    table = []
    for path in args.results:
        rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
        groups = collections.defaultdict(list)
        for row in rows:
            ref = refs.get(row["id"])
            s = row.get("set") or (ref or {}).get("set")
            if wanted and s not in wanted:
                continue
            groups[(row["engine"], row["lang"], s)].append((row, ref))
        for (engine, lang, s), items in sorted(groups.items()):
            scored = [(r, ref) for r, ref in items if ref and ref.get("ref")]
            errors = [r for r, _ in items if r.get("error")]
            line = {"file": os.path.basename(path), "engine": engine, "lang": lang, "set": s,
                    "n": len(items), "errors": len(errors)}
            if scored:
                R = [normalise(ref["ref"], lang) for _, ref in scored]
                H = [normalise(r.get("hyp", ""), lang) for r, _ in scored]
                line["wer"] = 100 * jiwer.wer(R, H) if any(R) else float("nan")
                nd = [(a, b) for (a, b), (_, ref) in zip(zip(R, H), scored)
                      if not re.search(r"\d", ref["ref"])]
                line["wer_nd"] = 100 * jiwer.wer([a for a, _ in nd], [b for _, b in nd]) \
                    if nd else float("nan")
                st = collections.Counter()
                for r, ref in scored:
                    st += punct_case(ref["ref"], r.get("hyp", ""))
                prec, rec = pct(st["hit"], st["hyp_marks"]), pct(st["hit"], st["ref_marks"])
                line["punct_p"], line["punct_r"] = prec, rec
                line["punct_f1"] = 2 * prec * rec / (prec + rec) if prec + rec else float("nan")
                line["punct_class"] = pct(st["class_match"], st["hit"])
                line["case_acc"] = pct(st["case_ok"], st["case_n"])
                line["starts_cap"] = pct(st["starts_cap"], st["utts"])
                line["ends_stop"] = pct(st["ends_stop"], st["utts"])
                if args.errors:
                    worst = sorted(zip(R, H, scored), key=lambda t: -jiwer.wer(t[0], t[1])
                                   if t[0] else 0)[: args.errors]
                    for a, b, (r, _) in worst:
                        print(f"  [{engine} {r['id']}]\n    REF {a}\n    HYP {b}", file=sys.stderr)
            ms = [r["ms"] for r, _ in items if not r.get("error")]
            tails = [r["tail_ms"] for r, _ in items if r.get("tail_ms") is not None]
            line["ms_p50"], line["ms_p90"] = p(ms, 0.5), p(ms, 0.9)
            line["tail_p50"], line["tail_p90"] = p(tails, 0.5), p(tails, 0.9)
            line["dur_mean"] = statistics.mean(r["dur"] for r, _ in items)
            loads = [r.get("load1", -1) for r, _ in items]
            line["load1_max"] = max(loads)
            line["rss_mb"] = max(r.get("rss_mb", -1) for r, _ in items)
            table.append(line)

    cols = ["engine", "lang", "set", "n", "errors", "wer", "wer_nd", "punct_f1", "punct_p",
            "punct_r", "punct_class", "case_acc", "starts_cap", "ends_stop", "dur_mean",
            "ms_p50", "ms_p90", "tail_p50", "tail_p90", "rss_mb", "load1_max"]
    print("| " + " | ".join(cols) + " |")
    print("|" + "---|" * len(cols))
    for line in table:
        cells = []
        for c in cols:
            v = line.get(c, "")
            cells.append(f"{v:.1f}" if isinstance(v, float) else str(v))
        print("| " + " | ".join(cells) + " |")
    if args.csv:
        import csv
        with open(args.csv, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["file"] + cols)
            w.writeheader()
            for line in table:
                w.writerow({k: line.get(k, "") for k in ["file"] + cols})


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Measure Uzbek WER for a set of whisper.cpp decode configurations.

Scored with the Python re-port of uzbek_text_norm v0.3.0 in uznorm.py (318/318 parity against
the repo's reference fixture) plus jiwer, on the same 344-clip stratified subset of
OvozifyLabs/asr_evaluate_set that produced the 25.19% on record for navoi-medium. So `arch`
below should reproduce ~25.19% and anything that does not means the harness is wrong.

  python sweep.py list
  python sweep.py run  <variant> [<variant> ...]
  python sweep.py score [<variant> ...]
"""
import json
import os
import re
import subprocess
import sys
import time

import jiwer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import uznorm

WORK = os.environ.get("KOTIBA_WORK", os.path.expanduser("~/.cache/kotiba-measure"))

BASE = WORK
CLI = f"{BASE}/wcpp/build/bin/whisper-cli"
# whisper-cli writes <input>.txt next to each input, so two concurrent runs sharing an input
# directory clobber each other. SWEEP_SUB lets a second wave point at its own symlink farm.
SUB = os.environ.get("SWEEP_SUB", f"{BASE}/gap01/sub")
OUT = f"{BASE}/gap01/runs"
ARCHIVE = os.environ.get("KOTIBA_GROUND_TRUTH",
                        os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
MODELS = os.path.expanduser("~/Library/Application Support/Kotiba/models")

UZ = f"{MODELS}/ggml-navoi-medium-q5_0.bin"
REFS = json.load(open(f"{ARCHIVE}/refs.json"))
META = json.load(open(f"{ARCHIVE}/meta.json"))
SUBSET = json.load(open(f"{ARCHIVE}/subset.json"))

# The app's live vocabulary hint, verbatim from Vocabulary.hint(for:) — terms joined by ", ".
APP_PROMPT = "Kotiba, Toshkent"

VARIANTS = {
    # Reproduce the archived measurement exactly: greedy, best_of left at whisper-cli's
    # default 5, no prompt. This is the 25.19% control.
    "arch":          ["-bs", "1"],
    # Kotiba as actually shipped: greedy.best_of hard-set to 1, plus the vocabulary hint.
    "app":           ["-bs", "1", "-bo", "1", "--prompt", APP_PROMPT],
    # Isolate the two ways the app differs from the control.
    "app-noprompt":  ["-bs", "1", "-bo", "1"],
    "arch-prompt":   ["-bs", "1", "--prompt", APP_PROMPT],
    # Beam search, the obvious accuracy lever.
    "beam5":         ["-bs", "5"],
    "beam5-prompt":  ["-bs", "5", "--prompt", APP_PROMPT],
    "beam8":         ["-bs", "8"],
    # Wave 1 showed the vocabulary hint is the *only* thing that separates `app` from the control,
    # and that it drops punctuation emission from 68.3% to 61.0%. whisper conditions on the prompt
    # as preceding text, so an unpunctuated fragment is a model of unpunctuated writing. These two
    # test whether giving the hint punctuation buys it back.
    "prompt-dot":    ["-bs", "1", "--prompt", APP_PROMPT + "."],
    "prompt-sent":   ["-bs", "1", "--prompt",
                      "Kotiba, Toshkent. Bu yerda ismlar toʻgʻri yozilgan."],
    # Decoder hygiene.
    "beam5-sns":     ["-bs", "5", "-sns"],
    "beam5-nofb":    ["-bs", "5", "-nf"],
    "arch-nofa":     ["-bs", "1", "-nfa"],
    "beam5-nofa":    ["-bs", "5", "-nfa"],
}

COMMON = ["-l", "uz", "-nt", "-np", "-otxt", "-t", "8"]


def run(name, model=UZ, tag=None):
    tag = tag or name
    outdir = f"{OUT}/{tag}"
    if os.path.exists(f"{outdir}/.done"):
        print(f"skip {tag} (already decoded)")
        return
    os.makedirs(outdir, exist_ok=True)
    wavs = [f"{SUB}/{k}.wav" for k in SUBSET if os.path.exists(f"{SUB}/{k}.wav")]
    print(f"== {tag}: {len(wavs)} clips, args {VARIANTS[name]} ==", flush=True)
    for f in os.listdir(SUB):
        if f.endswith(".txt"):
            os.remove(f"{SUB}/{f}")
    t0 = time.time()
    proc = subprocess.run(
        [CLI, "-m", model] + COMMON + VARIANTS[name] + wavs,
        capture_output=True, text=True)
    secs = time.time() - t0
    if proc.returncode != 0:
        print(f"FAILED rc={proc.returncode}\n{proc.stderr[-2000:]}")
        return
    moved = 0
    for f in os.listdir(SUB):
        if f.endswith(".txt"):
            os.rename(f"{SUB}/{f}", f"{outdir}/{f}")
            moved += 1
    open(f"{outdir}/.seconds", "w").write(str(round(secs, 1)))
    open(f"{outdir}/.done", "w").write("")
    print(f"{tag}: {secs:.0f}s -> {moved} transcripts", flush=True)


def load(tag):
    d = f"{OUT}/{tag}"
    out = {}
    if not os.path.isdir(d):
        return out
    for p in os.listdir(d):
        if not p.endswith(".txt"):
            continue
        k = p.split(".")[0]
        out[k] = open(f"{d}/{p}", errors="replace").read().strip().replace("\n", " ")
    return out


def wer(keys, hyps):
    pairs = []
    for k in keys:
        if k not in hyps:
            continue
        r = uznorm.normalize_reference(REFS[k])
        h = uznorm.normalize_hypothesis(hyps[k])
        if r.strip():
            pairs.append((r, h))
    if not pairs:
        return None, 0
    return jiwer.wer([a for a, _ in pairs], [b for _, b in pairs]) * 100, len(pairs)


UPPER = re.compile(r"[A-ZА-Я]")
PUNCT = re.compile(r"[.,?!;:]")


def score(tags):
    print(f"{'variant':16} {'n':>4} {'WER%':>8} {'digit':>8} {'nodigit':>8} "
          f"{'ru-mix':>8} {'secs':>7} {'caps%':>6} {'punc%':>6}")
    rows = {}
    for tag in tags:
        hyps = load(tag)
        if not hyps:
            print(f"{tag:16}  (no decode)")
            continue
        keys = list(hyps)
        a, na = wer(keys, hyps)
        d, _ = wer([k for k in keys if META[k]["digits"]], hyps)
        o, _ = wer([k for k in keys if not META[k]["digits"]], hyps)
        r, _ = wer([k for k in keys if META[k]["ru"]], hyps)
        secs = open(f"{OUT}/{tag}/.seconds").read().strip() if os.path.exists(
            f"{OUT}/{tag}/.seconds") else "?"
        n = len(hyps) or 1
        caps = 100 * sum(1 for v in hyps.values() if UPPER.search(v)) / n
        punc = 100 * sum(1 for v in hyps.values() if PUNCT.search(v)) / n
        f = lambda x: f"{x:.2f}" if x is not None else "—"
        print(f"{tag:16} {na:>4} {f(a):>8} {f(d):>8} {f(o):>8} {f(r):>8} "
              f"{secs:>7} {caps:5.1f}% {punc:5.1f}%")
        rows[tag] = dict(all=a, dig=d, non=o, ru=r, n=na, secs=secs, caps=caps, punc=punc)
    json.dump(rows, open(f"{OUT}/scores.json", "w"), indent=1)
    return rows


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    args = sys.argv[2:]
    os.makedirs(OUT, exist_ok=True)
    if cmd == "list":
        for k, v in VARIANTS.items():
            print(f"  {k:16} {' '.join(v)}")
    elif cmd == "run":
        for name in (args or list(VARIANTS)):
            run(name)
    elif cmd == "score":
        score(args or [t for t in VARIANTS if os.path.isdir(f"{OUT}/{t}")])
    else:
        print(__doc__)
        sys.exit(2)

#!/usr/bin/env python3
"""Decode the same 344 clips with the same params but a different model file.

Answers "how much is q5_0 quantisation costing us" with a number instead of a guess. The f16 and
q8_0 files were rebuilt here from islomov/rubaistt_v2_medium at the revision the 25.19% was
measured against, and the fresh q5_0 reproduces the shipped file's sha256 byte for byte — so the
only variable between these runs is the quantisation.
"""
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sweep

WORK = os.environ.get("KOTIBA_WORK", os.path.expanduser("~/.cache/kotiba-measure"))

BASE = WORK
CONV = f"{BASE}/conv/out"
SUB = f"{BASE}/gap01/sub"
RUNS = f"{BASE}/gap01/runs"

MODELS = {
    "f16":  f"{CONV}/ggml-navoi-medium-f16.bin",
    "q8_0": f"{CONV}/ggml-navoi-medium-q8_0.bin",
}


def decode(tag, model, args):
    outdir = f"{RUNS}/{tag}"
    if os.path.exists(f"{outdir}/.done"):
        print(f"skip {tag}")
        return
    os.makedirs(outdir, exist_ok=True)
    wavs = [f"{SUB}/{k}.wav" for k in sweep.SUBSET if os.path.exists(f"{SUB}/{k}.wav")]
    for f in os.listdir(SUB):
        if f.endswith(".txt"):
            os.remove(f"{SUB}/{f}")
    print(f"== {tag}: {len(wavs)} clips, {os.path.basename(model)}, {args} ==", flush=True)
    t0 = time.time()
    p = subprocess.run([sweep.CLI, "-m", model, "-l", "uz", "-nt", "-np", "-otxt", "-t", "8"]
                       + args + wavs, capture_output=True, text=True)
    if p.returncode != 0:
        print(f"FAILED {tag}: {p.stderr[-800:]}")
        return
    for f in os.listdir(SUB):
        if f.endswith(".txt"):
            shutil.move(f"{SUB}/{f}", f"{outdir}/{f}")
    open(f"{outdir}/.seconds", "w").write(str(round(time.time() - t0, 1)))
    open(f"{outdir}/.done", "w").write("")
    print(f"{tag}: {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    tags = []
    for name, path in MODELS.items():
        if not os.path.exists(path):
            print(f"MISSING {path}")
            continue
        decode(f"m-{name}", path, ["-bs", "1"])
        tags.append(f"m-{name}")
    print()
    sweep.score(["arch"] + tags)

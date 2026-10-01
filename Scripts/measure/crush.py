#!/usr/bin/env python3
"""Does *severe* flattening cost Uzbek accuracy? The first attempt did not really test it.

`levels.py`'s clip17 condition multiplied every clip by 1.72 and clamped, which only saturates
clips whose original peak already exceeded 1/1.72 = 0.581. Measured afterwards, it flattened just
1.06% of samples — mild, and it cost nothing (25.20% against a 25.19% baseline). That is not
evidence about the case the app warns on.

This normalises each clip to full scale FIRST and then overdrives, so every clip is genuinely
flattened by a known amount.
"""
import array
import json
import os
import shutil
import subprocess
import sys
import time
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sweep

WORK = os.environ.get("KOTIBA_WORK", os.path.expanduser("~/.cache/kotiba-measure"))

BASE = WORK
SUB = f"{BASE}/gap01/sub"
DEG = f"{BASE}/gap01/degraded"
ARCHIVE = os.environ.get("KOTIBA_GROUND_TRUTH",
                        os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
SUBSET = json.load(open(f"{ARCHIVE}/subset.json"))
CLI = f"{BASE}/wcpp/build/bin/whisper-cli"
UZ = (os.path.expanduser("~/Library/Application Support/Kotiba/models/ggml-navoi-medium-q5_0.bin"))
RUNS = f"{BASE}/gap01/runs"

# Per-clip normalise to 1.0, then multiply and clamp. Overdrive of 3 means everything above a
# third of full scale saturates, which is heavy, audible flattening.
CONDITIONS = {"crush3": 3.0, "crush8": 8.0}


def read_wav(path):
    with wave.open(path, "rb") as w:
        n, rate = w.getnframes(), w.getframerate()
        raw = w.readframes(n)
    a = array.array("h")
    a.frombytes(raw)
    return [v / 32768.0 for v in a], rate


def write_wav(path, floats, rate):
    ints = array.array("h", (max(-32768, min(32767, int(v * 32767))) for v in floats))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(ints.tobytes())


def build(name, overdrive):
    out = f"{DEG}/{name}"
    if os.path.exists(f"{out}/.built"):
        print(f"skip build {name}")
        return out
    os.makedirs(out, exist_ok=True)
    sat = tot = 0
    for k in SUBSET:
        src = f"{SUB}/{k}.wav"
        if not os.path.exists(src):
            continue
        s, rate = read_wav(src)
        peak = max(abs(v) for v in s) or 1.0
        g = overdrive / peak
        s = [max(-1.0, min(1.0, v * g)) for v in s]
        sat += sum(1 for v in s if abs(v) >= 0.999)
        tot += len(s)
        write_wav(f"{out}/{k}.wav", s, rate)
    open(f"{out}/.built", "w").write("")
    print(f"built {name}: overdrive x{overdrive}, {100*sat/tot:.1f}% of samples flattened",
          flush=True)
    return out


def decode(name, wavdir):
    tag = f"lvl-{name}"
    outdir = f"{RUNS}/{tag}"
    if os.path.exists(f"{outdir}/.done"):
        print(f"skip decode {tag}")
        return tag
    os.makedirs(outdir, exist_ok=True)
    wavs = sorted(f"{wavdir}/{f}" for f in os.listdir(wavdir) if f.endswith(".wav"))
    for f in os.listdir(wavdir):
        if f.endswith(".txt"):
            os.remove(f"{wavdir}/{f}")
    t0 = time.time()
    p = subprocess.run([CLI, "-m", UZ, "-l", "uz", "-nt", "-np", "-otxt", "-t", "8", "-bs", "1"]
                       + wavs, capture_output=True, text=True)
    if p.returncode != 0:
        print(f"FAILED {tag}: {p.stderr[-600:]}")
        return None
    for f in os.listdir(wavdir):
        if f.endswith(".txt"):
            shutil.move(f"{wavdir}/{f}", f"{outdir}/{f}")
    open(f"{outdir}/.seconds", "w").write(str(round(time.time() - t0, 1)))
    open(f"{outdir}/.done", "w").write("")
    print(f"{tag}: {time.time()-t0:.0f}s", flush=True)
    return tag


if __name__ == "__main__":
    tags = []
    for name, over in CONDITIONS.items():
        t = decode(name, build(name, over))
        if t:
            tags.append(t)
    print()
    sweep.score(["arch", "lvl-quiet10", "lvl-clip17"] + tags)

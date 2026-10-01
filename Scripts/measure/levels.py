#!/usr/bin/env python3
"""Does input level actually cost Uzbek accuracy, or is the clipping warning cosmetic?

Kotiba's own diagnostics show two real-world conditions on real Uzbek dictations:
  * peak 1.72 and 1.33 — above full scale, the app warns "a flattened waveform transcribes badly"
  * peak 0.05 — very quiet

whisper.cpp's log-mel does per-utterance max normalisation (mel = max(mel, max-8); (mel+4)/4),
so a *uniform* gain change should be largely normalised away. Hard clipping is a different thing:
it destroys waveform shape and adds broadband harmonics. This measures which of the two matters.

Builds degraded copies of the 344-clip subset and reports WER for each condition.
"""
import array
import json
import os
import shutil
import subprocess
import sys
import time
import wave

WORK = os.environ.get("KOTIBA_WORK", os.path.expanduser("~/.cache/kotiba-measure"))

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

BASE = WORK
SUB = f"{BASE}/gap01/sub"
DEG = f"{BASE}/gap01/degraded"
ARCHIVE = os.environ.get("KOTIBA_GROUND_TRUTH",
                        os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
SUBSET = json.load(open(f"{ARCHIVE}/subset.json"))

# Conditions. gain is applied to the float signal, then the named limiter behaviour runs.
#   clip  — hard clip at +-1.0, which is what a flattened waveform looks like
#   scale — divide the whole signal back down so the peak lands at 0.95 (no shape loss)
CONDITIONS = {
    "quiet10":   dict(gain=0.10, mode="none"),   # ~peak 0.05, like diagnostics record 4
    "clip17":    dict(gain=1.72, mode="clip"),   # like record 2: peak 1.72, truly flattened
    "clip13":    dict(gain=1.33, mode="clip"),   # like record 3
    "loud17ok":  dict(gain=1.72, mode="scale"),  # same gain, NOT clipped — isolates shape loss
}


def read_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, path
        n = w.getnframes()
        raw = w.readframes(n)
    ints = array.array("h")
    ints.frombytes(raw)
    return [v / 32768.0 for v in ints], w.getframerate()


def write_wav(path, floats, rate=16000):
    ints = array.array("h", (max(-32768, min(32767, int(v * 32767))) for v in floats))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(ints.tobytes())


def build(name):
    cfg = CONDITIONS[name]
    outdir = f"{DEG}/{name}"
    if os.path.exists(f"{outdir}/.built"):
        print(f"skip build {name}")
        return outdir
    os.makedirs(outdir, exist_ok=True)
    peaks = []
    for k in SUBSET:
        src = f"{SUB}/{k}.wav"
        if not os.path.exists(src):
            continue
        s, rate = read_wav(src)
        g = cfg["gain"]
        s = [v * g for v in s]
        if cfg["mode"] == "clip":
            s = [max(-1.0, min(1.0, v)) for v in s]
        elif cfg["mode"] == "scale":
            p = max(abs(v) for v in s) or 1.0
            if p > 0.95:
                f = 0.95 / p
                s = [v * f for v in s]
        peaks.append(max(abs(v) for v in s))
        write_wav(f"{outdir}/{k}.wav", s, rate)
    open(f"{outdir}/.built", "w").write("")
    print(f"built {name}: {len(peaks)} clips, mean peak {sum(peaks)/len(peaks):.3f}")
    return outdir


CLI = f"{BASE}/wcpp/build/bin/whisper-cli"
UZ = os.path.expanduser("~/Library/Application Support/Kotiba/models/ggml-navoi-medium-q5_0.bin")
RUNS = f"{BASE}/gap01/runs"


def decode(name, wavdir, args):
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
    p = subprocess.run([CLI, "-m", UZ, "-l", "uz", "-nt", "-np", "-otxt", "-t", "8"] + args + wavs,
                       capture_output=True, text=True)
    if p.returncode != 0:
        print(f"FAILED {tag}: {p.stderr[-800:]}")
        return None
    for f in os.listdir(wavdir):
        if f.endswith(".txt"):
            shutil.move(f"{wavdir}/{f}", f"{outdir}/{f}")
    open(f"{outdir}/.seconds", "w").write(str(round(time.time() - t0, 1)))
    open(f"{outdir}/.done", "w").write("")
    print(f"{tag}: {time.time()-t0:.0f}s", flush=True)
    return tag


if __name__ == "__main__":
    args = sys.argv[1:] or ["-bs", "1"]
    tags = []
    for name in CONDITIONS:
        d = build(name)
        t = decode(name, d, args)
        if t:
            tags.append(t)
    import sweep
    print()
    sweep.score(["arch"] + tags)

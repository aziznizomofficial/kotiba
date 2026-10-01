#!/usr/bin/env python3
"""Rebuild the GAP-01 Uzbek eval WAVs from OvozifyLabs/asr_evaluate_set.

Deliberately identical in ordering and resampling to the archived
_archive/navo-models-evidence/gap01/prep.py, so the clip keys line up with the surviving
refs.json / meta.json / subset.json and the 25.19% WER on record is reproducible.
"""
import array
import json
import os
import wave

import pyarrow as pa

WORK = os.environ.get("KOTIBA_WORK", os.path.expanduser("~/.cache/kotiba-measure"))

# The committed ground truth. Same default and override as sweep.py.
ARCHIVE = os.environ.get("KOTIBA_GROUND_TRUTH",
                        os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))

SRC = WORK + "/gap01"
OUT = WORK + "/gap01/wav"
os.makedirs(OUT, exist_ok=True)


def batches(path):
    with pa.memory_map(path, "rb") as src:
        try:
            reader = pa.ipc.open_stream(src)
        except pa.ArrowInvalid:
            src.seek(0)
            reader = pa.ipc.open_file(src)
            for i in range(reader.num_record_batches):
                yield reader.get_batch(i)
            return
        for batch in reader:
            yield batch


idx = 0
total_s = 0.0
refs = {}
for shard in sorted(f for f in os.listdir(SRC) if f.endswith(".arrow")):
    for batch in batches(os.path.join(SRC, shard)):
        cols = batch.to_pydict()
        for audio, txt in zip(cols["audio"], cols["transcript"]):
            sr = audio["sampling_rate"]
            pcm = audio["array"]
            n = len(pcm)
            if sr != 16000:
                ratio = 16000 / sr
                m = int(n * ratio)
                pcm = [pcm[min(n - 1, int(j / ratio))] for j in range(m)]
                n = m
            ints = array.array("h", (max(-32768, min(32767, int(v * 32767))) for v in pcm))
            key = f"{idx:04d}"
            with wave.open(f"{OUT}/{key}.wav", "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(16000)
                w.writeframes(ints.tobytes())
            refs[key] = (txt or "").strip()
            total_s += n / 16000
            idx += 1
        print(f"  … {idx} clips", flush=True)

json.dump(refs, open(f"{SRC}/refs-rebuilt.json", "w"), ensure_ascii=False)
print(f"wrote {idx} wavs, {total_s / 60:.1f} min of audio")

# Cross-check against the archived refs: same corpus, same order?
archived = json.load(open(
    os.path.join(ARCHIVE, "refs.json")))
same = sum(1 for k in refs if archived.get(k) == refs[k])
print(f"refs match archive: {same}/{len(refs)} (archive has {len(archived)})")

sub = json.load(open(os.path.join(ARCHIVE, "subset.json")))
subdir = f"{SRC}/sub"
os.makedirs(subdir, exist_ok=True)
missing = 0
for k in sub:
    src = f"{OUT}/{k}.wav"
    dst = f"{subdir}/{k}.wav"
    if not os.path.exists(src):
        missing += 1
        continue
    if not os.path.exists(dst):
        os.symlink(src, dst)
print(f"subset {len(sub)} clips linked, {missing} missing")

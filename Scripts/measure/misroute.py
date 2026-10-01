#!/usr/bin/env python3
"""Of the Uzbek clips the router sends away from the Uzbek engine, where do they actually land?

TieredRouter picks `ru > en ? .russian : .english` for everything below the threshold. Those two
destinations fail differently, and only one of them is recoverable by the script check added in
this branch:

  -> .russian  runs whisper large-v3-turbo, which writes Uzbek out in Cyrillic. Non-Russian
               Cyrillic letters give it away, so ScriptCheck.looksLikeUzbekInCyrillic catches it
               and the session reruns on the Uzbek engine.
  -> .english  runs Apple SpeechTranscriber, which emits plausible LATIN English. Uzbek is also
               written in Latin, so no script check can separate them. Nothing catches this one.
"""
import json
import os
import re
import sys

WORK = os.environ.get("KOTIBA_WORK", os.path.expanduser("~/.cache/kotiba-measure"))

BASE = WORK
ARCHIVE = os.environ.get("KOTIBA_GROUND_TRUTH",
                        os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
META = json.load(open(f"{ARCHIVE}/meta.json"))

CLIP = re.compile(r"^(\d+)\.wav\s+([\d.]+)s")
TOP = re.compile(r"^\s+top:\s+(.*)$")
MASS = re.compile(r"^\s+turkic mass:\s+([\d.]+)")


def parse(tag):
    path = f"{BASE}/detect/{tag}.stdout"
    if not os.path.exists(path):
        return {}
    out, key = {}, None
    for line in open(path):
        m = CLIP.match(line)
        if m:
            key = m.group(1)
            out[key] = {"dur": float(m.group(2)), "top": {}}
            continue
        if key is None:
            continue
        m = TOP.match(line)
        if m:
            for pair in m.group(1).split("  "):
                pair = pair.strip()
                if not pair:
                    continue
                bits = pair.split()
                if len(bits) == 2:
                    try:
                        out[key]["top"][bits[0]] = float(bits[1])
                    except ValueError:
                        pass
            continue
        m = MASS.match(line)
        if m:
            out[key]["mass"] = float(m.group(1))
    return out


for tag in sys.argv[1:] or ["base"]:
    rows = parse(tag)
    rows = {k: v for k, v in rows.items() if "mass" in v}
    if not rows:
        print(f"{tag}: no data")
        continue
    n = len(rows)
    for threshold in (0.05, 0.01):
        missed = {k: v for k, v in rows.items() if v["mass"] < threshold}
        to_ru = {k: v for k, v in missed.items()
                 if v["top"].get("ru", 0) > v["top"].get("en", 0)}
        to_en = {k: v for k, v in missed.items() if k not in to_ru}
        print("=" * 78)
        print(f"{tag}, threshold {threshold} — {n} Uzbek clips, {len(missed)} misrouted "
              f"({100*len(missed)/n:.1f}%)")
        print("=" * 78)
        print(f"  -> Russian engine (Cyrillic out; the script check RECOVERS these): "
              f"{len(to_ru):>3}  {100*len(to_ru)/n:.1f}% of all")
        print(f"  -> Apple English  (Latin out; NOTHING catches these):             "
              f"{len(to_en):>3}  {100*len(to_en)/n:.1f}% of all")
        if missed:
            print(f"  recovered share of the misroutes: {100*len(to_ru)/len(missed):.0f}%")
        short = [k for k in missed if META[k]["dur"] < 4]
        print(f"  of the misroutes, {len(short)} are under 4 s "
              f"({100*len(short)/max(1,len(missed)):.0f}%) — dictation's normal length")
        print()

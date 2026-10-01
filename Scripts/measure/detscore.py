#!/usr/bin/env python3
"""How often would the acoustic router send known-Uzbek audio to the wrong engine?

Every clip in this corpus is Uzbek, so any clip whose Turkic cluster mass falls below the live
threshold is a dictation that would never reach the Uzbek model. Scripts/Manifest.json claims
"88% Uzbek recall at a Turkic cluster-mass threshold of 0.05" for ggml-base; this measures it.
"""
import json
import os
import sys

WORK = os.environ.get("KOTIBA_WORK", os.path.expanduser("~/.cache/kotiba-measure"))

BASE = WORK
ARCHIVE = os.environ.get("KOTIBA_GROUND_TRUTH",
                        os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
META = json.load(open(f"{ARCHIVE}/meta.json"))

# The two English utterances from the owner's own diagnostics that were routed TO Uzbek, and the
# one real Uzbek utterance that was routed AWAY from it. Real data, same detector, same settings.
OWNER = [
    ("English, routed to Uzbek", 0.2302),
    ("English, routed to Uzbek", 0.1192),
    ("Uzbek, routed to RUSSIAN", 0.0122),
    ("Uzbek, routed to Uzbek", 0.1829),
    ("Uzbek, routed to Uzbek", 0.7647),
]


def load(tag):
    path = f"{BASE}/detect/{tag}.tsv"
    if not os.path.exists(path):
        return {}
    out = {}
    for line in open(path):
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 4 or parts[0] != "MASS":
            continue
        key = parts[1].split(".")[0]
        out[key] = (float(parts[2]), float(parts[3]))
    return out


THRESHOLDS = [0.01, 0.02, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50]

for tag in sys.argv[1:] or ["base", "turbo"]:
    rows = load(tag)
    if not rows:
        print(f"{tag}: no data")
        continue
    masses = sorted(m for _, m in rows.values())
    n = len(masses)
    print("=" * 78)
    print(f"{tag} — Turkic cluster mass over {n} clips, ALL of which are Uzbek")
    print("=" * 78)
    qs = [0, 5, 10, 25, 50, 75, 90, 100]
    print("  percentiles: " + "  ".join(
        f"p{q}={masses[min(n - 1, q * n // 100)]:.3f}" for q in qs))
    print()
    print(f"  {'threshold':>10} {'recall':>8} {'MISROUTED':>10}  (Uzbek dictations sent elsewhere)")
    for t in THRESHOLDS:
        hit = sum(1 for m in masses if m >= t)
        miss = n - hit
        mark = "   <-- the live setting" if abs(t - 0.05) < 1e-9 else (
            "   <-- ClusterMass.defaultThreshold in code" if abs(t - 0.5) < 1e-9 else "")
        print(f"  {t:>10.2f} {100*hit/n:7.1f}% {miss:>10}{mark}")

    # Short clips are where dictation lives and where language ID is weakest.
    print()
    print(f"  {'duration':>12} {'clips':>6} {'recall@0.05':>12} {'median mass':>12}")
    bands = [(0, 2), (2, 4), (4, 8), (8, 15), (15, 1e9)]
    for lo, hi in bands:
        keys = [k for k in rows if lo <= META[k]["dur"] < hi]
        if not keys:
            continue
        ms = sorted(rows[k][1] for k in keys)
        hit = sum(1 for m in ms if m >= 0.05)
        label = f"{lo}-{hi}s" if hi < 1e9 else f"{lo}s+"
        print(f"  {label:>12} {len(keys):>6} {100*hit/len(keys):11.1f}% "
              f"{ms[len(ms)//2]:12.3f}")
    print()

print("=" * 78)
print("The owner's own five routed dictations, same detector, same 0.05 threshold")
print("=" * 78)
for label, mass in sorted(OWNER, key=lambda r: r[1]):
    verdict = "-> UZBEK engine" if mass >= 0.05 else "-> away from Uzbek"
    print(f"  mass {mass:.4f}  {verdict:20} {label}")
print()
print("  English scored 0.230 and 0.119. Real Uzbek scored 0.012 and 0.183.")
print("  The classes interleave, so NO threshold separates them: 0.05 misroutes the 0.012 Uzbek,")
print("  and any threshold high enough to reject the 0.230 English also rejects the 0.183 Uzbek.")

#!/usr/bin/env python3
"""Python re-port of Kotiba's UzbekNormaliser (itself a port of NavAI uzbek_text_norm v0.3.0).

uzbek_text_norm is not on PyPI, so scoring needs an implementation here. This one is validated
against Tests/KotibaCoreTests/Fixtures/uzbek-normaliser-parity.json — the 318-pair fixture that
was generated from the reference Python implementation. If it passes 318/318 it is equivalent to
the normaliser the public Uzbek leaderboard scores with, so WER measured through it is comparable
to the 25.19% already on record for navoi-medium.

Derived from NavAI's uzbek_text_norm (https://github.com/NavAI-pro/uzbek-text-norm, MIT,
Copyright (c) 2026 NavAI); see THIRD_PARTY_NOTICES.md.
"""
import re

OKINA = "ʻ"

CYR2LAT_MULTI = [
    ("ў", "o" + OKINA), ("ӯ", "o" + OKINA), ("қ", "q"), ("ғ", "g" + OKINA),
    ("ҳ", "h"), ("ё", "yo"), ("ю", "yu"), ("я", "ya"), ("ш", "sh"),
    ("ч", "ch"), ("ц", "ts"),
]
CYR2LAT_ONE = [
    ("а", "a"), ("б", "b"), ("в", "v"), ("г", "g"), ("д", "d"),
    ("ж", "j"), ("з", "z"), ("и", "i"), ("й", "y"), ("к", "k"),
    ("л", "l"), ("м", "m"), ("н", "n"), ("о", "o"), ("п", "p"),
    ("р", "r"), ("с", "s"), ("т", "t"), ("у", "u"), ("ф", "f"),
    ("х", "x"), ("э", "e"), ("ъ", OKINA), ("ь", ""),
]
YE_CONTEXT = set(" \t\nаеёиоуўэюяьъ")


def cyrillic_to_latin(text):
    out = []
    previous = None
    for ch in text.lower():
        if ch == "е":
            out.append("ye" if previous is None or previous in YE_CONTEXT else "e")
        else:
            out.append(ch)
        previous = ch
    s = "".join(out)
    for c, l in CYR2LAT_MULTI:
        s = s.replace(c, l)
    for c, l in CYR2LAT_ONE:
        s = s.replace(c, l)
    return s


ONES = {1: "bir", 2: "ikki", 3: "uch", 4: "to'rt", 5: "besh",
        6: "olti", 7: "yetti", 8: "sakkiz", 9: "to'qqiz"}
TENS = {10: "o'n", 20: "yigirma", 30: "o'ttiz", 40: "qirq", 50: "ellik",
        60: "oltmish", 70: "yetmish", 80: "sakson", 90: "to'qson"}
SCALES = [(1_000_000_000, "milliard"), (1_000_000, "million"), (1_000, "ming"), (1, "")]
VOWELS = set("aeiou")


def _spell_group(n, leading_bir):
    parts = []
    hundreds, rest = divmod(n, 100)
    if hundreds == 1:
        parts.append("bir yuz" if leading_bir else "yuz")
    elif hundreds > 0:
        parts.append(ONES[hundreds] + " yuz")
    if rest > 0:
        if rest < 10:
            parts.append(ONES[rest])
        else:
            t, o = divmod(rest, 10)
            parts.append(TENS[t * 10] + ((" " + ONES[o]) if o > 0 else ""))
    return " ".join(parts)


def number_to_words(value):
    assert value >= 0
    if value == 0:
        return "nol"
    if value >= 1_000_000_000_000:
        return " ".join("nol" if d == "0" else ONES[int(d)] for d in str(value))
    n = value
    out = []
    for div, name in SCALES:
        q, n = divmod(n, div)
        if q == 0:
            continue
        is_ones = name == ""
        if q == 1 and not is_ones:
            out.append("bir " + name)
        elif is_ones:
            out.append(_spell_group(q, True))
        else:
            out.append(_spell_group(q, False) + " " + name)
    return " ".join(out)


ORDINAL_DROP_BIR = {"bir yuz": "yuz", "bir ming": "ming",
                    "bir million": "million", "bir milliard": "milliard"}


def number_to_ordinal_words(value):
    cardinal = number_to_words(value)
    words = ORDINAL_DROP_BIR.get(cardinal, cardinal)
    if " " not in words:
        return words + ("nchi" if (words[-1:] or "x") in VOWELS else "inchi")
    head, _, last = words.rpartition(" ")
    last += "nchi" if (last[-1:] or "x") in VOWELS else "inchi"
    return head + " " + last


THOUSANDS_SEP = re.compile(r"(?<=\d)[,\s](?=\d{3}\b)")
ORDINAL_PATTERN = re.compile(r"(\d+)[-‐-―]([^\W\d_]+)", re.UNICODE)
DIGIT_RUN = re.compile(r"\d+")
BARE_ORDINAL_MARKER = {"chi", "nchi", "inchi"}


def spell_numbers(text):
    t = THOUSANDS_SEP.sub("", text)

    def _ord(m):
        try:
            n = int(m.group(1))
        except ValueError:
            return m.group(0)
        word = number_to_ordinal_words(n)
        suffix = m.group(2)
        return word if suffix.lower() in BARE_ORDINAL_MARKER else word + " " + suffix

    t = ORDINAL_PATTERN.sub(_ord, t)
    return DIGIT_RUN.sub(lambda m: number_to_words(int(m.group(0))), t)


ZERO_WIDTH = set("﻿​‌‍⁠")
UNI_HYPHEN = set("‐‑‒―−")
APOSTROPHES = set("'‘’ʻʼ`")
PUNCTUATION = set(
    "!\"$%&()*+,-./:;=>?[\\]_{}~«»¼½¾–—"
    "“”„‟•…″‽€™√")


def clean(text):
    out = []
    for ch in text:
        if ch in ZERO_WIDTH:
            continue
        out.append("-" if ch in UNI_HYPHEN else ch)
    s = "".join(out).lower()

    folded = []
    previous = None
    for ch in s:
        if ch in APOSTROPHES and previous in ("o", "g"):
            folded.append(OKINA)
        elif ch in ("‘", "’", "ʼ"):
            folded.append(OKINA)
        else:
            folded.append(ch)
        previous = ch

    stripped = []
    for ch in folded:
        if ch in PUNCTUATION:
            stripped.append(" ")
        elif ch == "а":
            stripped.append("a")
        elif ch in ("ӯ", "Ӯ"):
            stripped.append("o")
            stripped.append(OKINA)
        elif ch == "­":
            stripped.append(" ")
        else:
            stripped.append(ch)

    collapsed = " ".join("".join(stripped).split())
    return "".join(OKINA if c == "'" else c for c in collapsed)


DEFAULT_TAGS = {"noise", "hesitation"}


def _normalise(text, transliterate):
    t = cyrillic_to_latin(text) if transliterate else text
    t = spell_numbers(t)
    t = clean(t)
    return " ".join(w for w in t.split(" ") if w and w not in DEFAULT_TAGS)


def normalize_reference(text):
    return _normalise(text, False)


def normalize_hypothesis(text):
    return _normalise(text, True)


if __name__ == "__main__":
    import json
    import os
    import sys

    here = os.path.dirname(os.path.abspath(__file__))
    fixture = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        here, "..", "..", "Tests/KotibaCoreTests/Fixtures/uzbek-normaliser-parity.json")
    data = json.load(open(fixture))
    ok = bad = 0
    failures = []
    for p in data["pairs"]:
        fn = normalize_reference if p["mode"] == "reference" else normalize_hypothesis
        got = fn(p["in"])
        if got == p["out"]:
            ok += 1
        else:
            bad += 1
            if len(failures) < 6:
                failures.append((p["mode"], p["in"][:90], p["out"][:90], got[:90]))
    print(f"generator: {data.get('generator')}")
    print(f"parity: {ok}/{ok + bad} pass, {bad} fail")
    for mode, i, want, got in failures:
        print(f"  [{mode}] in   {i}\n         want {want}\n         got  {got}")
    sys.exit(1 if bad else 0)

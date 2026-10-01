# The golden fixtures

`windows/fixtures/golden/*.json` is the macOS implementation stating its own answers. The
Windows port is asserted against them; it is not trusted to have reproduced them.

This exists because of **D-W1**. Kotiba's core is a measured classifier, not business logic. The
Turkic cluster threshold, the seven language codes in that cluster, the four Uzbek-Cyrillic
letters, the four-distinct-word evidence bar and the okina/tutuq rule are all numbers and sets
arrived at by measurement over real audio. A TypeScript reimplementation that is quietly
different from any one of them produces bad Uzbek — and stays green in every test it also
wrote, because a test written from the same misunderstanding agrees with it.

## Regenerating

```
swift run kotiba-golden windows/fixtures/golden
```

Run it from anywhere: the *inputs* are located from `#filePath`, so only the output path is
relative to the working directory. Two runs of unchanged source produce byte-identical files.

```
shasum -a 256 windows/fixtures/golden/*.json > /tmp/a
swift run kotiba-golden windows/fixtures/golden
shasum -a 256 windows/fixtures/golden/*.json | diff /tmp/a -   # must be silent
```

`make golden-check` (run by `make test` and by CI) regenerates into a scratch directory and
fails if the generator exits non-zero — a new `AppSettings` field does that by design — or if any
committed fixture differs from what the source now produces.

Regenerate and commit the result whenever `KotibaCore`'s routing, delivery or capitalisation
changes, or whenever `AppSettings` or `BuiltInModes` changes. A fixture diff in a PR that
changes behaviour is the point; a fixture diff in a PR that does not is a bug.

## The seven files

| file | pins | rows |
|---|---|---|
| `cluster-mass.json` | `ClusterMass.mass` / `.isUzbek` — the acoustic tier | 129 |
| `script-check.json` | `ScriptCheck` — the post-transcription verifier | 45 |
| `route.json` | `TieredRouter`, the silence gate, verification, recovery | 102 + 67 + 396 + 13 |
| `uzbek-delivery.json` | `UzbekNormaliser.forDelivery` | 1302 |
| `capitalise.json` | `Capitaliser.restore` + the composed delivery pipeline | 239 + 1224 |
| `settings.json` | every shipped `AppSettings` default (field list closed — a new Mac setting fails the generator until listed), the four built-in modes' whole-dictation templates | 37 + 4 |
| `modes.json` | the deterministic half of the modes, and `prompts`: every `OnDeviceModes` per-sentence prompt, invoked per language, with the droppable sets | 154×2 + 5 + 3 + 4 + 5 + 3×4 prompts |

**`uzbek-scoring.json` is deliberately absent.** The wiring audit found the scoring normaliser
(`clean`, `normaliseReference`, `normaliseHypothesis`) has no caller on the shipping path, and
`foldOrthography` is on 02-BEHAVIOUR §3's confirmed-dead list. t04 has been told not to port
them, so a fixture pinning their output would pin code that will not exist. If the port ever
needs WER numbers comparable to the public Uzbek leaderboard, that is when to add it back.

## Reading a fixture

Every file carries the same header keys before its data:

- `fixture` — its own name.
- `generator` — which version of `kotiba-golden` wrote it. Deliberately a version and not a
  timestamp: a date would be the one field that changed on every regeneration, and would train
  a reader to skim past the diff.
- `source` — the Swift file and symbols the values came from.
- `note` — what the mechanism is and the specific way a reasonable person gets it wrong.
- `constants` — every constant the fixture exercises, at its literal value.
- `count` / `<thing>Count` — the row count, so a truncated file fails loudly.

Rows carry an `exercises` string wherever they are a named boundary rather than bulk corpus.
It is not decoration: the brief requires every constant in `02-BEHAVIOUR.md` to have at least
one case whose output changes if that constant is wrong, and `exercises` is how a reader checks
that claim without re-deriving it.

### Comparison rules

- **Strings compare exactly.** No trimming, no case folding, and above all **no Unicode
  normalisation** — NFC would fold nothing here today, but a port that normalises on the way in
  has already lost the distinction the fixture exists to pin.
- **Booleans and integers compare exactly.**
- **Doubles compare within the tolerance the file states**, which is `1e-9` wherever a
  `massTolerance` or `rateTolerance` key appears. The reason is in `JSON.swift`: `mass` sums a
  dictionary's values, dictionary iteration order is not portable between processes or between
  languages, and the last bit or two of a five-term sum moves with the order. No case sits
  within `1e-9` of a threshold except the two deliberately exact ones, whose ratios are exactly
  representable in binary — so the *decision* is never inside the tolerance, only the printed
  number.

## The format

Written by `Sources/kotiba-golden/JSON.swift` rather than `JSONEncoder`, for two reasons that
are both load-bearing.

**Every non-ASCII scalar is written as `\uXXXX`.** The fixtures exist to pin the difference
between okina U+02BB and tutuq belgisi U+02BC, and a literal `ʻ` in a UTF-8 file is one editor,
one `git config core.autocrlf`, one well-meaning normalisation pass away from being `ʼ`. An
escape survives all of that, and `JSON.parse` decodes it natively — so on the TypeScript side
this costs nothing at all. Do not "fix" the escaping to make the files readable in a browser.

**Object keys are sorted and arrays are ordered.** Two-space indent, LF endings, one trailing
newline, fixed-point decimals with trailing zeros kept and `-0` folded to `0`. No key anywhere
carries a clock, a locale, a hostname or a path outside the repository.

Lists a port has to reproduce are sorted by **Unicode scalar order**, not by Swift's `<` — see
`scalarOrder` in `JSON.swift`. Swift compares strings by canonical equivalence, which is
deterministic but is not what `Array.prototype.sort()` does, and a list the port must match
should be ordered by a rule the port can implement in one line.

## Where the strings come from

Nothing here is invented. A sentence written to exercise a branch tests the branch, not the
language. Every row is either already committed as evidence, or is a boundary lifted verbatim
from a test or a doc comment that says why the boundary is there.

| corpus | rows | what it is |
|---|---|---|
| `Tests/KotibaCoreTests/Fixtures/uzbek-normaliser-parity.json` | 318 | pairs from NavAI `uzbek_text_norm` v0.3.0 — the widest spread of apostrophe glyphs here |
| `Tests/KotibaCoreTests/Fixtures/uzbek-transcripts.json` | 120 | real output of the shipping Uzbek model: ASCII apostrophes, punctuation ~⅔ of the time, **not one capital** |
| `archive/navo-models-evidence/gap01/refs.json` | 745 | UzbekVoice gold references, 142 × U+02BB and 10 × U+02BC — where `forDelivery` must be a **no-op** |
| `archive/navo-models-evidence/gap01/corrector.json` | 20 pairs | the only real Uzbek here carrying capitals, so the only material that can tell an idempotent capitaliser from a destructive one |
| `Corpus.textBoundaries` | 85 | boundaries, each naming the constant it would expose |

`Tests/KotibaAudioTests/Fixtures/mel-parity.json` is the fourth committed fixture and is
deliberately not read: `MelSpectrogram` is on the confirmed-dead list, so there is nothing on
the Windows side for it to be parity with.

## The two seams, named

A golden fixture that blurs "measured" into "believed" is worse than one that says which is
which. There are exactly two places where a value is not the return of a public API call, and
both announce themselves in the JSON.

**`route.json` → `rerunsDerivedBy`.** `DictationSession.isUsableRerun` is public, and the
generator calls it. (It was internal once, and the generator carried a transcribed copy of its
body; the copy is gone, so there is nothing left to keep in sync by hand.)

**`settings.json` → `defaultsDerivedBy`.** `AppSettings` lives in `KotibaUI`, which is
MainActor-isolated, depends on SwiftUI and pulls in the 184 MB whisper binary target — and its
`init` calls `load()`, which reads `UserDefaults.standard`. A generator whose entire product is
byte-identical output cannot have the generating machine's state in its input, so `kotiba-golden`
depends on `KotibaCore` and `KotibaModels` only.

Typing the 28 defaults in by hand was the other option, and it is worse: the fixture becomes a
second copy that drifts silently the first time someone changes a setting, which is the exact
failure golden fixtures exist to remove. So the generator **parses the `public var`
declarations out of `Sources/KotibaUI/Settings.swift`** at generation time. That file is
committed, so this is as deterministic as a literal, and the field list in `SettingsFixtures`
is closed in both directions — a setting renamed, added or removed makes `kotiba-golden` exit
non-zero and name it, rather than quietly emitting a fixture that no longer describes the app.
Expressions rather than literals (`turkicThreshold = ClusterMass.defaultThreshold`) resolve
through the real symbol, so the fixture cannot disagree with the constant it points at. That
one matters: `turkicThreshold` and `ClusterMass.defaultThreshold` once held *different* numbers
and only the settings file had the measured one.

## Two things the fixtures record that are not endorsements

A parity fixture pins what the Mac app does, including where that is wrong. Two rows are worth
naming before someone reproduces them on purpose.

- **`settings.json` → `applications`.** `com.agilebits.onepassword7`, the real bundle
  identifier of 1Password 7, comes back `unknown` and **not sensitive** — the table's prefix is
  `com.agilebits.onepassword` and the matcher requires an exact match or a dot boundary, which a
  trailing `7` is not. `com.1password.1password` matches, so the credential gate holds for
  1Password 8 and misses 7. 02-BEHAVIOUR §4 calls this gate a security property. The Windows
  port writes its own executable-path table and should not inherit the miss. Raised for t05.
- **`settings.json` → `defaults.defaultModeKey` is `super`, while `modeDefaultKeyInRegistry` is
  `message`.** These are different things — the first is what a fresh dictation starts in when
  no app-specific mode claims the frontmost application, the second is what `defaultMode`
  returns — and they genuinely disagree. Both are in the fixture because a port will assume
  they do not. There are **four** modes and `docs/SETUP.md`'s six are stale.

## Adding a case

Add it to `Corpus.textBoundaries` with the constant it exercises, or to the fixture's own probe
list if it is routing-shaped, then regenerate. Do not hand-edit a file in
`windows/fixtures/golden/` — it is generated output, and the next regeneration silently
discards the edit. If a value in a generated file looks wrong, the Swift is what to fix; the
fixture is a mirror and is working correctly by showing you.

# What the Windows port must reproduce

This file is the **index and the deltas**. The detail lives in `docs/windows/inventory/*.md`,
generated on 2026-08-19 by nine readers over `Sources/`: 272 components with the file and line
that defines each, who really calls it, and **468 constants with their literal values**.

Read your module's inventory file in full before writing anything. Then read the Swift.
Where the inventory and the Swift disagree, the Swift is right — the inventory is a map.

| your task | read |
|---|---|
| t03 routing | `inventory/routing.md` |
| t04 text | `inventory/text-delivery.md` |
| t05 settings, history, diagnostics | `inventory/settings-modes.md`, `inventory/platform.md` |
| t06 engines | `inventory/engines.md` |
| t07 hotkey, insertion | `inventory/platform.md` |
| t08 audio | `inventory/audio.md` |
| t09 session | `inventory/session.md` |
| t10 shell | `inventory/ui-parity.md` |
| everyone | `inventory/critic-completeness.md` — what the other eight missed |

---

## 1. The thing most likely to be got wrong: routing is ONE BIT

Kotiba does **not** choose between three languages. It chooses **Uzbek engine** or **unified
engine (English + Russian)**, in three tiers, in this order:

1. **A manual pin** short-circuits everything, costs nothing, and is absolute.
2. **One acoustic pass** over the finished utterance: whisper's language head on
   `ggml-base-q5_1` gives a ~99-language posterior, which is reduced to **Turkic cluster mass** —
   the summed probability of `{uz, tr, az, tk, kk, ky, tg}` over the total — and compared with
   **0.05**, using `>=`. The tie deliberately favours Uzbek.
3. **A script check on the emitted transcript**, which can overturn a non-pinned route toward
   Uzbek and re-transcribe on the Uzbek engine under a **10 s deadline**.

Cluster mass exists because **`uz` never wins on argmax**: clean Uzbek scores `tr 0.63 / az 0.17 /
uz 0.00`. A port that takes the top language from the detector will route Uzbek to Turkish and
produce garbage — and will look correct in every unit test that does not use real audio.

Two details from `inventory/routing.md` that a reasonable person would get wrong:

- The script classifier counts **only ASCII A–Z/a–z** as Latin and **only U+0400–U+04FF** as
  Cyrillic. `\p{Script=Latin}` is not a substitute — it reclassifies accented Latin and U+02BB and
  silently changes four decisions at once.
- The two word-splitting predicates are **different on purpose** and both are load-bearing. One
  splits on non-letters and deduplicates through a set; the other keeps digits and U+02BB inside
  words and walks consecutive pairs without deduplicating. Swapping them breaks a real test each.

## 2. Three normalisers, one of which is a shipped bug if you use it

`inventory/text-delivery.md`. There is a **delivery** normaliser, a **scoring** normaliser, and a
third half-way one with no callers at all. Only delivery is on the user's path. Running the
scoring one on delivered text is this project's most expensive historical bug — it lowercases and
turns `.`, `,` and `?` into spaces, which also makes the capitaliser look broken, because the
capitaliser finds sentence starts by looking for exactly the punctuation that was just removed.

Okina **U+02BB** and tutuq belgisi **U+02BC** are different letters. The rule is the single
character immediately before, lowercased: `o` or `g` → U+02BB, anything else → U+02BC. Never a
global replace. Getting it backwards spells `sanʼat` as `sanʻat`, which is visibly wrong to an
Uzbek reader.

## 3. Do not port dead code

The repository's signature defect is components that are complete, tested, documented and called
from nowhere. Porting one ships behaviour the Mac app does not execute, and there is no way to
notice afterwards.

**Confirmed dead — do NOT port:** `LanguageProbe`, `EnrollmentStore`,
`Vocabulary.acceptsHint(engineFamily:)`, `SilenceTrimmer`, `EnergyDetector`, `MelSpectrogram`,
`KeystrokeSink`, `Focus.isSelfFrontmost`, `Focus.frontmostName`, `Accessibility.openSettings`,
`DictationController.cancel()` (there is no cancel gesture — `HotkeyEvent` has only `.pressed`
and `.released`), `foldOrthography`, the whole `Mode: Codable` / `ModeRegistry` / `JSONValue`
layer (modes are compiled-in literals; nothing reads or writes a mode file), and most of
`ModelStore`'s API beyond download and verify.

Each module's inventory marks `wiredFrom` per component. `NO CALLERS` means do not build it.
If your task's brief asks for something this list calls dead, the list wins — say so in
your result and move on.

## 4. What the eight readers nearly missed, and you would have too

From `inventory/critic-completeness.md`:

- **The credential-field gate is a security property.** When the frontmost application is a
  password manager, `resolveMode()` forces the raw, prompt-less mode and suppresses polish
  entirely. Without it, a password dictated into 1Password is sent to whatever polish endpoint
  the user configured. The macOS comment says this defect shipped once already. **Port it.**
- **The capitaliser is seeded with the union of vocabulary terms across all three languages**, so
  those words are force-capitalised mid-sentence in English and Russian too. Implementing
  "capitalise sentence starts" alone diverges the moment a user adds one vocabulary word.
- **The whisper `initial_prompt` assembly moves punctuation emission by ±23 points** and is sent
  for Uzbek even when no vocabulary is configured. Copy its assembly exactly.
- **Mode selection has four tiers of precedence** and matches bundle ids by longest prefix on a
  dot boundary. The Windows analogue is the executable path / AUMID — decide it once and write it
  down.
- **`docs/SETUP.md` is stale and will mislead you.** It lists six modes where the code has four,
  names the wrong default, and says language detection is unimplemented, which stopped being true.
  `Scripts/dmg-README.txt` is the accurate user-facing document.

## 5. Windows deltas — where the port deliberately differs

Everything else is parity. These are the exceptions, and each is a decision with a reason.

| # | macOS | Windows | why |
|---|---|---|---|
| D-W4 | right ⌘ held | **Right Ctrl** held, configurable | no Command key; Right Alt is AltGr on the audience's layouts |
| D-W2 | English via `SpeechTranscriber`, 117 ms | English via `large-v3-turbo` | no Windows equivalent exists |
| D-W5 | `history.sqlite` + FTS5 | JSONL + in-memory index | avoids a native module nobody here can debug |
| D-W6 | AVAudioEngine + AVAudioConverter | hidden renderer, `AudioContext({sampleRate:16000})` | the browser's resampler is VHQ-class and already written |
| D-W11 | `whisperBeamSize = 5` for every model | **beam 1 for the Uzbek model, 5 for `large-v3-turbo`** | see below |
| — | 3 permission blockers | 1 (microphone) | Windows needs no Accessibility or Input Monitoring grant |
| — | no onboarding flow | a first-run window | the gesture changed; a user who does not know the key has no app |

### D-W11 — beam size is per model, and Uzbek gets 1

Decision **D-08** in `docs/decisions/REGISTER.md` measured it on the 344-clip evaluation subset:
on the model that actually ships (`uzbek_stt_v1`), beam 5 is worth **0.03 WER points** — 21.65%
against 21.68%, which is noise — and costs **+21% latency on a 2.8 s clip and +39% on an 8.8 s
clip**. The register says outright that `whisperBeamSize` "should go back to 1 with this swap"
and that the shipped 5 is inherited from the superseded model.

macOS still ships 5. On a CPU-only Windows laptop that is the cheapest latency win available and
it costs nothing measurable in accuracy, so Windows takes it. `large-v3-turbo` keeps beam 5 —
D-08 measured Uzbek only, and nothing licenses changing a model that was not measured.

### The model conflict you will hit, and its resolution

`Scripts/Manifest.json` and `ModelCatalogue` still describe `ggml-navoi-medium-q5_0.bin`.
`Scripts/make-dmg.sh` and `knownUzbekModels` use `ggml-uzbek-stt-v1-q5_0.bin`. Both files are
539,212,484 bytes with **different** sha256s, so picking the wrong one fails verification in a
way that looks like a corrupt download.

**Windows ships `ggml-uzbek-stt-v1-q5_0.bin`, sha256
`2891c1ca99f40a5519cd2e863e85b70b6cdc057b46fdbb5edbe6d9cead29c1b2`**, from the `models-v2`
release of this repo. It is what `/Applications/Kotiba.app` runs today and what D-08 selected.

## 6. Five failures that already shipped on macOS

Every one of these was found in production, and every one has a Windows analogue.

1. **`isReady()` used as a gate instead of a trigger.** A lazily-loaded engine is legitimately not
   ready before first use; refusing it made Uzbek fail on every default install while pointing the
   user at a model file that was present and valid. Attempt `prepare()`, *then* re-ask. Only a
   throwing prepare is terminal, with its reason preserved verbatim.
2. **A fix at one layer stopping at the next.** The composite engine's readiness was an OR over
   members, so it read ready forever and re-broke Russian one level below the fix. Assume every
   wrapper lies until its own test says otherwise.
3. **A latched admission gate.** The gate moved onto a variable cleared only in a method with no
   callers, so every press after the first was refused with "Still finishing the last one" for the
   life of the process. Name the running condition once, clear it on every exit path, and drive
   **ten** consecutive dictations in the test — two would not have caught it.
4. **Silence delivered as an empty paste.** The rule is a whole-buffer peak below **0.012**,
   checked in the session, plus a second gate on an empty normalised transcript.
5. **`greedy.best_of` left at −1 in the beam branch.** `whisper_full_default_params` fills only
   the struct for the chosen strategy, so every fallback rung above temperature 0 collapsed to one
   unranked random sample. Set `best_of = 5` in **both** branches.

## 7. The parity fixtures that already exist

`Tests/KotibaCoreTests/Fixtures/uzbek-normaliser-parity.json` holds **318 pairs**, and there are
`uzbek-transcripts.json` and `mel-parity.json` beside it. t02 **extends** these into
`windows/fixtures/golden/`; it does not invent a parallel corpus.

---

## 8. The wiring audit — authoritative

`inventory/critic-wiring.md` walked the call graph from the app entry point and classified every
public component: **61 LIVE, 25 DEAD.** It supersedes §3 above where they differ. Two entries
change what earlier drafts of the task briefs asked for:

- **The scoring normaliser is dead too.** `clean`, `normaliseReference`, `normaliseHypothesis`,
  `foldOrthography` and the private subtree only they reach (`cyrillicToLatin`, `spellNumbers`,
  `numberToWords`, `numberToOrdinalWords`) are reachable only from the unshipped `kotiba-probe`
  tool and from tests. The Windows port implements **`forDelivery` only**. It is a WER-measurement
  tool, not part of the product.
- **`WhisperEngine.unload()` has no caller** — the macOS app never unloads a model once loaded.
  So idle unload on Windows is a deliberate addition, not parity, and it is worth having: 1.1 GB
  of resident weights on a low-RAM laptop is a different situation from an M4 Pro. Label it as an
  addition.

Also dead and not to be built: `PolishClient.verifyKey`, `DiagnosticsStore.clear`/`exportSummary`,
`HistoryStore.count`, `ModelStore.isInstalled`/`remove`/`installedBytes`,
`Capitaliser.sentenceInitialCapitalRate`, `Vocabulary.acceptsHint`/`set`,
`WhisperLanguageDetector.isReady`/`unload`, `AppleSpeechEngine.failureReason`/`release`/
`isAvailable`, `DictationSession.plausible`/`transitions`, `Mode.version`/`voiceModelID`/
`polishModelID`, `WAVFile`/`WAVFileSource`, and the whole `Apps/iOS` tree.

# The Arabic speed-check clip

`arabic-speed-check.wav` — 16 kHz mono 16-bit PCM, **3.00 s**, peak 0.268, 96 KB,
sha256 `00dd0476385d11c6776102bf7c9efcfefd063e3da1ed650918e2441141fd1e76`.

What Cohere Transcribe Arabic decodes, twice, the first time it loads on a PC
(`src/engines/arabic.ts`): if the faster of the two takes more than 450 ms, Arabic switches
itself to NVIDIA's FastConformer. Three seconds is the median tail a real dictation leaves
after its last pause (C4 §1), so the number is the key-release cost the user would feel.

The first 3 s of FLEURS `ar_eg` test utterance `6078467931729042050.wav` (Google, **CC-BY-4.0**),
reference text in full:

> بين الساعة 10:00 إلى 11:00 مساءً بتوقيت الجبل، أُضرِمَ حريقٌ من قبل النزلاء في الفناء.

cut by `Scripts/measure/tr-ar/prep.py` as `ar-lat3-1` of C4's latency set. Cohere reads the
cut as «بين الساعة العاشرة إلى الحادية عشرة مساءً».

It lives here, not in `fixtures/audio/`, because `--check` runs every WAV in that directory
through the unpinned pipeline, and Arabic is not a language `--check` routes. The installer
carries it at `resources/audio/` (`electron-builder.yml`, checked by `verify-installer.mjs`).

KOTIBA 1.0 — hold a key, speak, let go: the text appears where your cursor is
==============================================================================

Uzbek, English and Russian, plus Turkish and Arabic if you turn them on.
Everything is recognised on this Mac. No account. Your voice never leaves it.

Needs: a Mac with Apple Silicon (M1 or newer) and macOS 26 or newer.


INSTALL — four steps
--------------------

1. Drag Kotiba into the Applications folder.

2. The first open will be refused. This build is free and open source, so it
   is not signed or notarised by Apple (that costs a yearly fee). macOS says
   it "could not verify that Kotiba is free of malware" — that is about the
   missing paid signature, not about anything found in the app.

   IMPORTANT: in that dialog, do NOT click "Move to Trash" — it deletes the
   app. Instead:

       a. Double-click Kotiba once, and in the warning click  Done.
       b. Open  System Settings -> Privacy & Security  and scroll down.
          Next to  '"Kotiba" was blocked to protect your Mac'  click
          Open Anyway,  enter your password, then  Open.

   Needed once per downloaded version.

   Prefer one line of Terminal? This removes the block instead:

       xattr -dr com.apple.quarantine /Applications/Kotiba.app

   (If macOS already deleted Kotiba, open the .dmg again and drag it again.)

3. Give Kotiba two permissions. macOS will NOT ask for these, so grant them
   by hand, or the app can hear you but cannot type:

       System Settings -> Privacy & Security -> Accessibility
           turn Kotiba ON   (or click +, choose /Applications/Kotiba.app)

       System Settings -> Privacy & Security -> Input Monitoring
           turn Kotiba ON

   The microphone permission is asked for normally. Say yes.
   Kotiba's first-run setup shows which of the three are still missing and
   opens the right page for each.

   AFTER EVERY UPDATE: because this build is signed "ad hoc" (no Apple
   certificate), macOS treats each new version as a new app and forgets these
   two permissions. If the hotkey or typing stops working after an update,
   remove Kotiba from both lists with the  –  button and add it again.

4. When setup is done, Kotiba downloads the rest of itself — nothing to
   choose, about 1.9 GB once ("Getting Kotiba ready" on Home):

       English + Russian   Parakeet Ultra            about 632 MB
       Modes               Qwen3 1.7B                about 1.28 GB

   Each file is checked against its published checksum, and an interrupted
   download continues where it stopped (at the next launch, if you quit).
   Kotiba works while they download: Uzbek at once (its model is inside the
   app), English on Apple's built-in recogniser, and the modes tidy fillers
   and punctuation by rule. Russian starts when Parakeet has arrived.


USING IT
--------

Hold the RIGHT COMMAND key, speak for as long as you like, let go. The text
appears wherever your cursor is — any app, any text field. A small black pill
with a live waveform shows that Kotiba is listening. You can change the key
on the Hotkey page.

Kotiba lives in the menu bar; its window has Home, History, Statistics,
Modes, Languages, Hotkey and Settings.

  Language   Automatic, or pin one. Automatic finds Uzbek by itself in most
             cases (in testing, about 3 Uzbek dictations in 100 went to
             another language). Pinning a language is instant and always right.

  Modes      Super    keeps your words, fixes only clear slips and punctuation
             Message  turns speech into a chat message
             Note     makes a short note
             Raw      exactly what was said
             All four run on this Mac.

  Optional languages (Languages page, off until you turn them on; nothing
  of theirs is downloaded before that, and the size shows under the switch):
             Turkish  whisper large-v3-turbo (about 574 MB, downloaded once).
                      Recognised by itself in dictations of 5 s or more;
                      pin Turkish for shorter ones.
             Arabic   Cohere Transcribe Arabic, whisper turbo and Gemma 4
                      E2B for its modes (about 5.45 GB together, downloaded
                      once). Modern Standard Arabic and the main dialects,
                      with punctuation.
             Turning one off offers to delete its files again.


HONEST NOTES
------------

  Uzbek is the reason this app exists, and it is genuinely hard: on real,
  noisy recordings expect roughly one word in five to need correcting. That
  is the best any shippable Uzbek model does today — measured, not guessed.
  English and Russian are far more accurate (about 6-7 words in 100 wrong on
  a standard test set).

  "Always on" (offered in setup) keeps Kotiba running through quits, crashes
  and restarts. Only "Turn off always-on & quit" in the menu stops it.

  Optional "cloud polish" (off by default) sends recognised TEXT, never
  audio, to an endpoint you name, with a key you supply. Everything else
  stays on the Mac.


IF SOMETHING GOES WRONG
-----------------------

Settings -> Diagnostics records what happened on every dictation — which
engine ran, how long each stage took, what went wrong. It contains no
transcript text, so it is safe to send.

  "It heard nothing"           Check System Settings -> Sound -> Input. If it
                               repeats, quit and reopen Kotiba (your audio
                               device probably changed).

  Nothing is typed             Accessibility is not granted. Step 3.

  The hotkey does nothing      Input Monitoring is not granted. Step 3. After
                               an update: remove and re-add Kotiba there.

  Uzbek comes out as another   Pin Uzbek in the menu bar.
  language


Source code, issues and new versions:
    https://github.com/aziznizomofficial/kotiba

Kotiba is MIT-licensed. Uzbek model: Kotib/uzbek_stt_v1 by the Kotibai &
Rubai team (Apache-2.0) — Kotiba is not affiliated with KotibAI (kotib.ai).
English/Russian: Parakeet Ultra (CC BY 4.0, NVIDIA / moondream /
FluidInference). Full notices: Settings -> About, and THIRD_PARTY_NOTICES.md.

Built by Aziz Nizom.  Kotiba (котиба) is Uzbek for secretary.

# Kotiba for Windows

Kotiba is a voice-to-text app: hold a key, speak, let go, and the words land wherever your
cursor was. It already exists for Mac. This is the same app, rebuilt so it runs on Windows —
same three languages (Uzbek, Russian, English), same behaviour, same idea: everything happens
on your own machine, nothing is sent anywhere.

The owner's instruction for this port, word for word: *"Fully clone… one to one, functionally,
but for Windows… people should be able to download the file from Telegram, install it and start
using it without problems."* Every decision on this project traces back to that sentence.

If you only want to install and use the app, you don't need this folder — read
`90-DELIVERY/READ ME FIRST.txt` instead, which ships next to the installer. Everything below
is for whoever is building or reviewing the Windows port.

## What's here

| file | what it's for |
|---|---|
| `00-DECISIONS.md` | The settled calls — why Electron, why Right Ctrl, why one big installer instead of a download-on-first-run, and so on. Read this before questioning why something was built a certain way; the reasoning is already written down. |
| `01-ARCHITECTURE.md` | The map of `windows/` — which folder does what, and the one rule that keeps the core logic testable without a Windows machine: the routing and text code can't touch Electron, files, or any Windows-only API. |
| `02-BEHAVIOUR.md` | What the Mac app actually does, constant by constant, pulled from reading its Swift source. This is the contract the Windows build has to match — not "roughly the same app," but the same routing decisions, the same thresholds, the same bugs-already-fixed. |
| `90-DELIVERY/` | What ships to a real person: the note that comes with the installer, and the Telegram announcement text. |

## Why this exists

Kotiba's whole reason for being is Uzbek dictation — nothing mainstream transcribes Uzbek
usably. The Mac version works well. Most of the people who'd want it are on Windows laptops,
not Macs, so a Windows build isn't a nice-to-have; it's the version most people can actually
use.

## The shape of the build

- **Electron + TypeScript**, not a native Windows rewrite. Nobody working on this owns a
  Windows machine, so the only thing that can be built and checked before it reaches a real
  person is something that runs headless on a shared build server. See `00-DECISIONS.md`
  (D-W1) for the full reasoning, including how the "is the port actually accurate" worry gets
  answered without a human comparing it by ear.
- **One installer, everything inside** — around 1.2 GB, because all three speech models are
  bundled in. No first-run download, because a download that can fail is a second chance for
  the app to look broken right after someone commits to trying it.
- **Right Ctrl** is the dictation key, held while speaking. Windows has no Command key, so the
  Mac's gesture couldn't just carry over — see D-W4 for why Right Ctrl specifically, and not
  Right Alt.
- **Unsigned.** Windows will show a warning on first open (SmartScreen). That's expected, not a
  bug — a proper certificate costs money the project doesn't spend, and the warning is
  explained up front in `90-DELIVERY/READ ME FIRST.txt` so nobody reads it as "this is broken."

## Verifying a change

```
bash windows/scripts/gate.sh
```

Run from the repository root. It type-checks, lints, runs the tests — including the
golden-fixture tests that check the Windows port produces byte-for-byte the same routing and
text output as the Mac app — and checks that no core-logic file has quietly started depending
on Electron or the file system. It must pass before anything is considered done.

## Where the rest of the project lives

`windows/README.md` is the working README for the code itself — layout, dependencies, how to
run the tests locally. This file is the front door for the documents *about* the port; that one
is the front door for the code.

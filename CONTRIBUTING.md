# Contributing

Thanks for looking. Kotiba is a small project with a few firm rules; they are short.

## Set up

```
make doctor && make bootstrap && make generate && make build
```

To build the signed app you need your own Apple Team ID: put
`DEVELOPMENT_TEAM = ABCDE12345` in `Config/Local.xcconfig` (git-ignored). `make build`, `make test`
and `make lint` need no signing. Windows: `cd windows && npm ci && npm run gate`.

## Before you open a pull request

- `make build && make test && make lint` pass, and for anything under `windows/`,
  `npm run gate` passes.
- **`KotibaCore` stays pure.** No AVFoundation, Core ML, SwiftUI, AppKit or `#if os(...)` in
  `Sources/KotibaCore`; new platform behaviour goes behind a protocol in `Contracts.swift`.
  `make lint` checks it.
- **Code without a caller is a bug.** A component that is written and tested but called from
  nowhere in production does not count as done. Say where it is called from.
- **Nothing fails silently.** Every failure path shows the user something or writes a
  diagnostic.
- **Speed and accuracy claims need a method and a number** (machine, set, load). "Verified"
  without them will be asked about.
- **New model, library or data file:** add it to `THIRD_PARTY_NOTICES.md` and the About text
  first, with its licence read from the source. CC BY, GPL-family and use-restricted licences
  need a discussion before they go in.
- Tests must never touch real system state (volume, login items, Keychain, the user's models
  folder).
- Never commit dictation text, recordings of a real person, keys, or your Team ID.

## Issues

Include the macOS or Windows version, the app version, and the **Settings › Diagnostics**
summary. It contains timings and outcomes but no words, so it is safe to paste.

By contributing you agree that your contribution is licensed under the project's MIT licence.

# kotiba-input protocol

Text insertion at the caret. One long-lived process, spawned by Electron main, one
command per line in, one response per line out.

## Invocation

    kotiba-input.exe                serve commands on stdin until EOF
    kotiba-input.exe --version      print `kotiba-input <version>` on stderr, exit 0

Since 1.2.0 every key event this helper synthesises (the unicode path's characters and the
clipboard path's Ctrl+V) carries `dwExtraInfo = 0x4B4F5442`, the value kotiba-hook 1.2.0
skips, so a paste made while the next dictation's key is held never cancels that dictation.

The client sends `"path":"clipboard"` for any text containing a line break or a tab
(`pathFor` in `src/platform/insert.ts`): typed, U+000A is Enter in a chat box and a tab
moves the focus.

## Framing

stdin and stdout are **UTF-8, binary mode, one JSON object per `\n`-terminated line**.
A trailing `\r` on an incoming line is tolerated and stripped; outgoing lines never
carry one. Blank lines are ignored. stdout is unbuffered: a response is readable the
moment it is written.

Every request may carry an `id`, echoed verbatim in the response. Commands are handled
strictly in order.

Unlike `kotiba-stt` there is no length prefix, because there is no binary payload to
resynchronise past: a malformed line costs exactly that line.

## Requests

### `insert`

```json
{"id":"7","op":"insert","text":"Assalomu alaykum","path":"auto",
 "restoreDelayMs":250,"confirm":true}
```

| field | default | meaning |
|-------|---------|---------|
| `text` | — | UTF-8. Empty is refused with `empty`. |
| `path` | `"auto"` | `"unicode"`, `"clipboard"` or `"auto"`. |
| `restoreDelayMs` | `250` | Clipboard path only. Parity with `PasteboardSink.restoreDelay`. |
| `confirm` | `true` | Clipboard path only. Read the clipboard back before pasting. |

**`unicode`** — `SendInput` with `KEYEVENTF_UNICODE`, one key-down/key-up pair per UTF-16
code unit, in batches of 128 units with no batch ever splitting a surrogate pair. The
keyboard layout is never consulted, so U+02BB and U+02BC go in directly on a machine
that has no Uzbek layout installed. Nothing of the user's is borrowed. This is the
default and the primary path, and it is the one place this port is simpler than macOS,
where no keycode can produce the okina at all.

**`clipboard`** — snapshot the clipboard, write `CF_UNICODETEXT`, read it back when
`confirm`, synthesise Ctrl+V, and restore the snapshot `restoreDelayMs` later on a
detached thread. Exists because unicode injection is not universal: an application that
reads scan codes rather than characters ignores a `KEYEVENTF_UNICODE` event *silently*,
and `SendInput` still reports success because the event was injected, not consumed.

**`auto`** — unicode, falling back to the clipboard when `SendInput` refuses to inject.
It cannot detect an application that accepts the injection and ignores it; that case
needs `path: "clipboard"` from the caller.

### `replace`

```json
{"id":"8","op":"replace","previous":"raw text","text":"polished text"}
```

Swaps text this app inserted for its polished form, over UI Automation, **verifying
first**. It takes the focused element's caret range, walks the range start backwards,
reads the covered text back, and only selects and overwrites when what is immediately
before the caret is exactly `previous`. Anything else is refused with `moved`.

Replacement destroys what it selects, so an unverified select-last-N eats whatever the
user typed in between. That is why the read-back is not optional.

### `foreground`

```json
{"id":"9","op":"foreground"}
```

Which application is in front, via `GetForegroundWindow` + `GetWindowThreadProcessId` +
`QueryFullProcessImageNameW`. It lives in this helper rather than in a third one because
the architecture allows two, and because the question is asked twice per dictation — at
hotkey-down for the mode decision and again after transcription for the prompt.

```json
{"id":"9","ok":true,"appId":"telegram","displayName":"Telegram","pid":8123}
```

`appId` is the executable basename, lowercased, `.exe` stripped — the decision written
down in `windows/src/contracts/modes.ts`. `displayName` is the same basename with its
original case and is **for display only**. The window title is never reported: it holds
document content ("Passwords - 1Password"), it changes with locale, and it is the exact
fragility the macOS bundle-identifier scheme was chosen to avoid.

When the front application cannot be identified — no foreground window (locked session,
UAC on the secure desktop), or an elevated process a non-elevated Kotiba may not open —
the answer is a refusal, not an empty success:

```json
{"id":"9","ok":false,"code":"foregroundUnknown","detail":"cannot open process 8123, GetLastError=5"}
```

The distinction is a security property. The credential gate reads this answer, and
"I do not know what is in front" must never arrive looking like "nothing sensitive is
in front".

### `audioSessions` (1.1.0) — ducking

```json
{"id":"10","op":"audioSessions"}
```

Every audio session on every ACTIVE render endpoint whose state is
`AudioSessionStateActive` — a stream is open and running — excluding the system-sounds
session. Only what is playing is ever reported, so only what is playing is ever lowered.

```json
{"id":"10","ok":true,"sessions":[{"id":"{0.0.0.00000000}.{…}|…%b12345","pid":8123,"volume":0.8,"muted":false}]}
```

`id` is `IAudioSessionControl2::GetSessionInstanceIdentifier`, stable for the session's
life — which is what lets a crash marker written by one Kotiba process be restored by the
next. `volume` is the session's own `ISimpleAudioVolume` level, the per-app slider in the
Volume Mixer. The consumer excludes Kotiba's own process ids.

### `setSessionVolume` (1.1.0)

```json
{"id":"11","op":"setSessionVolume","session":"…","volume":0.2,"ifNear":0.8,"tolerance":0.02}
```

Sets one session's level and reads it back. With `ifNear`, the write happens only while
the session is still within `tolerance` of that level — the level Kotiba last left it at.
Anything further away is the user moving the app's slider during the hold, and their
choice stands:

```json
{"id":"11","ok":true,"volume":0.2}
{"id":"11","ok":false,"code":"userChanged","volume":0.6}
{"id":"11","ok":false,"code":"sessionGone"}
```

The check and the write are one call, so there is no gap between looking and writing.
A session not in the last `audioSessions` listing (a restore from a fresh process) is
found again by enumerating every session in any state.

The ramp, the 200 ms start delay and the marker are the consumer's
(`windows/src/platform/ducking.ts`). The app runs a SECOND instance of this helper for
ducking, so a volume ramp never queues behind a paste.

### `hello`

```json
{"op":"hello"}
```

## Responses

Success:

```json
{"id":"7","ok":true,"path":"unicode","units":16}
{"id":"7","ok":true,"path":"clipboard","units":16,"clipboardSaved":true,
 "restoreDelayMs":250,"droppedFormats":"CF_BITMAP"}
{"id":"8","ok":true,"path":"automation","units":21}
```

Refusal — `ok` is a boolean and `code` is what a caller branches on. **Never match on a
message** (D-W10):

```json
{"id":"7","ok":false,"code":"couldNotSendKeys","detail":"SendInput delivered 4 of 16 units"}
```

| `code` | maps to `INSERTION_REFUSALS` |
|--------|------------------------------|
| `empty` | `empty` |
| `nothingToReplace` | `nothingToReplace` |
| `clipboardRefused` | `clipboardRefused` |
| `clipboardStolen` | `clipboardStolen` |
| `couldNotSendKeys` | `couldNotSendKeys` |
| `moved` | `moved` |
| `notEditable` | `notEditable` |
| `badRequest` | — a bug in the caller; the helper stays alive |
| `userChanged` | — ducking: the user moved the session's volume; leave it |
| `sessionGone` | — ducking: the session ended or its device went away |
| `audioUnavailable` | — ducking: the endpoints could not be enumerated |

The user-visible sentence for each is written once, in
`windows/src/contracts/errors.ts`, and is never assembled here.

Optional diagnostic fields on any response:

- `heldModifiers` — modifiers physically down when the insertion ran, e.g. `"RCtrl"`.
  Should always be absent: insertion happens after the hotkey is released. When it is
  present, a Ctrl+V became a Ctrl+Shift+V, and that is otherwise unexplainable.
- `droppedFormats` — clipboard formats the snapshot deliberately did not capture.
- `unicodeUnitsBeforeFallback` — on `path: "clipboard"` reached from `"auto"`, how many
  units the unicode attempt delivered before Windows refused it. Non-zero means part of
  the text landed twice, and a success message with no number would leave that
  unexplainable.

## What the clipboard snapshot preserves, and what it does not

Every format whose clipboard handle is an `HGLOBAL` block is copied byte for byte and
put back: `CF_UNICODETEXT`, `CF_TEXT`, `CF_HDROP`, `CF_DIB`, HTML Format, RTF, and every
registered private format.

Deliberately **not** captured, and named in `droppedFormats` so the caller can say so:
`CF_BITMAP`, `CF_PALETTE`, `CF_METAFILEPICT`, `CF_ENHMETAFILE`, `CF_OWNERDISPLAY`, and
the three `CF_DSP*` display formats. These are GDI handles, not memory blocks;
duplicating one across a process whose lifetime we do not control corrupts the user's
clipboard rather than merely losing it. Note that an image copied from most modern
applications is also offered as `CF_DIB`, which *is* preserved.

Restoring an **empty** snapshot empties the clipboard rather than leaving the dictated
text behind. Parity with `PasteboardSink.restore`, and correct on its own terms: the
clipboard was empty before, so it is empty after.

## Known races, both inherited from macOS deliberately

1. Two insertions less than `restoreDelayMs` apart: the first restore lands after the
   second insert.
2. The `confirm` read-back only detects an overwrite between our write and our read. It
   cannot detect an application that steals the clipboard after Ctrl+V is posted.

## Shutdown

Close stdin. The helper finishes the line it is on and exits 0.

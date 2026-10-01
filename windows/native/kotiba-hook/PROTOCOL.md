# kotiba-hook protocol

The push-to-talk reporter. One process, spawned by Electron main, killed with the app.

## Invocation

    kotiba-hook.exe                 watch, report on stdout until stdin closes
    kotiba-hook.exe --version       print `kotiba-hook <version>` on stderr, exit 0

No arguments configure it. **It does not know which key is the hotkey** — that is
policy, it belongs to the consumer, and D-W4 requires the key to be reconfigurable
without a restart. Since 1.1.0 the consumer may name ONE non-modifier key to swallow
(below), which is the only thing the helper is ever told about the binding.

**Since 1.2.0 Kotiba's own keystrokes are not reported.** kotiba-input (1.2.0) stamps every
key event it synthesises with `dwExtraInfo = 0x4B4F5442` ("KOTB"); an injected event carrying
that value passes through unreported. A paste lands while the NEXT dictation's key may be
held (overlapping presses), and each typed character (VK_PACKET, 231) or the paste chord's
V used to reach the consumer as another key during the hold and cancel it. Every other
injected event (AutoHotkey, a vendor remapper) is still reported.

## stdin — commands (1.1.0)

One command per `\n`-terminated line. Unknown lines are ignored, so an older consumer
talking to this helper, or a newer one talking to an older helper, degrades to "nothing
swallowed, nothing polled" rather than to a dead hook.

    SWALLOW <vk>     swallow this key from now on; 0 swallows nothing (the default)
    POLL <vk>        answer on stdout with `STATE <vk> 1` if the key is physically down
                     now (`GetAsyncKeyState`, high bit), `STATE <vk> 0` if not

`SWALLOW` is sent by the consumer on every launch and every rebind: `0` for a modifier
binding (Right Ctrl is never eaten), the key's code for an ordinary-key binding (F13,
Caps Lock…), and `0` while "Record new key" is open. The helper then returns 1 from the
hook — the key never reaches any application — for that key's down, its autorepeat and
its up, EXCEPT when Ctrl, Alt or a Windows key is held at the down: a combination is the
system's, and both the down and its up then pass through. The DOWN/UP lines are written
either way; the consumer needs the edges.

`POLL` is sent every 250 ms while a hold is open, and never at idle. For the key the
helper is holding back, the answer comes from the hook's own record: a swallowed key never
reaches the system key state, so `GetAsyncKeyState` would read it as up (1.1.0 did, and
ended every F13 dictation at the first poll). A `SWALLOW` arriving mid-hold changes what is
swallowed NEXT; the held key's owed key-up is still eaten. It recovers a key-up
the hook never saw — a hook Windows removed after `LowLevelHooksTimeout`, or input to an
elevated window, which a normal-integrity hook does not receive.

Both are handed from the stdin thread to the hook thread with `PostThreadMessage`, so
every stdout write still happens on the hook thread and nothing in the callback locks.

## stdout — the only thing a consumer parses

One line per key transition, `\n`-terminated, flushed immediately, in the order the
transitions happened:

    DOWN <vk>[ S]
    UP <vk>[ S]
    STATE <vk> <0|1>      only ever in answer to a POLL

` S` (1.1.1) marks a transition the helper SWALLOWED. The consumer trusts it over its own
record of which modifiers are down, because the helper read the real keyboard.

`<vk>` is a decimal Win32 virtual-key code in 1..254 with no padding, matching
`HOOK_LINE_PATTERN` in `windows/src/contracts/hotkey.ts`:

    /^(DOWN|UP) (\d{1,3})$/

Modifier codes are **sided**: 162 `VK_LCONTROL`, 163 `VK_RCONTROL`, 164 `VK_LMENU`,
165 `VK_RMENU`, 160 `VK_LSHIFT`, 161 `VK_RSHIFT`. The generic 16/17/18 are never
emitted; if the driver reports one, the helper resolves the side before printing.

The stream is binary-mode and unbuffered. A line never carries `\r`.

Anything else appearing on stdout is a bug in the helper. A consumer logs such a line
and continues; it must not try to interpret it.

## stdout at startup — the resync sweep

Immediately before installing the hook, the helper samples every VK with
`GetAsyncKeyState` and emits `DOWN <vk>` for every key that is **physically down at that
moment**. These lines are indistinguishable from real transitions, which is the point:
the consumer's picture of the keyboard is complete from the first line rather than from
the first edge, so a hotkey that was already held when the helper started still opens a
dictation, and its eventual `UP` is not orphaned.

This is the Windows analogue of `PushToTalkMonitor.resyncHeld()` on macOS.

## stderr — diagnostics, never parsed

    kotiba-hook <version>: watching
    kotiba-hook: SetWindowsHookEx refused, GetLastError=<n>

## Exit codes

| code | meaning |
|------|---------|
| 0 | stdin closed; the hook was removed cleanly |
| 2 | `SetWindowsHookEx` refused — no interactive desktop, almost never user-fixable |
| 3 | the stdout pipe broke; the helper stopped rather than watch keys into nothing |

## Shutdown

Close the helper's stdin. It sees EOF, posts `WM_QUIT`, unhooks, and exits 0. Killing
the process is also safe — Windows removes a low-level hook when its owning thread dies
— but then the exit code no longer distinguishes "we stopped it" from "it crashed".

## Invariants a change to this program must not break

1. **It never swallows a key it was not told to, and never a modifier.** `HookProc`
   returns `CallNextHookEx` on every path except the `SWALLOW`ed key's own transitions.
   Eating Right Ctrl would break every Ctrl chord in every other application.
2. **It has no policy beyond the swallow.** No hotkey knowledge, no debounce, no chord
   rule, no filtering of injected events. The swallow's one rule (not under Ctrl, Alt or
   Windows) has to live here because a hook must answer synchronously.
3. **The callback stays trivial.** Windows silently removes a hook that exceeds
   `LowLevelHooksTimeout`, and a silently-removed hook is a dead gesture with a healthy
   tray icon. No allocation, no locking, no COM in the callback.
4. **It emits VK codes only** — never scan codes, never characters, never modifier
   state. See the privacy note in `src/main.cpp`: this pipe sees every key the user
   presses, and its containment is a property of the design, not of a filter.

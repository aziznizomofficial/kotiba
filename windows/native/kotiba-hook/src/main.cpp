// kotiba-hook — the push-to-talk reporter. D-W4.
//
// One job: watch the keyboard and say, on stdout, one line per key transition.
//
//     DOWN <vk>\n
//     UP <vk>\n
//
// `<vk>` is a decimal Win32 virtual-key code, 1..254, no padding. Nothing else is ever
// written to stdout — status, errors and diagnostics go to stderr — so a consumer can
// treat a non-matching stdout line as a bug in this program rather than as data.
//
// ---------------------------------------------------------------------------------
// TWO HARD REQUIREMENTS, both from D-W4, and both are how this goes wrong
// ---------------------------------------------------------------------------------
//
//   1. IT OBSERVES. `HookProc` returns `CallNextHookEx` on every path except ONE: the
//      single non-modifier key the consumer has named with `SWALLOW <vk>` (1.0 — F13,
//      Caps Lock and friends as the hotkey, the Mac's active tap). A modifier is never
//      swallowed and cannot be named: swallowing Right Ctrl would break every Ctrl chord
//      in every other application on the machine.
//
//   2. IT HAS (ALMOST) NO POLICY. It does not know which key is the hotkey, it does not
//      debounce, it does not decide that a chord cancels anything. It reports
//      transitions; the consumer (windows/src/platform/hotkey.ts, and the pure tracker in
//      windows/src/core/hotkey) decides what they mean. The one rule that has to live
//      here is the swallow, because a hook must answer "eat this key?" synchronously and
//      cannot wait for a pipe round trip: a named key is swallowed unless Ctrl, Alt or a
//      Windows key is held (a combination is the system's), and once a press has been
//      swallowed its autorepeat and its key-up are swallowed with it.
//
// ---------------------------------------------------------------------------------
// LEFT AND RIGHT
// ---------------------------------------------------------------------------------
//
// The whole gesture depends on telling Right Ctrl from Left Ctrl, and the ordinary
// state APIs cannot: `GetAsyncKeyState(VK_CONTROL)` merges the two, and a hook that
// merged them would fire on the Left Ctrl that is half the shortcuts on the machine.
//
// A low-level hook does not have that problem. `KBDLLHOOKSTRUCT::vkCode` arrives
// already sided — 162 `VK_LCONTROL` / 163 `VK_RCONTROL` — because the sided mapping
// happens below this layer. `Sided()` below is the belt-and-braces path for drivers
// and injectors that report the generic `VK_CONTROL` / `VK_MENU` / `VK_SHIFT`: Ctrl and
// Alt are told apart by `LLKHF_EXTENDED` (the right-hand key carries the E0 prefix),
// Shift by its scan code, which is the one modifier where the extended flag says
// nothing.
//
// ---------------------------------------------------------------------------------
// THE CALLBACK BUDGET, which is why this program is so plain
// ---------------------------------------------------------------------------------
//
// Windows removes a low-level hook that takes longer than `LowLevelHooksTimeout`
// (HKEY_CURRENT_USER\Control Panel\Desktop, ~300 ms by default) to answer — silently,
// with no error and no callback. Every subsequent key is then unreported and the
// gesture is dead for the life of the process, which is exactly the failure mode this
// program must not have. So the callback formats a short line, writes it, flushes it,
// and returns. No allocation, no locking, no logging, no COM.
//
// The one thing it can still block on is the pipe: if the parent stops reading, the
// write blocks and the hook is removed. That is the parent's responsibility and it is
// stated here because it is invisible from the other side — hotkey.ts must consume
// stdout continuously and must never pause the stream.
//
// ---------------------------------------------------------------------------------
// WHAT THIS STREAM IS, and what must never be done with it
// ---------------------------------------------------------------------------------
//
// Reporting every transition means this pipe carries every key the user presses in
// every application while Kotiba runs, including passwords. That is inherent in the
// gesture: "any other key pressed during the hold cancels the dictation" cannot be
// answered without seeing the other key. It is made acceptable by containment, not by
// filtering, and the containment is a real obligation on both sides:
//
//   * stdout is an anonymous pipe inherited by the parent process only. This program
//     never opens a file, a socket, or a registry key. It has no network code.
//   * it reports the VK CODE only — never a scan code, never a character, never the
//     shift state — so the stream cannot be reconstructed into typed text.
//   * the consumer must not record, log or diagnose a non-hotkey VK. hotkey.ts counts
//     them and discards them; see the note there.
//
// Injected events (`LLKHF_INJECTED`) are reported like any other — with ONE exception.
// Filtering them all would break every user whose keyboard is remapped through AutoHotkey
// or a vendor driver. The exception is Kotiba's OWN typing: kotiba-input stamps every
// keystroke it synthesises with `kKotibaInjectedTag` in `dwExtraInfo`, and those pass
// through unreported. Since 1.0 a paste lands WHILE the next dictation's key is held
// (overlapping presses), and each typed character (VK_PACKET) or the paste chord's V used
// to reach the consumer as "another key during the hold" and cancel the dictation being
// spoken.
//
// ---------------------------------------------------------------------------------
// STARTUP RESYNC
// ---------------------------------------------------------------------------------
//
// The consumer's `isHeld` is inferred purely from edges, so a key that was already down
// when this process started would never produce the DOWN edge that opens a dictation —
// and worse, its eventual UP would arrive unpaired. macOS solves the same problem by
// re-sampling the hardware modifier state whenever its tap is re-enabled
// (`PushToTalkMonitor.resyncHeld`, Sources/KotibaPlatform/Hotkey.swift).
//
// The equivalent here is a sweep: before the hook is installed, every VK from 1 to 254
// is sampled with `GetAsyncKeyState` and a `DOWN` line is emitted for each one that is
// physically down. It is still policy-free — it reports state, it does not interpret
// it — and it means the consumer's view is complete from the first line rather than
// from the first edge.
//
// ---------------------------------------------------------------------------------
// LIFETIME
// ---------------------------------------------------------------------------------
//
// The parent stops this program by closing its stdin. A reader thread sees EOF and
// posts WM_QUIT to the hook thread, which unhooks and exits 0. Killing the process
// works too and leaks nothing — Windows removes the hook when the owning thread dies —
// but the stdin path gives a clean exit code, which is the difference between "we shut
// it down" and "it crashed" in the tray.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <fcntl.h>
#include <io.h>

#include <cstdio>
#include <cstring>
#include <thread>

namespace {

constexpr const char* kVersion = "1.2.0";

/// kotiba-input's stamp on its own keystrokes (`kKotibaInjectedTag` there). Skipped unreported.
constexpr ULONG_PTR kKotibaInjectedTag = 0x4B4F5442;

/// The hook thread, so the stdin reader can post WM_QUIT to it.
DWORD g_hookThreadId = 0;

/// Set once the pipe has failed. The message loop then exits: a hook whose reports go
/// nowhere is worse than no hook, because the tray still reads healthy.
volatile LONG g_pipeBroken = 0;

/// Thread messages from the stdin reader to the hook thread. Everything that writes to
/// stdout happens on the hook thread, so the two never interleave a line and nothing in
/// the callback needs a lock.
constexpr UINT kMsgSwallow = WM_APP + 1;  // wParam: the vk to swallow, 0 for none
constexpr UINT kMsgPoll = WM_APP + 2;     // wParam: the vk whose state to report

/// The one key the consumer asked to be swallowed, or 0. Written and read on the hook
/// thread only (the message loop sets it; the callback reads it).
DWORD g_swallowVk = 0;
/// The key whose press was swallowed and whose key-up is still OWED, or 0. Kept apart from
/// `g_swallowVk` on purpose: a `SWALLOW` arriving mid-hold (a rebind, the recorder
/// opening) changes which key is swallowed NEXT, and must not let this key's up through
/// without its down — an application would then see a lone key-up.
DWORD g_heldSwallowedVk = 0;

/// Emit one line and flush. Called from the hook callback, so it must stay this small.
///
/// `snprintf` into a fixed buffer plus `fwrite` rather than `printf`: this runs on every
/// key the user presses, and the callback budget above is the reason.
void Report(const char* edge, DWORD vk, bool swallowed = false) {
  char line[24];
  // ` S` marks a transition this helper swallowed. The consumer trusts it over its own
  // record of which modifiers are down, because this helper read the real keyboard.
  const int n = std::snprintf(line, sizeof(line), "%s %lu%s\n", edge, static_cast<unsigned long>(vk),
                              swallowed ? " S" : "");
  if (n <= 0) return;
  if (std::fwrite(line, 1, static_cast<size_t>(n), stdout) != static_cast<size_t>(n) ||
      std::fflush(stdout) != 0) {
    InterlockedExchange(&g_pipeBroken, 1);
    if (g_hookThreadId != 0) PostThreadMessage(g_hookThreadId, WM_QUIT, 0, 0);
  }
}

/// Resolve a generic modifier VK to its sided form.
///
/// The low-level hook normally hands us the sided code already. This exists for the
/// cases where it does not — some injectors and some vendor drivers report the generic
/// VK — because the entire gesture is "RIGHT Ctrl", and a generic 17 reported as if it
/// were the right-hand key would open the microphone on every Ctrl+C on the machine.
DWORD Sided(DWORD vk, const KBDLLHOOKSTRUCT& event) {
  const bool extended = (event.flags & LLKHF_EXTENDED) != 0;
  switch (vk) {
    case VK_CONTROL:
      return extended ? VK_RCONTROL : VK_LCONTROL;
    case VK_MENU:
      return extended ? VK_RMENU : VK_LMENU;
    case VK_SHIFT:
      // Shift is the exception: neither shift key sets the extended flag, so the scan
      // code is the only discriminator. MapVirtualKey resolves it the way the layout
      // does. A zero answer falls back to the generic code rather than inventing one.
      {
        const UINT sided = MapVirtualKey(event.scanCode, MAPVK_VSC_TO_VK_EX);
        return sided != 0 ? sided : vk;
      }
    default:
      return vk;
  }
}

/// Ctrl, Alt or a Windows key physically down. Called from the callback, so it is four
/// `GetAsyncKeyState` reads and nothing else.
bool ShortcutModifierHeld() {
  return (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 || (GetAsyncKeyState(VK_MENU) & 0x8000) != 0 ||
         (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
}

/// Whether this transition of the named key is eaten. Reported either way — the consumer
/// needs the edge to open and close the dictation.
bool ShouldSwallow(DWORD vk, bool down) {
  if (down) {
    if (g_heldSwallowedVk != 0 && vk == g_heldSwallowedVk) return true;  // autorepeat
    if (g_swallowVk == 0 || vk != g_swallowVk) return false;
    if (ShortcutModifierHeld()) return false;  // Ctrl+F13 is someone else's shortcut
    g_heldSwallowedVk = vk;
    return true;
  }
  // Only the up we owe. The up of a press we let through goes through too.
  if (g_heldSwallowedVk == 0 || vk != g_heldSwallowedVk) return false;
  g_heldSwallowedVk = 0;
  return true;
}

LRESULT CALLBACK HookProc(int nCode, WPARAM wParam, LPARAM lParam) {
  // HC_ACTION is the only code a keyboard hook receives; anything else — and every
  // negative code — must be forwarded untouched and not examined.
  bool swallow = false;
  if (nCode == HC_ACTION && lParam != 0) {
    const KBDLLHOOKSTRUCT* event = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lParam);
    const bool ours = (event->flags & LLKHF_INJECTED) != 0 && event->dwExtraInfo == kKotibaInjectedTag;
    const DWORD vk = ours ? 0 : Sided(event->vkCode, *event);
    if (vk != 0 && vk < 255) {
      switch (wParam) {
        case WM_KEYDOWN:
        case WM_SYSKEYDOWN:
          // Auto-repeat is not filtered here — the consumer's tracker treats a DOWN for a
          // key it already has down as a repeat. Modifier keys do not auto-repeat at all.
          swallow = ShouldSwallow(vk, true);
          Report("DOWN", vk, swallow);
          break;
        case WM_KEYUP:
        case WM_SYSKEYUP:
          swallow = ShouldSwallow(vk, false);
          Report("UP", vk, swallow);
          break;
        default:
          break;
      }
    }
  }
  // The named non-modifier hotkey only. Returning non-zero without calling the next hook
  // is what stops the key reaching any application.
  if (swallow) return 1;
  return CallNextHookEx(nullptr, nCode, wParam, lParam);
}

/// `STATE <vk> 0|1`: is the key physically down right now. The answer to `POLL <vk>`.
///
/// A SWALLOWED key never reaches the system's key state — `GetAsyncKeyState` reads 0 for
/// it while it is held — so for the key this helper is holding back, the hook's own
/// record is the answer. Reading the async state there ended every F13 dictation at the
/// first poll.
void ReportState(DWORD vk) {
  char line[32];
  const bool held = (g_heldSwallowedVk != 0 && vk == g_heldSwallowedVk) ||
                    (GetAsyncKeyState(static_cast<int>(vk)) & 0x8000) != 0;
  const int down = held ? 1 : 0;
  const int n = std::snprintf(line, sizeof(line), "STATE %lu %d\n", static_cast<unsigned long>(vk), down);
  if (n <= 0) return;
  if (std::fwrite(line, 1, static_cast<size_t>(n), stdout) != static_cast<size_t>(n) ||
      std::fflush(stdout) != 0) {
    InterlockedExchange(&g_pipeBroken, 1);
    PostQuitMessage(0);
  }
}

/// Emit the current physical state of the whole keyboard, before the hook is installed.
/// See "STARTUP RESYNC" above.
void SweepHeldKeys() {
  for (DWORD vk = 1; vk < 255; ++vk) {
    // The high bit is "physically down now". The LOW bit is the toggle state (Caps
    // Lock, Num Lock) and must not be read as held — that is the classic misuse of this
    // API, and it would report Caps Lock as a stuck key on half the machines in the
    // world.
    if ((GetAsyncKeyState(static_cast<int>(vk)) & 0x8000) != 0) Report("DOWN", vk);
  }
}

/// One command line from the parent. Unknown lines are ignored: a newer consumer talking
/// to an older helper, or the reverse, must degrade to "no swallow, no poll", never to a
/// dead hook.
///
///     SWALLOW <vk>     swallow this non-modifier key from now on (0: nothing)
///     POLL <vk>        answer `STATE <vk> 0|1` on stdout
void HandleCommand(const char* line) {
  unsigned long vk = 0;
  if (std::sscanf(line, "SWALLOW %lu", &vk) == 1) {
    if (vk < 255) PostThreadMessage(g_hookThreadId, kMsgSwallow, static_cast<WPARAM>(vk), 0);
  } else if (std::sscanf(line, "POLL %lu", &vk) == 1) {
    if (vk > 0 && vk < 255) PostThreadMessage(g_hookThreadId, kMsgPoll, static_cast<WPARAM>(vk), 0);
  }
}

/// Read commands until EOF. The parent closing the pipe is the shutdown signal.
void WatchStdin() {
  char line[128];
  size_t length = 0;
  for (;;) {
    const int c = std::fgetc(stdin);
    if (c == EOF) break;  // EOF, or an unreadable stdin — either way, time to go.
    if (c == '\n') {
      line[length] = '\0';
      if (length > 0 && line[length - 1] == '\r') line[length - 1] = '\0';
      HandleCommand(line);
      length = 0;
    } else if (length + 1 < sizeof(line)) {
      line[length++] = static_cast<char>(c);
    }
    // A line longer than the buffer is truncated, parsed, and does no harm.
  }
  if (g_hookThreadId != 0) PostThreadMessage(g_hookThreadId, WM_QUIT, 0, 0);
}

}  // namespace

int main(int argc, char** argv) {
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--version") == 0) {
      std::fprintf(stderr, "kotiba-hook %s\n", kVersion);
      return 0;
    }
  }

  // Unbuffered, and binary: a `\n` written here must be a `\n` read there. With the
  // default text mode the CRT would translate it to CRLF, the consumer splitting on
  // `\n` would see a trailing `\r` on every line, and every line would fail the
  // DOWN/UP pattern — on every key, silently, forever.
  if (stdout != nullptr) {
    _setmode(_fileno(stdout), _O_BINARY);
    setvbuf(stdout, nullptr, _IONBF, 0);
  }

  g_hookThreadId = GetCurrentThreadId();
  // Create this thread's message queue NOW. A thread has none until its first USER call,
  // and a `PostThreadMessage` from the stdin reader before then fails silently — the
  // parent's `SWALLOW` is written the instant the process starts.
  MSG primer;
  PeekMessage(&primer, nullptr, WM_USER, WM_USER, PM_NOREMOVE);

  SweepHeldKeys();

  const HHOOK hook = SetWindowsHookEx(WH_KEYBOARD_LL, HookProc, GetModuleHandle(nullptr), 0);
  if (hook == nullptr) {
    // D-W8: this needs no granted permission, so a refusal here is a real fault —
    // usually a session with no interactive desktop (a service, an SSH shell) rather
    // than anything the user can fix. Say the code; the parent turns it into a
    // sentence, because the parent is where the user-visible strings live.
    std::fprintf(stderr, "kotiba-hook: SetWindowsHookEx refused, GetLastError=%lu\n",
                 GetLastError());
    return 2;
  }

  std::fprintf(stderr, "kotiba-hook %s: watching\n", kVersion);
  std::fflush(stderr);

  std::thread stdinWatcher(WatchStdin);
  stdinWatcher.detach();

  // A low-level hook is delivered to the installing thread's message queue, so this
  // loop is not decoration: without it the callback is never called at all.
  MSG message;
  while (GetMessage(&message, nullptr, 0, 0) > 0) {
    // Thread messages have no window, so they are handled here rather than dispatched.
    if (message.hwnd == nullptr && message.message == kMsgSwallow) {
      // Changes what is swallowed NEXT. A key already held back keeps its owed key-up.
      g_swallowVk = static_cast<DWORD>(message.wParam);
      continue;
    }
    if (message.hwnd == nullptr && message.message == kMsgPoll) {
      ReportState(static_cast<DWORD>(message.wParam));
      continue;
    }
    TranslateMessage(&message);
    DispatchMessage(&message);
  }

  UnhookWindowsHookEx(hook);
  return InterlockedCompareExchange(&g_pipeBroken, 0, 0) != 0 ? 3 : 0;
}

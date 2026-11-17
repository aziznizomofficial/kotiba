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
// THE CALLBACK BUDGET, and why the callback does not write to the pipe (1.3.0)
// ---------------------------------------------------------------------------------
//
// Windows removes a low-level hook that takes longer than `LowLevelHooksTimeout`
// (HKEY_CURRENT_USER\Control Panel\Desktop, ~300 ms by default, at most 1 s) to answer —
// silently, with no error and no callback. Every subsequent key is then unreported and the
// gesture is dead: the app "does not react", with a healthy tray icon. So the callback does
// no I/O at all. It records the transition in a lock-free ring and signals an event; a
// writer thread turns the ring into lines on stdout. A parent that stops reading (its event
// loop stalled behind a model load, a pipe that fills) now blocks the WRITER, never the
// hook. Until 1.2.0 the callback wrote and flushed the pipe itself, and a full pipe blocked
// it past the timeout.
//
// The process and the hook thread also run above normal priority. The hook thread sleeps in
// `GetMessage` almost always; what it must not do is wait behind the speech engines, which
// keep every core busy at normal priority exactly while the user is pressing the key.
//
// ---------------------------------------------------------------------------------
// A HOOK WINDOWS REMOVED ANYWAY IS NOTICED AND PUT BACK (1.3.0)
// ---------------------------------------------------------------------------------
//
// A stall can still happen — a hard page fault on a machine paging hard while a 1.3 GB model
// loads is enough — and there is no API that says "your hook is gone". So the helper ALSO
// registers for Raw Input from the keyboard (RIDEV_INPUTSINK, on a message-only window).
// Raw input is a posted message, not a hook: it keeps arriving after the hook is removed.
// Its content is never read — only that a key event happened, and when. Once a second, if
// raw input has seen a key event that the hook has not (by more than `kMissedSlackMs`), the
// hook is re-installed, `REHOOKED` is written, and the keyboard is re-swept against what was
// last reported, so a key that went down or up while the hook was gone is reported now (the
// held dictation key opens or closes instead of being lost). A raw-input registration that
// fails degrades to re-installing the hook every `kBlindRearmMs`.
//
// A false alarm costs one re-install, which also moves this hook to the head of the chain —
// useful in its own right when another application's hook stops passing events on.
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

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <thread>

namespace {

constexpr const char* kVersion = "1.3.0";

/// kotiba-input's stamp on its own keystrokes (`kKotibaInjectedTag` there). Skipped unreported.
constexpr ULONG_PTR kKotibaInjectedTag = 0x4B4F5442;

/// How far raw input may run ahead of the hook before the hook is presumed removed. Both
/// clocks are this thread's own `GetTickCount` at the moment it handled the event, and the
/// hook is always called before the raw input message for the same key is posted, so a
/// live hook is never behind by more than the time it takes this thread to get from one
/// to the other.
constexpr DWORD kMissedSlackMs = 500;
/// How often the watchdog compares the two.
constexpr UINT kWatchIntervalMs = 1000;
/// Re-installs closer together than this are not done: a false alarm that repeats (input to
/// an elevated window, which raw input may see and the hook cannot) must not churn.
constexpr DWORD kMinRearmGapMs = 5000;
/// Without raw input, the blind cadence.
constexpr DWORD kBlindRearmMs = 30000;
constexpr UINT_PTR kWatchTimerId = 1;

/// The hook thread, so the stdin reader and the writer can post to it.
DWORD g_hookThreadId = 0;
/// The installed hook. Replaced by `Rearm`. Hook thread only.
HHOOK g_hook = nullptr;

/// Set once the pipe has failed. The message loop then exits: a hook whose reports go
/// nowhere is worse than no hook, because the tray still reads healthy.
volatile LONG g_pipeBroken = 0;

/// Thread messages from the stdin reader to the hook thread. Everything that is REPORTED is
/// enqueued on the hook thread, so the ring has exactly one producer and nothing in the
/// callback needs a lock.
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

/// What the consumer has been told is down, by vk. Hook thread only. The re-sweep after a
/// re-installed hook reports the difference between this and the hardware.
bool g_reportedDown[256] = {};

/// The hook thread's `GetTickCount` at the last hook callback, and at the last raw input
/// key event. Hook thread only (both the callback and the window procedure run there).
DWORD g_lastHookTick = 0;
DWORD g_lastRawTick = 0;
DWORD g_lastRearmTick = 0;
bool g_rawInput = false;

// ---------------------------------------------------------------------------------
// The ring: hook thread → writer thread. Single producer, single consumer, no locks.
// ---------------------------------------------------------------------------------

enum class Kind : uint8_t { kDown, kUp, kState, kRehooked };

struct Record {
  Kind kind;
  uint8_t flag;  // DOWN/UP: swallowed. STATE: held.
  uint16_t vk;
};

constexpr uint32_t kRingSize = 4096;  // a power of two; ~12 minutes of autorepeat
Record g_ring[kRingSize];
std::atomic<uint32_t> g_head{0};  // written by the producer only
std::atomic<uint32_t> g_tail{0};  // written by the consumer only
std::atomic<uint32_t> g_overflow{0};
std::atomic<bool> g_writerQuit{false};
HANDLE g_wake = nullptr;      // auto-reset: something was enqueued, or it is time to go
HANDLE g_writerDone = nullptr;

/// Called from the hook callback: no I/O, no allocation, no lock — a store and a SetEvent.
void Enqueue(Kind kind, DWORD vk, bool flag) {
  const uint32_t head = g_head.load(std::memory_order_relaxed);
  const uint32_t tail = g_tail.load(std::memory_order_acquire);
  if (head - tail >= kRingSize) {
    // The parent has not read for minutes. Dropping is the only answer that keeps the hook
    // alive; the consumer's POLL recovers a lost key-up of the dictation key.
    g_overflow.fetch_add(1, std::memory_order_relaxed);
    return;
  }
  g_ring[head & (kRingSize - 1)] = Record{kind, static_cast<uint8_t>(flag ? 1 : 0), static_cast<uint16_t>(vk)};
  g_head.store(head + 1, std::memory_order_release);
  SetEvent(g_wake);
}

/// A transition, enqueued and remembered as reported.
void Report(bool down, DWORD vk, bool swallowed = false) {
  if (vk < 256) g_reportedDown[vk] = down;
  Enqueue(down ? Kind::kDown : Kind::kUp, vk, swallowed);
}

int Format(const Record& record, char* out, size_t room) {
  switch (record.kind) {
    case Kind::kDown:
    case Kind::kUp:
      // ` S` marks a transition this helper swallowed. The consumer trusts it over its own
      // record of which modifiers are down, because this helper read the real keyboard.
      return std::snprintf(out, room, "%s %u%s\n", record.kind == Kind::kDown ? "DOWN" : "UP",
                           static_cast<unsigned>(record.vk), record.flag != 0 ? " S" : "");
    case Kind::kState:
      return std::snprintf(out, room, "STATE %u %d\n", static_cast<unsigned>(record.vk),
                           record.flag != 0 ? 1 : 0);
    case Kind::kRehooked:
      return std::snprintf(out, room, "REHOOKED\n");
  }
  return 0;
}

/// The writer thread: the only code that touches stdout. It may block on a full pipe for as
/// long as the parent likes; the hook does not wait for it.
void WriteLoop() {
  char buffer[4096];
  for (;;) {
    WaitForSingleObject(g_wake, INFINITE);
    for (;;) {
      uint32_t tail = g_tail.load(std::memory_order_relaxed);
      const uint32_t head = g_head.load(std::memory_order_acquire);
      if (tail == head) break;
      size_t used = 0;
      while (tail != head && used + 32 < sizeof(buffer)) {
        const int n = Format(g_ring[tail & (kRingSize - 1)], buffer + used, sizeof(buffer) - used);
        if (n > 0) used += static_cast<size_t>(n);
        ++tail;
      }
      g_tail.store(tail, std::memory_order_release);
      if (used > 0 && (std::fwrite(buffer, 1, used, stdout) != used || std::fflush(stdout) != 0)) {
        InterlockedExchange(&g_pipeBroken, 1);
        if (g_hookThreadId != 0) PostThreadMessage(g_hookThreadId, WM_QUIT, 0, 0);
        SetEvent(g_writerDone);
        return;
      }
    }
    const uint32_t dropped = g_overflow.exchange(0, std::memory_order_relaxed);
    if (dropped != 0) {
      std::fprintf(stderr, "kotiba-hook: the parent stopped reading; %u transitions dropped\n", dropped);
      std::fflush(stderr);
    }
    if (g_writerQuit.load(std::memory_order_acquire)) {
      SetEvent(g_writerDone);
      return;
    }
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
    // Proof of life for the watchdog, for EVERY event, Kotiba's own included.
    g_lastHookTick = GetTickCount();
    const KBDLLHOOKSTRUCT* event = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lParam);
    const bool ours = (event->flags & LLKHF_INJECTED) != 0 && event->dwExtraInfo == kKotibaInjectedTag;
    const DWORD vk = ours ? 0 : Sided(event->vkCode, *event);
    if (vk != 0 && vk < 255) {
      switch (wParam) {
        case WM_KEYDOWN:
        case WM_SYSKEYDOWN:
          // Auto-repeat is not filtered here — the consumer's tracker treats a DOWN for a
          // key it already has down as a repeat. Held modifiers autorepeat too on Windows.
          swallow = ShouldSwallow(vk, true);
          Report(true, vk, swallow);
          break;
        case WM_KEYUP:
        case WM_SYSKEYUP:
          swallow = ShouldSwallow(vk, false);
          Report(false, vk, swallow);
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

/// Physically down now, as far as this helper can know. A SWALLOWED key never reaches the
/// system's key state — `GetAsyncKeyState` reads 0 for it while it is held — so for the key
/// this helper is holding back, the hook's own record is the answer. Reading the async state
/// there ended every F13 dictation at the first poll.
bool PhysicallyDown(DWORD vk) {
  return (g_heldSwallowedVk != 0 && vk == g_heldSwallowedVk) ||
         (GetAsyncKeyState(static_cast<int>(vk)) & 0x8000) != 0;
}

/// `STATE <vk> 0|1`: is the key physically down right now. The answer to `POLL <vk>`.
void ReportState(DWORD vk) { Enqueue(Kind::kState, vk, PhysicallyDown(vk)); }

/// Report every key whose physical state differs from what was last reported — at startup
/// (nothing reported yet: every held key) and after a re-installed hook.
///
/// The high bit of `GetAsyncKeyState` is "physically down now". The LOW bit is the toggle
/// state (Caps Lock, Num Lock) and must not be read as held — that is the classic misuse of
/// this API, and it would report Caps Lock as a stuck key on half the machines in the world.
void SweepHeldKeys() {
  for (DWORD vk = 1; vk < 255; ++vk) {
    // The generic modifiers are never reported; their sided twins are. The mouse buttons
    // share the VK space but are not keys: the hook never reports them, so a sweep that did
    // would leave a "key" down forever — or, after a re-install mid-hold, cancel the
    // dictation as a chord because the user was holding the mouse.
    if (vk == VK_SHIFT || vk == VK_CONTROL || vk == VK_MENU) continue;
    if (vk == VK_LBUTTON || vk == VK_RBUTTON || vk == VK_MBUTTON || vk == VK_XBUTTON1 || vk == VK_XBUTTON2) {
      continue;
    }
    const bool down = PhysicallyDown(vk);
    if (down != g_reportedDown[vk]) Report(down, vk);
  }
}

/// Put the hook back. The new one is installed BEFORE the old one is removed, and both
/// happen on this thread between two messages, so no key can fall between them (a hook is
/// only ever called while this thread is inside `GetMessage`).
void Rearm(bool announce) {
  const HHOOK fresh = SetWindowsHookEx(WH_KEYBOARD_LL, HookProc, GetModuleHandle(nullptr), 0);
  if (fresh == nullptr) {
    std::fprintf(stderr, "kotiba-hook: re-installing the hook was refused, GetLastError=%lu\n", GetLastError());
    std::fflush(stderr);
    return;
  }
  if (g_hook != nullptr) UnhookWindowsHookEx(g_hook);  // fails harmlessly if Windows removed it
  g_hook = fresh;
  g_lastRearmTick = GetTickCount();
  g_lastHookTick = g_lastRearmTick;
  if (!announce) return;
  std::fprintf(stderr, "kotiba-hook: the hook had stopped receiving keys; re-installed\n");
  std::fflush(stderr);
  Enqueue(Kind::kRehooked, 0, false);
  // A swallowed key whose up passed while the hook was gone has no state to read back, and
  // the safe guess is "released": a held state nothing can end is a microphone left open.
  g_heldSwallowedVk = 0;
  SweepHeldKeys();
}

/// Once a second: has raw input seen a key the hook has not?
void Watch() {
  const DWORD now = GetTickCount();
  if (now - g_lastRearmTick < kMinRearmGapMs) return;
  if (!g_rawInput) {
    if (now - g_lastRearmTick >= kBlindRearmMs) Rearm(false);
    return;
  }
  if (g_lastRawTick == 0) return;
  if (static_cast<LONG>(g_lastRawTick - g_lastHookTick) > static_cast<LONG>(kMissedSlackMs)) Rearm(true);
}

LRESULT CALLBACK WatchProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_INPUT:
      // Only that a key event happened. The payload — which key — is never read.
      g_lastRawTick = GetTickCount();
      break;  // DefWindowProc must still see WM_INPUT, to release the input
    case WM_TIMER:
      if (wParam == kWatchTimerId) {
        Watch();
        return 0;
      }
      break;
    default:
      break;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

/// The message-only window that receives raw input and the watchdog's timer.
void StartWatching() {
  WNDCLASSEXW cls = {};
  cls.cbSize = sizeof(cls);
  cls.lpfnWndProc = WatchProc;
  cls.hInstance = GetModuleHandle(nullptr);
  cls.lpszClassName = L"KotibaHookWatch";
  RegisterClassExW(&cls);
  const HWND window = CreateWindowExW(0, cls.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr,
                                      cls.hInstance, nullptr);
  if (window == nullptr) {
    std::fprintf(stderr, "kotiba-hook: no watch window (GetLastError=%lu); the hook is not watched\n",
                 GetLastError());
    std::fflush(stderr);
    return;
  }
  RAWINPUTDEVICE keyboard = {};
  keyboard.usUsagePage = 0x01;  // generic desktop
  keyboard.usUsage = 0x06;      // keyboard
  keyboard.dwFlags = RIDEV_INPUTSINK;
  keyboard.hwndTarget = window;
  g_rawInput = RegisterRawInputDevices(&keyboard, 1, sizeof(keyboard)) != FALSE;
  if (!g_rawInput) {
    std::fprintf(stderr, "kotiba-hook: raw input refused (GetLastError=%lu); re-hooking every %lu s\n",
                 GetLastError(), static_cast<unsigned long>(kBlindRearmMs / 1000));
    std::fflush(stderr);
  }
  SetTimer(window, kWatchTimerId, kWatchIntervalMs, nullptr);
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

  // Above the speech engines, which hold every core at normal priority while the key is
  // down. The hook thread is idle in `GetMessage` otherwise, so this costs nothing.
  SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS);
  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);

  g_hookThreadId = GetCurrentThreadId();
  // Create this thread's message queue NOW. A thread has none until its first USER call,
  // and a `PostThreadMessage` from the stdin reader before then fails silently — the
  // parent's `SWALLOW` is written the instant the process starts.
  MSG primer;
  PeekMessage(&primer, nullptr, WM_USER, WM_USER, PM_NOREMOVE);

  g_wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  g_writerDone = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (g_wake == nullptr || g_writerDone == nullptr) {
    std::fprintf(stderr, "kotiba-hook: CreateEvent failed, GetLastError=%lu\n", GetLastError());
    return 2;
  }
  std::thread writer(WriteLoop);
  writer.detach();

  SweepHeldKeys();

  g_hook = SetWindowsHookEx(WH_KEYBOARD_LL, HookProc, GetModuleHandle(nullptr), 0);
  if (g_hook == nullptr) {
    // D-W8: this needs no granted permission, so a refusal here is a real fault —
    // usually a session with no interactive desktop (a service, an SSH shell) rather
    // than anything the user can fix. Say the code; the parent turns it into a
    // sentence, because the parent is where the user-visible strings live.
    std::fprintf(stderr, "kotiba-hook: SetWindowsHookEx refused, GetLastError=%lu\n",
                 GetLastError());
    return 2;
  }
  g_lastRearmTick = GetTickCount();
  g_lastHookTick = g_lastRearmTick;
  StartWatching();

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

  if (g_hook != nullptr) UnhookWindowsHookEx(g_hook);
  // Let the writer put out what is queued (the parent may be waiting on a STATE), but never
  // hang on a pipe nobody reads.
  g_writerQuit.store(true, std::memory_order_release);
  SetEvent(g_wake);
  WaitForSingleObject(g_writerDone, 200);
  return InterlockedCompareExchange(&g_pipeBroken, 0, 0) != 0 ? 3 : 0;
}

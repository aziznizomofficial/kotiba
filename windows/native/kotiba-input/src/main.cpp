// kotiba-input — text insertion at the caret. The other half of what makes this a
// dictation app rather than a transcription tool.
//
// Reads one JSON command per line on stdin, writes one JSON response per line on
// stdout. The wire format is in PROTOCOL.md next to this file; the reasoning is here.
//
// ---------------------------------------------------------------------------------
// WHY THE PRIMARY PATH IS DIFFERENT FROM macOS, AND WHY THAT IS AN IMPROVEMENT
// ---------------------------------------------------------------------------------
//
// On macOS the clipboard is the PRIMARY path and it is not a preference: keystroke
// synthesis cannot type Uzbek there, because macOS 26.5.1 ships no Uzbek Latin keyboard
// layout and therefore no keycode produces the okina U+02BB. `KeystrokeSink` refuses
// outright on that one character (PasteboardSink.swift:160), and `Insertion.sink()`
// never constructs it anyway.
//
// Windows does not have that constraint. `SendInput` with `KEYEVENTF_UNICODE` carries a
// UTF-16 code unit as payload — the keyboard layout is not consulted at all — so
// U+02BB, U+02BC, Cyrillic and the whole BMP go in directly, with no clipboard involved
// and nothing of the user's to save and put back. That is strictly better than the
// macOS path and it is the default here.
//
// The clipboard path remains, because unicode injection is not universal: an
// application that reads scan codes rather than characters (games, some remote-desktop
// and terminal emulators, a few Java toolkits) ignores a `KEYEVENTF_UNICODE` event
// entirely, and does so silently — `SendInput` reports success because the event was
// injected, not because anything consumed it. So the fallback exists and the response
// always says which path ran, because a diagnostic that cannot tell "we pasted" from
// "we typed" cannot explain a user's empty text field.
//
// ---------------------------------------------------------------------------------
// THE CLIPBOARD IS THE USER'S, NOT OURS
// ---------------------------------------------------------------------------------
//
// Whenever the clipboard path runs, the previous contents are snapshotted and put back.
// Silently eating what someone had copied is a bug they will notice and will not
// report; they will conclude the app is unreliable and stop using it.
//
// What is preserved, and what is not, is stated in the response rather than assumed:
// formats whose clipboard handle is an `HGLOBAL` block are copied byte for byte, and
// the handful of GDI-handle formats (bitmaps, metafiles, palettes, owner-display) are
// named in `droppedFormats`. Restoring an `HBITMAP` or an `HENHMETAFILE` means
// duplicating a GDI object across a process whose lifetime we do not control, and a
// wrong answer there corrupts the user's clipboard rather than merely losing it.
// Saying so is the honest option; pretending is not.
//
// macOS restores after 250 ms on a detached task, off the critical path, and returns
// `.inserted` immediately. This keeps that timing and that shape, including its known
// consequence: two insertions less than the restore delay apart race, and the first
// restore lands after the second insert.
//
// ---------------------------------------------------------------------------------
// REPLACE, WHICH IS WHAT MAKES THE POLISH PASS REAL
// ---------------------------------------------------------------------------------
//
// `replace` swaps text this app already inserted for its polished form. On macOS it is
// done over the Accessibility tree with a verification step, and the reason the
// verification is not optional is written into the Swift: replacement destroys what it
// selects, so an unverified "select the last N characters" eats whatever the user typed
// in between. The same method fits UI Automation almost exactly — take the caret range,
// walk its start backwards, READ IT BACK, and only if the characters immediately before
// the caret are exactly what we inserted do we select and overwrite.
//
// This is also the file's biggest untested surface. It compiles on Windows and it has
// never run on Windows; see the result notes for t07.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

// `ole2.h` before `uiautomation.h`, and both after `windows.h`. This ordering is
// load-bearing, and getting it wrong is what broke the first Windows CI run.
//
// `WIN32_LEAN_AND_MEAN` above makes `windows.h` skip `ole2.h`, which is where the
// `interface` macro (`struct`) and `IUnknown` come from. `uiautomation.h` pulls in the
// SDK's `UIAutomationCore.h`, whose first hundred lines are
// `typedef interface IRawElementProviderSimple IRawElementProviderSimple;` and its
// siblings — so with no `interface` macro in scope MSVC reads a missing type specifier
// per interface (C4430 / C2146) until it gives up at 100 errors. The failure names
// UIAutomationCore.h and looks like the well-known umbrella/provider-header collision;
// it is not. It is a header that was never included.
//
// So: never include `UIAutomationCore.h` directly, include the `uiautomation.h`
// umbrella, and make sure the COM base declarations arrive before it.
#include <ole2.h>

#include <uiautomation.h>

// Core Audio, for `audioSessions` / `setSessionVolume` (ducking). After `ole2.h` for the
// same reason as above: these headers declare COM interfaces too.
#include <audiopolicy.h>
#include <mmdeviceapi.h>

#include <fcntl.h>
#include <io.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "json.h"

namespace {

constexpr const char* kVersion = "1.2.0";

/// Stamped into `dwExtraInfo` of EVERY keystroke this helper synthesises, and the one value
/// kotiba-hook skips (the same literal lives in kotiba-hook/src/main.cpp). Since 1.0 a paste
/// lands WHILE the next dictation's key is held — overlapping presses — and the hook used to
/// report each typed character (VK_PACKET, 231) and the paste chord's V as "another key
/// during the hold", which cancelled the dictation being spoken. "KOTB" in ASCII; any
/// other injector (AutoHotkey, a vendor remapper) carries a different value and is still
/// reported, so remapped hotkeys keep working.
constexpr ULONG_PTR kKotibaInjectedTag = 0x4B4F5442;

/// Parity with `PasteboardSink.restoreDelay` (250 ms). The user's text is already
/// delivered when this timer starts; the delay exists to let the target application
/// finish reading the clipboard before we put the user's own contents back.
constexpr int kDefaultRestoreDelayMs = 250;

/// How many UTF-16 units go into one `SendInput` call.
///
/// There is no API limit that forces chunking; the reason is that a single enormous
/// array is one failure with no idea how far it got, whereas chunks report progress. A
/// chunk boundary is never allowed to fall between the halves of a surrogate pair —
/// `AppendUnits` checks for that, because a lone surrogate is not a character and the
/// target application would be handed one.
constexpr size_t kUnitsPerBatch = 128;

/// Codes a caller branches on. They map one-for-one onto `INSERTION_REFUSALS` in
/// windows/src/contracts/errors.ts, so the sentence the user reads is written once, in
/// TypeScript, and never assembled here. D-W10 in miniature: never match on a message.
constexpr const char* kCodeEmpty = "empty";
constexpr const char* kCodeNothingToReplace = "nothingToReplace";
constexpr const char* kCodeClipboardRefused = "clipboardRefused";
constexpr const char* kCodeClipboardStolen = "clipboardStolen";
constexpr const char* kCodeCouldNotSendKeys = "couldNotSendKeys";
constexpr const char* kCodeMoved = "moved";
constexpr const char* kCodeNotEditable = "notEditable";
constexpr const char* kCodeBadRequest = "badRequest";

/// Everything that touches the clipboard takes this. The restore runs on a detached
/// thread 250 ms later, and by then the main loop may well be inside the next command.
std::mutex g_clipboardMutex;

// ---------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------

std::wstring Widen(const std::string& utf8) {
  if (utf8.empty()) return std::wstring();
  const int needed =
      MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
  if (needed <= 0) return std::wstring();
  std::wstring wide(static_cast<size_t>(needed), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), &wide[0], needed);
  return wide;
}

std::string Narrow(const std::wstring& wide) {
  if (wide.empty()) return std::string();
  const int needed = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()),
                                         nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return std::string();
  std::string utf8(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), &utf8[0], needed,
                      nullptr, nullptr);
  return utf8;
}

// ---------------------------------------------------------------------------------
// SendInput
// ---------------------------------------------------------------------------------

void AppendUnit(std::vector<INPUT>& inputs, wchar_t unit) {
  INPUT down = {};
  down.type = INPUT_KEYBOARD;
  down.ki.wVk = 0;  // mandatory with KEYEVENTF_UNICODE: the payload is wScan, not a key
  down.ki.wScan = unit;
  down.ki.dwFlags = KEYEVENTF_UNICODE;
  down.ki.dwExtraInfo = kKotibaInjectedTag;
  INPUT up = down;
  up.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
  inputs.push_back(down);
  inputs.push_back(up);
}

/// Type `text` as unicode payload. Returns the number of UTF-16 units delivered.
///
/// The keyboard layout is not consulted, which is the whole point: this is how U+02BB
/// reaches a machine that has never heard of an Uzbek Latin layout.
size_t SendUnicodeText(const std::wstring& text) {
  size_t delivered = 0;
  size_t index = 0;
  while (index < text.size()) {
    size_t end = index + kUnitsPerBatch;
    if (end > text.size()) end = text.size();
    // Never split a surrogate pair across two SendInput calls: the two halves must
    // arrive in the same injected sequence or the target sees a lone surrogate.
    if (end < text.size() && IS_HIGH_SURROGATE(text[end - 1])) end -= 1;
    if (end <= index) end = index + 1;  // pathological input; make progress regardless

    std::vector<INPUT> inputs;
    inputs.reserve((end - index) * 2);
    for (size_t i = index; i < end; ++i) AppendUnit(inputs, text[i]);

    const UINT sent = SendInput(static_cast<UINT>(inputs.size()), inputs.data(), sizeof(INPUT));
    delivered += sent / 2;
    if (sent != inputs.size()) break;  // blocked (UIPI, a locked desktop) — say how far
    index = end;
  }
  return delivered;
}

/// Which modifiers the user is physically holding right now.
///
/// Not corrected, only reported. Insertion happens after the hotkey is released, so
/// this should always be empty; when it is not, a Ctrl+V became a Ctrl+Shift+V and the
/// resulting "it pasted the wrong thing" is otherwise unexplainable from a log.
std::string HeldModifiers() {
  struct Entry {
    int vk;
    const char* name;
  };
  static const Entry kEntries[] = {
      {VK_LSHIFT, "LShift"}, {VK_RSHIFT, "RShift"}, {VK_LCONTROL, "LCtrl"},
      {VK_RCONTROL, "RCtrl"}, {VK_LMENU, "LAlt"},   {VK_RMENU, "RAlt"},
      {VK_LWIN, "LWin"},     {VK_RWIN, "RWin"},
  };
  std::string held;
  for (const Entry& entry : kEntries) {
    if ((GetAsyncKeyState(entry.vk) & 0x8000) != 0) {
      if (!held.empty()) held += ",";
      held += entry.name;
    }
  }
  return held;
}

/// Synthesise Ctrl+V.
///
/// Both the down and the up of V carry no modifier state of their own — on Windows the
/// modifier is a separate key event, unlike the macOS `CGEventFlags` the Swift sets on
/// both events. The Ctrl key-up is unconditional and must stay that way: leaving a
/// synthetic Ctrl down would put the user's keyboard into a modifier state they never
/// asked for and cannot see.
bool SendControlV() {
  INPUT inputs[4] = {};
  for (INPUT& input : inputs) {
    input.type = INPUT_KEYBOARD;
    input.ki.dwExtraInfo = kKotibaInjectedTag;
  }

  inputs[0].ki.wVk = VK_CONTROL;
  inputs[0].ki.wScan = static_cast<WORD>(MapVirtualKey(VK_CONTROL, MAPVK_VK_TO_VSC));
  inputs[1].ki.wVk = 'V';
  inputs[1].ki.wScan = static_cast<WORD>(MapVirtualKey('V', MAPVK_VK_TO_VSC));
  inputs[2].ki.wVk = 'V';
  inputs[2].ki.wScan = inputs[1].ki.wScan;
  inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
  inputs[3].ki.wVk = VK_CONTROL;
  inputs[3].ki.wScan = inputs[0].ki.wScan;
  inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;

  const UINT sent = SendInput(4, inputs, sizeof(INPUT));
  if (sent == 4) return true;

  // Partially injected is worse than not injected: a Ctrl that went down without its
  // up leaves the machine holding a modifier. Put it back up, best effort.
  INPUT release = {};
  release.type = INPUT_KEYBOARD;
  release.ki.wVk = VK_CONTROL;
  release.ki.dwFlags = KEYEVENTF_KEYUP;
  release.ki.dwExtraInfo = kKotibaInjectedTag;
  SendInput(1, &release, sizeof(INPUT));
  return false;
}

// ---------------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------------

struct ClipboardItem {
  UINT format = 0;
  std::vector<char> bytes;
};

struct ClipboardSnapshot {
  std::vector<ClipboardItem> items;
  /// Formats deliberately not captured, named for the response. Never silent.
  std::string dropped;
  bool taken = false;
};

/// Formats whose clipboard handle is a GDI object rather than an `HGLOBAL`. Copying the
/// bytes behind these is meaningless and putting them back is worse than losing them.
bool IsGdiHandleFormat(UINT format) {
  switch (format) {
    case CF_BITMAP:
    case CF_PALETTE:
    case CF_METAFILEPICT:
    case CF_ENHMETAFILE:
    case CF_OWNERDISPLAY:
    case CF_DSPBITMAP:
    case CF_DSPENHMETAFILE:
    case CF_DSPMETAFILEPICT:
      return true;
    default:
      return false;
  }
}

std::string FormatName(UINT format) {
  wchar_t name[128];
  const int written = GetClipboardFormatNameW(format, name, 128);
  if (written > 0) return Narrow(std::wstring(name, static_cast<size_t>(written)));
  return "format#" + std::to_string(format);
}

/// The clipboard is a single shared resource and any application may hold it open.
/// One attempt fails often enough on a busy machine to be a real source of "it did
/// nothing"; retrying briefly is the documented remedy.
bool OpenClipboardWithRetry() {
  for (int attempt = 0; attempt < 12; ++attempt) {
    if (OpenClipboard(nullptr)) return true;
    Sleep(15);
  }
  return false;
}

ClipboardSnapshot SnapshotClipboard() {
  ClipboardSnapshot snapshot;
  if (!OpenClipboardWithRetry()) return snapshot;

  UINT format = 0;
  while ((format = EnumClipboardFormats(format)) != 0) {
    if (IsGdiHandleFormat(format)) {
      if (!snapshot.dropped.empty()) snapshot.dropped += ",";
      snapshot.dropped += FormatName(format);
      continue;
    }
    const HANDLE handle = GetClipboardData(format);
    if (handle == nullptr) continue;
    const SIZE_T size = GlobalSize(handle);
    if (size == 0) continue;
    const void* source = GlobalLock(handle);
    if (source == nullptr) continue;
    ClipboardItem item;
    item.format = format;
    item.bytes.assign(static_cast<const char*>(source),
                      static_cast<const char*>(source) + size);
    GlobalUnlock(handle);
    snapshot.items.push_back(std::move(item));
  }

  CloseClipboard();
  snapshot.taken = true;
  return snapshot;
}

bool WriteClipboardText(const std::wstring& text) {
  const SIZE_T bytes = (text.size() + 1) * sizeof(wchar_t);
  const HGLOBAL block = GlobalAlloc(GMEM_MOVEABLE, bytes);
  if (block == nullptr) return false;
  void* target = GlobalLock(block);
  if (target == nullptr) {
    GlobalFree(block);
    return false;
  }
  std::memcpy(target, text.c_str(), bytes);
  GlobalUnlock(block);

  if (!OpenClipboardWithRetry()) {
    GlobalFree(block);
    return false;
  }
  EmptyClipboard();
  if (SetClipboardData(CF_UNICODETEXT, block) == nullptr) {
    // Ownership only transfers on success. On failure the block is still ours to free,
    // and leaking it here would leak once per dictation for the life of the process.
    CloseClipboard();
    GlobalFree(block);
    return false;
  }
  CloseClipboard();
  return true;
}

/// Read the clipboard back and compare, the equivalent of `PasteboardSink.confirm`.
/// It only detects an overwrite between our write and our read — a microsecond window —
/// and it cannot detect an application that steals the clipboard after Ctrl+V is
/// posted. It costs nothing and it catches the case it can.
bool ClipboardHoldsText(const std::wstring& expected) {
  if (!OpenClipboardWithRetry()) return false;
  bool same = false;
  const HANDLE handle = GetClipboardData(CF_UNICODETEXT);
  if (handle != nullptr) {
    const wchar_t* text = static_cast<const wchar_t*>(GlobalLock(handle));
    if (text != nullptr) {
      same = expected == std::wstring(text);
      GlobalUnlock(handle);
    }
  }
  CloseClipboard();
  return same;
}

void RestoreClipboard(const ClipboardSnapshot& snapshot) {
  if (!snapshot.taken) return;
  if (!OpenClipboardWithRetry()) return;
  // ALWAYS empty first, even when the snapshot is empty. Parity with
  // `PasteboardSink.restore`, and it is the right behaviour on its own terms: the
  // user's clipboard was empty before the dictation, so it is empty after — it does not
  // keep the dictated text as a parting gift.
  EmptyClipboard();
  for (const ClipboardItem& item : snapshot.items) {
    const HGLOBAL block = GlobalAlloc(GMEM_MOVEABLE, item.bytes.size());
    if (block == nullptr) continue;
    void* target = GlobalLock(block);
    if (target == nullptr) {
      GlobalFree(block);
      continue;
    }
    std::memcpy(target, item.bytes.data(), item.bytes.size());
    GlobalUnlock(block);
    if (SetClipboardData(item.format, block) == nullptr) GlobalFree(block);
  }
  CloseClipboard();
}

// ---------------------------------------------------------------------------------
// UI Automation — the verified in-place replace
// ---------------------------------------------------------------------------------

IUIAutomation* g_automation = nullptr;

/// One COM apartment and one IUIAutomation for the life of the process. Creating the
/// automation object costs tens of milliseconds and it is entirely reusable.
void EnsureAutomation() {
  if (g_automation != nullptr) return;
  CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER,
                   __uuidof(IUIAutomation), reinterpret_cast<void**>(&g_automation));
}

struct ReplaceResult {
  bool ok = false;
  const char* code = kCodeNotEditable;
};

/// Take the caret range of whatever has focus, walk its start backwards until the text
/// it covers is exactly `previous`, select it, and type `polished` over the top.
///
/// The read-back loop is what makes this safe. UI Automation's `TextUnit_Character` is
/// what the PROVIDER says a character is — for most controls a UTF-16 unit, for some a
/// grapheme cluster — so moving back by `previous.size()` units is a guess. The loop
/// makes the guess self-correcting: it reads what it actually selected, and if that is
/// longer than what we inserted it walks the start forward by the difference and reads
/// again. It gives up rather than guessing, and giving up is `moved`, which the caller
/// reports and survives.
ReplaceResult ReplaceViaAutomation(const std::wstring& previous, const std::wstring& polished) {
  ReplaceResult result;
  EnsureAutomation();
  if (g_automation == nullptr) return result;

  IUIAutomationElement* focused = nullptr;
  if (FAILED(g_automation->GetFocusedElement(&focused)) || focused == nullptr) return result;

  IUIAutomationTextPattern* pattern = nullptr;
  focused->GetCurrentPatternAs(UIA_TextPatternId, __uuidof(IUIAutomationTextPattern),
                               reinterpret_cast<void**>(&pattern));
  focused->Release();
  if (pattern == nullptr) return result;  // no text pattern: notEditable, and truthfully so

  IUIAutomationTextRange* caret = nullptr;
  IUIAutomationTextRangeArray* selection = nullptr;
  if (SUCCEEDED(pattern->GetSelection(&selection)) && selection != nullptr) {
    int count = 0;
    selection->get_Length(&count);
    if (count > 0) selection->GetElement(0, &caret);
    selection->Release();
  }
  if (caret == nullptr) {
    // No selection at all. TextPattern2 exposes the caret directly; controls that
    // implement neither cannot be replaced into and say so.
    IUIAutomationTextPattern2* pattern2 = nullptr;
    if (SUCCEEDED(pattern->QueryInterface(__uuidof(IUIAutomationTextPattern2),
                                          reinterpret_cast<void**>(&pattern2))) &&
        pattern2 != nullptr) {
      BOOL active = FALSE;
      pattern2->GetCaretRange(&active, &caret);
      pattern2->Release();
    }
  }
  pattern->Release();
  if (caret == nullptr) return result;

  IUIAutomationTextRange* range = nullptr;
  if (FAILED(caret->Clone(&range)) || range == nullptr) {
    caret->Release();
    return result;
  }
  // Collapse to the END of the selection. macOS does the same thing by taking
  // `range.location + range.length` as the caret — the text we inserted sits before the
  // end of the selection, never before its start.
  range->MoveEndpointByRange(TextPatternRangeEndpoint_Start, caret,
                             TextPatternRangeEndpoint_End);
  range->MoveEndpointByRange(TextPatternRangeEndpoint_End, caret,
                             TextPatternRangeEndpoint_End);
  caret->Release();

  const int wanted = static_cast<int>(previous.size());
  int moved = 0;
  if (FAILED(range->MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character,
                                       -wanted, &moved)) ||
      moved == 0) {
    range->Release();
    result.code = kCodeMoved;
    return result;
  }

  bool matched = false;
  for (int attempt = 0; attempt < 8; ++attempt) {
    BSTR text = nullptr;
    if (FAILED(range->GetText(-1, &text)) || text == nullptr) break;
    const std::wstring got(text, SysStringLen(text));
    SysFreeString(text);

    if (got == previous) {
      matched = true;
      break;
    }
    if (got.size() <= previous.size()) break;  // we cannot walk backwards from here

    const int surplus = static_cast<int>(got.size() - previous.size());
    int advanced = 0;
    if (FAILED(range->MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character,
                                         surplus, &advanced)) ||
        advanced <= 0) {
      break;
    }
  }

  if (!matched) {
    range->Release();
    // The characters before the caret are not what we typed: the user edited, or the
    // focus moved, or another writer got there first. Refusing is the only safe answer
    // — selecting and overwriting anyway is what eats the user's own words.
    result.code = kCodeMoved;
    return result;
  }

  const HRESULT selected = range->Select();
  range->Release();
  if (FAILED(selected)) {
    result.code = kCodeNotEditable;
    return result;
  }

  // The selection is live; typing over it replaces it, and the target application keeps
  // its own undo stack — which is exactly why macOS sets a selection and writes into it
  // rather than rewriting the whole field value.
  if (SendUnicodeText(polished) != polished.size()) {
    result.code = kCodeCouldNotSendKeys;
    return result;
  }

  result.ok = true;
  return result;
}

// ---------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------

void Emit(const std::string& line) {
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

void Refuse(const std::string& id, const char* code, const std::string& detail) {
  kotiba::JsonWriter writer;
  writer.string("id", id).boolean("ok", false).string("code", code);
  if (!detail.empty()) writer.string("detail", detail);
  Emit(writer.finish());
}

// ---------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------

void HandleInsert(const kotiba::JsonObject& request, const std::string& id) {
  const std::wstring text = Widen(request.string("text"));
  if (text.empty()) {
    Refuse(id, kCodeEmpty, "");
    return;
  }

  const std::string wanted = request.string("path", "auto");
  const int restoreDelayMs =
      static_cast<int>(request.integer("restoreDelayMs", kDefaultRestoreDelayMs));
  const bool confirm = request.boolean("confirm", true);
  const std::string held = HeldModifiers();

  // ---- the primary path: unicode straight at the caret, no clipboard involved -----
  size_t unicodeDelivered = 0;
  if (wanted == "unicode" || wanted == "auto") {
    const size_t delivered = SendUnicodeText(text);
    unicodeDelivered = delivered;
    if (delivered == text.size()) {
      kotiba::JsonWriter writer;
      writer.string("id", id)
          .boolean("ok", true)
          .string("path", "unicode")
          .integer("units", static_cast<int64_t>(delivered));
      if (!held.empty()) writer.string("heldModifiers", held);
      Emit(writer.finish());
      return;
    }
    if (wanted == "unicode") {
      Refuse(id, kCodeCouldNotSendKeys,
             "SendInput delivered " + std::to_string(delivered) + " of " +
                 std::to_string(text.size()) + " units");
      return;
    }
    // `auto` falls through to the clipboard. Anything already delivered has landed in
    // the target and the paste will follow it, so the caller is told both numbers.
  }

  // ---- the fallback: the user's clipboard, borrowed and given back ----------------
  std::lock_guard<std::mutex> guard(g_clipboardMutex);
  ClipboardSnapshot saved = SnapshotClipboard();

  if (!WriteClipboardText(text)) {
    RestoreClipboard(saved);
    Refuse(id, kCodeClipboardRefused, "");
    return;
  }
  if (confirm && !ClipboardHoldsText(text)) {
    RestoreClipboard(saved);
    Refuse(id, kCodeClipboardStolen, "");
    return;
  }
  if (!SendControlV()) {
    RestoreClipboard(saved);
    Refuse(id, kCodeCouldNotSendKeys, "SendInput refused the paste chord");
    return;
  }

  // Off the critical path, exactly as macOS does it: the text is already delivered, and
  // the caller is not made to wait for the user's clipboard to be put back.
  std::thread([saved, restoreDelayMs]() {
    std::this_thread::sleep_for(std::chrono::milliseconds(restoreDelayMs));
    std::lock_guard<std::mutex> restoreGuard(g_clipboardMutex);
    RestoreClipboard(saved);
  }).detach();

  kotiba::JsonWriter writer;
  writer.string("id", id)
      .boolean("ok", true)
      .string("path", "clipboard")
      .integer("units", static_cast<int64_t>(text.size()))
      .boolean("clipboardSaved", saved.taken)
      .integer("restoreDelayMs", restoreDelayMs);
  if (unicodeDelivered > 0) {
    // `auto` fell back after getting part of the way in. Whatever landed is in the
    // target and the paste followed it, so the caller is told both numbers rather than
    // being left to explain duplicated text from a success message.
    writer.integer("unicodeUnitsBeforeFallback", static_cast<int64_t>(unicodeDelivered));
  }
  if (!saved.dropped.empty()) writer.string("droppedFormats", saved.dropped);
  if (!held.empty()) writer.string("heldModifiers", held);
  Emit(writer.finish());
}

void HandleReplace(const kotiba::JsonObject& request, const std::string& id) {
  const std::wstring previous = Widen(request.string("previous"));
  const std::wstring polished = Widen(request.string("text"));
  if (previous.empty()) {
    Refuse(id, kCodeNothingToReplace, "");
    return;
  }

  const ReplaceResult result = ReplaceViaAutomation(previous, polished);
  if (!result.ok) {
    Refuse(id, result.code, "");
    return;
  }
  kotiba::JsonWriter writer;
  writer.string("id", id)
      .boolean("ok", true)
      .string("path", "automation")
      .integer("units", static_cast<int64_t>(polished.size()));
  Emit(writer.finish());
}

// ---------------------------------------------------------------------------------
// Foreground
// ---------------------------------------------------------------------------------
//
// Which application is in front. Two consumers: mode selection, and the credential gate
// that refuses to build a polisher when the front application is a password manager.
//
// It lives in THIS helper rather than a third one because the architecture allows two
// native helpers and because this question is asked twice per dictation — once at
// hotkey-down for the mode decision and again after transcription for the prompt. A
// process spawn per question would put tens of milliseconds on the front of every press
// for an answer a warm pipe gives in under one.
//
// `appId` is the executable BASENAME, lowercased, with `.exe` removed — the decision
// written down in windows/src/contracts/modes.ts. Never the window title: a title holds
// document content ("Passwords - 1Password"), changes with locale, and is the exact
// fragility the macOS bundle-identifier scheme was chosen to avoid. `displayName` is the
// basename with its original case, and it is for display only.

std::string Basename(const std::wstring& path) {
  size_t slash = path.find_last_of(L"\\/");
  std::wstring name = slash == std::wstring::npos ? path : path.substr(slash + 1);
  if (name.size() > 4) {
    const std::wstring tail = name.substr(name.size() - 4);
    if (_wcsicmp(tail.c_str(), L".exe") == 0) name = name.substr(0, name.size() - 4);
  }
  return Narrow(name);
}

std::string Lowercased(const std::string& value) {
  std::string lower = value;
  for (char& c : lower) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return lower;
}

void HandleForeground(const std::string& id) {
  const HWND window = GetForegroundWindow();
  if (window == nullptr) {
    // No foreground window at all — a locked workstation, a UAC prompt on the secure
    // desktop, a screensaver. Reported as a refusal rather than as an empty answer: the
    // credential gate reads this, so "I do not know" must never look like "nothing
    // sensitive is in front".
    Refuse(id, "foregroundUnknown", "no foreground window");
    return;
  }

  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (pid == 0) {
    Refuse(id, "foregroundUnknown", "no process for the foreground window");
    return;
  }

  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) {
    // Usually an elevated process seen from a non-elevated one. Again a refusal: an
    // elevated password manager must not be reported as an unidentifiable application
    // that the gate then treats as safe.
    Refuse(id, "foregroundUnknown",
           "cannot open process " + std::to_string(pid) + ", GetLastError=" +
               std::to_string(GetLastError()));
    return;
  }

  wchar_t image[MAX_PATH * 2];
  DWORD size = static_cast<DWORD>(sizeof(image) / sizeof(image[0]));
  const BOOL got = QueryFullProcessImageNameW(process, 0, image, &size);
  CloseHandle(process);
  if (!got || size == 0) {
    Refuse(id, "foregroundUnknown", "cannot read the image name of process " + std::to_string(pid));
    return;
  }

  const std::string display = Basename(std::wstring(image, size));
  kotiba::JsonWriter writer;
  writer.string("id", id)
      .boolean("ok", true)
      .string("appId", Lowercased(display))
      .string("displayName", display)
      .integer("pid", static_cast<int64_t>(pid));
  Emit(writer.finish());
}


// ---------------------------------------------------------------------------------
// Ducking — the other apps' playback, per session
// ---------------------------------------------------------------------------------
//
// While the dictation key is held, Kotiba lowers what OTHER applications are playing and
// puts it back on release. The policy — the 200 ms start delay, the ramp, the "the user
// moved it, leave it" rule, the crash marker — is TypeScript (windows/src/platform/
// ducking.ts), where it is tested. This helper offers the two primitives that need COM:
//
//   * `audioSessions` — every audio session on every active render endpoint that is in
//     `AudioSessionStateActive` right now (a stream is open and running), with its process
//     id and its own volume. Inactive and expired sessions are not reported: only what is
//     actually playing is ever touched. The system-sounds session is left out — lowering
//     Windows' own dings is not what "lower other audio" means.
//   * `setSessionVolume` — one session's `ISimpleAudioVolume`, by the session's instance
//     identifier, read back after the write.
//
// Why per-session and not the endpoint volume the Mac moves: on Windows the master
// volume is shared by every app INCLUDING the one the user is dictating into, and a
// session volume is exactly the per-app mixer slider the user already knows. Lowering the
// music's slider leaves a video call's slider alone unless it too is playing.
//
// Instance identifiers are stable for a session's lifetime, which is what makes a crash
// marker written by one Kotiba process usable by the next.

/// The volumes from the last `audioSessions`, by instance id. A ramp step then costs one
/// COM call instead of a fresh enumeration; a session gone since is looked up again.
std::vector<std::pair<std::wstring, ISimpleAudioVolume*>> g_sessionCache;

void ClearSessionCache() {
  for (auto& entry : g_sessionCache) {
    if (entry.second != nullptr) entry.second->Release();
  }
  g_sessionCache.clear();
}

/// Every session on every active render endpoint. `onlyActive` filters by state; the
/// visitor gets the control and returns false to stop.
template <typename Visit>
bool ForEachSession(bool onlyActive, Visit visit) {
  IMMDeviceEnumerator* enumerator = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator))) ||
      enumerator == nullptr) {
    return false;
  }
  IMMDeviceCollection* devices = nullptr;
  if (FAILED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices)) ||
      devices == nullptr) {
    enumerator->Release();
    return false;
  }
  UINT deviceCount = 0;
  devices->GetCount(&deviceCount);
  bool keepGoing = true;
  for (UINT d = 0; d < deviceCount && keepGoing; ++d) {
    IMMDevice* device = nullptr;
    if (FAILED(devices->Item(d, &device)) || device == nullptr) continue;
    IAudioSessionManager2* manager = nullptr;
    if (SUCCEEDED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                                   reinterpret_cast<void**>(&manager))) &&
        manager != nullptr) {
      IAudioSessionEnumerator* sessions = nullptr;
      if (SUCCEEDED(manager->GetSessionEnumerator(&sessions)) && sessions != nullptr) {
        int sessionCount = 0;
        sessions->GetCount(&sessionCount);
        for (int i = 0; i < sessionCount && keepGoing; ++i) {
          IAudioSessionControl* control = nullptr;
          if (FAILED(sessions->GetSession(i, &control)) || control == nullptr) continue;
          IAudioSessionControl2* control2 = nullptr;
          if (SUCCEEDED(control->QueryInterface(__uuidof(IAudioSessionControl2),
                                                reinterpret_cast<void**>(&control2))) &&
              control2 != nullptr) {
            AudioSessionState state = AudioSessionStateInactive;
            control2->GetState(&state);
            const bool systemSounds = control2->IsSystemSoundsSession() == S_OK;
            if (!systemSounds && (!onlyActive || state == AudioSessionStateActive)) {
              keepGoing = visit(control2);
            }
            control2->Release();
          }
          control->Release();
        }
        sessions->Release();
      }
      manager->Release();
    }
    device->Release();
  }
  devices->Release();
  enumerator->Release();
  return true;
}

std::wstring InstanceId(IAudioSessionControl2* control) {
  LPWSTR raw = nullptr;
  std::wstring id;
  if (SUCCEEDED(control->GetSessionInstanceIdentifier(&raw)) && raw != nullptr) {
    id = raw;
    CoTaskMemFree(raw);
  }
  return id;
}

void HandleAudioSessions(const std::string& id) {
  ClearSessionCache();
  std::string list = "[";
  bool first = true;
  const bool ok = ForEachSession(true, [&](IAudioSessionControl2* control) {
    ISimpleAudioVolume* volume = nullptr;
    if (FAILED(control->QueryInterface(__uuidof(ISimpleAudioVolume),
                                       reinterpret_cast<void**>(&volume))) ||
        volume == nullptr) {
      return true;
    }
    float level = 0;
    BOOL muted = FALSE;
    volume->GetMasterVolume(&level);
    volume->GetMute(&muted);
    DWORD pid = 0;
    control->GetProcessId(&pid);
    const std::wstring instance = InstanceId(control);
    if (instance.empty()) {
      volume->Release();
      return true;
    }
    g_sessionCache.emplace_back(instance, volume);  // the cache owns the reference now
    kotiba::JsonWriter item;
    item.string("id", Narrow(instance))
        .integer("pid", static_cast<int64_t>(pid))
        .number("volume", static_cast<double>(level))
        .boolean("muted", muted != FALSE);
    if (!first) list += ",";
    list += item.finish();
    first = false;
    return true;
  });
  list += "]";
  if (!ok) {
    Refuse(id, "audioUnavailable", "the audio endpoints could not be enumerated");
    return;
  }
  kotiba::JsonWriter writer;
  writer.string("id", id).boolean("ok", true).raw("sessions", list);
  Emit(writer.finish());
}

void HandleSetSessionVolume(const kotiba::JsonObject& request, const std::string& id) {
  const std::wstring wanted = Widen(request.string("session"));
  double level = request.number("volume", -1);
  if (wanted.empty() || level < 0 || level > 1) {
    Refuse(id, kCodeBadRequest, "setSessionVolume needs a session and a volume in 0...1");
    return;
  }

  ISimpleAudioVolume* volume = nullptr;
  for (auto& entry : g_sessionCache) {
    if (entry.first == wanted) volume = entry.second;
  }
  bool owned = false;
  if (volume == nullptr) {
    // Not in the last listing — the restore after a crash, from a fresh process. Any
    // state: a session that paused since it was ducked must still get its level back.
    ForEachSession(false, [&](IAudioSessionControl2* control) {
      if (InstanceId(control) != wanted) return true;
      if (SUCCEEDED(control->QueryInterface(__uuidof(ISimpleAudioVolume),
                                            reinterpret_cast<void**>(&volume))) &&
          volume != nullptr) {
        owned = true;
      }
      return false;
    });
  }
  if (volume == nullptr) {
    Refuse(id, "sessionGone", "");
    return;
  }
  // `ifNear`: write only while the session still sits within `tolerance` of the level
  // Kotiba last left it at. Anything further away is the user moving the app's slider in
  // the mixer during the hold, and their choice stands — the Mac ducker's rule, checked
  // here in the same call as the write so there is no gap between the look and the leap.
  const double ifNear = request.number("ifNear", -1);
  if (ifNear >= 0) {
    float current = 0;
    volume->GetMasterVolume(&current);
    const double tolerance = request.number("tolerance", 0.02);
    if (std::fabs(static_cast<double>(current) - ifNear) > tolerance) {
      if (owned) volume->Release();
      kotiba::JsonWriter writer;
      writer.string("id", id)
          .boolean("ok", false)
          .string("code", "userChanged")
          .number("volume", static_cast<double>(current));
      Emit(writer.finish());
      return;
    }
  }
  const HRESULT set = volume->SetMasterVolume(static_cast<float>(level), nullptr);
  float readBack = static_cast<float>(level);
  volume->GetMasterVolume(&readBack);
  if (owned) volume->Release();
  if (FAILED(set)) {
    // AUDCLNT_E_DEVICE_INVALIDATED and friends: the device went away under the session.
    Refuse(id, "sessionGone", "SetMasterVolume failed, HRESULT=" + std::to_string(static_cast<long>(set)));
    return;
  }
  kotiba::JsonWriter writer;
  writer.string("id", id).boolean("ok", true).number("volume", static_cast<double>(readBack));
  Emit(writer.finish());
}

void HandleHello(const std::string& id) {
  kotiba::JsonWriter writer;
  writer.string("id", id)
      .boolean("ok", true)
      .string("helper", "kotiba-input")
      .string("version", kVersion);
  Emit(writer.finish());
}

void HandleLine(const std::string& line) {
  const kotiba::JsonObject request = kotiba::JsonObject::parse(line);
  const std::string id = request.string("id");
  if (!request.ok) {
    Refuse(id, kCodeBadRequest, request.error);
    return;
  }
  const std::string op = request.string("op");
  if (op == "insert") {
    HandleInsert(request, id);
  } else if (op == "replace") {
    HandleReplace(request, id);
  } else if (op == "foreground") {
    HandleForeground(id);
  } else if (op == "hello") {
    HandleHello(id);
  } else if (op == "audioSessions") {
    HandleAudioSessions(id);
  } else if (op == "setSessionVolume") {
    HandleSetSessionVolume(request, id);
  } else {
    // A refusal, not a death. The process stays alive and the caller learns why —
    // the same rule kotiba-stt follows, for the same reason.
    Refuse(id, kCodeBadRequest, "unknown op '" + op + "'");
  }
}

}  // namespace

int main(int argc, char** argv) {
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--version") == 0) {
      std::fprintf(stderr, "kotiba-input %s\n", kVersion);
      return 0;
    }
  }

  // Binary mode on both pipes. stdin carries UTF-8 JSON and stdout carries UTF-8 JSON;
  // the CRT's text-mode CRLF translation would corrupt both, and on stdout it would put
  // a `\r` at the end of every response line for the consumer to trip over.
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  setvbuf(stdout, nullptr, _IONBF, 0);

  // Single-threaded apartment: UI Automation is happy in one, and the restore thread
  // never touches COM.
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  std::fprintf(stderr, "kotiba-input %s: ready\n", kVersion);
  std::fflush(stderr);

  std::string line;
  int character = 0;
  while ((character = std::fgetc(stdin)) != EOF) {
    if (character == '\n') {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (!line.empty()) HandleLine(line);
      line.clear();
      continue;
    }
    line.push_back(static_cast<char>(character));
  }
  if (!line.empty()) HandleLine(line);

  ClearSessionCache();
  if (g_automation != nullptr) g_automation->Release();
  CoUninitialize();
  return 0;
}

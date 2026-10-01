// kotiba-stt — the persistent whisper host. D-W7.
//
// One process, one model, held for the life of the app. `whisper-cli.exe` per dictation
// reloads 539 MB of weights on every press of the key; that reload IS the reason this
// program exists, and nothing in here may reload a model between requests.
//
// The loop is: read a frame from stdin, run it, write one line of JSON to stdout. It
// never writes anything to stdout that is not a response line — whisper.cpp's own
// chatter is silenced through `whisper_log_set` for exactly that reason, the same call
// the Swift engine makes (WhisperEngine.swift:213).
//
// ---------------------------------------------------------------------------------
// THE FRAME, and why the length prefix is outside the JSON
// ---------------------------------------------------------------------------------
//
//     "KSTT" <8 hex headerBytes> <8 hex payloadBytes> "\n"     — 21 bytes, fixed
//     <headerBytes of UTF-8 JSON>
//     <payloadBytes of float32, little-endian, 16 kHz mono>
//
// The obvious design puts the sample count inside the JSON header. It cannot recover
// from a malformed header: if the JSON does not parse, the host does not know how many
// audio bytes follow, so it cannot resynchronise and the only honest thing left is to
// die. The brief requires that a malformed request be reported and survived, so the two
// lengths sit in a fixed-width prefix that is readable without parsing anything. A
// garbage header now costs one error line and the exact number of bytes it declared.
//
// Responses are one line of JSON, `\n`-terminated, flushed. `id` is echoed verbatim so
// a client can match them up, and `ok` is a boolean — never a sentence to be matched
// (D-W10). Every failure also carries `code`, which is what a caller branches on.
//
// TWO THREADS, SINCE 1.1 (C2, streaming Uzbek). The main thread reads frames; a worker
// thread runs `load`, `unload`, `transcribe`, `detect` and `shutdown` strictly in the order
// they arrived, exactly as the single loop did. Three kinds of request are answered by the
// READER instead, at once, whatever the worker is doing — because each is useless if it
// waits behind a decode:
//
//   * `abort` {target}: ends the named `transcribe` early (whisper polls the flag between
//     decoder steps) or drops it before it starts. A streaming session aborts a speculative
//     decode the moment new speech makes it stale, so the tail at key-release never queues
//     behind work nobody wants.
//   * `vad_open` / `vad` / `vad_reset` / `vad_close`: Silero VAD (ggml-silero-v6.2.0.bin,
//     whisper.cpp's own `whisper_vad_*`), one context per dictation, fed the capture stream
//     chunk by chunk while a commit may be decoding on the worker. A VAD answer that waited
//     for a 20 s commit decode would find every pause seconds late.
//
// Their ids start with `!` by convention, which is how the client tells an immediate answer
// from the one its serialised request is waiting for. Every line goes out under one mutex.
//
// A CRASH IS DISTINGUISHABLE FROM A REFUSAL. A refusal is a response line with
// `"ok":false` from a process that is still running. A crash is the absence of any
// line and a non-zero exit; the exit codes are enumerated in `ExitCode` below and none
// of them is ever reached by a bad request.

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

#include "json.h"
#include "whisper.h"
#ifdef GGML_BACKEND_DL
#include "ggml-backend.h"
#endif

namespace {

constexpr const char* kHostVersion = "1.1.0";
constexpr const char* kWhisperTag = "v1.9.2";
constexpr size_t kPrefixBytes = 21;  // "KSTT" + 8 + 8 + "\n"
/// 30 minutes of 16 kHz float32. A dictation is seconds; anything near this is a client
/// bug or a corrupted stream, and allocating on a bad length is how a host gets OOM-killed.
constexpr uint32_t kMaxPayloadBytes = 30u * 60u * 16000u * 4u;
/// A header longer than this is not a request. The initial prompt is the only field that
/// can be large and it is a vocabulary list, not a document.
constexpr uint32_t kMaxHeaderBytes = 1u << 20;

enum ExitCode : int {
  kExitClean = 0,
  /// stdin closed or a read failed mid-frame. The parent restarts us.
  kExitStreamEnded = 0,
  kExitStdioFailed = 2,
  /// The byte stream is no longer a sequence of frames. Unrecoverable by construction:
  /// we cannot know where the next frame starts. Never reached by a bad request, only
  /// by a client that is not speaking this protocol.
  kExitDesynchronised = 3,
};

// ---------------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------------

/// Reads exactly `count` bytes or reports that the stream ended.
bool readExactly(void* into, size_t count) {
  auto* cursor = static_cast<unsigned char*>(into);
  size_t got = 0;
  while (got < count) {
    const size_t n = std::fread(cursor + got, 1, count - got, stdin);
    if (n == 0) return false;
    got += n;
  }
  return true;
}

/// Two threads write responses; a line is never interleaved with another.
std::mutex gOutput;

void writeLine(const std::string& line) {
  std::lock_guard<std::mutex> lock(gOutput);
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

void respondError(const std::string& id, const char* code, const std::string& reason) {
  kotiba::JsonWriter writer;
  writer.string("id", id).boolean("ok", false).string("code", code).string("error", reason);
  writeLine(writer.finish());
}

/// Diagnostics go to stderr, which the parent captures and never parses.
void note(const std::string& text) {
  std::fputs(("kotiba-stt: " + text + "\n").c_str(), stderr);
  std::fflush(stderr);
}

// ---------------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------------

struct CoreCounts {
  int logical = 0;
  /// 0 when the platform will not say. The client must not divide by it.
  int physical = 0;
  /// Physical cores of the highest efficiency class — P-cores on a hybrid part, and
  /// equal to `physical` on a uniform one. 0 when unknown.
  int performance = 0;
};

/// What the machine actually is, as opposed to what `os.cpus().length` reports.
///
/// This exists because the macOS thread rule — `max(1, min(8, activeProcessorCount - 2))`
/// — was chosen against an M4 Pro, where every core is a real core and the count is not
/// inflated by SMT. On Windows the same number counts hyperthreads and E-cores, so the
/// identical formula describes a different machine. The host reports the truth and lets
/// the TypeScript side decide; see docs/windows/03-ENGINE-PARITY.md § threads.
CoreCounts detectCores() {
  CoreCounts counts;
#ifdef _WIN32
  SYSTEM_INFO info;
  GetSystemInfo(&info);
  counts.logical = static_cast<int>(info.dwNumberOfProcessors);

  DWORD length = 0;
  GetLogicalProcessorInformationEx(RelationProcessorCore, nullptr, &length);
  if (length > 0 && GetLastError() == ERROR_INSUFFICIENT_BUFFER) {
    std::vector<unsigned char> buffer(length);
    auto* first = reinterpret_cast<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX*>(buffer.data());
    if (GetLogicalProcessorInformationEx(RelationProcessorCore, first, &length)) {
      BYTE bestClass = 0;
      DWORD offset = 0;
      // Two passes: the efficiency class of the fastest core is not known until every
      // core has been seen, so counting P-cores in one pass would count whichever class
      // happened to appear first.
      while (offset < length) {
        const auto* entry =
            reinterpret_cast<const SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX*>(buffer.data() + offset);
        if (entry->Relationship == RelationProcessorCore) {
          ++counts.physical;
          bestClass = (std::max)(bestClass, entry->Processor.EfficiencyClass);
        }
        offset += entry->Size;
      }
      offset = 0;
      while (offset < length) {
        const auto* entry =
            reinterpret_cast<const SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX*>(buffer.data() + offset);
        if (entry->Relationship == RelationProcessorCore &&
            entry->Processor.EfficiencyClass == bestClass) {
          ++counts.performance;
        }
        offset += entry->Size;
      }
    }
  }
#else
  // The host is built and smoke-tested on macOS and Linux too, where there is no cheap
  // portable answer. Reporting 0 is honest; guessing is what produced the bug this
  // whole function exists to avoid.
  const long online = sysconf(_SC_NPROCESSORS_ONLN);
  counts.logical = online > 0 ? static_cast<int>(online) : 1;
#endif
  if (counts.logical < 1) counts.logical = 1;
  return counts;
}

// ---------------------------------------------------------------------------------
// The model, held
// ---------------------------------------------------------------------------------

class Host {
 public:
  ~Host() { unload(); }

  bool loaded() const { return context_ != nullptr; }
  const std::string& modelPath() const { return modelPath_; }

  /// Returns an empty string on success, or the reason it failed.
  std::string load(const std::string& path, bool useGpu, bool flashAttn) {
    if (context_ != nullptr && modelPath_ == path && useGpu_ == useGpu &&
        flashAttn_ == flashAttn) {
      return "";  // Idempotent. Reloading is the thing this program exists not to do.
    }
    unload();

    whisper_context_params params = whisper_context_default_params();
    params.use_gpu = useGpu;
    // Tied to the GPU flag with no separate control, exactly as WhisperEngine.swift:110.
    params.flash_attn = flashAttn;

    whisper_context* loaded = whisper_init_from_file_with_params(path.c_str(), params);
    if (loaded == nullptr) {
      return "whisper.cpp could not load " + path +
             " — the file may be truncated or not a ggml model";
    }
    context_ = loaded;
    modelPath_ = path;
    useGpu_ = useGpu;
    flashAttn_ = flashAttn;
    return "";
  }

  void unload() {
    if (context_ != nullptr) {
      whisper_free(context_);
      context_ = nullptr;
    }
    modelPath_.clear();
  }

  whisper_context* context() const { return context_; }

 private:
  whisper_context* context_ = nullptr;
  std::string modelPath_;
  bool useGpu_ = false;
  bool flashAttn_ = false;
};

// ---------------------------------------------------------------------------------
// whisper_full_params, field for field
// ---------------------------------------------------------------------------------

/// Builds the parameter struct from the request.
///
/// EVERY field the Swift `WhisperContext.run` sets is set here from the wire, and NO
/// field it leaves alone is touched. The full correspondence, with the Swift line
/// numbers, is docs/windows/03-ENGINE-PARITY.md — that table is the contract, this is
/// its implementation.
///
/// The two traps, both of which have already cost this project once:
///
///   * `greedy.best_of` is assigned in BOTH branches. `whisper_full_default_params`
///     fills only the struct arm for the strategy it was given, so the beam arm leaves
///     `greedy.best_of` at the struct literal -1, `max(1, -1) == 1`, and every
///     temperature-fallback rung above t=0 collapses to a single unranked draw from a
///     `std::discrete_distribution`. Setting only `beam_size` reproduces that bug
///     exactly.
///   * `language` and `initial_prompt` are `const char*` the C API does NOT copy. They
///     must outlive `whisper_full`, so the callers' `std::string`s are held by the
///     caller for the whole call and only their `c_str()` is stored here.
whisper_full_params buildParams(const kotiba::JsonObject& request, const std::string& language,
                                const std::string& initialPrompt, bool hasPrompt) {
  const std::string strategy = request.string("strategy", "greedy");
  const bool beam = (strategy == "beam");

  whisper_full_params params = whisper_full_default_params(
      beam ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY);

  params.print_realtime = request.boolean("printRealtime", false);
  params.print_progress = request.boolean("printProgress", false);
  params.print_timestamps = request.boolean("printTimestamps", false);
  params.print_special = request.boolean("printSpecial", false);
  params.no_timestamps = request.boolean("noTimestamps", true);

  params.translate = request.boolean("translate", false);
  params.single_segment = request.boolean("singleSegment", false);
  params.suppress_blank = request.boolean("suppressBlank", true);

  params.no_speech_thold = static_cast<float>(request.number("noSpeechThold", 0.6));
  params.n_threads = static_cast<int>(request.integer("nThreads", 4));
  if (params.n_threads < 1) params.n_threads = 1;

  // Only in the beam branch. In the greedy branch whisper's own -1 must stand: passing
  // beam_size 1 with a beam strategy is a different decoder, not a faster one.
  if (beam) {
    params.beam_search.beam_size = static_cast<int>(request.integer("beamSearchBeamSize", 5));
  }

  // Unconditional. See the comment above; this line is the whole reason it is there.
  params.greedy.best_of = static_cast<int>(request.integer("greedyBestOf", 5));

  params.language = language.c_str();
  // Never true. The router already decided, and whisper's own language ID is what scored
  // `uz 0.00` on clean Uzbek — letting it choose is how Uzbek silently became Turkish.
  params.detect_language = request.boolean("detectLanguage", false);

  params.initial_prompt = hasPrompt ? initialPrompt.c_str() : nullptr;

  // The encoder window, in positions (50 per second). 0 — and absence, and anything
  // negative — is whisper's own "the model's window". The streaming Uzbek tail sends a
  // window fitted to the audio plus 5 s of silence, rounded to 256 (C2 §3); that is only
  // safe with flash attention OFF on this context, which the client sets at `load`.
  const int64_t audioCtx = request.integer("audioCtx", 0);
  params.audio_ctx = audioCtx > 0 ? static_cast<int>(audioCtx) : 0;

  return params;
}

// ---------------------------------------------------------------------------------
// Abort — the streaming session's speculative decodes
// ---------------------------------------------------------------------------------

/// Which `transcribe` is running, which queued ones were abandoned, and the flag whisper
/// polls. Written by the reader (`abort`) and the worker (start and end of a decode).
struct AbortBook {
  std::mutex lock;
  std::string running;
  std::set<std::string> dropped;
  std::atomic<bool> raised{false};
};

AbortBook gAbort;

/// whisper.cpp calls this before each ggml computation; true ends `whisper_full` early.
bool abortRequested(void* data) {
  return static_cast<std::atomic<bool>*>(data)->load(std::memory_order_relaxed);
}

// ---------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------

/// Whisper is asked for at least one second of audio.
///
/// whisper.cpp returns SUCCESS with ZERO SEGMENTS for anything under 10 mel frames, so a
/// short utterance comes back as a silent empty transcript — which is the exact v1 defect
/// this project exists to eliminate. The client pads too (`padForDecode`); this is the
/// backstop, because a caller that forgets must still get a transcript rather than a
/// plausible-looking empty string.
constexpr size_t kMinimumSamples = 16000;

void padForDecode(std::vector<float>& samples) {
  if (samples.size() < kMinimumSamples) samples.resize(kMinimumSamples, 0.0f);
}

void handleTranscribe(Host& host, const kotiba::JsonObject& request, const std::string& id,
                      std::vector<float>& samples) {
  if (!host.loaded()) {
    respondError(id, "no_model", "no model is loaded — send `load` first");
    return;
  }
  if (samples.empty()) {
    respondError(id, "no_audio", "no audio");
    return;
  }
  const std::string language = request.string("language", "");
  if (language.empty()) {
    // The engine NEVER lets whisper auto-detect; detection is a separate pass on a
    // separate model. An absent language is a client bug, not a request to guess.
    respondError(id, "bad_request", "`language` is required — this host never auto-detects");
    return;
  }

  padForDecode(samples);

  const bool hasPrompt = request.has("initialPrompt") && !request.isNull("initialPrompt");
  // Held here, in the caller's scope, for the whole whisper_full call. See buildParams.
  const std::string initialPrompt = hasPrompt ? request.string("initialPrompt", "") : "";
  whisper_full_params params = buildParams(request, language, initialPrompt, hasPrompt);

  // Abandoned while it waited in the queue: never started, never costs a decode.
  {
    std::lock_guard<std::mutex> lock(gAbort.lock);
    if (gAbort.dropped.erase(id) > 0) {
      respondError(id, "aborted", "aborted before it started");
      return;
    }
    gAbort.running = id;
    gAbort.raised.store(false, std::memory_order_relaxed);
  }
  params.abort_callback = abortRequested;
  params.abort_callback_user_data = &gAbort.raised;

  const auto began = std::chrono::steady_clock::now();
  const int status =
      whisper_full(host.context(), params, samples.data(), static_cast<int>(samples.size()));
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::steady_clock::now() - began)
                           .count();

  bool aborted = false;
  {
    std::lock_guard<std::mutex> lock(gAbort.lock);
    gAbort.running.clear();
    aborted = gAbort.raised.exchange(false, std::memory_order_relaxed);
  }
  if (aborted) {
    // Whatever whisper returned, the caller said it no longer wants this text.
    respondError(id, "aborted", "aborted after " + std::to_string(elapsed) + " ms");
    return;
  }

  if (status != 0) {
    respondError(id, "decode_failed",
                 "whisper_full returned " + std::to_string(status));
    return;
  }

  // Segment texts carry their own leading space. Joining with ' ' double-spaces every
  // boundary, so they are concatenated with no separator — WhisperEngine.swift:292.
  std::string text;
  const int segments = whisper_full_n_segments(host.context());
  for (int index = 0; index < segments; ++index) {
    const char* segment = whisper_full_get_segment_text(host.context(), index);
    if (segment == nullptr) continue;
    text += segment;
  }

  kotiba::JsonWriter writer;
  writer.string("id", id)
      .boolean("ok", true)
      .string("text", text)
      .integer("segments", segments)
      .integer("ms", elapsed)
      .integer("audioCtx", params.audio_ctx);
  writeLine(writer.finish());
}

void handleDetect(Host& host, const kotiba::JsonObject& request, const std::string& id,
                  std::vector<float>& samples) {
  if (!host.loaded()) {
    respondError(id, "no_model", "no model is loaded — send `load` first");
    return;
  }
  if (samples.empty()) {
    respondError(id, "no_audio", "no audio");
    return;
  }

  // Whisper's encoder always consumes a 30 s frame, padding what it is given, so a
  // longer clip costs no more than a short one — but trimming keeps the mel computation
  // honest about what it is looking at (LanguageDetector.swift:90-95).
  const size_t window =
      static_cast<size_t>(request.integer("windowSeconds", 30)) * kMinimumSamples;
  if (window > 0 && samples.size() > window) samples.resize(window);
  padForDecode(samples);

  int threads = static_cast<int>(request.integer("nThreads", 4));
  if (threads < 1) threads = 1;

  // The encoder window the head reads, in positions (50 per second; 0, absence and anything
  // negative = the model's 1500). The Turkish check sends a window fitted to the audio
  // (TurkishCheck.headMargin on the Mac, C4 §13): the full window cost the Mac 0.56 s a
  // check and this CPU several times that, for a head that separates Turkish from Uzbek at
  // least as well fitted. The detector sends nothing and reads the full window as before.
  //
  // whisper.cpp v1.9.2 has no setter for the window `whisper_lang_auto_detect` encodes with:
  // it reads the state's `exp_n_audio_ctx`, which only `whisper_full` writes — and which a
  // streaming decode on this context leaves fitted to ITS audio, so without this the head's
  // window was whatever the last decode used. So a `whisper_full` whose encoder-begin
  // callback refuses to start computes the mel, writes the window and stops before the
  // encoder; the head then encodes once, with exactly that window, on every call.
  const int64_t audioCtx = request.integer("audioCtx", 0);
  whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  params.n_threads = threads;
  params.print_progress = false;
  params.print_realtime = false;
  params.print_timestamps = false;
  params.no_timestamps = true;
  params.language = "en";
  params.detect_language = false;
  params.audio_ctx = audioCtx > 0 ? static_cast<int>(audioCtx) : 0;
  params.encoder_begin_callback = [](whisper_context*, whisper_state*, void*) { return false; };
  params.encoder_begin_callback_user_data = nullptr;
  if (whisper_full(host.context(), params, samples.data(), static_cast<int>(samples.size())) != 0) {
    respondError(id, "detect_failed", "whisper could not compute the mel for the audio");
    return;
  }

  const int count = whisper_lang_max_id() + 1;
  std::vector<float> probabilities(static_cast<size_t>(count), 0.0f);
  const int top =
      whisper_lang_auto_detect(host.context(), 0, threads, probabilities.data());
  if (top < 0) {
    respondError(id, "detect_failed", "whisper_lang_auto_detect returned " + std::to_string(top));
    return;
  }

  std::vector<std::pair<std::string, double>> posterior;
  posterior.reserve(static_cast<size_t>(count));
  for (int language = 0; language < count; ++language) {
    const double probability = static_cast<double>(probabilities[static_cast<size_t>(language)]);
    // Everything below a thousandth is noise across 99 languages and only makes the
    // diagnostics harder to read (LanguageDetector.swift:131-133).
    if (probability <= 0.001) continue;
    const char* name = whisper_lang_str(language);
    if (name == nullptr) continue;
    posterior.emplace_back(name, probability);
  }

  kotiba::JsonWriter writer;
  writer.string("id", id).boolean("ok", true).integer("audioCtx", params.audio_ctx)
      .posterior("posterior", posterior);
  writeLine(writer.finish());
}

void handleHello(const kotiba::JsonObject& request, const std::string& id) {
  (void)request;
  const CoreCounts cores = detectCores();
  kotiba::JsonWriter writer;
  writer.string("id", id)
      .boolean("ok", true)
      .string("host", kHostVersion)
      .string("whisper", kWhisperTag)
      .integer("logicalCores", cores.logical)
      .integer("physicalCores", cores.physical)
      .integer("performanceCores", cores.performance);
  writeLine(writer.finish());
}

// ---------------------------------------------------------------------------------
// Silero VAD — answered by the reader, one context per dictation
// ---------------------------------------------------------------------------------

/// Open VAD contexts by handle. Touched only by the reader thread.
std::map<int64_t, whisper_vad_context*> gVads;
int64_t gNextVad = 1;

void handleVadOpen(const kotiba::JsonObject& request, const std::string& id) {
  const std::string path = request.string("model", "");
  if (path.empty()) {
    respondError(id, "bad_request", "`model` is required");
    return;
  }
  whisper_vad_context_params params = whisper_vad_default_context_params();
  // CPU, one thread. It is tiny, and the decoder is the thing that needs the machine.
  params.use_gpu = false;
  params.n_threads = 1;
  whisper_vad_context* context = whisper_vad_init_from_file_with_params(path.c_str(), params);
  if (context == nullptr) {
    respondError(id, "vad_failed", "whisper.cpp could not load the VAD model " + path);
    return;
  }
  const int64_t handle = gNextVad++;
  gVads[handle] = context;
  kotiba::JsonWriter writer;
  writer.string("id", id).boolean("ok", true).integer("handle", handle).integer("frameSamples", 512);
  writeLine(writer.finish());
}

void handleVad(const kotiba::JsonObject& request, const std::string& id, const std::vector<float>& samples) {
  const auto found = gVads.find(request.integer("handle", 0));
  if (found == gVads.end()) {
    respondError(id, "no_vad", "no VAD context with that handle");
    return;
  }
  // Whole 512-sample frames only; the caller keeps the remainder for the next call. The
  // LSTM state carries over between calls — that is what makes it causal — and is reset
  // only by `vad_reset`, between dictations.
  const size_t frames = samples.size() / 512;
  std::string json = "[";
  if (frames > 0) {
    const bool ok = whisper_vad_detect_speech_no_reset(found->second, samples.data(),
                                                       static_cast<int>(frames * 512));
    const int count = ok ? whisper_vad_n_probs(found->second) : 0;
    const float* probs = ok ? whisper_vad_probs(found->second) : nullptr;
    for (size_t index = 0; index < frames; ++index) {
      // A failed graph must not read as silence — that would trim words. It reads as
      // speech, which only delays a cut. (SileroSpeechDetector.swift does the same.)
      const float p = (probs != nullptr && static_cast<int>(index) < count) ? probs[index] : 1.0f;
      char buffer[16];
      std::snprintf(buffer, sizeof(buffer), "%s%.4f", index == 0 ? "" : ",", static_cast<double>(p));
      json += buffer;
    }
  }
  json += "]";
  kotiba::JsonWriter writer;
  writer.string("id", id).boolean("ok", true).raw("probs", json);
  writeLine(writer.finish());
}

void handleVadReset(const kotiba::JsonObject& request, const std::string& id) {
  const auto found = gVads.find(request.integer("handle", 0));
  if (found == gVads.end()) {
    respondError(id, "no_vad", "no VAD context with that handle");
    return;
  }
  whisper_vad_reset_state(found->second);
  kotiba::JsonWriter writer;
  writer.string("id", id).boolean("ok", true);
  writeLine(writer.finish());
}

void handleVadClose(const kotiba::JsonObject& request, const std::string& id) {
  const auto found = gVads.find(request.integer("handle", 0));
  if (found != gVads.end()) {
    whisper_vad_free(found->second);
    gVads.erase(found);
  }
  kotiba::JsonWriter writer;
  writer.string("id", id).boolean("ok", true);
  writeLine(writer.finish());
}

void handleAbort(const kotiba::JsonObject& request, const std::string& id) {
  const std::string target = request.string("target", "");
  bool running = false;
  {
    std::lock_guard<std::mutex> lock(gAbort.lock);
    if (!target.empty() && gAbort.running == target) {
      gAbort.raised.store(true, std::memory_order_relaxed);
      running = true;
    } else if (!target.empty()) {
      // Not running: queued, or already answered. Remembered so the worker skips it if it
      // is still coming; bounded, because an abort for a finished request is never cleared.
      if (gAbort.dropped.size() > 256) gAbort.dropped.clear();
      gAbort.dropped.insert(target);
    }
  }
  kotiba::JsonWriter writer;
  writer.string("id", id).boolean("ok", true).boolean("running", running);
  writeLine(writer.finish());
}

// ---------------------------------------------------------------------------------
// The worker: everything that touches the whisper context, in arrival order
// ---------------------------------------------------------------------------------

struct Job {
  kotiba::JsonObject request;
  std::string id;
  std::string op;
  std::vector<float> samples;
  /// For op `!refuse`: a refusal the reader decided on, answered IN ORDER by the worker, so
  /// a malformed request's error line still comes after the lines of everything sent
  /// before it — the order the single loop gave and the protocol test holds.
  std::string code;
  std::string reason;
};

class JobQueue {
 public:
  void push(Job job) {
    {
      std::lock_guard<std::mutex> lock(lock_);
      jobs_.push_back(std::move(job));
    }
    ready_.notify_one();
  }
  /// No more jobs will come; the worker drains what is queued and stops.
  void close() {
    {
      std::lock_guard<std::mutex> lock(lock_);
      closed_ = true;
    }
    ready_.notify_one();
  }
  /// False once closed and empty.
  bool pop(Job& into) {
    std::unique_lock<std::mutex> lock(lock_);
    ready_.wait(lock, [this] { return closed_ || !jobs_.empty(); });
    if (jobs_.empty()) return false;
    into = std::move(jobs_.front());
    jobs_.pop_front();
    return true;
  }

 private:
  std::mutex lock_;
  std::condition_variable ready_;
  std::deque<Job> jobs_;
  bool closed_ = false;
};

void runJob(Host& host, Job& job) {
  const std::string& op = job.op;
  const std::string& id = job.id;
  if (op == "!refuse") {
    respondError(id, job.code.c_str(), job.reason);
    return;
  }
  if (op == "hello") {
    handleHello(job.request, id);
    return;
  }
  if (op == "load") {
    const std::string path = job.request.string("model", "");
    if (path.empty()) {
      respondError(id, "bad_request", "`model` is required");
      return;
    }
    const std::string failure = host.load(path, job.request.boolean("useGpu", false),
                                          job.request.boolean("flashAttn", false));
    if (!failure.empty()) {
      respondError(id, "model_corrupt", failure);
      return;
    }
    kotiba::JsonWriter writer;
    writer.string("id", id).boolean("ok", true).string("model", host.modelPath());
    writeLine(writer.finish());
    return;
  }
  if (op == "unload") {
    host.unload();
    kotiba::JsonWriter writer;
    writer.string("id", id).boolean("ok", true);
    writeLine(writer.finish());
    return;
  }
  if (op == "transcribe") {
    handleTranscribe(host, job.request, id, job.samples);
    return;
  }
  if (op == "detect") {
    handleDetect(host, job.request, id, job.samples);
    return;
  }
  respondError(id, "unknown_op", "no operation named '" + op + "'");
}

// ---------------------------------------------------------------------------------
// The reader: frames off stdin
// ---------------------------------------------------------------------------------

enum class FrameOutcome { kHandled, kShutdown, kStreamEnded, kDesynchronised };

/// A refusal decided by the reader, answered by the worker in arrival order.
void refuseInOrder(JobQueue& queue, const std::string& id, const char* code, const std::string& reason) {
  Job job;
  job.id = id;
  job.op = "!refuse";
  job.code = code;
  job.reason = reason;
  queue.push(std::move(job));
}

FrameOutcome readAndDispatchFrame(JobQueue& queue, std::string& shutdownId) {
  char prefix[kPrefixBytes + 1] = {0};
  if (!readExactly(prefix, kPrefixBytes)) return FrameOutcome::kStreamEnded;

  if (std::memcmp(prefix, "KSTT", 4) != 0 || prefix[kPrefixBytes - 1] != '\n') {
    // Not a frame boundary. There is no way to find the next one without guessing, and
    // guessing at a stream that carries megabytes of raw float is worse than stopping.
    note("frame prefix is not KSTT — the stream is not this protocol");
    respondError("", "bad_frame", "the stream is not framed as this protocol expects");
    return FrameOutcome::kDesynchronised;
  }

  unsigned headerBytes = 0;
  unsigned payloadBytes = 0;
  if (std::sscanf(prefix + 4, "%8x%8x", &headerBytes, &payloadBytes) != 2) {
    note("frame prefix carries no lengths");
    respondError("", "bad_frame", "the frame prefix does not carry two hex lengths");
    return FrameOutcome::kDesynchronised;
  }
  if (headerBytes > kMaxHeaderBytes || payloadBytes > kMaxPayloadBytes) {
    note("frame declares an implausible length");
    respondError("", "bad_frame", "the frame declares more bytes than this host will accept");
    return FrameOutcome::kDesynchronised;
  }
  if (payloadBytes % 4 != 0) {
    // Not fatal on its own, but the payload is float32 and a length that is not a
    // multiple of four means the sender is building the buffer wrong. Drain it so the
    // next frame still lines up, then refuse.
    std::vector<unsigned char> discard(payloadBytes);
    std::string header(headerBytes, '\0');
    if (headerBytes > 0 && !readExactly(&header[0], headerBytes)) {
      return FrameOutcome::kStreamEnded;
    }
    if (payloadBytes > 0 && !readExactly(discard.data(), payloadBytes)) {
      return FrameOutcome::kStreamEnded;
    }
    refuseInOrder(queue, "", "bad_frame", "the audio payload is not a whole number of float32 samples");
    return FrameOutcome::kHandled;
  }

  std::string header(headerBytes, '\0');
  if (headerBytes > 0 && !readExactly(&header[0], headerBytes)) {
    return FrameOutcome::kStreamEnded;
  }

  // Read the payload BEFORE anything can fail on the header. This is what makes a
  // malformed request survivable: the declared bytes always leave the pipe, so the next
  // frame starts where it said it would whatever the header turned out to be.
  std::vector<float> samples(payloadBytes / 4);
  if (payloadBytes > 0 && !readExactly(samples.data(), payloadBytes)) {
    return FrameOutcome::kStreamEnded;
  }

  const kotiba::JsonObject request = kotiba::JsonObject::parse(header);
  if (!request.ok) {
    refuseInOrder(queue, "", "bad_json", request.error);
    return FrameOutcome::kHandled;
  }

  const std::string id = request.string("id", "");
  const std::string op = request.string("op", "");

  // Answered here, now — see the header of this file for why each one cannot wait.
  if (op == "abort") {
    handleAbort(request, id);
    return FrameOutcome::kHandled;
  }
  if (op == "vad_open") {
    handleVadOpen(request, id);
    return FrameOutcome::kHandled;
  }
  if (op == "vad") {
    handleVad(request, id, samples);
    return FrameOutcome::kHandled;
  }
  if (op == "vad_reset") {
    handleVadReset(request, id);
    return FrameOutcome::kHandled;
  }
  if (op == "vad_close") {
    handleVadClose(request, id);
    return FrameOutcome::kHandled;
  }
  if (op == "shutdown") {
    // Answered AFTER everything queued before it, as the single loop did: the caller sees
    // every earlier response, then this one.
    shutdownId = id;
    return FrameOutcome::kShutdown;
  }
  if (op == "hello" || op == "load" || op == "unload" || op == "transcribe" || op == "detect") {
    Job job;
    job.request = request;
    job.id = id;
    job.op = op;
    job.samples = std::move(samples);
    queue.push(std::move(job));
    return FrameOutcome::kHandled;
  }

  refuseInOrder(queue, id, "unknown_op", "no operation named '" + op + "'");
  return FrameOutcome::kHandled;
}

}  // namespace

int main() {
#ifdef _WIN32
  // Without this the CRT translates \n to \r\n on the way out and, far worse, eats 0x1A
  // in the float payload on the way in. A model whose weights are fine and whose audio
  // silently truncates at the first EOF byte is a bug that presents as bad accuracy.
  if (_setmode(_fileno(stdin), _O_BINARY) == -1) return kExitStdioFailed;
  if (_setmode(_fileno(stdout), _O_BINARY) == -1) return kExitStdioFailed;
#endif

  // whisper.cpp writes progress and tensor chatter to stderr by default. Here it would
  // also risk reaching stdout through some future build's logger, and stdout carries the
  // protocol. Silenced once, exactly as WhisperEngine.swift:213 does.
  whisper_log_set([](ggml_log_level, const char*, void*) {}, nullptr);

#ifdef GGML_BACKEND_DL
  // KOTIBA_CPU_ALL_VARIANTS (CMakeLists.txt): the CPU backend is not linked in, it is one
  // ggml-cpu-<variant>.dll per x86 level beside this exe. This scores them against CPUID and
  // loads the best one the machine can run. Without it there is no CPU device at all and
  // every `load` fails — so it runs once, here, before anything can ask for a model.
  ggml_backend_load_all();
  if (ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU) == nullptr) {
    note("no ggml-cpu-*.dll this CPU can run was found beside kotiba-stt.exe");
  }
#endif

  note(std::string("ready — host ") + kHostVersion + ", whisper.cpp " + kWhisperTag);

  Host host;
  JobQueue queue;
  std::thread worker([&host, &queue] {
    Job job;
    while (queue.pop(job)) runJob(host, job);
  });

  int exitCode = kExitClean;
  std::string shutdownId;
  bool shutdown = false;
  for (;;) {
    const FrameOutcome outcome = readAndDispatchFrame(queue, shutdownId);
    if (outcome == FrameOutcome::kHandled) continue;
    if (outcome == FrameOutcome::kShutdown) {
      shutdown = true;
      break;
    }
    exitCode = outcome == FrameOutcome::kStreamEnded ? kExitStreamEnded : kExitDesynchronised;
    break;
  }

  // Everything already queued is still answered — a parent that wrote a request and then
  // closed stdin gets its line, as it did from the single loop. Then the model is freed.
  queue.close();
  worker.join();
  for (auto& entry : gVads) whisper_vad_free(entry.second);
  gVads.clear();
  if (shutdown) {
    kotiba::JsonWriter writer;
    writer.string("id", shutdownId).boolean("ok", true);
    writeLine(writer.finish());
  }
  return exitCode;
}

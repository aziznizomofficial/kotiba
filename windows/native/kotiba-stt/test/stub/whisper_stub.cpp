// Deterministic fakes for the protocol test. NOT part of the shipping build.
//
// `whisper_full` does not decode anything; it writes the parameters it was handed into
// the "transcript". That is what lets the test assert the two things that already
// shipped wrong once — `greedy.best_of == 5` in the BEAM branch, and `beam_size`
// untouched in the greedy branch — without a 539 MB model or a real decode.
//
// The defaults below are the REAL whisper.cpp v1.9.2 defaults, transcribed from the tag,
// so a field main.cpp forgets to set shows up in the echo at its true default rather
// than at zero.

#include "whisper.h"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace {
std::string gTranscript;
int gSegments = 0;

/// Any path containing this is treated as an unloadable model, so the test can drive
/// the corrupt-model branch without producing a corrupt file.
const char* kRefuseMarker = "REFUSE";
}  // namespace

struct whisper_context {
  int marker = 0xC0FFEE;
};

extern "C" {

struct whisper_context_params whisper_context_default_params(void) {
  struct whisper_context_params params;
  params.use_gpu = true;
  params.flash_attn = true;
  params.gpu_device = 0;
  params.dtw_token_timestamps = false;
  return params;
}

struct whisper_full_params whisper_full_default_params(enum whisper_sampling_strategy strategy) {
  struct whisper_full_params params;
  std::memset(&params, 0, sizeof(params));

  params.strategy = strategy;
  params.n_threads = 4;
  params.n_max_text_ctx = 16384;
  params.offset_ms = 0;
  params.duration_ms = 0;

  params.translate = false;
  params.no_context = true;
  params.no_timestamps = false;
  params.single_segment = false;
  params.print_special = false;
  params.print_progress = true;
  params.print_realtime = false;
  params.print_timestamps = true;

  params.token_timestamps = false;
  params.thold_pt = 0.01f;
  params.thold_ptsum = 0.01f;
  params.max_len = 0;
  params.split_on_word = false;
  params.max_tokens = 0;

  params.debug_mode = false;
  params.audio_ctx = 0;
  params.tdrz_enable = false;
  params.suppress_regex = nullptr;
  params.initial_prompt = nullptr;
  params.carry_initial_prompt = false;
  params.prompt_tokens = nullptr;
  params.prompt_n_tokens = 0;
  params.language = "en";
  params.detect_language = false;
  params.suppress_blank = true;
  params.suppress_nst = false;
  params.temperature = 0.0f;
  params.max_initial_ts = 1.0f;
  params.length_penalty = -1.0f;
  params.temperature_inc = 0.2f;
  params.entropy_thold = 2.4f;
  params.logprob_thold = -1.0f;
  params.no_speech_thold = 0.6f;

  // THE POINT OF THIS FILE. whisper_full_default_params fills only the arm for the
  // strategy it was given; the other keeps the struct literal -1. Reproduced exactly.
  params.greedy.best_of = -1;
  params.beam_search.beam_size = -1;
  params.beam_search.patience = -1.0f;

  if (strategy == WHISPER_SAMPLING_GREEDY) {
    params.greedy.best_of = 5;
  } else {
    params.beam_search.beam_size = 5;
  }

  return params;
}

struct whisper_context* whisper_init_from_file_with_params(const char* path_model,
                                                           struct whisper_context_params params) {
  (void)params;
  if (path_model == nullptr) return nullptr;
  if (std::strstr(path_model, kRefuseMarker) != nullptr) return nullptr;
  return new whisper_context();
}

void whisper_free(struct whisper_context* ctx) { delete ctx; }

/// The encoder window the last `whisper_full` wrote into the (only) state.
static int gWindow = 0;

int whisper_full(struct whisper_context* ctx, struct whisper_full_params params,
                 const float* samples, int n_samples) {
  if (ctx == nullptr) return -1;
  (void)samples;

  // As v1.9.2 does: the mel and the state's encoder window are written before the main
  // loop, whose first act is to ask the encoder-begin callback. Refused, nothing is decoded
  // — the Turkish check's way of setting the window its language head reads.
  gWindow = params.audio_ctx;
  if (params.encoder_begin_callback != nullptr &&
      !params.encoder_begin_callback(ctx, nullptr, params.encoder_begin_callback_user_data)) {
    return 0;
  }

  // A prompt containing SLOW decodes for up to two seconds, polling the abort callback the
  // way whisper.cpp polls it between computations — so the test can abort one mid-flight.
  if (params.initial_prompt != nullptr && std::strstr(params.initial_prompt, "SLOW") != nullptr) {
    for (int step = 0; step < 200; ++step) {
      if (params.abort_callback != nullptr && params.abort_callback(params.abort_callback_user_data)) {
        return -6;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
  }

  char buffer[1024];
  std::snprintf(buffer, sizeof(buffer),
                "strategy=%d n_threads=%d best_of=%d beam_size=%d translate=%d "
                "no_timestamps=%d single_segment=%d suppress_blank=%d no_speech_thold=%.2f "
                "detect_language=%d language=%s prompt=%s no_context=%d audio_ctx=%d "
                "temperature=%.2f temperature_inc=%.2f entropy_thold=%.2f logprob_thold=%.2f "
                "print_progress=%d print_timestamps=%d n_samples=%d",
                static_cast<int>(params.strategy), params.n_threads, params.greedy.best_of,
                params.beam_search.beam_size, params.translate ? 1 : 0,
                params.no_timestamps ? 1 : 0, params.single_segment ? 1 : 0,
                params.suppress_blank ? 1 : 0, static_cast<double>(params.no_speech_thold),
                params.detect_language ? 1 : 0,
                params.language == nullptr ? "(null)" : params.language,
                params.initial_prompt == nullptr ? "(null)" : params.initial_prompt,
                params.no_context ? 1 : 0, params.audio_ctx,
                static_cast<double>(params.temperature),
                static_cast<double>(params.temperature_inc),
                static_cast<double>(params.entropy_thold),
                static_cast<double>(params.logprob_thold), params.print_progress ? 1 : 0,
                params.print_timestamps ? 1 : 0, n_samples);
  gTranscript = buffer;
  gSegments = 1;
  return 0;
}

int whisper_full_n_segments(struct whisper_context* ctx) {
  (void)ctx;
  return gSegments;
}

const char* whisper_full_get_segment_text(struct whisper_context* ctx, int i_segment) {
  (void)ctx;
  if (i_segment != 0) return nullptr;
  return gTranscript.c_str();
}

int whisper_pcm_to_mel(struct whisper_context* ctx, const float* samples, int n_samples,
                       int n_threads) {
  (void)samples;
  (void)n_samples;
  (void)n_threads;
  return ctx == nullptr ? -1 : 0;
}

int whisper_lang_max_id(void) { return 4; }

const char* whisper_lang_str(int id) {
  static const char* names[] = {"en", "ru", "tr", "az", "uz"};
  if (id < 0 || id > 4) return nullptr;
  return names[id];
}

int whisper_lang_auto_detect(struct whisper_context* ctx, int offset_ms, int n_threads,
                             float* lang_probs) {
  (void)offset_ms;
  (void)n_threads;
  if (ctx == nullptr || lang_probs == nullptr) return -1;
  // The shape the routing research measured on clean Uzbek: `tr` wins, `uz` scores zero.
  // A value under the 0.001 floor is included so the test can assert it is dropped.
  lang_probs[0] = 0.10f;    // en
  lang_probs[1] = 0.0005f;  // ru — below the noise floor, must NOT appear
  lang_probs[2] = 0.63f;    // tr
  // `az` reports the encoder window the last `whisper_full` set (per ten thousand), so the
  // protocol test can see which window the head read; the model's own (0) reads as 0.17.
  lang_probs[3] = gWindow > 0 ? static_cast<float>(gWindow) / 10000.0f : 0.17f;    // az
  lang_probs[4] = 0.00f;    // uz
  return 2;
}

// A fake Silero: speech wherever a 512-sample frame's mean magnitude is over 0.1, so the
// test feeds loud and quiet chunks and reads the decisions back. Keeps a frame count as its
// "state", so reset is observable.
struct whisper_vad_context {
  std::vector<float> probs;
  int framesSeen = 0;
};

struct whisper_vad_context_params whisper_vad_default_context_params(void) {
  struct whisper_vad_context_params params;
  params.n_threads = 4;
  params.use_gpu = true;
  params.gpu_device = 0;
  return params;
}

struct whisper_vad_context* whisper_vad_init_from_file_with_params(
    const char* path_model, struct whisper_vad_context_params params) {
  (void)params;
  if (path_model == nullptr || std::strstr(path_model, kRefuseMarker) != nullptr) return nullptr;
  return new whisper_vad_context();
}

bool whisper_vad_detect_speech_no_reset(struct whisper_vad_context* vctx, const float* samples,
                                        int n_samples) {
  if (vctx == nullptr) return false;
  vctx->probs.clear();
  for (int start = 0; start + 512 <= n_samples; start += 512) {
    double sum = 0;
    for (int i = 0; i < 512; ++i) sum += samples[start + i] < 0 ? -samples[start + i] : samples[start + i];
    vctx->probs.push_back(sum / 512 > 0.1 ? 0.9f : 0.05f);
    ++vctx->framesSeen;
  }
  return true;
}

void whisper_vad_reset_state(struct whisper_vad_context* vctx) {
  if (vctx != nullptr) vctx->framesSeen = 0;
}

int whisper_vad_n_probs(struct whisper_vad_context* vctx) {
  return vctx == nullptr ? 0 : static_cast<int>(vctx->probs.size());
}

float* whisper_vad_probs(struct whisper_vad_context* vctx) {
  return vctx == nullptr || vctx->probs.empty() ? nullptr : vctx->probs.data();
}

void whisper_vad_free(struct whisper_vad_context* ctx) { delete ctx; }

void whisper_log_set(ggml_log_callback log_callback, void* user_data) {
  (void)log_callback;
  (void)user_data;
}

}  // extern "C"

// A STUB whisper.h, for the protocol test only. NOT part of the shipping build.
//
// The shipping host links whisper.cpp v1.9.2 (see ../../CMakeLists.txt). That build
// needs cmake, a compiler and ~10 minutes, and nobody on this project owns the Windows
// machine it targets — so the framing, the JSON, the malformed-request handling and the
// parameter plumbing would otherwise ship with no test at all.
//
// This declares exactly the symbols main.cpp uses, with the exact v1.9.2 signatures
// (fetched from the tag), so a mismatch between main.cpp and the real header is a
// compile error here rather than a surprise on a runner. The bodies in whisper_stub.cpp
// are deterministic fakes that ECHO BACK the parameters they were given, which is what
// lets the test assert `greedy.best_of == 5` in the beam branch.

#ifndef WHISPER_H
#define WHISPER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum ggml_log_level {
  GGML_LOG_LEVEL_NONE = 0,
  GGML_LOG_LEVEL_DEBUG = 1,
  GGML_LOG_LEVEL_INFO = 2,
  GGML_LOG_LEVEL_WARN = 3,
  GGML_LOG_LEVEL_ERROR = 4,
  GGML_LOG_LEVEL_CONT = 5,
};

typedef void (*ggml_log_callback)(enum ggml_log_level level, const char* text, void* user_data);

// ggml.h: "if not NULL, called before ggml computation; if it returns true, the computation
// is aborted". whisper_full_params carries one (v1.9.2 whisper.h:574).
typedef bool (*ggml_abort_callback)(void* data);

struct whisper_context;
typedef int32_t whisper_token;

struct whisper_context;
struct whisper_state;
typedef bool (*whisper_encoder_begin_callback)(struct whisper_context* ctx,
                                               struct whisper_state* state, void* user_data);

struct whisper_context_params {
  bool use_gpu;
  bool flash_attn;
  int gpu_device;
  bool dtw_token_timestamps;
};

enum whisper_sampling_strategy {
  WHISPER_SAMPLING_GREEDY = 0,
  WHISPER_SAMPLING_BEAM_SEARCH = 1,
};

struct whisper_full_params {
  enum whisper_sampling_strategy strategy;

  int n_threads;
  int n_max_text_ctx;
  int offset_ms;
  int duration_ms;

  bool translate;
  bool no_context;
  bool no_timestamps;
  bool single_segment;
  bool print_special;
  bool print_progress;
  bool print_realtime;
  bool print_timestamps;

  bool token_timestamps;
  float thold_pt;
  float thold_ptsum;
  int max_len;
  bool split_on_word;
  int max_tokens;

  bool debug_mode;
  int audio_ctx;

  bool tdrz_enable;

  const char* suppress_regex;

  const char* initial_prompt;
  bool carry_initial_prompt;
  const whisper_token* prompt_tokens;
  int prompt_n_tokens;

  const char* language;
  bool detect_language;

  bool suppress_blank;
  bool suppress_nst;

  float temperature;
  float max_initial_ts;
  float length_penalty;

  float temperature_inc;
  float entropy_thold;
  float logprob_thold;
  float no_speech_thold;

  struct {
    int best_of;
  } greedy;

  struct {
    int beam_size;
    float patience;
  } beam_search;

  // v1.9.2 carries several callbacks between `beam_search` and the grammar fields; the
  // stub declares the one main.cpp sets. Order does not matter to a designated-member
  // assignment, and nothing here is laid out against the real struct.
  ggml_abort_callback abort_callback;
  void* abort_callback_user_data;

  whisper_encoder_begin_callback encoder_begin_callback;
  void* encoder_begin_callback_user_data;
};

// Silero VAD, v1.9.2 whisper.h:699-750 — the functions main.cpp calls, with their exact
// signatures.
struct whisper_vad_context;

struct whisper_vad_context_params {
  int n_threads;
  bool use_gpu;
  int gpu_device;
};

struct whisper_vad_context_params whisper_vad_default_context_params(void);
struct whisper_vad_context* whisper_vad_init_from_file_with_params(
    const char* path_model, struct whisper_vad_context_params params);
bool whisper_vad_detect_speech_no_reset(struct whisper_vad_context* vctx, const float* samples,
                                        int n_samples);
void whisper_vad_reset_state(struct whisper_vad_context* vctx);
int whisper_vad_n_probs(struct whisper_vad_context* vctx);
float* whisper_vad_probs(struct whisper_vad_context* vctx);
void whisper_vad_free(struct whisper_vad_context* ctx);

struct whisper_context_params whisper_context_default_params(void);
struct whisper_full_params whisper_full_default_params(enum whisper_sampling_strategy strategy);

struct whisper_context* whisper_init_from_file_with_params(const char* path_model,
                                                           struct whisper_context_params params);
void whisper_free(struct whisper_context* ctx);

int whisper_full(struct whisper_context* ctx, struct whisper_full_params params,
                 const float* samples, int n_samples);
int whisper_full_n_segments(struct whisper_context* ctx);
const char* whisper_full_get_segment_text(struct whisper_context* ctx, int i_segment);

int whisper_pcm_to_mel(struct whisper_context* ctx, const float* samples, int n_samples,
                       int n_threads);
int whisper_lang_max_id(void);
const char* whisper_lang_str(int id);
int whisper_lang_auto_detect(struct whisper_context* ctx, int offset_ms, int n_threads,
                             float* lang_probs);

void whisper_log_set(ggml_log_callback log_callback, void* user_data);

#ifdef __cplusplus
}
#endif

#endif  // WHISPER_H

// What an engine returns, and the exact parameter set it is asked to run with.

import { SAMPLE_RATE } from './audio.js';
import type { Language } from './language.js';

/**
 * What an engine emitted. `raw` is verbatim, before ANY normalisation — the delivery
 * normaliser, the replacements and the capitaliser all run downstream of this.
 *
 * Ported from `Transcript` (Sources/KotibaCore/Contracts.swift:91).
 */
export interface TranscriptResult {
  /** Exactly what the engine emitted. Persisted as `raw` in history and diagnostics. */
  readonly raw: string;
  readonly language: Language;
  /** Stable and human-readable, e.g. `whisper-ggml-uzbek-stt-v1-q5_0`. Recorded. */
  readonly engineId: string;
}

/** `WHISPER_SAMPLING_GREEDY` or `WHISPER_SAMPLING_BEAM_SEARCH`. */
export type WhisperStrategy = 'greedy' | 'beam';

/**
 * ONE FIELD PER `whisper_full_params` FIELD THE SWIFT ENGINE SETS.
 *
 * Everything absent from this interface keeps its whisper.cpp v1.9.2 default and MUST be
 * left alone — see `WHISPER_V192_DEFAULTS` below for the values that matters depend on.
 * Source of truth: Sources/KotibaEngines/WhisperEngine.swift:217-272, transcribed in
 * docs/windows/inventory/engines.md § "THE whisper_full_params PARITY TABLE".
 *
 * This crosses the wire to `kotiba-stt.exe` as JSON, so every field is a plain value.
 */
export interface WhisperParams {
  /** `beam` when beamSize > 1, else `greedy`. Chooses which struct arm is filled. */
  readonly strategy: WhisperStrategy;

  readonly printRealtime: false;
  /** whisper's own default is TRUE — Kotiba turns it off. */
  readonly printProgress: false;
  /** whisper's own default is TRUE — Kotiba turns it off. */
  readonly printTimestamps: false;
  readonly printSpecial: false;
  /** whisper's own default is false — Kotiba turns it ON. */
  readonly noTimestamps: true;

  /** NEVER true. A live test asserts Uzbek does not come back as English. */
  readonly translate: false;
  readonly singleSegment: false;
  readonly suppressBlank: true;

  /** `no_speech_thold`. Permanently 0.6; no settings control exists. */
  readonly noSpeechThold: number;

  /**
   * `n_threads`. Resolved, never 0 on the wire.
   * `threads > 0 ? threads : max(1, min(8, cpuCount - 2))` — this overrides whisper's
   * own `min(4, hardware_concurrency)` and leaves two cores for audio and the UI.
   */
  readonly nThreads: number;

  /**
   * `beam_search.beam_size`. Set ONLY in the beam branch; `null` in the greedy branch,
   * where whisper's own −1 must stand. Do not pass beam_size 1 with a beam strategy.
   */
  readonly beamSearchBeamSize: number | null;

  /**
   * `greedy.best_of`, set to 5 UNCONDITIONALLY, in BOTH branches.
   *
   * `whisper_full_default_params` fills only the struct arm for the chosen strategy, so
   * in the beam branch this stayed at the literal −1, `max(1, -1) == 1`, and every
   * temperature-fallback rung above t=0 collapsed to one unranked random sample. Setting
   * only `beam_size` reproduces that shipped bug.
   */
  readonly greedyBestOf: number;

  /** The language code handed to whisper: `en` | `ru` | `uz`. Never auto. */
  readonly language: Language;

  /** NEVER true. The router already decided; whisper must not re-decide. */
  readonly detectLanguage: false;

  /**
   * `initial_prompt`. `null` leaves the field at nullptr, and `null` is deliberately NOT
   * the same as `""` to a decoder. Sent for Uzbek even when no vocabulary is configured
   * (the style exemplar), which moves punctuation emission by ±23 points.
   */
  readonly initialPrompt: string | null;
}

/**
 * whisper.cpp v1.9.2 defaults Kotiba does NOT set, recorded because behaviour depends on
 * them and a different whisper build can move them underneath the port.
 *
 * The derived temperature ladder is [0.0, 0.2, 0.4, 0.6, 0.8, 1.0] — six rungs, the last
 * accepted unconditionally. A rung fails when the best decoder was marked failed, or when
 * `avg_logprobs < logprobThold` AND `no_speech_prob < noSpeechThold`. A decoder is marked
 * failed when `result_len > 32` AND `entropy < entropyThold`.
 */
export const WHISPER_V192_DEFAULTS = {
  nMaxTextCtx: 16384,
  offsetMs: 0,
  durationMs: 0,
  /** Past transcription is never reused as context — each dictation is independent. */
  noContext: true,
  tokenTimestamps: false,
  tholdPt: 0.01,
  tholdPtsum: 0.01,
  maxLen: 0,
  splitOnWord: false,
  maxTokens: 0,
  debugMode: false,
  /** 0 means the FULL 1500-frame audio context. Kotiba never truncates it. */
  audioCtx: 0,
  tdrzEnable: false,
  carryInitialPrompt: false,
  suppressNst: false,
  temperature: 0.0,
  maxInitialTs: 1.0,
  lengthPenalty: -1.0,
  temperatureInc: 0.2,
  entropyThold: 2.4,
  logprobThold: -1.0,
  beamSearchPatience: -1.0,
  grammarPenalty: 100.0,
  vad: false,
} as const;

/** The ladder `temperature 0.0` + `temperature_inc 0.2` produces. */
export const TEMPERATURE_LADDER = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0] as const;

/** `whisper_context_default_params` fields Kotiba touches. Both follow `useGPU`. */
export interface WhisperContextParams {
  readonly useGpu: boolean;
  /** Tied to `useGpu`; there is no separate control. */
  readonly flashAttn: boolean;
}

/**
 * The five-field options struct the app builds per language before it becomes
 * `WhisperParams`. Ported from `WhisperEngine.Options`
 * (Sources/KotibaEngines/WhisperEngine.swift:52).
 *
 * NOTE the type defaults are NOT the shipped values: the app builds
 * `{ useGpu: settings.whisperUseGPU, beamSize: <per family>, initialPrompt: hint }`.
 */
export interface WhisperOptions {
  readonly useGpu: boolean;
  /** 0 is the sentinel for "decide from the machine". */
  readonly threads: number;
  readonly beamSize: number;
  readonly initialPrompt: string | null;
  readonly noSpeechThreshold: number;
}

/** `WhisperEngine.Options` type defaults. Not what ships — see `DEFAULT_SETTINGS`. */
export const DEFAULT_WHISPER_OPTIONS: WhisperOptions = {
  useGpu: true,
  threads: 0,
  beamSize: 1,
  initialPrompt: null,
  noSpeechThreshold: 0.6,
};

/**
 * D-W11 — beam size is per model on Windows, and the Uzbek model gets 1.
 *
 * Decision D-08 measured beam 5 on `uzbek_stt_v1` at 21.65% WER against greedy's 21.68%
 * — noise — for +21% latency on a 2.8 s clip and +39% on an 8.8 s one. On a CPU-only
 * Windows laptop that is the cheapest latency win available. `large-v3-turbo` keeps
 * beam 5: D-08 measured Uzbek only, and nothing licenses changing a model nobody measured.
 */
export const BEAM_SIZE_BY_FAMILY = {
  uzbek: 1,
  unified: 5,
  // C4 measured Turkish (and whisper's Arabic fallback) greedy, as the streamed tail runs it:
  // 7.2 % WER on FLEURS tr. Beam 5 was never measured on either and would cost latency.
  turkish: 1,
  arabic: 1,
} as const;

/**
 * Whisper is asked for at least one second of audio. Shorter buffers are ZERO-PADDED to
 * this length: without it whisper.cpp's <10-mel-frame guard returns zero segments and a
 * short "yes" silently produces an empty transcript.
 */
export const MINIMUM_DECODE_SAMPLES = SAMPLE_RATE;

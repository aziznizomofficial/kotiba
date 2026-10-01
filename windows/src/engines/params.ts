// Building the parameter set for one decode, and the two numbers that must not be
// copied from macOS without thinking.
//
// Nothing here touches an OS — it is here rather than in src/core only because it
// belongs to the engine's vocabulary, not the router's. It is pure and tested as such.

import {
  BEAM_SIZE_BY_FAMILY,
  MINIMUM_DECODE_SAMPLES,
  type EngineFamily,
  type Language,
  type Settings,
  type WhisperParams,
} from '../contracts/index.js';

/**
 * `configured > 0 ? configured : max(1, min(8, cpuCount - 2))`.
 *
 * The formula is macOS's, verbatim (WhisperEngine.swift:232-234): it overrides whisper's
 * own `min(4, hardware_concurrency)` and leaves two cores for audio and the UI.
 *
 * WHAT CHANGES ON WINDOWS IS WHAT YOU FEED IT. See `resolveDecodeCores` — passing
 * `os.cpus().length` here reproduces the shape of the macOS rule while describing a
 * completely different machine.
 */
export function resolveThreadCount(cpuCount: number, configured: number): number {
  if (configured > 0) return Math.floor(configured);
  return Math.max(1, Math.min(8, Math.floor(cpuCount) - 2));
}

/**
 * How many cores this machine can really give a decode, from the logical count Node
 * reports.
 *
 * THE DECISION, and it is a deliberate divergence rather than an oversight:
 *
 * macOS computes threads from `ProcessInfo.activeProcessorCount` on an M4 Pro, where
 * every one of those is a physical core with its own vector units. `os.cpus().length` on
 * Windows counts something else entirely — hyperthreads on any SMT part, and E-cores on
 * every Intel 12th-gen-or-later laptop the audience actually owns. A 4-core/8-thread
 * i5 reports 8 and would be told to run 6 decoder threads across 4 cores; ggml's matmul
 * threads spin rather than sleep, so oversubscription there costs latency instead of
 * buying it.
 *
 * So the logical count is halved before the macOS formula sees it. `n <= 2` is passed
 * through because the CI runner is a 1-core / 2-logical VM and halving it to 1 would
 * make the smoke test unrepresentative of nothing at all.
 *
 *     2 logical (CI runner)     → 2  → 1 thread
 *     8 logical (4C/8T i5)      → 4  → 2 threads
 *     12 logical (6C/12T)       → 6  → 4 threads
 *     24 logical (8P+16E i9)    → 12 → 8 threads (capped)
 *     32 logical (16C/32T)      → 16 → 8 threads (capped)
 *
 * `kotiba-stt.exe` reports the machine's true physical and performance-core counts in its
 * `hello` response, which is a better answer than this heuristic. It is not used here
 * because `WhisperParams` is fixed when the engine is constructed and the host has not
 * spoken yet; the numbers are recorded for the diagnostics pane and are the obvious
 * refinement if this rule is ever measured and found wanting.
 */
export function resolveDecodeCores(logicalCount: number): number {
  const logical = Math.max(1, Math.floor(logicalCount));
  if (logical <= 2) return logical;
  return Math.floor(logical / 2);
}

/**
 * The beam width for a family. D-W11: PER MODEL on Windows.
 *
 * The Uzbek model is fixed at 1 whatever the setting says — D-08 measured beam 5 on
 * `uzbek_stt_v1` at 21.65% WER against greedy's 21.68%, which is noise, for +21% latency
 * on a 2.8 s clip and +39% on an 8.8 s one. `large-v3-turbo` takes the setting (5 by
 * default): D-08 measured Uzbek only, and nothing licenses changing a model nobody
 * measured.
 */
export function beamSizeFor(family: EngineFamily, settings: Settings): number {
  if (family !== 'unified') return BEAM_SIZE_BY_FAMILY[family];
  const configured = Math.floor(settings.whisperBeamSize);
  return configured > 0 ? configured : BEAM_SIZE_BY_FAMILY.unified;
}

/**
 * The whole parameter set for one decode, field for field against
 * `WhisperContext.run` (Sources/KotibaEngines/WhisperEngine.swift:217-277).
 *
 * The correspondence, with a line number for every row, is docs/windows/03-ENGINE-PARITY.md.
 */
export function whisperParamsFor(options: {
  readonly language: Language;
  readonly family: EngineFamily;
  readonly settings: Settings;
  readonly initialPrompt: string | null;
  readonly cpuCount: number;
}): WhisperParams {
  const beamSize = beamSizeFor(options.family, options.settings);
  const beam = beamSize > 1;

  return {
    strategy: beam ? 'beam' : 'greedy',

    printRealtime: false,
    printProgress: false,
    printTimestamps: false,
    printSpecial: false,
    noTimestamps: true,

    translate: false,
    singleSegment: false,
    suppressBlank: true,

    // Permanently 0.6. `WhisperEngine.Options.noSpeechThreshold` has no settings control
    // on macOS and none is added here.
    noSpeechThold: 0.6,

    // `threads` is the macOS Options field, whose 0 means "decide from the machine".
    // Nothing in Kotiba ever sets it, so this is always the derived value — but the
    // sentinel is honoured rather than dropped, because a diagnostics build that pins it
    // is the only way to isolate a thread-count problem on a machine nobody owns.
    nThreads: resolveThreadCount(options.cpuCount, 0),

    // ONLY in the beam branch. In the greedy branch whisper's own -1 must stand.
    beamSearchBeamSize: beam ? beamSize : null,

    // Unconditional, in BOTH branches. `whisper_full_default_params` fills only the arm
    // for the chosen strategy, so the beam arm otherwise keeps the struct literal -1,
    // `max(1, -1) == 1`, and every temperature-fallback rung above t=0 collapses to one
    // unranked draw. That bug shipped on macOS; setting only `beam_size` reproduces it.
    greedyBestOf: 5,

    language: options.language,
    // Never true. The router already decided, and whisper's own language ID is what
    // scored `uz 0.00` on clean Uzbek.
    detectLanguage: false,

    // `null` and `''` are different instructions to a decoder: null leaves the field at
    // nullptr, an empty string prepends nothing but still switches the code path. The
    // empty string is normalised to null so only one of them ever crosses the wire —
    // WhisperEngine.swift:268 makes the same distinction with `!prompt.isEmpty`.
    initialPrompt:
      options.initialPrompt === null || options.initialPrompt.length === 0
        ? null
        : options.initialPrompt,
  };
}

/**
 * Pad a short buffer to at least one second before decoding.
 *
 * whisper.cpp returns SUCCESS with ZERO SEGMENTS for anything under 10 mel frames, so
 * without this a short "yes" silently produces an empty transcript — which is the exact
 * v1 defect this project exists to eliminate. Pad rather than refuse: a one-word
 * dictation is a legitimate dictation (WhisperEngine.swift:158-162).
 *
 * Returns the input unchanged when it is already long enough, so the common path copies
 * nothing.
 */
export function padForDecode(samples: Float32Array): Float32Array {
  if (samples.length >= MINIMUM_DECODE_SAMPLES) return samples;
  const padded = new Float32Array(MINIMUM_DECODE_SAMPLES);
  padded.set(samples, 0);
  return padded;
}

// The language-ID pass. Ported from `WhisperLanguageDetector`
// (Sources/KotibaEngines/LanguageDetector.swift:22).
//
// whisper's language head on `ggml-base-q5_1` gives a ~99-language posterior. 59 MB,
// ~34 ms, and it is NEVER asked to transcribe: stock Whisper scores 101.73% WER on
// Uzbek, but *identifying* a language and *transcribing* it are different problems and
// the encoder's language head is fine for the first while hopeless at the second.
//
// The output is deliberately handed to cluster mass rather than read as an argmax. A
// multilingual model given clean Uzbek answers `tr 0.63 / az 0.17 / uz 0.00`, so a rule
// that waits for `uz` to win never fires. Summing the mass across the languages Uzbek is
// heard as is the whole trick, and it lives in src/core/routing (t03), not here.
//
// NON-THROWING. A failure is an EMPTY MAP, meaning "no opinion" — the router treats that
// as a fallback rather than a refusal. Being unsure must never be louder than being
// right, and it must never block a dictation.
//
// `WhisperLanguageDetector.isReady` and `.unload` are dead in the macOS app and are not
// ported.

import type { AcousticClassifier, AudioBuffer, LanguagePosterior } from '../contracts/index.js';
import { SAMPLE_RATE } from '../contracts/index.js';
import { createSttHost, type SttHost, type SttHostOptions } from './host-client.js';
import { inspectModelFile } from './model-store.js';
import { padForDecode, resolveDecodeCores, resolveThreadCount } from './params.js';

/**
 * Detection reads the first 30 s of audio. Whisper's encoder always consumes a 30 s
 * frame, padding what it is given, so a longer clip costs no more than a short one — but
 * trimming keeps the mel computation honest about what it is looking at.
 */
export const DETECTOR_WINDOW_SECONDS = 30;

export interface AcousticClassifierOptions {
  readonly modelPath: string;
  readonly hostPath: string;
  /** The detector needs its own host: it holds a different model from the engines. */
  readonly host?: SttHost;
  readonly hostOptions?: Partial<SttHostOptions>;
  readonly cpuCount?: number;
  readonly onNote?: (note: string) => void;
}

export function createAcousticClassifier(
  options: AcousticClassifierOptions,
): AcousticClassifier & { dispose: () => Promise<void> } {
  const note = options.onNote ?? (() => {});
  const host: SttHost =
    options.host ??
    createSttHost({
      hostPath: options.hostPath,
      onNote: note,
      ...options.hostOptions,
      // A respawned host has no model. Without this `loaded` stayed true after the first
      // death, every later `detect` was answered `no_model`, and every press routed to the
      // fallback language — Uzbek sent to the unified engine — until Kotiba was restarted.
      // `stt-engine.ts` forgets its resident model the same way.
      onExit: () => {
        loaded = false;
      },
    });

  let loaded = false;
  let loading: Promise<void> | null = null;
  let counter = 0;

  async function loadOnce(): Promise<void> {
    const inspection = await inspectModelFile(options.modelPath);
    if (inspection.status !== 'ready') {
      throw new Error(inspection.reason ?? 'the detector model is unusable');
    }
    const response = await host.request({
      id: `dload-${String((counter += 1))}`,
      op: 'load',
      model: options.modelPath,
      // The macOS detector hardcodes both to true (LanguageDetector.swift:52-53) rather
      // than following the engine setting. On Windows there is no Metal and the host
      // links a CPU-only whisper, so this is false and the flag is inert either way.
      useGpu: false,
      flashAttn: false,
    });
    if (!response.ok) {
      throw new Error(response.error ?? 'the detector model would not load');
    }
    loaded = true;
    note(`detector: loaded ${options.modelPath}`);
  }

  async function prepare(): Promise<void> {
    if (loaded) return;
    if (loading !== null) {
      await loading;
      return;
    }
    const attempt = loadOnce();
    loading = attempt.then(
      () => undefined,
      () => undefined,
    );
    try {
      await attempt;
    } finally {
      loading = null;
    }
  }

  async function posterior(audio: AudioBuffer): Promise<LanguagePosterior> {
    if (audio.samples.length === 0) return {};
    try {
      if (!loaded) await prepare();
      if (!loaded) return {};

      // Trim to the window before padding, exactly as the Swift does: `prefix(limit)`
      // then pad up to one second (LanguageDetector.swift:89-95).
      const limit = DETECTOR_WINDOW_SECONDS * SAMPLE_RATE;
      const windowed =
        audio.samples.length > limit ? audio.samples.subarray(0, limit) : audio.samples;
      const samples = padForDecode(windowed);

      const response = await host.request(
        {
          id: `det-${String((counter += 1))}`,
          op: 'detect',
          windowSeconds: DETECTOR_WINDOW_SECONDS,
          nThreads: resolveThreadCount(
            options.cpuCount ?? resolveDecodeCores(4),
            0,
          ),
        },
        samples,
      );
      if (!response.ok || response.posterior === undefined) {
        // `no_model` means the host is not the one this module loaded (it restarted): load
        // again on the next press rather than asking a model-less host forever.
        if (!response.ok && response.code === 'no_model') loaded = false;
        note(`detector: no opinion — ${response.error ?? 'no posterior returned'}`);
        return {};
      }
      return response.posterior;
    } catch (error) {
      // Every failure is "no opinion". The router falls back to the default language,
      // which is a worse answer than a detection and a far better one than a dead press.
      note(`detector: no opinion — ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }

  return {
    posterior,
    dispose: async () => {
      loaded = false;
      if (options.host === undefined) await host.dispose();
    },
  };
}

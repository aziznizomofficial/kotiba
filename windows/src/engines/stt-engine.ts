// One engine over one model, talking to a `kotiba-stt.exe` it owns.
//
// Ported from `WhisperEngine` (Sources/KotibaEngines/WhisperEngine.swift:25).
//
// THE INVARIANT, and it broke Uzbek and Russian on every default install once already:
// `isReady()` answers "is the model resident", NOT "will this engine work". FALSE IS NOT
// A FAILURE. A caller that finds false calls `prepare()` and RE-ASKS; only a `prepare()`
// that throws is terminal, and its reason is preserved verbatim. Refusing on
// `isReady() === false` pointed the user at a model file that was present and valid.
//
// `prepare()` is idempotent, deduplicated across concurrent callers — two callers must
// not both map 539 MB — and a call after a failure RETRIES rather than latching broken
// for the process lifetime (WhisperEngine.swift:98-136).

import {
  asEngineError,
  EngineFailure,
  SAMPLE_RATE,
  engineError,
  type AudioBuffer,
  type CreateSttEngine,
  type Language,
  type SttEngine,
  type TranscriptResult,
  type WhisperParams,
} from '../contracts/index.js';
import { fittedAudioContext } from '../core/stt/speech-segmenter.js';
import { createSttHost, type SttHost, type SttHostOptions } from './host-client.js';
import { inspectModelFile } from './model-store.js';
import { padForDecode } from './params.js';

export interface SttEngineOptions {
  readonly engineId: string;
  readonly modelPath: string;
  readonly params: WhisperParams;
  readonly hostPath: string;
  readonly supportedLanguages?: Iterable<Language>;
  /**
   * The `initial_prompt` for one decode, asked PER CALL rather than fixed in `params`.
   *
   * macOS builds a whole `WhisperEngine.Options` per language, with
   * `settings.vocabularyValue.hint(for: language)` in it (DictationController.swift:426-432),
   * and each of its whisper engines serves exactly one language. Windows cannot copy that
   * shape: D-W2 puts English AND Russian on `large-v3-turbo`, so one engine spans two
   * languages with two different hints — and the hint is decoder CONTEXT, so a Russian
   * exemplar sentence in front of English audio biases the decoder toward Russian, which
   * is the failure this app exists around.
   *
   * Absent means "whatever `params.initialPrompt` already says", so an engine constructed
   * without one behaves exactly as before.
   */
  readonly initialPromptFor?: (language: Language) => string | null;
  /** `settings.whisperUseGPU`. `flash_attn` follows it unless `flashAttention` says otherwise. */
  readonly useGpu?: boolean;
  /**
   * whisper.cpp's flash-attention kernels. Defaults to `useGpu` (the Mac's tie). MUST be
   * false on an engine that decodes with more than one encoder window — the streaming Uzbek
   * engine: v1.9.2's flash path attends past the window it wrote, and a stream mixing
   * full-window commits with fitted speculations measured 27.13 % WER against 21.83 %
   * (C2 §3). The non-flash path reads exactly `audio_ctx` positions.
   */
  readonly flashAttention?: boolean;
  /** Injected in tests, and by the manager when it wants to share a host. */
  readonly host?: SttHost;
  readonly hostOptions?: Partial<SttHostOptions>;
  readonly onNote?: (note: string) => void;
}

/**
 * The wire form of the parameters. One place, so the field names cannot drift between
 * the client and `buildParams` in main.cpp.
 */
function paramsToWire(params: WhisperParams): Record<string, unknown> {
  return {
    strategy: params.strategy,
    printRealtime: params.printRealtime,
    printProgress: params.printProgress,
    printTimestamps: params.printTimestamps,
    printSpecial: params.printSpecial,
    noTimestamps: params.noTimestamps,
    translate: params.translate,
    singleSegment: params.singleSegment,
    suppressBlank: params.suppressBlank,
    noSpeechThold: params.noSpeechThold,
    nThreads: params.nThreads,
    // Only in the beam branch. `null` is not sent at all, so the host's own
    // "leave whisper's -1 alone" path is the one that runs.
    ...(params.beamSearchBeamSize === null
      ? {}
      : { beamSearchBeamSize: params.beamSearchBeamSize }),
    greedyBestOf: params.greedyBestOf,
    language: params.language,
    detectLanguage: params.detectLanguage,
    // Sent as an explicit null, not omitted: null and absent are the same to the host,
    // but sending it makes the frame self-describing in a diagnostics dump.
    initialPrompt: params.initialPrompt,
  };
}

/** An engine that can also free its weights without shutting its host down. */
export type UnloadableSttEngine = SttEngine & { unload(): Promise<void> };

/** One decoded segment, and what it cost. `WhisperEngine.Decode`. */
export interface SegmentDecode {
  readonly text: string;
  /** Encoder positions it ran with; 0 is the model's window. */
  readonly audioContext: number;
  readonly milliseconds: number;
}

export interface SegmentDecodeOptions {
  readonly language: Language;
  /** The whole prompt for this segment (hint + carried text), or `null` for none. */
  readonly prompt: string | null;
  /** Encoder positions; 0 is the model's window. */
  readonly audioContext: number;
  /** Aborts the decode: dropped if it has not started, ended early if it has. */
  readonly signal?: AbortSignal;
}

/** Silero VAD in the engine's host, one context per dictation. */
export interface HostSpeechDetector {
  readonly frameSamples: number;
  /** One probability per whole frame of `samples`; state carries over between calls. */
  probabilities(samples: Float32Array): Promise<number[]>;
  close(): Promise<void>;
}

/** What the streaming Uzbek session needs from an engine, beyond `SttEngine`. */
export interface SegmentDecodingEngine extends UnloadableSttEngine {
  /** False when two encoder windows would corrupt this context (flash attention on). */
  mixesWindowsSafely(): boolean;
  decodeSegment(samples: Float32Array, options: SegmentDecodeOptions): Promise<SegmentDecode>;
  /** Opens Silero in this engine's host. Throws when the host or the file cannot. */
  openSpeechDetector(modelPath: string): Promise<HostSpeechDetector>;
  /**
   * This model's own language head over (the first 30 s of) `samples`, loading the model if it
   * is cold — the Mac's `TurkishCheck` verifier is turbo's head, and the Turkish engine already
   * holds turbo, so asking it costs one encoder pass and no new file (D-11, C4). `{}` = no answer.
   *
   * `headMargin`: encode a window fitted to the audio plus this many positions of silence
   * (`fittedAudioContext`), not the model's 30 s — the Mac's `WhisperLanguageHead`, with
   * `TURKISH_HEAD_MARGIN` (C4 §13). Ignored with flash attention on, which cannot mix windows.
   */
  detectLanguage(
    samples: Float32Array,
    options?: { readonly headMargin?: number },
  ): Promise<Record<string, number>>;
}

let detectCounter = 0;

export function createSttEngineWithHost(options: SttEngineOptions): SegmentDecodingEngine {
  const note = options.onNote ?? (() => {});
  const supported = new Set<Language>(options.supportedLanguages ?? ['uz']);
  const flashAttention = options.flashAttention ?? options.useGpu ?? false;
  let loaded = false;

  /**
   * The weights died with the process that held them.
   *
   * `isReady()` answers "is the model resident", so leaving the flag up after the host
   * exits makes it lie — and the lie costs the user TWO failed dictations rather than
   * one. The first press kills the host (a crash, an OOM, a hang this client times out);
   * the second press finds `loaded === true`, skips `prepare()`, and sends a transcribe
   * frame to a brand-new host that has no model in it. Only on the third press does the
   * `no_model` refusal below finally clear the flag.
   *
   * Nothing here throws or reports: a host that died has already been reported by the
   * client, and this is only the bookkeeping that makes the next press a SLOW dictation
   * instead of a failed one.
   */
  function forgetResidentModel(reason: string): void {
    if (!loaded) return;
    loaded = false;
    note(`${options.engineId}: the host is gone (${reason}) — the model will be reloaded`);
  }

  const host: SttHost =
    options.host ??
    createSttHost({
      hostPath: options.hostPath,
      onNote: note,
      ...options.hostOptions,
      // After the spread, deliberately: an engine that does not notice its own host
      // dying is the bug this exists to prevent, and no caller has a reason to override
      // it. A host injected via `options.host` is owned by someone else and gets the
      // in-request path below instead.
      onExit: forgetResidentModel,
    });
  /** The in-progress load, so two callers cannot both map 539 MB. */
  let loading: Promise<void> | null = null;
  let lastError: string | null = null;
  let requestCounter = 0;

  async function loadOnce(): Promise<void> {
    // A bare existence check is what the Swift does (WhisperEngine.swift:102), but the
    // model store's four-bytes-and-a-stat costs the same and tells the difference
    // between missing and corrupt — which is the whole of D-W10.
    const inspection = await inspectModelFile(options.modelPath);
    if (inspection.status === 'notInstalled') {
      lastError = `no model at ${options.modelPath}`;
      throw new EngineFailure(engineError.modelMissing(options.modelPath));
    }
    if (inspection.status === 'corrupt') {
      lastError = inspection.reason;
      throw new EngineFailure(
        engineError.modelCorrupt(options.modelPath, inspection.reason ?? 'unusable'),
      );
    }

    const response = await host.request({
      id: `load-${String((requestCounter += 1))}`,
      op: 'load',
      model: options.modelPath,
      useGpu: options.useGpu ?? false,
      // Tied to the GPU flag (WhisperEngine.swift:110) unless the engine mixes windows.
      flashAttn: flashAttention,
    });

    if (!response.ok) {
      lastError = response.error ?? 'the model would not load';
      // The host reached the file and whisper.cpp refused it. That is a corrupt model,
      // and saying so is more useful than "not ready".
      throw new EngineFailure(engineError.modelCorrupt(options.modelPath, lastError));
    }

    loaded = true;
    lastError = null;
    note(`${options.engineId}: model loaded from ${options.modelPath}`);
  }

  async function prepare(): Promise<void> {
    if (loaded) return;
    if (loading !== null) {
      // Join the load already in flight rather than starting a second one.
      await loading;
      return;
    }
    const attempt = loadOnce();
    // Cleared in `finally` so a FAILED prepare retries on the next call rather than
    // latching broken for the process lifetime.
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

  async function transcribe(audio: AudioBuffer, language: Language, signal?: AbortSignal): Promise<TranscriptResult> {
    if (!supported.has(language)) {
      throw new EngineFailure(engineError.languageUnsupported(language, options.engineId));
    }
    if (audio.samples.length === 0) {
      throw new EngineFailure(engineError.transcriptionFailed('no audio'));
    }
    // Cold is not broken. Load, then carry on — this is the cold-start path that makes a
    // first dictation slow instead of failed.
    if (!loaded) await prepare();
    if (!loaded) {
      throw new EngineFailure(engineError.notReady(lastError ?? 'no context'));
    }

    // Whisper pads to 30 s internally, but under 10 mel frames it returns SUCCESS with
    // zero segments, so a short "yes" comes back as an empty transcript. Pad rather than
    // refuse: a one-word dictation is a legitimate dictation.
    const samples = padForDecode(audio.samples);

    // `null` and `''` are different instructions to a decoder — null leaves the field at
    // nullptr, an empty string prepends nothing but still switches the code path — so the
    // empty string is normalised away here exactly as `whisperParamsFor` does it.
    const prompt = options.initialPromptFor?.(language) ?? null;
    const forThisCall: WhisperParams = {
      ...options.params,
      language,
      ...(options.initialPromptFor === undefined
        ? {}
        : { initialPrompt: prompt === null || prompt.length === 0 ? null : prompt }),
    };

    if (signal?.aborted === true) throw new EngineFailure(engineError.transcriptionFailed('aborted'));
    const id = `stt-${String((requestCounter += 1))}`;
    // An abandoned decode must not keep the host: requests run one at a time, so a reroute
    // that gave up at its deadline left the next Uzbek dictation queued behind a decode
    // nobody was waiting for. The abort goes at once (`immediate`), as `decodeSegment`'s.
    const abort = (): void => {
      void host.immediate({ op: 'abort', target: id }).catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once: true });
    let response;
    try {
      response = await host.request(
        {
          id,
          op: 'transcribe',
          ...paramsToWire(forThisCall),
        },
        samples,
      );
    } catch (error) {
      // A THROW from the client is a death, not a refusal — the two are different states
      // and it says so. Whatever the host had loaded went with it, so the flag comes
      // down here as well as in `onExit`: this path also covers a host this engine does
      // not own (`options.host`), which has no `onExit` of ours attached.
      if (asEngineError(error)?.kind === 'hostUnavailable') {
        forgetResidentModel(asEngineError(error)?.reason ?? 'it died mid-request');
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }

    if (!response.ok) {
      // The host is alive and refused. If it says it lost the model, drop the resident
      // flag so the next attempt reloads rather than refusing forever.
      if (response.code === 'no_model') loaded = false;
      throw new EngineFailure(
        engineError.transcriptionFailed(
          response.code === 'aborted' ? 'aborted' : (response.error ?? 'the engine refused the request'),
        ),
      );
    }

    return {
      raw: (response.text ?? '').trim(),
      language,
      engineId: options.engineId,
    };
  }

  /**
   * Frees the weights WITHOUT killing the host.
   *
   * This is the seam idle unload needs, and the distinction matters: `dispose()` shuts
   * the host down for good, so an engine disposed to reclaim memory could never load
   * again. `unload` frees the 539 MB — which is all the memory there is to reclaim; the
   * host process itself is a few MB — and leaves a process that can reload on the next
   * press. Not in the `SttEngine` contract because `WhisperEngine.unload()` has no
   * caller on macOS; idle unload is a Windows addition (see manager.ts).
   */
  async function unload(): Promise<void> {
    if (!loaded) return;
    loaded = false;
    try {
      await host.request({ id: `unload-${String((requestCounter += 1))}`, op: 'unload' });
      note(`${options.engineId}: model unloaded`);
    } catch (error) {
      // The host was already gone. The weights are freed either way, which is the whole
      // point — recorded rather than thrown, because nobody asked for a transcript.
      note(
        `${options.engineId}: unload found the host already gone — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * One segment for a streaming session: the engine's own parameters, except that the
   * prompt and the encoder window are the caller's. Serialised with every other call on this
   * host, exactly like `transcribe` — a stream and a batch decode share one model.
   */
  async function decodeSegment(samples: Float32Array, decode: SegmentDecodeOptions): Promise<SegmentDecode> {
    if (!supported.has(decode.language)) {
      throw new EngineFailure(engineError.languageUnsupported(decode.language, options.engineId));
    }
    if (decode.signal?.aborted === true) throw new EngineFailure(engineError.transcriptionFailed('aborted'));
    if (!loaded) await prepare();
    if (!loaded) throw new EngineFailure(engineError.notReady(lastError ?? 'no context'));
    const padded = padForDecode(samples);
    const forThisCall: WhisperParams = {
      ...options.params,
      language: decode.language,
      initialPrompt: decode.prompt === null || decode.prompt.length === 0 ? null : decode.prompt,
    };
    const id = `seg-${String((requestCounter += 1))}`;
    // The abort goes to the host AT ONCE (`immediate`), not behind the decode it is meant to
    // stop. Sent for a decode not yet written, the host drops it when it arrives.
    const abort = (): void => {
      void host.immediate({ op: 'abort', target: id }).catch(() => undefined);
    };
    decode.signal?.addEventListener('abort', abort, { once: true });
    const started = Date.now();
    try {
      const response = await host.request(
        { id, op: 'transcribe', ...paramsToWire(forThisCall), audioCtx: decode.audioContext },
        padded,
      );
      if (!response.ok) {
        if (response.code === 'no_model') loaded = false;
        throw new EngineFailure(
          engineError.transcriptionFailed(response.code === 'aborted' ? 'aborted' : (response.error ?? 'refused')),
        );
      }
      return {
        text: (response.text ?? '').trim(),
        audioContext: response.audioCtx ?? 0,
        milliseconds: response.ms ?? Date.now() - started,
      };
    } catch (error) {
      if (asEngineError(error)?.kind === 'hostUnavailable') {
        forgetResidentModel(asEngineError(error)?.reason ?? 'it died mid-request');
      }
      throw error;
    } finally {
      decode.signal?.removeEventListener('abort', abort);
    }
  }

  async function openSpeechDetector(modelPath: string): Promise<HostSpeechDetector> {
    const opened = await host.immediate({ op: 'vad_open', model: modelPath });
    if (!opened.ok || opened.handle === undefined) {
      throw new Error(opened.error ?? `this host cannot run Silero (${opened.code ?? 'no answer'})`);
    }
    const handle = opened.handle;
    const frameSamples = opened.frameSamples ?? 512;
    let closed = false;
    return {
      frameSamples,
      async probabilities(frames: Float32Array): Promise<number[]> {
        const expected = Math.floor(frames.length / frameSamples);
        if (closed || expected === 0) return new Array<number>(expected).fill(1);
        const answer = await host.immediate({ op: 'vad', handle }, frames);
        const probs = answer.ok ? (answer.probs ?? []) : [];
        // A failed call must not read as silence — that would trim words. It reads as
        // speech, which only delays a cut (the Mac's SileroSpeechDetector does the same).
        return Array.from({ length: expected }, (_, index) => probs[index] ?? 1);
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await host.immediate({ op: 'vad_close', handle }).catch(() => undefined);
      },
    };
  }

  async function detectLanguage(
    samples: Float32Array,
    detect: { readonly headMargin?: number } = {},
  ): Promise<Record<string, number>> {
    if (samples.length === 0) return {};
    if (!loaded) await prepare();
    if (!loaded) return {};
    const window = 30 * SAMPLE_RATE;
    const input = padForDecode(samples.length > window ? samples.subarray(0, window) : samples);
    // 0 = the model's window: no margin asked for, or a context that cannot mix windows.
    const audioCtx =
      detect.headMargin === undefined || flashAttention ? 0 : fittedAudioContext(input.length, detect.headMargin);
    const response = await host.request(
      {
        id: `tdet-${String((detectCounter += 1))}`,
        op: 'detect',
        windowSeconds: 30,
        nThreads: options.params.nThreads,
        audioCtx,
      },
      input,
    );
    if (!response.ok || response.posterior === undefined) {
      note(`${options.engineId}: language head gave no answer — ${response.error ?? 'no posterior'}`);
      return {};
    }
    return response.posterior;
  }

  return {
    engineId: options.engineId,
    supportedLanguages: supported,
    detectLanguage,
    isReady: async () => loaded,
    prepare,
    transcribe,
    unload,
    mixesWindowsSafely: () => !flashAttention,
    decodeSegment,
    openSpeechDetector,
    dispose: async () => {
      loaded = false;
      // Only when this engine owns the host. A shared host belongs to the manager.
      if (options.host === undefined) await host.dispose();
    },
  };
}

/**
 * `CreateSttEngine`'s options plus the one fact the contract cannot express and the
 * CALLER always knows for certain: which languages this model actually serves.
 *
 * The contract's three fields describe a file. Which languages come out of that file is
 * a property of the ROLE it was resolved for — `uzbek`, `russian`, `fastEnglish` — and
 * the engine manager is holding that role when it calls this. Before this field existed
 * the composition roots guessed it from the model's FILENAME, which is FINDING 7: a
 * `small.en` engine claiming `['en', 'ru']` decoded Russian audio with an English-only
 * model, and a valid Uzbek model whose file was not named `*uzbek*` claimed `['en','ru']`
 * and made every Uzbek dictation fail with `noEngineInstalled('uz')`.
 *
 * OPTIONAL, so a caller written against the plain contract still type-checks and still
 * works. `CreateSttEngine` remains assignable to `CreateSttEngineForRole`.
 */
export type SttEngineFactoryOptions = Parameters<CreateSttEngine>[0] & {
  readonly supportedLanguages?: Iterable<Language>;
  /** The vocabulary hint for one decode. See `SttEngineOptions.initialPromptFor`. */
  readonly initialPromptFor?: (language: Language) => string | null;
  /** See `SttEngineOptions.flashAttention`. Off for the streaming Uzbek engine. */
  readonly flashAttention?: boolean;
};

/** A `CreateSttEngine` that can also be told the role's languages. */
export type CreateSttEngineForRole = (options: SttEngineFactoryOptions) => SttEngine;

/**
 * The contract factory. `hostPath` is not in `CreateSttEngine`'s options — the contract
 * predates the host being a separate process for every engine — so the composition root
 * binds it with `bindSttEngineFactory` and hands the result down.
 *
 * `supportedLanguagesFor` is a LAST RESORT and the composition roots no longer pass one:
 * whatever the caller states in `options.supportedLanguages` wins, because the caller
 * knows the role and this function only ever knew the engine id.
 */
export function bindSttEngineFactory(deps: {
  readonly hostPath: string;
  readonly useGpu: boolean;
  readonly supportedLanguagesFor?: (engineId: string) => Iterable<Language>;
  readonly onNote?: (note: string) => void;
}): CreateSttEngineForRole {
  return (options) =>
    createSttEngineWithHost({
      engineId: options.engineId,
      modelPath: options.modelPath,
      params: options.params,
      hostPath: deps.hostPath,
      useGpu: deps.useGpu,
      // The caller's own answer first; `createSttEngineWithHost` owns the last-resort
      // default, so it stays one policy in one place.
      supportedLanguages:
        options.supportedLanguages ?? deps.supportedLanguagesFor?.(options.engineId),
      ...(options.initialPromptFor === undefined
        ? {}
        : { initialPromptFor: options.initialPromptFor }),
      ...(options.flashAttention === undefined ? {} : { flashAttention: options.flashAttention }),
      ...(deps.onNote === undefined ? {} : { onNote: deps.onNote }),
    });
}

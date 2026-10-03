// src/engines — model store, engine manager, STT host client.  OWNER: t06
//
// May use Node. May NOT import `electron`.
//
// D-W7: a PERSISTENT NATIVE HOST, not a CLI per dictation. `whisper-cli.exe` per
// dictation reloads 539 MB of weights every press. `kotiba-stt.exe` is a small C++ host
// over whisper.cpp's C API that loads a model once, holds it, and answers frames on
// stdin with JSON on stdout — see windows/native/kotiba-stt/ for the process and
// docs/windows/03-ENGINE-PARITY.md for the field-by-field parameter table it exists to
// guarantee.
//
// A crashed helper is restarted by the client and reported, never silently.
//
// The four things this module is where the bodies are buried:
//
//   * `greedy.best_of` is 5 in BOTH branches (params.ts, and again in main.cpp).
//   * short audio is zero-padded to one second, or whisper returns SUCCESS with zero
//     segments and a short "yes" becomes an empty transcript.
//   * every decode is serialised through one chain per host: `whisper_full` mutates the
//     KV cache and logits of the context it was given, and whisper.h says "Not thread
//     safe for same context".
//   * the language is ALWAYS pinned on the transcription call. Detection is a separate
//     pass on a separate model, and it never becomes an auto-detect.

export {
  beamSizeFor,
  padForDecode,
  resolveDecodeCores,
  resolveThreadCount,
  whisperParamsFor,
} from './params.js';

export {
  createSttHost,
  encodeFrame,
  DEFAULT_LOAD_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
  type HostGreeting,
  type HostResponse,
  type SttHost,
  type SttHostOptions,
} from './host-client.js';

export {
  createModelStore,
  inspectModelFile,
  sha256OfFile,
} from './model-store.js';

export {
  bindSttEngineFactory,
  createSttEngineWithHost,
  type HostSpeechDetector,
  type SegmentDecode,
  type SegmentDecodeOptions,
  type SegmentDecodingEngine,
  type CreateSttEngineForRole,
  type SttEngineFactoryOptions,
  type SttEngineOptions,
} from './stt-engine.js';

export {
  createAcousticClassifier,
  DETECTOR_WINDOW_SECONDS,
  type AcousticClassifierOptions,
} from './classifier.js';

export {
  createEngineManager,
  createEngineManagerWith,
  roleFor,
  DEFAULT_IDLE_UNLOAD,
  type EngineManagerDeps,
  type IdleUnloadPolicy,
} from './manager.js';

// English + Russian on ONNX Runtime (C1 §8), and the first-use bundle downloads it and the
// modes' model share. Wired by `src/main/compose.ts` as the unified family's lead.
export {
  createBundleStore,
  type BundleProgress,
  type BundleStore,
  type BundleStoreOptions,
} from './bundle-store.js';

export {
  ParakeetEngine,
  ParakeetStream,
  loadParakeetRuntime,
  startParakeetWorker,
  resolveOrtThreads,
  DEFAULT_PARAKEET_IDLE_UNLOAD_MS,
  DEFAULT_PARAKEET_LOAD_BUDGET_MS,
  PARAKEET_ENGINE_ID,
  type ParakeetEngineOptions,
  type ParakeetRuntime,
} from './parakeet.js';

export type { UnifiedLead } from './manager.js';

// C2: Uzbek while the key is held — Silero-cut segments decoded behind the speaker.
export {
  StreamingWhisperSession,
  createStreamingWhisperEngine,
  energyDetector,
  DEFAULT_STREAMING_WHISPER,
  type AsyncSpeechDetector,
  type SegmentDecoder,
  type StreamingReport,
  type StreamingWhisperConfiguration,
} from './streaming-whisper.js';

export {
  CRASH_LIMIT,
  CRASH_WINDOW_MS,
  CrashLimiter,
  EngineProcessExit,
  engineHostPath,
  forkLauncher,
  type EngineChannel,
  type EngineLauncher,
  type EngineRole,
} from './engine-process.js';
export { startParakeetProcess } from './parakeet-process.js';

// C4: Arabic — Cohere through transcribe.cpp, or FastConformer on a PC too slow for it.
export {
  ARABIC_SPEECH_SEGMENTER,
  ArabicEngine,
  DEFAULT_SPEED_THRESHOLD_MS,
  type ArabicActiveReason,
  type ArabicEngineOptions,
  type ArabicEngineStatus,
  type ArabicSpeedCheck,
  type ArabicSpeedCheckStore,
} from './arabic.js';
export {
  ARABIC_ENGINE_KINDS,
  ARABIC_MAX_SEGMENT_SECONDS,
  loadArabicRuntime,
  serveArabic,
  startArabicProcess,
  type ArabicDecode,
  type ArabicEngineKind,
  type ArabicRuntime,
  type ArabicRuntimeOptions,
} from './arabic-runtime.js';

// P4 (D-14): the language-ID model — VoxLingua107 ECAPA on ONNX Runtime, in its own process. The
// router's classifier when it is installed; whisper base (`createAcousticClassifier`) otherwise.
export {
  ECAPA_LABELS,
  LANGUAGE_ID_MINIMUM_BYTES,
  LANGUAGE_ID_MODEL_FILE,
  LANGUAGE_ID_THREADS,
  createLanguageIdentifier,
  resolveLanguageIDPath,
  ecapaInput,
  loadLanguageIDRuntime,
  posteriorFromLogp,
  startLanguageIDProcess,
  type LanguageIdentifier,
  type LanguageIdentifierOptions,
  type LanguageIDRuntime,
} from './language-id.js';
export { serveLanguageID } from './language-id-runtime.js';

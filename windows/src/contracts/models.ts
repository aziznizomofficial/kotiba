// The models, and the ONE question that must never be answered by reading prose.
//
// Ported from `ModelFile` / `ModelEntry` / `ModelCatalogue`
// (Sources/KotibaModels/ModelStore.swift, Sources/KotibaModels/ModelCatalogue.swift) and
// D-W3 / D-W25 (Uzbek, the detector and Silero ship inside the installer; the rest is downloaded).

import type { Language } from './language.js';

/** The models this build knows about. */
export const MODEL_IDS = ['uzbek_stt_v1', 'large_v3_turbo', 'base_detector', 'small_en'] as const;
export type ModelId = (typeof MODEL_IDS)[number];

/**
 * Whether a model file is usable, as an ENUM.
 *
 * `notInstalled` and `corrupt` are different machine states and must be distinguished
 * by a flag set by the component that knows — never by matching a human sentence.
 * D-W10 names the precedent: `ai-balance/windows` recovered state with the regex
 * `no [A-Z_]+ stored`, the real message read `no GONKA_API_KEY / GONKA_BASE_URL
 * stored`, the regex missed, and a healthy app exited non-zero. `--check` reports on
 * this value, and on nothing else.
 *
 * Never widen this to carry a message. The message lives beside it, in `reason`.
 */
export const MODEL_STATUSES = ['notInstalled', 'corrupt', 'ready'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/**
 * What an inspection found. `status` is what code branches on; `reason` is what a human
 * reads, and it is `null` exactly when `status === 'ready'`.
 */
export interface ModelInspection {
  readonly status: ModelStatus;
  /** The path inspected. Empty when nothing was configured. */
  readonly path: string;
  /** Size in bytes, or 0 when the file could not be stat'ed. */
  readonly bytes: number;
  /** Non-null iff `status !== 'ready'`. Never parsed. */
  readonly reason: string | null;
}

/** The exact wording macOS shows for each unusable verdict. */
export const MODEL_PROBLEM_REASONS = {
  missing: 'the file is not there any more',
  /** `the file is only ${Math.floor(bytes / 1048576)} MB — it looks like a download that did not finish` */
  tooSmallPrefix: 'the file is only ',
  tooSmallSuffix: ' MB — it looks like a download that did not finish',
  notGgml: 'the file is not a whisper.cpp ggml model',
} as const;

/**
 * The first four bytes of every whisper.cpp ggml model, read little-endian.
 * On disk they are literally `6c 6d 67 67`.
 */
export const GGML_MAGIC = 0x6767_6d6c;

/**
 * Below this a file cannot be a usable speech model. The smallest one shipped is the
 * 57 MB detector.
 *
 * This plus the four magic bytes is what "the model exists" MEANS in this app. Every
 * readiness question goes through it. With a plain existence check a half-finished
 * download turns Uzbek ready, clears the blocker, shows a green tick, and the only
 * feedback is whisper guessing 7.8 s into a load, once per launch, forever.
 */
export const MODEL_MINIMUM_BYTES = 8 * 1024 * 1024;

/** One model: where it comes from, what it must hash to, and what it weighs. */
export interface ModelSpec {
  readonly id: ModelId;
  /** Human-readable, shown in the Settings pane and in `preparing` status. */
  readonly name: string;
  /** The file name on disk, relative to the models directory. */
  readonly fileName: string;
  /** Lowercase hex. Empty means unknown-but-permitted — it installs and the hash is recorded. */
  readonly sha256: string;
  /** Exact size, or `null` when unknown. Never used as a gate; `MODEL_MINIMUM_BYTES` is. */
  readonly bytes: number | null;
  /** Public URL, or `null` when there is no public copy. */
  readonly url: string | null;
  /** D-W3: true means the installer carries it, so there is no first-run download. */
  readonly bundled: boolean;
}

/**
 * Every model, in one place, so a sha256 cannot exist in two files and disagree — which
 * is exactly how `ClusterMass.defaultThreshold` came to say 0.5 while the app said 0.05.
 *
 * THE MODEL CONFLICT, resolved: `Scripts/Manifest.json` and `ModelCatalogue` used to
 * describe `ggml-navoi-medium-q5_0.bin` (both now name uzbek-stt-v1, C2), while `make-dmg.sh`
 * and `knownUzbekModels` use `ggml-uzbek-stt-v1-q5_0.bin`. Both files are 539,212,484 bytes with DIFFERENT
 * sha256s, so picking the wrong one fails verification in a way that looks like a
 * corrupt download. Windows ships `uzbek-stt-v1`: it is what the installed Mac app runs
 * today, it is what D-08 selected, and it measured 21.68% WER against navoi's 25.19%.
 */
/**
 * Where this project's OWN model builds are published for anyone to fetch — the models no
 * upstream hosts as ggml (today: the Uzbek engine). One constant, mirrored as
 * `public_models_base` in `Scripts/Manifest.json` and `ModelCatalogue.publicModelsBase` on the
 * Mac; tests on both sides assert they agree.
 *
 * Release `models-v2` of `aziznizomofficial/kotiba` carries the Uzbek ggml (uploaded 2026-10-01
 * for 1.0.0). A plain GET answers once that repository is public; while it is still private,
 * `scripts/fetch-models.mjs` reaches the same asset through `gh` (`PRIVATE_MODELS_RELEASE`).
 */
export const PUBLIC_MODELS_BASE =
  'https://github.com/aziznizomofficial/kotiba/releases/download/models-v2/';

/** Whether PUBLIC_MODELS_BASE is the live host. True from 1.0.0, so a missing Uzbek model is
 * offered as a download (the installer carries the file anyway). Mirrors
 * `ModelCatalogue.uzbekEngineIsPublic`. */
export const PUBLIC_MODELS_LIVE = true;

/** The authenticated route to the same release (via `gh`) — the fallback while the repository
 * is private, and for anyone whose plain GET fails. Same repository, same tag. */
export const PRIVATE_MODELS_RELEASE = { repo: 'aziznizomofficial/kotiba', tag: 'models-v2' } as const;

export const MODEL_CATALOGUE: Readonly<Record<ModelId, ModelSpec>> = {
  uzbek_stt_v1: {
    id: 'uzbek_stt_v1',
    name: 'Uzbek model',
    fileName: 'ggml-uzbek-stt-v1-q5_0.bin',
    sha256: '2891c1ca99f40a5519cd2e863e85b70b6cdc057b46fdbb5edbe6d9cead29c1b2',
    bytes: 539_212_484,
    // D-W3 still bundles it in the installer; the URL is how a stranger's build (and a
    // repair of a broken install) gets the same bytes. Reproducible from Hugging Face with
    // `Scripts/convert-uzbek.sh`, byte for byte. See PUBLIC_MODELS_BASE.
    url: `${PUBLIC_MODELS_BASE}ggml-uzbek-stt-v1-q5_0.bin`,
    bundled: true,
  },
  large_v3_turbo: {
    id: 'large_v3_turbo',
    name: 'whisper large-v3-turbo q5_0',
    fileName: 'ggml-large-v3-turbo-q5_0.bin',
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    bytes: 574_041_195,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    // D-W25 (2026-10-02): no longer in the installer. Turkish's engine and Arabic's language
    // head + fallback, so it is downloaded when Turkish or Arabic is turned on, and only then.
    // English and Russian are Parakeet's (a core download); turbo serves them only on a PC that
    // happens to have it for Turkish or Arabic.
    bundled: false,
  },
  base_detector: {
    id: 'base_detector',
    name: 'whisper base q5_1',
    fileName: 'ggml-base-q5_1.bin',
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
    bytes: 59_707_625,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
    bundled: true,
  },
  small_en: {
    id: 'small_en',
    name: 'whisper small.en q5_1',
    fileName: 'ggml-small.en-q5_1.bin',
    // D-W2's Fast English model is not in Scripts/Manifest.json, so no sha256 is
    // recorded anywhere in this repo. Empty is a legal entry: it installs and the store
    // records the hash it got, which is how a manifest gets filled in from a real run.
    // t11 should pin it once a verified download exists.
    sha256: '',
    bytes: null,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin',
    // D-W2: fetched on demand, not bundled, not the default.
    bundled: false,
  },
};

/** The two models the installer carries (plus Silero, a bundle). Their absence is a broken
 * install, not a choice. whisper turbo left it in D-W25: it is a Turkish/Arabic download now. */
export const BUNDLED_MODEL_IDS: readonly ModelId[] = ['uzbek_stt_v1', 'base_detector'];

/**
 * Auto-discovery candidates per role, BEST FIRST. Order is meaningful: `uzbek-stt-v1`
 * measured 21.68% WER against `navoi-medium`'s 25.19%, so it wins when both are present.
 */
export const KNOWN_MODEL_FILES = {
  uzbek: ['ggml-uzbek-stt-v1-q5_0.bin', 'ggml-navoi-medium-q5_0.bin'],
  russian: ['ggml-large-v3-turbo-q5_0.bin'],
  detector: ['ggml-base-q5_1.bin'],
  fastEnglish: ['ggml-small.en-q5_1.bin'],
} as const;

/** Which model serves which language, given the Fast English setting. */
export interface ModelAssignment {
  readonly language: Language;
  readonly modelId: ModelId;
}

/** Progress of a download the app started itself. */
export interface ModelDownloadProgress {
  readonly modelId: ModelId;
  readonly receivedBytes: number;
  /** `null` when the server did not send a length. */
  readonly totalBytes: number | null;
}

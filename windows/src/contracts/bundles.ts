// The on-device models that are fetched on first use rather than shipped in the installer:
// Parakeet Ultra (English + Russian speech), Qwen3-1.7B (the modes) and, only for a user who
// turns Arabic on, its two engines (C4). PURE data.
//
// WHY THESE ARE NOT `ModelId`s. `ModelId` is a whisper.cpp ggml FILE — one file, four
// magic bytes, a role in the model store's three-step resolution, and a row in `--check`'s
// report that CI asserts on. A Parakeet bundle is five files of ONNX, and the GGUF has
// different magic bytes; folding either into `MODEL_IDS` would make the ggml inspection call
// them corrupt, and every consumer of that enum would need a case it cannot act on.
//
// D-W3 said "no first-run download" because the Uzbek model cannot be public and a failed
// download after install is a second chance to fail. Neither applies here: both files are
// public, pinned to one commit and sha256-checked. Since D-W25 they are the CORE download,
// fetched after setup with no question asked: Uzbek works from the first minute, English and
// Russian wait for Parakeet (a press says how far it has got — the installer no longer carries
// whisper turbo), and every mode runs its deterministic half until the GGUF lands. This is the Mac's arrangement
// (`ModelCatalogue.parakeetUltra` / `.polishModel`, fetched through `ModelStore`).

import { PUBLIC_MODELS_BASE } from './models.js';

export const BUNDLE_IDS = ['parakeet_ultra', 'qwen3_1_7b', 'silero_vad', 'cohere_arabic', 'fastconformer_ar', 'gemma4_e2b_ar', 'ecapa_lid'] as const;
export type BundleId = (typeof BUNDLE_IDS)[number];

/** One file of a bundle: where it is in the upstream repo, and what it must be. */
export interface BundleFile {
  /** Path inside the upstream repository at the pinned revision. */
  readonly remotePath: string;
  /** Name on disk inside the bundle's directory. */
  readonly localName: string;
  readonly bytes: number;
  /** Lowercase hex. Never empty: a bundle is fetched only when every file can be verified. */
  readonly sha256: string;
}

export interface ModelBundleSpec {
  readonly id: BundleId;
  /** Shown to the user. */
  readonly name: string;
  /** The directory under the models directory the files land in. */
  readonly directory: string;
  /** `https://huggingface.co/<repo>/resolve/<revision>/` — pinned, so a force-push upstream is a 404, not a different model. */
  readonly baseUrl: string;
  readonly files: readonly BundleFile[];
  /** Attribution the About page and NOTICE owe before release. */
  readonly licence: string;
  /**
   * True when the INSTALLER carries it (staged by `scripts/fetch-models.mjs` into
   * `resources/models/<directory>/`), so the app never downloads it. Only Silero today: 885 KB
   * is not worth a network request, a second chance to fail, or an energy-gate fallback on a
   * first Uzbek dictation that happened before a download finished.
   */
  readonly shipped?: boolean;
}

/**
 * Parakeet Ultra, int8 ONNX — C1 §8. moondream's post-training of NVIDIA Parakeet-TDT-0.6B-v3,
 * exported by Olicorne with istupakov's onnx-asr layout. Scored on this project's own
 * FLEURS sets at 5.8 % English / 7.3 % Russian on ONNX Runtime, the Mac's accuracy.
 */
export const PARAKEET_ULTRA: ModelBundleSpec = {
  id: 'parakeet_ultra',
  name: 'Parakeet Ultra',
  directory: 'parakeet-tdt-0.6b-v3-ultra-int8',
  baseUrl:
    'https://huggingface.co/Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx/resolve/dd203225f41c8a7d0323967afa1869cea0907436/',
  files: [
    {
      remotePath: 'int8/encoder-model.int8.onnx',
      localName: 'encoder-model.int8.onnx',
      bytes: 649_524_002,
      sha256: 'fc7de298eae88ba8aae8ea62bde60cd401401bd294748b8d57a72e5ad6b9d04a',
    },
    {
      remotePath: 'int8/decoder_joint-model.int8.onnx',
      localName: 'decoder_joint-model.int8.onnx',
      bytes: 18_203_490,
      sha256: 'f7e2db395a3b738cb2893cfb853d25863cebcc5282583a2e86b5762559e0bd32',
    },
    {
      remotePath: 'nemo128.onnx',
      localName: 'nemo128.onnx',
      bytes: 139_764,
      sha256: 'a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f',
    },
    {
      remotePath: 'vocab.txt',
      localName: 'vocab.txt',
      bytes: 93_939,
      sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d',
    },
    {
      remotePath: 'config.json',
      localName: 'config.json',
      bytes: 97,
      sha256: '666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466',
    },
  ],
  licence: 'CC-BY-4.0 (NVIDIA Parakeet-TDT-0.6B-v3 → moondream parakeet-ultra → Olicorne ONNX export)',
};

/** Qwen3-1.7B Q4_K_M — C3 §7. The same GGUF the Mac runs, Apache-2.0. */
export const QWEN3_1_7B: ModelBundleSpec = {
  id: 'qwen3_1_7b',
  name: 'Qwen3-1.7B',
  directory: 'qwen3-1.7b-q4_k_m',
  baseUrl: 'https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/daeb8e2d528a760970442092f6bf1e55c3b659eb/',
  files: [
    {
      remotePath: 'Qwen3-1.7B-Q4_K_M.gguf',
      localName: 'Qwen3-1.7B-Q4_K_M.gguf',
      bytes: 1_282_439_264,
      sha256: 'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5',
    },
  ],
  licence: 'Apache-2.0 (Qwen3-1.7B, GGUF by ggml-org)',
};

/**
 * Silero VAD v6.2.0 in ggml — C2 §4, §10. What the streaming Uzbek session cuts at pauses
 * with, through whisper.cpp's own `whisper_vad_*` in `kotiba-stt.exe`. 885 KB, MIT. Without it
 * each stream falls back to the energy gate, which cost whole phrases on the harness.
 *
 * SHIPPED IN THE INSTALLER, not downloaded: `baseUrl` is where `fetch-models.mjs` stages it
 * from at build time, and the sha256 below is checked there and again by the app.
 */
export const SILERO_VAD: ModelBundleSpec = {
  id: 'silero_vad',
  name: 'Silero VAD',
  directory: 'silero-vad-v6.2.0',
  baseUrl: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/',
  files: [
    {
      remotePath: 'ggml-silero-v6.2.0.bin',
      localName: 'ggml-silero-v6.2.0.bin',
      bytes: 885_098,
      sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
    },
  ],
  licence: 'MIT (snakers4/silero-vad, ggml conversion by ggml-org)',
  shipped: true,
};

/**
 * Cohere Transcribe Arabic 07-2026, Q5_K_M GGUF — C4 §7.2, the Arabic winner: 7.0 % WER on
 * FLEURS MSA against whisper turbo's 13.8 %, 38 % on Casablanca dialects against 61 %, and
 * punctuation F1 73 where whisper writes almost none. Run by transcribe.cpp (MIT) through its
 * npm binding, CPU or Vulkan on Windows.
 *
 * The upstream `CohereLabs/…` repo is click-through gated; this is handy-computer's ungated
 * Apache-2.0 redistribution, pinned to one commit. FETCHED ONLY WHEN THE USER TURNS ARABIC ON —
 * 1.77 GB is not something a dictation app downloads behind anyone's back.
 */
export const COHERE_ARABIC: ModelBundleSpec = {
  id: 'cohere_arabic',
  name: 'Cohere Transcribe Arabic',
  directory: 'cohere-transcribe-arabic-07-2026-q5_k_m',
  baseUrl:
    'https://huggingface.co/handy-computer/cohere-transcribe-arabic-07-2026-gguf/resolve/5e6b33c211458ac69347d297abb6d47a250c328f/',
  files: [
    {
      remotePath: 'cohere-transcribe-arabic-07-2026-Q5_K_M.gguf',
      localName: 'cohere-transcribe-arabic-07-2026-Q5_K_M.gguf',
      bytes: 1_770_270_112,
      sha256: '55e61c9b047e36f0e084d367f6b0bfecc71a6a0527da6eea4f0c687f3584775f',
    },
  ],
  licence: 'Apache-2.0 (Cohere Transcribe Arabic 07-2026, © Cohere; GGUF by handy-computer)',
};

/**
 * NVIDIA FastConformer-Hybrid Arabic (115 M), int8 ONNX — C4 §7.3.1, the Arabic engine for a PC
 * too slow for Cohere: whisper-turbo accuracy (12.9 % MSA, tied) WITH punctuation (F1 61), and a
 * key-release tail of 74–94 ms on a CPU where Cohere's was ~600 ms. Run on the ONNX Runtime the
 * port already carries for Parakeet; its log-mel front end is `src/core/stt/nemo-ctc.ts`.
 * Fetched automatically only when Arabic is on AND the speed check (or the user) chooses it.
 */
export const FASTCONFORMER_AR: ModelBundleSpec = {
  id: 'fastconformer_ar',
  name: 'FastConformer Arabic',
  directory: 'stt-ar-fastconformer-hybrid-large-pcd-int8',
  baseUrl:
    'https://huggingface.co/OpenVoiceOS/stt_ar_fastconformer_hybrid_large_pcd_v1.0_onnx/resolve/c5f78db4d5a8da706ab74cad73481c18b8d736b9/',
  files: [
    {
      remotePath: 'model.int8.onnx',
      localName: 'model.int8.onnx',
      bytes: 131_652_238,
      sha256: '91820d182c2643da79b3a858d980675a442c120a203dac2482ded90da087ebd8',
    },
    {
      remotePath: 'vocab.txt',
      localName: 'vocab.txt',
      bytes: 12_858,
      sha256: '9b938381a19a69bb279cdcfc299419f25a049ea1de192e0d10317274a0f20074',
    },
    {
      remotePath: 'config.json',
      localName: 'config.json',
      bytes: 96,
      sha256: 'e807f8692efbb65fec1e6356c55e58e9ce023d67f49b0dc36608b1d9d4b59480',
    },
  ],
  licence: 'CC-BY-4.0 (NVIDIA stt_ar_fastconformer_hybrid_large_pcd_v1.0 → OpenVoiceOS ONNX export)',
};

/**
 * Gemma 4 E2B Q4_K_M — Arabic's own modes model (the Mac's `ModelCatalogue.arabicModesModel`,
 * C4 §14.5): Super, Message and Note for Arabic dictations only; every other language keeps
 * Qwen3-1.7B. Optional, offered with Arabic. Apache-2.0 (Google), unsloth's GGUF, pinned.
 */
export const GEMMA4_E2B_AR: ModelBundleSpec = {
  id: 'gemma4_e2b_ar',
  name: 'Gemma 4 E2B (Arabic modes)',
  directory: 'gemma-4-e2b-it-q4_k_m',
  baseUrl: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/0314792d7f1f7e229411f620751375812bb9faf2/',
  files: [
    {
      remotePath: 'gemma-4-E2B-it-Q4_K_M.gguf',
      localName: 'gemma-4-E2B-it-Q4_K_M.gguf',
      bytes: 3_106_738_272,
      sha256: '740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8',
    },
  ],
  licence: 'Apache-2.0 (Google Gemma 4 E2B, GGUF by unsloth)',
};

/**
 * The language-ID model (P4, D-14): SpeechBrain's VoxLingua107 ECAPA-TDNN, exported by
 * `Scripts/export-ecapa.py` as one ONNX graph (opset 17, Float32) from the waveform to 107
 * log-posteriors — byte-reproducible from the pinned Hugging Face revision, and published with
 * this project's own model builds (`PUBLIC_MODELS_BASE`; `Scripts/Manifest.json` role
 * `language-id-windows`). The Mac runs the same graph as Core ML.
 *
 * SHIPPED IN THE INSTALLER, like whisper base, the detector it replaces: routing is what makes
 * Uzbek reachable at all, and Uzbek works offline from the first launch (D-W3). 86 MB is over
 * `SHIPPED_HASH_LIMIT_BYTES`, so `fetch-models.mjs` stages it WITH its verification stamp. A dev
 * tree without it — or an install that lost it — routes on whisper base, and the Languages page
 * offers it as a download (`lang.downloadDetector`).
 */
export const ECAPA_LID: ModelBundleSpec = {
  id: 'ecapa_lid',
  name: 'VoxLingua107 language ID',
  directory: 'ecapa-voxlingua107-lid',
  baseUrl: PUBLIC_MODELS_BASE,
  files: [
    {
      remotePath: 'ecapa-voxlingua107-lid.onnx',
      localName: 'ecapa-voxlingua107-lid.onnx',
      bytes: 86_031_971,
      sha256: '63e67bbfd406512158325dd8453014216f24d02f121d32d8a8c2ddcf85083cb6',
    },
  ],
  licence: 'Apache-2.0 (SpeechBrain lang-id-voxlingua107-ecapa); trained on VoxLingua107, CC BY 4.0',
  shipped: true,
};

export const BUNDLE_CATALOGUE: Readonly<Record<BundleId, ModelBundleSpec>> = {
  parakeet_ultra: PARAKEET_ULTRA,
  qwen3_1_7b: QWEN3_1_7B,
  silero_vad: SILERO_VAD,
  cohere_arabic: COHERE_ARABIC,
  fastconformer_ar: FASTCONFORMER_AR,
  gemma4_e2b_ar: GEMMA4_E2B_AR,
  ecapa_lid: ECAPA_LID,
};

/** The bundles the installer carries. Their absence is a broken install, not a download. */
export const SHIPPED_BUNDLE_IDS: readonly BundleId[] = BUNDLE_IDS.filter((id) => BUNDLE_CATALOGUE[id].shipped === true);

/**
 * The largest bundle whose shipped copy is VERIFIED BY HASH when found without a stamp. The
 * installer's copy carries no `.kotiba-verified.json` (NSIS integrity is the installer's own
 * CRC), so a small shipped bundle is hashed once per launch instead — Silero is 885 KB, about
 * 2 ms. Anything bigger must carry a stamp.
 */
export const SHIPPED_HASH_LIMIT_BYTES = 16 * 1024 * 1024;

export function bundleBytes(spec: ModelBundleSpec): number {
  return spec.files.reduce((sum, file) => sum + file.bytes, 0);
}

/** Where a bundle is, as the user reads it. One value, set by the component that knows. */
export type BundleState =
  | { readonly kind: 'notDownloaded' }
  | { readonly kind: 'downloading'; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly kind: 'downloaded' }
  | { readonly kind: 'loaded' }
  | { readonly kind: 'failed'; readonly reason: string };

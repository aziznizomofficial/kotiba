// Settings › About, as data. PURE.
//
// The short form of THIRD_PARTY_NOTICES.md, as the Mac's `AboutCard` is
// (Sources/KotibaUI/Panes/AboutPane.swift) — with the WINDOWS builds named where the two
// platforms differ (Parakeet is the ONNX export here, not the Core ML build). The wording is
// legal, not marketing: if a model or library is added to the app, add its line here and its
// row in THIRD_PARTY_NOTICES.md.
//
// THE LINKS ARE ALSO THE ALLOW-LIST. The renderer may ask main to open a URL in the browser,
// and main opens it only when it is EXACTLY one of the addresses below (`isAllowedExternalLink`).
// A page that has been made to ask for anything else — another scheme, a `file:` path, a
// lookalike host, the same host with a different path — gets a refusal, never a browser.

import type { MessageKey } from '../core/i18n/index.js';
import { t } from '../core/i18n/index.js';

/** Where the source lives. */
export const SOURCE_URL = 'https://github.com/aziznizomofficial/kotiba';

/** The full notices, in the repository. */
export const NOTICES_URL = 'https://github.com/aziznizomofficial/kotiba/blob/main/THIRD_PARTY_NOTICES.md';

export interface Credit {
  readonly title: string;
  readonly detail: string;
  /** Opened in the browser. Must be https and is part of the allow-list. */
  readonly link: string;
  readonly linkLabel: string;
}

/**
 * CC BY 4.0 §3(a) asks for this attribution wherever the model is used, and the Windows app
 * uses Olicorne's ONNX int8 export — the sentence THIRD_PARTY_NOTICES.md §1.1 gives, for the
 * Windows build.
 */
export const PARAKEET_ATTRIBUTION =
  '“Parakeet Ultra” is a post-training by moondream of NVIDIA’s parakeet-tdt-0.6b-v3, licensed ' +
  'under CC BY 4.0 (creativecommons.org/licenses/by/4.0). Kotiba uses the ONNX int8 export by ' +
  'Olicorne. Changes were made to the original model by those parties; Kotiba makes none. No ' +
  'endorsement by NVIDIA, moondream or Olicorne is implied.';

/** The models, in the order a user meets them. */
export const MODEL_CREDITS: readonly Credit[] = [
  {
    title: 'English and Russian: Parakeet Ultra — CC BY 4.0',
    detail: PARAKEET_ATTRIBUTION,
    link: 'https://huggingface.co/Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx',
    linkLabel: 'Model',
  },
  {
    title: 'Uzbek: Kotib STT (uzbek_stt_v1) — Apache-2.0',
    detail:
      'Kotib/uzbek_stt_v1 by the Kotibai & Rubai team, a fine-tune of OpenAI Whisper medium. ' +
      'Here it is converted to ggml and quantised to q5_0, which is a modification. ' +
      'Kotiba is not affiliated with KotibAI (kotib.ai).',
    link: 'https://huggingface.co/Kotib/uzbek_stt_v1',
    linkLabel: 'Model',
  },
  {
    title: 'Turkish and language detection: Whisper — MIT',
    detail:
      'OpenAI Whisper large-v3-turbo (downloaded with Turkish or Arabic) and base, © 2022 OpenAI; ggml conversion and quantisation ' +
      'by the ggml authors.',
    link: 'https://huggingface.co/ggerganov/whisper.cpp',
    linkLabel: 'Model',
  },
  {
    title: 'Modes: Qwen3-1.7B — Apache-2.0',
    detail: 'Alibaba Qwen team; GGUF and Q4_K_M quantisation by ggml-org.',
    link: 'https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF',
    linkLabel: 'Model',
  },
  {
    title: 'Arabic: Cohere Transcribe Arabic 07-2026 — Apache-2.0',
    detail:
      'Cohere Transcribe Arabic 07-2026, © Cohere; GGUF conversion and Q5_K_M quantisation by ' +
      'handy-computer. Downloaded only when Arabic is turned on.',
    link: 'https://huggingface.co/handy-computer/cohere-transcribe-arabic-07-2026-gguf',
    linkLabel: 'Model',
  },
  {
    title: 'Arabic on a slower PC: NVIDIA FastConformer — CC BY 4.0',
    detail:
      '“stt_ar_fastconformer_hybrid_large_pcd_v1.0” by NVIDIA, licensed under CC BY 4.0 ' +
      '(creativecommons.org/licenses/by/4.0); ONNX int8 export by OpenVoiceOS. Changes were made ' +
      'by those parties; Kotiba makes none. No endorsement by NVIDIA or OpenVoiceOS is implied.',
    link: 'https://huggingface.co/OpenVoiceOS/stt_ar_fastconformer_hybrid_large_pcd_v1.0_onnx',
    linkLabel: 'Model',
  },
  {
    title: 'Pauses in Uzbek: Silero VAD — MIT',
    detail: 'Silero Team; ggml conversion by ggml-org. Ships inside the installer.',
    link: 'https://huggingface.co/ggml-org/whisper-vad',
    linkLabel: 'Model',
  },
];

/** The software the app is built on, THIRD_PARTY_NOTICES.md §2–§4. */
export const LIBRARY_CREDITS: readonly Credit[] = [
  {
    title: 'whisper.cpp and llama.cpp (ggml) — MIT',
    detail: '© 2023–2026 The ggml authors. whisper.cpp runs in kotiba-stt.exe; llama.cpp through node-llama-cpp.',
    link: 'https://github.com/ggml-org/whisper.cpp',
    linkLabel: 'Source',
  },
  {
    title: 'ONNX Runtime — MIT',
    detail: '© Microsoft Corporation, through onnxruntime-node. Runs Parakeet.',
    link: 'https://github.com/microsoft/onnxruntime',
    linkLabel: 'Source',
  },
  {
    title: 'node-llama-cpp — MIT',
    detail: '© 2023 Gilad S. Runs Qwen3-1.7B.',
    link: 'https://github.com/withcatai/node-llama-cpp',
    linkLabel: 'Source',
  },
  {
    title: 'transcribe.cpp and koffi — MIT',
    detail: '© The transcribe.cpp authors, © Niels Martignène. Run Cohere Transcribe Arabic.',
    link: 'https://github.com/handy-computer/transcribe.cpp',
    linkLabel: 'Source',
  },
  {
    title: 'Electron and Chromium — MIT and others',
    detail:
      '© Electron contributors, © 2013–2020 GitHub Inc. Chromium’s own notices are in ' +
      'LICENSES.chromium.html beside Kotiba.exe.',
    link: 'https://github.com/electron/electron',
    linkLabel: 'Source',
  },
  {
    title: 'Uzbek text normaliser — MIT',
    detail: 'A port of NavAI uzbek_text_norm v0.3.0, © 2026 NavAI. zod (MIT) validates the settings file.',
    link: 'https://github.com/NavAI-pro/uzbek-text-norm',
    linkLabel: 'Source',
  },
];

/**
 * What each model is FOR, the part of a credit's title before the colon — the one part that is
 * prose rather than a name and a licence. Translated; the names, the licences and the
 * attribution sentences stay exactly as the licences ask for them.
 */
const PURPOSE_KEYS: Readonly<Record<string, MessageKey>> = {
  'English and Russian': 'about.purpose.enRu',
  Uzbek: 'about.purpose.uzbek',
  'Turkish and language detection': 'about.purpose.fallback',
  Modes: 'about.purpose.modes',
  'Pauses in Uzbek': 'about.purpose.pauses',
  Arabic: 'about.purpose.arabic',
  'Arabic on a slower PC': 'about.purpose.arabicFast',
  'Uzbek text normaliser': 'about.purpose.normaliser',
};

/** A credit's title in the interface language: "Узбекский: Kotib STT (uzbek_stt_v1) — Apache-2.0". */
export function creditTitle(credit: Credit): string {
  const colon = credit.title.indexOf(': ');
  if (colon > 0) {
    const key = PURPOSE_KEYS[credit.title.slice(0, colon)];
    if (key !== undefined) return `${t(key)}: ${credit.title.slice(colon + 2)}`;
  }
  const dash = credit.title.indexOf(' — ');
  if (dash > 0) {
    const key = PURPOSE_KEYS[credit.title.slice(0, dash)];
    if (key !== undefined) return `${t(key)} — ${credit.title.slice(dash + 3)}`;
  }
  return credit.title;
}

export function creditLinkLabel(credit: Credit): string {
  return credit.linkLabel === 'Model' ? t('about.model') : credit.linkLabel === 'Source' ? t('about.source') : credit.linkLabel;
}

/** Every address the About card may open, and nothing else. */
export const EXTERNAL_LINKS: ReadonlySet<string> = new Set([
  SOURCE_URL,
  NOTICES_URL,
  ...MODEL_CREDITS.map((credit) => credit.link),
  ...LIBRARY_CREDITS.map((credit) => credit.link),
]);

/**
 * Whether main may hand `url` to the browser. Exact membership AND https, checked on the
 * string the renderer sent — never normalised first, so `HTTPS://…` or a trailing `#` is a
 * different string and is refused.
 */
export function isAllowedExternalLink(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('https://') && EXTERNAL_LINKS.has(url);
}

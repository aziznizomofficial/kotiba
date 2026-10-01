// The model downloads, as data. PURE. (D-W25, superseding D-W23's Download models checklist.)
//
// Onboarding, Home's "Getting Kotiba ready" card, the Languages and Modes pages and the
// launch-time resume all read what is here, so they cannot disagree about what a model is
// called, how big it is, what Kotiba does without it, or when it is fetched.
//
// THE RULE (owner, 2026-10-02): a light installer, and no choices to make. The CORE — Parakeet
// Ultra (English and Russian) and Qwen3-1.7B (the modes) — downloads by itself once onboarding is
// finished or skipped, and resumes at every launch until it is here. Turkish and Arabic carry
// nothing by default: turning one on downloads everything it needs (Turkish: whisper turbo;
// Arabic: Cohere, turbo and Gemma 4 E2B), with the size shown before and the progress during.
import {
  BUNDLE_CATALOGUE,
  DOWNLOADABLE_MODELS,
  MODEL_CATALOGUE,
  bundleBytes,
  type AcceptedDownload,
  type BundleState,
  type ModelStatus,
} from '../contracts/index.js';
import { formatDecimal, t } from '../core/i18n/index.js';

export { DOWNLOADABLE_MODELS, type AcceptedDownload };

/** What one row of the step, and of the Languages page's list, shows. */
export type DownloadState =
  /** Verified on disk. */
  | { readonly kind: 'installed' }
  /** Shipped inside the installer — nothing to fetch. */
  | { readonly kind: 'included' }
  | { readonly kind: 'notDownloaded' }
  | { readonly kind: 'downloading'; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly kind: 'failed'; readonly reason: string }
  /** Missing, and there is no public copy to fetch it from. */
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface DownloadRow {
  readonly id: AcceptedDownload;
  readonly state: DownloadState;
}

export interface DownloadCopy {
  /** What it is for, first — the user decides on that, not on a model's name. */
  readonly title: string;
  readonly model: string;
  readonly bytes: number;
  /** What Kotiba does until it lands. Shown under the row, and in the summary. */
  readonly meanwhile: string;
}

export const DOWNLOAD_COPY: Readonly<Record<AcceptedDownload, DownloadCopy>> = {
  parakeet_ultra: {
    get title(): string {
      return t('dl.parakeet.title');
    },
    model: 'Parakeet Ultra',
    bytes: bundleBytes(BUNDLE_CATALOGUE.parakeet_ultra),
    get meanwhile(): string {
      return t('dl.parakeet.meanwhile');
    },
  },
  uzbek_stt_v1: {
    get title(): string {
      return t('dl.uzbek.title');
    },
    model: 'Kotib STT (uzbek_stt_v1)',
    bytes: MODEL_CATALOGUE.uzbek_stt_v1.bytes ?? 0,
    get meanwhile(): string {
      return t('dl.uzbek.meanwhile');
    },
  },
  qwen3_1_7b: {
    get title(): string {
      return t('dl.qwen.title');
    },
    model: 'Qwen3-1.7B',
    bytes: bundleBytes(BUNDLE_CATALOGUE.qwen3_1_7b),
    get meanwhile(): string {
      return t('dl.qwen.meanwhile');
    },
  },
  // Turkish's engine, and Arabic's language head and fallback (C4 §14.1) — one file for both.
  large_v3_turbo: {
    get title(): string {
      return t('dl.turbo.title');
    },
    model: 'whisper large-v3-turbo',
    bytes: MODEL_CATALOGUE.large_v3_turbo.bytes ?? 0,
    get meanwhile(): string {
      return t('dl.turbo.meanwhile');
    },
  },
  // C4: Arabic's engine. It also covers FastConformer (132 MB), which is fetched only if the
  // speed check (or the user) puts Arabic on it — the size shown is Cohere's.
  cohere_arabic: {
    get title(): string {
      return t('dl.arabic.title');
    },
    model: 'Cohere Transcribe Arabic',
    bytes: bundleBytes(BUNDLE_CATALOGUE.cohere_arabic),
    get meanwhile(): string {
      return t('dl.arabic.meanwhile');
    },
  },
  // Arabic's own modes model (C4 §14.5).
  gemma4_e2b_ar: {
    get title(): string {
      return t('dl.gemma.title');
    },
    model: 'Gemma 4 E2B',
    bytes: bundleBytes(BUNDLE_CATALOGUE.gemma4_e2b_ar),
    get meanwhile(): string {
      return t('dl.gemma.meanwhile');
    },
  },
};

/**
 * The core: what every user gets after setup, without being asked. Uzbek ships in the installer,
 * so its row is `included` and nothing is fetched — it is here so a damaged install mends itself.
 */
export const CORE_DOWNLOADS: readonly AcceptedDownload[] = ['parakeet_ultra', 'uzbek_stt_v1', 'qwen3_1_7b'];

/** Everything an optional language needs, fetched the moment it is turned on. */
export const LANGUAGE_DOWNLOADS: Readonly<Record<'tr' | 'ar', readonly AcceptedDownload[]>> = {
  tr: ['large_v3_turbo'],
  ar: ['large_v3_turbo', 'cohere_arabic', 'gemma4_e2b_ar'],
};

/** Megabytes, as the step and the buttons print them (decimal, like the sizes users see elsewhere). */
export function megabytes(bytes: number): string {
  return bytes >= 1_000_000_000
    ? t('unit.gb', { value: formatDecimal(bytes / 1_000_000_000, 2) })
    : t('unit.mb', { value: String(Math.round(bytes / 1_000_000)) });
}

/** A first-use bundle's state, as a row. */
export function bundleRowState(state: BundleState): DownloadState {
  switch (state.kind) {
    case 'downloaded':
    case 'loaded':
      return { kind: 'installed' };
    case 'downloading':
      return state;
    case 'failed':
      return { kind: 'failed', reason: state.reason };
    case 'notDownloaded':
      return { kind: 'notDownloaded' };
  }
}

/**
 * The Uzbek row. It ships in the installer (D-W3 still holds for it), so on a healthy install it
 * is `included`. Missing, it can be fetched only once this project's own model host is live
 * (`PUBLIC_MODELS_LIVE`); until then the honest answer is "reinstall", not a button that 404s.
 */
export function uzbekRowState(options: {
  readonly status: ModelStatus;
  readonly inInstaller: boolean;
  readonly downloadable: boolean;
  readonly downloading: { readonly receivedBytes: number; readonly totalBytes: number } | null;
  readonly error: string | null;
}): DownloadState {
  if (options.status === 'ready') return options.inInstaller ? { kind: 'included' } : { kind: 'installed' };
  if (options.downloading !== null) return { kind: 'downloading', ...options.downloading };
  if (!options.downloadable) {
    return {
      kind: 'unavailable',
      reason:
        options.status === 'corrupt'
          ? t('dl.uzbek.damaged')
          : t('dl.uzbek.missing'),
    };
  }
  if (options.error !== null) return { kind: 'failed', reason: options.error };
  return { kind: 'notDownloaded' };
}

/**
 * A downloaded model file's row (whisper turbo — Turkish's engine, Arabic's head): on this PC,
 * on its way, failed with why, or not downloaded. Never `included`: the installer does not carry it.
 */
export function modelRowState(options: {
  readonly status: ModelStatus;
  readonly downloading: { readonly receivedBytes: number; readonly totalBytes: number } | null;
  readonly error: string | null;
}): DownloadState {
  if (options.status === 'ready') return { kind: 'installed' };
  if (options.downloading !== null) return { kind: 'downloading', ...options.downloading };
  if (options.error !== null) return { kind: 'failed', reason: options.error };
  return { kind: 'notDownloaded' };
}

/** A row that is already on this PC — nothing to fetch. */
export function isPresent(state: DownloadState): boolean {
  return state.kind === 'installed' || state.kind === 'included';
}

/**
 * What to fetch now: every download the languages that are on want (`downloadWanted`) and that
 * is not here yet, in `DOWNLOADABLE_MODELS` order — Parakeet first, because it is what English
 * and Russian wait for. Nothing before onboarding is over (finished or skipped): the languages
 * are not chosen yet. After it, no acceptance is needed (D-W25). Asked at launch, when onboarding
 * ends, and whenever the languages change.
 */
export function launchResume(options: {
  readonly onboardingCompleted: boolean;
  readonly enabledLanguages: readonly string[];
  readonly present: (id: AcceptedDownload) => boolean;
}): AcceptedDownload[] {
  if (!options.onboardingCompleted) return [];
  return wantedDownloads(options.enabledLanguages).filter((id) => !options.present(id));
}

/** Every download the languages in `enabled` want, in fetch order. */
export function wantedDownloads(enabled: readonly string[]): AcceptedDownload[] {
  return DOWNLOADABLE_MODELS.filter((id) => downloadWanted(id, enabled));
}

/**
 * What turning `language` on would download, in bytes: its files (`LANGUAGE_DOWNLOADS`) that are
 * not on this PC. 0 for the core languages, and for one whose files are all here already. Shown
 * under the off toggle, before anything starts.
 */
export function languageDownloadBytes(language: string, rows: readonly DownloadRow[]): number {
  const ids = language === 'tr' || language === 'ar' ? LANGUAGE_DOWNLOADS[language] : [];
  return ids
    .filter((id) => {
      const row = rows.find((each) => each.id === id);
      return row === undefined || !isPresent(row.state);
    })
    .reduce((sum, id) => sum + DOWNLOAD_COPY[id].bytes, 0);
}

/** The one card while the core is still arriving: what is left, one bar, and a failure if any. */
export interface CoreReadiness {
  /** Bytes still to fetch, for "Getting Kotiba ready — 1.95 GB". */
  readonly remainingBytes: number;
  /** 0…1 over the core downloads that are not inside the installer. */
  readonly fraction: number;
  /** Something failed and nothing is downloading — the reason, for the Try again line. */
  readonly failed: string | null;
}

/**
 * Home's and onboarding's "Getting Kotiba ready" card, or `null` once the core is all here (or
 * nothing of it can be fetched). Only the core rows the languages that are on want; a row
 * shipped in the installer is not part of the bar.
 */
export function coreReadiness(rows: readonly DownloadRow[], enabled: readonly string[]): CoreReadiness | null {
  const core = rows.filter(
    (row) =>
      CORE_DOWNLOADS.includes(row.id) &&
      downloadWanted(row.id, enabled) &&
      row.state.kind !== 'included' &&
      row.state.kind !== 'unavailable',
  );
  if (core.every((row) => row.state.kind === 'installed')) return null;
  let total = 0;
  let done = 0;
  for (const row of core) {
    const bytes = DOWNLOAD_COPY[row.id].bytes;
    total += bytes;
    if (row.state.kind === 'installed') done += bytes;
    else if (row.state.kind === 'downloading') done += Math.min(bytes, row.state.receivedBytes);
  }
  const busy = core.some((row) => row.state.kind === 'downloading');
  const failure = core.find((row) => row.state.kind === 'failed');
  return {
    remainingBytes: Math.max(0, total - done),
    fraction: total > 0 ? Math.min(1, done / total) : 1,
    failed: !busy && failure !== undefined && failure.state.kind === 'failed' ? failure.state.reason : null,
  };
}

/** The downloads a dictation language waits for until they land. */
const ENGINE_DOWNLOADS: Readonly<Record<string, readonly AcceptedDownload[]>> = {
  en: ['parakeet_ultra'],
  ru: ['parakeet_ultra'],
  tr: ['large_v3_turbo'],
  ar: ['cohere_arabic', 'large_v3_turbo'],
};

/**
 * How far `language`'s engine download has got, in whole percent — or `null` when it is not on
 * its way (here already, failed, or never asked for). A dictation that finds no engine says this
 * ("still downloading, 42 %") instead of "not ready" (D-W25). `queued` counts as 0 %.
 */
export function gettingReadyPercent(
  language: string,
  rows: readonly DownloadRow[],
  queued: ReadonlySet<AcceptedDownload>,
): number | null {
  const ids = ENGINE_DOWNLOADS[language] ?? [];
  const pending = rows.filter(
    (row) => ids.includes(row.id) && !isPresent(row.state) && (row.state.kind === 'downloading' || queued.has(row.id)),
  );
  if (pending.length === 0) return null;
  let total = 0;
  let done = 0;
  for (const row of pending) {
    const bytes = DOWNLOAD_COPY[row.id].bytes;
    total += bytes;
    if (row.state.kind === 'downloading') done += Math.min(bytes, row.state.receivedBytes);
  }
  return total > 0 ? Math.min(99, Math.floor((100 * done) / total)) : 0;
}

/** The accepted list with `ids` added, in the canonical order, no duplicates. */
export function withAccepted(accepted: readonly AcceptedDownload[], ids: readonly AcceptedDownload[]): AcceptedDownload[] {
  const all = new Set([...accepted, ...ids]);
  return DOWNLOADABLE_MODELS.filter((id) => all.has(id));
}

/** Narrow what the renderer sent to known ids. Anything else is dropped, never fetched. */
export function parseDownloadIds(payload: unknown): AcceptedDownload[] {
  if (!Array.isArray(payload)) return [];
  return DOWNLOADABLE_MODELS.filter((id) => payload.includes(id));
}

/** One line per model still missing: what Kotiba does meanwhile. Empty once all are here. */
export function degradedNotes(rows: readonly DownloadRow[]): string[] {
  return rows.filter((row) => !isPresent(row.state)).map((row) => DOWNLOAD_COPY[row.id].meanwhile);
}

/**
 * Whether a download is wanted while `enabled` are the languages dictated in: a language's model
 * while a language it serves is on (Parakeet: English or Russian; the Uzbek model: Uzbek; whisper
 * turbo: Turkish or Arabic; Cohere and Gemma: Arabic), the modes' model always. Only these are
 * fetched, and the Languages page lists only these (the Mac's `ModelDownloads.Item.isWanted`).
 */
export function downloadWanted(id: AcceptedDownload, enabled: readonly string[]): boolean {
  switch (id) {
    case 'parakeet_ultra':
      return enabled.includes('en') || enabled.includes('ru');
    case 'uzbek_stt_v1':
      return enabled.includes('uz');
    case 'large_v3_turbo':
      return enabled.includes('tr') || enabled.includes('ar');
    case 'cohere_arabic':
    case 'gemma4_e2b_ar':
      return enabled.includes('ar');
    case 'qwen3_1_7b':
      return true;
  }
}

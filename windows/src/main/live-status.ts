// The controller's status as a title, a tone and a sentence — shared by the sidebar
// footer and the Home hero. PURE — the port of `LiveStatus` (Sources/KotibaUI/MainWindow.swift).

import type { Blocker, BlockerId, DictationStatus } from '../contracts/index.js';
import type { AcceptedDownload } from '../contracts/index.js';
import type { MessageKey } from '../core/i18n/index.js';
import { t } from '../core/i18n/index.js';

import type { DownloadRow } from './downloads-model.js';

/** The pipeline's stage words, as the interface says them. Unknown ones pass through. */
const STAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  arming: 'stage.arming',
  finalising: 'stage.finalising',
  routing: 'stage.routing',
  loading: 'stage.loading',
  transcribing: 'stage.transcribing',
  rerouting: 'stage.rerouting',
  polishing: 'stage.polishing',
  inserting: 'stage.inserting',
  'reached the 30-minute limit — transcribing everything up to it': 'stage.captureLimit',
};

/** "transcribing" → "transcribing" / "распознаю" / …, lower-case as a sentence uses it. */
export function stageName(stage: string): string {
  const key = STAGE_KEYS[stage];
  return key === undefined ? stage : t(key);
}


/** macOS `stage.capitalized` — first character up, the rest untouched. */
export function capitaliseStage(stage: string): string {
  if (stage.length === 0) return stage;
  const first = [...stage][0] ?? '';
  return first.toUpperCase() + stage.slice(first.length);
}

export interface LiveStatus {
  readonly title: string;
  readonly detail: string;
  readonly tone: 'good' | 'warning' | 'neutral';
  /** Something is happening right now: the dot pulses and the hero shows the pill. */
  readonly busy: boolean;
}

/** `hotkey` is the key in words, as a sentence says it: "right Ctrl", "F13". */
export function liveStatus(
  status: DictationStatus,
  blockers: readonly Blocker[],
  hotkey: string,
): LiveStatus {
  switch (status.kind) {
    case 'listening':
      return { title: t('live.listening'), detail: t('live.listeningDetail'), tone: 'good', busy: true };
    // Loading is not a problem and is not coloured like one: it finishes by itself.
    case 'preparing':
      return { title: t('live.loading'), detail: t('live.loadingDetail', { what: status.what }), tone: 'neutral', busy: true };
    case 'working':
      return {
        title: capitaliseStage(stageName(status.stage)),
        detail: t('live.workingDetail'),
        tone: 'good',
        busy: true,
      };
    case 'failed':
      return { title: t('live.didntFinish'), detail: status.message, tone: 'warning', busy: false };
    case 'idle':
    case 'succeeded':
    case 'heardNothing':
      // Calm, not an alarm: the notices under the hero say what to do, one line each.
      return {
        title: blockers.length > 0 ? t('live.almostReady') : t('live.ready'),
        detail: t('live.readyDetail', { key: hotkey }),
        tone: blockers.length > 0 ? 'neutral' : 'good',
        busy: false,
      };
  }
}

/** The model a blocker is about, when a download can fix it. */
const HEALED_BY: Partial<Record<BlockerId, AcceptedDownload>> = {
  'uzbek-model': 'uzbek_stt_v1',
  'russian-model': 'parakeet_ultra',
};

/**
 * The blockers the user should see: everything, less a missing model whose download is
 * running right now — that one is fixing itself, and comes back if the download fails. The
 * Mac's `DictationController.heals`.
 */
export function withoutHealing(
  blockers: readonly Blocker[],
  downloads: readonly DownloadRow[],
): Blocker[] {
  const running = new Set(downloads.filter((row) => row.state.kind === 'downloading').map((row) => row.id));
  return blockers.filter((blocker) => {
    const model = HEALED_BY[blocker.id];
    return model === undefined || !running.has(model);
  });
}

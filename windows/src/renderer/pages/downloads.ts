// The models list on the Languages page, from the one list main pushes (`AppSnapshot.downloads`),
// and the single "Getting Kotiba ready" card onboarding and Home show while the core arrives
// (D-W25 — the per-model checklist onboarding had under D-W23 is gone).
//
// A row: what the model is FOR, its name and size, and where it is — a live bar while it
// downloads (it resumes where it stopped), "On this PC" or "Included" once it is here, and the
// reason when it failed or cannot be fetched, with Try again. Under the list, what Kotiba does
// meanwhile — it works from the first minute, only slower or plainer.

import type { AcceptedDownload, DownloadRow, DownloadState } from '../../main/downloads-model.js';
import { DOWNLOAD_COPY, coreReadiness, degradedNotes, megabytes } from '../../main/downloads-model.js';
import { t } from '../../core/i18n/index.js';

import { footnote, h, hairline, statusDot } from '../components.js';
import type { Scope } from '../store.js';
import { store } from '../store.js';

export interface DownloadListOptions {
  /** Fetch one now — the Download / Try again button on a row that is not here. */
  readonly onDownload?: (id: AcceptedDownload) => void;
  /** Rows not to draw: models only languages that are off want. */
  readonly exclude?: ReadonlySet<AcceptedDownload>;
}

function percent(state: Extract<DownloadState, { kind: 'downloading' }>): number {
  return state.totalBytes > 0 ? Math.min(100, Math.floor((100 * state.receivedBytes) / state.totalBytes)) : 0;
}

function status(state: DownloadState): HTMLElement {
  switch (state.kind) {
    case 'installed':
      return statusDot(t('dl.onThisPc'), 'good');
    case 'included':
      return statusDot(t('dl.included'), 'good');
    case 'downloading':
      return statusDot(`${percent(state)} %`, 'warning', true);
    case 'failed':
      return statusDot(t('dl.didNotFinish'), 'bad');
    case 'unavailable':
      return statusDot(t('dl.missing'), 'bad');
    case 'notDownloaded':
      return statusDot(t('dl.notDownloaded'), 'neutral');
  }
}

function row(item: DownloadRow, options: DownloadListOptions): HTMLElement {
  const copy = DOWNLOAD_COPY[item.id];
  const state = item.state;
  const leading = h('span', { class: 'dl-check-spacer' });
  const trailing: (HTMLElement | null)[] = [status(state)];
  if (options.onDownload !== undefined && (state.kind === 'notDownloaded' || state.kind === 'failed')) {
    const fetch = h('button', { class: 'btn primary small', attrs: { type: 'button' } }, [
      state.kind === 'failed' ? t('dl.tryAgain') : t('dl.download'),
    ]);
    fetch.addEventListener('click', () => options.onDownload?.(item.id));
    trailing.push(fetch);
  }
  return h('div', { class: 'dl-row' }, [
    h('div', { class: 'row' }, [
      leading,
      h('div', { class: 'words' }, [
        h('div', { class: 'title', style: { 'font-weight': '600' } }, [
          copy.title,
          h('span', { class: 'c-tertiary', style: { 'font-weight': '400' } }, [` · ${copy.model}`]),
        ]),
        h('div', { class: 'detail-text' }, [
          state.kind === 'downloading'
            ? t('dl.progress', { received: megabytes(state.receivedBytes), total: megabytes(state.totalBytes) })
            : state.kind === 'included'
              ? t('dl.insideInstaller', { size: megabytes(copy.bytes) })
              : megabytes(copy.bytes),
        ]),
      ]),
      h('div', { class: 'control', style: { display: 'flex', gap: '8px', 'align-items': 'center' } }, trailing),
    ]),
    state.kind === 'downloading'
      ? h('div', { class: 'dl-bar', attrs: { role: 'progressbar', 'aria-valuenow': String(percent(state)) } }, [
          h('div', { class: 'dl-fill', style: { width: `${percent(state)}%` } }),
        ])
      : null,
    state.kind === 'failed' || state.kind === 'unavailable' ? footnote(state.reason, 'danger') : null,
  ]);
}

/** The list, redrawn whenever main pushes a new snapshot. */
export function downloadList(scope: Scope, options: DownloadListOptions = {}): HTMLElement {
  const list = h('div', { class: 'dl-list' });
  const meanwhile = h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '4px' } });
  scope.watch(['app'], () => {
    const rows = store.app.downloads.filter((item) => options.exclude?.has(item.id) !== true);
    const items: HTMLElement[] = [];
    rows.forEach((item, index) => {
      if (index > 0) items.push(hairline());
      items.push(row(item, options));
    });
    list.replaceChildren(...items);
    const notes = degradedNotes(rows);
    meanwhile.replaceChildren(...notes.map((note) => footnote(note)));
    meanwhile.hidden = notes.length === 0;
  });
  return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } }, [list, meanwhile]);
}

/**
 * "Getting Kotiba ready — 1.95 GB": one calm card with one bar over the core downloads that are
 * still arriving (Parakeet, Qwen), drawn by onboarding's last pages and by Home. It hides itself
 * once the core is here; a failure says why and offers Try again (the same downloads, resumed).
 */
export function readinessCard(scope: Scope, retry: () => void): HTMLElement {
  const title = h('div', { class: 't-headline' });
  const detail = h('div', { class: 'detail-text' });
  const fill = h('div', { class: 'dl-fill' });
  const bar = h('div', { class: 'dl-bar', attrs: { role: 'progressbar' } }, [fill]);
  const failure = h('div', { style: { display: 'flex', gap: '8px', 'align-items': 'center', 'flex-wrap': 'wrap' } });
  const root = h('div', { class: 'engine-card readiness-card' }, [
    h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '4px' } }, [title, detail]),
    bar,
    failure,
  ]);
  scope.watch(['app', 'settings'], () => {
    const ready = coreReadiness(store.app.downloads, store.settings.enabledLanguages);
    root.hidden = ready === null;
    if (ready === null) return;
    const percent = Math.floor(100 * ready.fraction);
    title.textContent = t('ready.title', { size: megabytes(ready.remainingBytes) });
    detail.textContent = t('ready.detail');
    fill.style.width = `${percent}%`;
    bar.setAttribute('aria-valuenow', String(percent));
    if (ready.failed === null) {
      failure.replaceChildren();
    } else {
      const again = h('button', { class: 'btn small', attrs: { type: 'button' } }, [t('dl.tryAgain')]);
      again.addEventListener('click', retry);
      failure.replaceChildren(footnote(t('ready.failed', { why: ready.failed }), 'danger'), again);
    }
  });
  return root;
}

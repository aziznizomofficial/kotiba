// Modes and Languages — what your words turn into, and which engine hears them. Ports
// of ModesPane and LanguagesPane (Sources/KotibaUI/Panes), with the Windows engine facts.

import { BUNDLE_CATALOGUE, DOWNLOADABLE_MODELS, MODEL_CATALOGUE, bundleBytes } from '../../contracts/index.js';
import type { AcceptedDownload } from '../../main/downloads-model.js';
import { downloadWanted, languageDownloadBytes, megabytes as sizeText } from '../../main/downloads-model.js';
import type { ArabicEngineChoice, BundleId, BundleState, Language } from '../../contracts/index.js';
import { canTurnOff, languageSubset } from '../../core/routing/language-subset.js';
import { detectionWanted } from '../../core/settings/models.js';
import { arabicChoiceOptions, arabicEngineLine, arabicReasonLine } from '../../main/languages-model.js';
import type { ModelSlotState } from '../../main/ipc.js';
import { IPC_INVOKE } from '../../main/ipc.js';
import { modeGlyph } from '../../main/pill-model.js';
import type { SectionId } from '../../main/settings-model.js';
import { appSections, modeSummary } from '../../main/settings-model.js';
import { formatDecimal, speechPickerName, t } from '../../core/i18n/index.js';

import { invoke } from '../bridge.js';
import { badge, button, flip, footnote, grid, h, segmented, statusDot, toggle } from '../components.js';
import { pageLanguageOrder } from '../language-order.js';
import { icon } from '../icons.js';
import { store } from '../store.js';

import type { Page } from './common.js';
import { modeName } from './common.js';

import { downloadList } from './downloads.js';
import { renderSection } from './section.js';
import { languagePicker, modePicker } from './usage.js';

function section(id: SectionId) {
  const found = appSections().find((each) => each.id === id);
  if (found === undefined) throw new Error(`no section ${id}`);
  return found;
}

/** Friendly names for the executables in the built-in activation lists. */
const APP_NAMES: Readonly<Record<string, string>> = {
  slack: 'Slack',
  discord: 'Discord',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  obsidian: 'Obsidian',
  notion: 'Notion',
  onenote: 'OneNote',
  winword: 'Word',
  outlook: 'Outlook',
  teams: 'Teams',
  'ms-teams': 'Teams',
  get notepad(): string {
    return t('app.notepad');
  },
};

function appName(id: string): string {
  return APP_NAMES[id.toLowerCase()] ?? id;
}

// ---------------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------------

export function modesPage(): Page {
  return renderSection(section('modes'), {
    customs: {
      modeNow: (scope) => {
        const detail = h('div', { class: 'detail-text' });
        scope.watch(['settings', 'app'], () => {
          detail.textContent =
            store.app.userPickedMode === null
              ? store.settings.modeFollowsApp
                ? t('modes.now.following')
                : t('modes.now.default')
              : t('modes.now.picked');
        });
        return h('div', { class: 'row' }, [
          h('div', { class: 'words' }, [h('div', { class: 'title' }, [t('s.right_now')]), detail]),
          h('div', { class: 'control', style: { 'min-width': '0', 'flex-shrink': '1' } }, [modePicker(scope)]),
        ]);
      },
      modeCards: (scope) => {
        const root = h('div');
        scope.watch(['settings', 'app'], () => {
          const defaultKey = store.settings.defaultModeKey;
          const follows = store.settings.modeFollowsApp;
          // What a polishing mode really runs right now — the rules alone until Qwen lands.
          const modesModel = store.app.onDevice.modesModel;
          const modelReady =
            store.settings.polishEnabled &&
            store.settings.preferOnDeviceModel &&
            (modesModel.kind === 'downloaded' || modesModel.kind === 'loaded');
          root.replaceChildren(
            grid(
              250,
              store.modes.map((mode) => {
                const isDefault = mode.key === defaultKey;
                const make = button(isDefault ? t('modes.default') : t('modes.makeDefault'), isDefault ? 'ghost' : 'default', () => {
                  // Not `mode:set`: this is the fallback, and pinning here would switch
                  // app-following off behind the toggle above.
                  void invoke(IPC_INVOKE.modeDefault, mode.key);
                }, true);
                make.disabled = isDefault;
                return h('div', { class: `mode-card${isDefault ? ' default' : ''}` }, [
                  h('div', { style: { display: 'flex', 'align-items': 'center', gap: '10px' } }, [
                    h('div', { class: `glyph-tile${isDefault ? ' on' : ''}` }, [icon(modeGlyph(mode.key), 15, 2)]),
                    h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '2px', flex: '1' } }, [
                      h('div', { class: 't-headline' }, [modeName(mode.key)]),
                      h('div', { class: 't-caption c-tertiary' }, [
                        !mode.polishes
                          ? t('modes.noModel')
                          : modelReady
                            ? t('modes.withModel')
                            : t('modes.rulesOnly'),
                      ]),
                    ]),
                    isDefault ? badge(follows ? t('modes.fallback') : t('modes.default'), 'accent') : null,
                  ]),
                  h('div', { class: 't-callout c-secondary' }, [modeSummary(mode.key)]),
                  mode.activationApps.length === 0
                    ? null
                    : h('div', { class: `t-caption ${follows ? 'c-secondary' : 'c-tertiary'}`, style: { display: 'flex', gap: '6px' } }, [
                        icon('app', 11, 2),
                        mode.activationApps.map(appName).join(', '),
                      ]),
                  h('div', { style: { 'margin-top': 'auto', display: 'flex', 'justify-content': 'flex-end' } }, [make]),
                ]);
              }),
            ),
          );
        });
        return root;
      },
      polishStatus: (scope) => {
        const root = h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } });
        scope.watch(['app', 'settings'], () => {
          const text = store.app.polishStatus;
          const model = store.app.onDevice.modesModel;
          const tone =
            !store.settings.polishEnabled ? 'neutral' : model.kind === 'failed' ? 'bad' : model.kind === 'downloaded' || model.kind === 'loaded' ? 'good' : 'warning';
          const row: (HTMLElement | null)[] = [statusDot(text, tone)];
          if (store.settings.polishEnabled && store.settings.preferOnDeviceModel) {
            row.push(bundleButton('qwen3_1_7b', model, t('modes.downloadModel')));
          }
          root.replaceChildren(...row.filter((each): each is HTMLElement => each !== null));
          root.hidden = text.length === 0;
        });
        return root;
      },
    },
  });
}

// ---------------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------------

function slot(role: string): ModelSlotState | null {
  return store.models?.slots.find((each) => each.role === role) ?? null;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] ?? path;
}

function megabytes(bytes: number): string {
  return t('unit.mb', { value: formatDecimal(bytes / 1_048_576, bytes > 100 * 1_048_576 ? 0 : 1) });
}

/**
 * Download / Retry for a first-use bundle, or nothing once it is on disk. The bytes shown
 * are the catalogue's, so the button can never promise a size the download is not.
 */
function bundleButton(id: BundleId, state: BundleState, label: string): HTMLElement | null {
  if (state.kind === 'downloaded' || state.kind === 'loaded') return null;
  const size = t('unit.mb', { value: String(Math.round(bundleBytes(BUNDLE_CATALOGUE[id]) / 1_000_000)) });
  const busy = state.kind === 'downloading';
  const text = busy
    ? t('dl.downloadingPercent', { percent: state.totalBytes > 0 ? Math.floor((100 * state.receivedBytes) / state.totalBytes) : 0 })
    : state.kind === 'failed'
      ? t('dl.tryAgainSize', { size })
      : t('dl.labelSize', { label, size });
  const control = button(text, 'primary', () => {
    void invoke(IPC_INVOKE.onDeviceDownload, id).finally(() => store.reloadModels());
  }, true);
  control.disabled = busy;
  return h('div', { style: { display: 'flex', gap: '6px', 'flex-wrap': 'wrap' } }, [
    control,
    state.kind === 'failed' ? footnote(state.reason, 'danger') : null,
  ]);
}

/** English and Russian: what Parakeet is doing, in one line. */
function parakeetLine(state: BundleState): string {
  switch (state.kind) {
    case 'loaded':
    case 'downloaded':
      return t('parakeet.ready');
    case 'downloading':
      return t('parakeet.downloading', { percent: state.totalBytes > 0 ? Math.floor((100 * state.receivedBytes) / state.totalBytes) : 0 });
    case 'failed':
      return t('parakeet.failed', { why: state.reason });
    case 'notDownloaded':
      return t('parakeet.notDownloaded');
  }
}

type EngineState = { kind: 'ready' } | { kind: 'missing' } | { kind: 'off' } | { kind: 'problem'; why: string };

function engineState(state: ModelSlotState | null): EngineState {
  if (state === null) return { kind: 'missing' };
  if (state.inspection.status === 'ready') return { kind: 'ready' };
  if (state.configuredPath.length === 0 && state.resolvedPath === null) return { kind: 'missing' };
  return { kind: 'problem', why: state.inspection.reason ?? t('engine.fileUnusable') };
}

function engineCard(options: {
  readonly code: string;
  readonly name: string;
  readonly engine: string;
  readonly state: EngineState;
  readonly file: { name: string; bytes: number } | null;
  readonly note: string;
  readonly extra?: HTMLElement | null;
  readonly actions?: HTMLElement | null;
}): HTMLElement {
  const ready = options.state.kind === 'ready';
  return h('div', { class: 'engine-card' }, [
    h('div', { style: { display: 'flex', 'align-items': 'center', gap: '10px' } }, [
      h('div', { class: `glyph-tile ${ready ? 'on' : 'off'}` }, [options.code]),
      h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '2px', flex: '1', 'min-width': '0' } }, [
        h('div', { class: 't-headline' }, [options.name]),
        h('div', { class: 't-caption c-tertiary' }, [options.engine]),
      ]),
      options.state.kind === 'ready'
        ? statusDot(t('common.ready'), 'good')
        : options.state.kind === 'off'
          ? statusDot(t('common.off'), 'neutral')
          : options.state.kind === 'missing'
          ? statusDot(t('common.noModel'), 'warning')
          : statusDot(t('engine.problem'), 'bad'),
    ]),
    options.file === null
      ? null
      : h('div', { style: { display: 'flex', gap: '6px', 'align-items': 'center', 'min-width': '0' } }, [
          icon('box', 11, 2),
          h('span', { class: 't-mono c-secondary', style: { overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' } }, [options.file.name]),
          options.file.bytes > 0 ? h('span', { class: 't-caption c-tertiary', style: { flex: 'none' } }, [megabytes(options.file.bytes)]) : null,
        ]),
    options.state.kind === 'problem' ? footnote(options.state.why, 'danger') : null,
    footnote(options.note),
    options.extra ?? null,
    h('div', { style: { 'margin-top': 'auto' } }, [options.actions ?? null]),
  ]);
}

/** Bytes each language's own model files would free (`language:removable`), re-asked on change. */
let removable: Readonly<Record<string, number>> = {};
let removableAsked = '';

/** Ask main again when the set of languages that are on (or the files on disk) may have moved. */
function refreshRemovable(repaint: () => void): void {
  const key = store.settings.enabledLanguages.join() + '|' + JSON.stringify(store.app.downloads.map((row) => row.state.kind));
  if (key === removableAsked) return;
  removableAsked = key;
  void invoke(IPC_INVOKE.languageRemovable).then((bytes) => {
    removable = bytes as Record<string, number>;
    repaint();
  }).catch(() => undefined);
}

/**
 * A language that is off: "Remove model files (size)", confirmed in place — the button turns
 * into the question and two buttons, never a dialog. Nothing while it is on, or when nothing of
 * its own is on disk (a file another language that is on still uses is kept).
 */
function removeFilesControl(code: Language): HTMLElement | null {
  const bytes = removable[code] ?? 0;
  if (store.settings.enabledLanguages.includes(code) || bytes <= 0) return null;
  const size = megabytes(bytes);
  const holder = h('div', { style: { display: 'flex', gap: '6px', 'flex-wrap': 'wrap', 'align-items': 'center' } });
  const ask = (): void => {
    const question = h('span', { class: 't-caption c-secondary' }, [t('lang.removeConfirm', { size })]);
    const yes = button(t('lang.removeYes'), 'destructive', () => {
      yes.disabled = true;
      void invoke(IPC_INVOKE.languageRemoveModels, code)
        .then(() => {
          removableAsked = '';
          return store.reloadModels();
        })
        .catch((error: unknown) => {
          holder.replaceChildren(footnote(error instanceof Error ? error.message : String(error), 'danger'));
        });
    }, true);
    holder.replaceChildren(question, yes, button(t('common.cancel'), 'ghost', idle, true));
  };
  const idle = (): void => {
    holder.replaceChildren(button(t('lang.removeFiles', { size }), 'ghost', ask, true));
  };
  idle();
  return holder;
}

/**
 * The five dictation languages' on/off — the last one on is disabled, with why — and the
 * fallback among those that are on. Off, a language is never routed to, not pinnable, not in
 * the tray or Home, and its engine is not kept in memory.
 */
function languageToggles(scope: import('../store.js').Scope): HTMLElement {
  const list = h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '4px' } });
  const fallback = h('div', { style: { display: 'contents' } });
  let order: readonly string[] = pageLanguageOrder(scope, (next) => {
    order = next;
    paint();
  });
  const paint = (): void => {
    const on = languageSubset(store.settings.enabledLanguages);
    const codes = order.filter((code): code is Language => ['uz', 'en', 'ru', 'tr', 'ar'].includes(code));
    list.replaceChildren(
      ...codes.map((code) => {
        const isOn = on.languages.has(code);
        const last = !canTurnOff(on, code);
        const control = toggle(isOn, (value) => {
          const next = value ? [...store.settings.enabledLanguages, code] : store.settings.enabledLanguages.filter((each) => each !== code);
          void store.write('enabledLanguages', next);
        }, t('lang.toggles.aria', { language: speechPickerName(code) }));
        control.set(isOn, last);
        return h('div', { class: 'row' }, [
          h('div', { class: `glyph-tile ${isOn ? 'on' : 'off'}` }, [code.toUpperCase()]),
          h('div', { class: 'words' }, [
            h('div', { class: 'title' }, [speechPickerName(code)]),
            last ? h('div', { class: 'detail-text' }, [t('lang.toggles.lastOn')]) : null,
            // Turkish and Arabic carry nothing until turned on (D-W25): the size, said first.
            !isOn && languageDownloadBytes(code, store.app.downloads) > 0
              ? h('div', { class: 'detail-text' }, [
                  t('lang.toggles.downloads', { size: sizeText(languageDownloadBytes(code, store.app.downloads)) }),
                ])
              : null,
          ]),
          h('div', { class: 'control' }, [control.element]),
        ]);
      }),
    );
    // The fallback, among the languages that are on — only when there is a choice to make.
    const enabledInOrder = codes.filter((code) => on.languages.has(code));
    if (enabledInOrder.length < 2) {
      fallback.replaceChildren();
      return;
    }
    const picker = segmented(
      enabledInOrder.map((code) => ({ value: code, label: speechPickerName(code) })),
      store.settings.defaultLanguage,
      (value) => {
        void store.write('defaultLanguage', value);
      },
    );
    fallback.replaceChildren(
      h('div', { class: 'row' }, [
        h('div', { class: 'words' }, [h('div', { class: 'title' }, [t('lang.fallback')])]),
        h('div', { class: 'control', style: { 'min-width': '0', 'flex-shrink': '1' } }, [picker.element]),
      ]),
    );
  };
  scope.watch(['settings'], paint);
  return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '8px' } }, [
    list,
    footnote(t('lang.toggles.footnote')),
    fallback,
  ]);
}

/** Arabic's engine: Automatic (the speed check decides), or the user's own pick. */
function arabicChoiceRow(choice: ArabicEngineChoice): HTMLElement {
  const picker = segmented(arabicChoiceOptions(), choice, (value) => {
    void store.write('arabicEngine', value);
  });
  return h('div', { class: 'row' }, [
    h('div', { class: 'words' }, [h('div', { class: 'title' }, [t('lang.ar.engine')])]),
    h('div', { class: 'control', style: { 'min-width': '0', 'flex-shrink': '1' } }, [picker.element]),
  ]);
}

/**
 * Download where a public copy exists — and nothing else: no file picker, no path reset. Only
 * Uzbek's card has one: whisper turbo is Turkish's and Arabic's and comes with them (D-W25).
 */
function modelButtons(role: 'uzbek', downloadId: 'uzbek_stt_v1' | null): HTMLElement {
  const state = slot(role);
  const ready = state?.inspection.status === 'ready';
  const row = h('div', { style: { display: 'flex', gap: '6px', 'flex-wrap': 'wrap' } });
  if (downloadId !== null && !ready) {
    const spec = MODEL_CATALOGUE[downloadId];
    const busy = store.app.downloading !== null;
    const download = button(
      busy ? t('dl.downloading') : t('dl.downloadSize', { size: t('unit.mb', { value: String(Math.round((spec.bytes ?? 0) / 1_048_576)) }) }),
      'primary',
      () => {
        void invoke(IPC_INVOKE.modelsDownload, downloadId).finally(() => store.reloadModels());
      },
      true,
    );
    download.disabled = busy;
    row.append(download);
  }
  return row;
}

/** Arabic's card: which engine serves and why, the override, and the download — or Off. */
function arabicCard(russian: ModelSlotState | null): HTMLElement {
  const enabled = store.settings.enabledLanguages.includes('ar');
  const status = store.app.arabic;
  const wanted = status?.wanted ?? 'cohere';
  const bundle: BundleId = wanted === 'cohere' ? 'cohere_arabic' : 'fastconformer_ar';
  const bundleState = wanted === 'cohere' ? (status?.cohere ?? { kind: 'notDownloaded' }) : (status?.fastConformer ?? { kind: 'notDownloaded' });
  return engineCard({
    code: 'AR',
    name: speechPickerName('ar'),
    engine: arabicEngineLine(status),
    // Ready as soon as it is on: whisper types Arabic until Cohere lands.
    state: !enabled ? { kind: 'off' } : status?.active !== null && status !== null ? { kind: 'ready' } : engineState(russian),
    file: null,
    note: enabled ? arabicReasonLine(status) : t('lang.off.note'),
    extra: enabled ? arabicChoiceRow(store.settings.arabicEngine) : null,
    actions: enabled
      ? h('div', { style: { display: 'flex', gap: '6px', 'flex-wrap': 'wrap' } }, [
          bundleButton(bundle, bundleState, wanted === 'cohere' ? t('lang.ar.downloadCohere') : t('lang.ar.downloadFastConformer')),
          // Arabic's own modes model (C4 §14.5): Super, Message and Note for Arabic.
          bundleButton('gemma4_e2b_ar', store.app.onDevice.arabicModesModel, t('lang.ar.downloadModes')),
        ])
      : removeFilesControl('ar'),
  });
}

export function languagesPage(): Page {
  return renderSection(section('languages'), {
    customs: {
      languageToggles: (scope) => languageToggles(scope),
      quickPickers: (scope) => {
        const detail = h('div', { class: 'detail-text' });
        const detector = h('div', { style: { display: 'flex', gap: '8px', 'align-items': 'center' } });
        scope.watch(['app'], () => {
          const pinned = store.app.pinnedLanguage;
          detail.textContent =
            pinned === null
              ? t('lang.pin.automatic')
              : t('lang.pin.pinned', { language: speechPickerName(pinned) });
        });
        // The detector is the half Kotiba CAN fetch — public, and what makes automatic detection
        // work at all. Since P4 it is the language-ID model (86 MB, `ecapa_lid`): the installer
        // carries it, so this shows only for a tree or an install without it (whisper base, if
        // present, routes meanwhile and the row does not show).
        scope.watch(['models', 'settings', 'app'], () => {
          const report = store.models;
          const needs = detectionWanted(store.settings) && report !== null && !report.autoDetectReady;
          detector.hidden = !needs;
          if (!needs) return;
          const detectorSlot = slot('detector');
          const busy = store.app.downloading !== null;
          const fetch = button(busy ? t('dl.downloading') : t('lang.downloadDetector'), 'primary', () => {
            void invoke(IPC_INVOKE.onDeviceDownload, 'ecapa_lid').finally(() => store.reloadModels());
          });
          fetch.disabled = busy;
          detector.replaceChildren(
            statusDot(t('lang.needsDetector'), 'warning'),
            h('span', { style: { flex: '1' } }),
            detectorSlot?.inspection.status === 'ready' ? '' : fetch,
          );
        });
        return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '12px' } }, [
          h('div', { class: 'row' }, [
            h('div', { class: 'words' }, [h('div', { class: 'title' }, [t('menu.language')]), detail]),
            h('div', { class: 'control', style: { 'min-width': '0', 'flex-shrink': '1' } }, [languagePicker(scope)]),
          ]),
          detector,
        ]);
      },
      engineCards: (scope) => {
        const root = h('div');
        // The cards follow the pickers' order (default, then recent use), fixed for the life
        // of the page; the grid keeps its element so a late re-sort can glide (`flip`).
        const cardGrid = grid(250, []);
        let order: readonly string[] = pageLanguageOrder(scope, (next) => {
          order = next;
          paintCards();
        });
        let cards: Readonly<Record<string, HTMLElement>> = {};
        const paintCards = (): void => {
          flip(cardGrid, () => {
            cardGrid.replaceChildren(
              ...order.flatMap((code) => {
                const card = cards[code];
                if (card === undefined) return [];
                card.setAttribute('data-key', code);
                return [card];
              }),
            );
          });
        };
        root.append(cardGrid);
        const unwanted = new Set<AcceptedDownload>(
          DOWNLOADABLE_MODELS.filter((id) => !downloadWanted(id, store.settings.enabledLanguages)),
        );
        // Every model the languages that are on want (D-W25), with a button per
        // row that is not here: Download / Try again, resumed after a restart.
        const models = h('div', { class: 'engine-card', style: { 'margin-top': '12px' } }, [
          h('div', { class: 't-headline' }, [t('lang.modelsOnThisPc')]),
          downloadList(scope, {
            // A model only languages that are off use is not offered (`downloadWanted`).
            exclude: unwanted,
            onDownload: (id) => {
              void invoke(IPC_INVOKE.downloadsAccept, [id]).finally(() => store.reloadModels());
            },
          }),
        ]);
        const repaint = (): void => {
          paint();
        };
        const paint = (): void => {
          const on = (code: Language): boolean => store.settings.enabledLanguages.includes(code);
          unwanted.clear();
          for (const id of DOWNLOADABLE_MODELS) if (!downloadWanted(id, store.settings.enabledLanguages)) unwanted.add(id);
          // A language that is off: its card says Off, and offers to remove its own files.
          const offCard = (code: Language, engine: string): HTMLElement =>
            engineCard({
              code: code.toUpperCase(),
              name: speechPickerName(code),
              engine,
              state: { kind: 'off' },
              file: null,
              note: t('lang.off.note'),
              actions: removeFilesControl(code),
            });
          const russian = slot('russian');
          const uzbek = slot('uzbek');
          const fast = store.settings.fastEnglish;
          const fastEnglish = slot('fastEnglish');
          const parakeet = store.app.onDevice.parakeet;
          const parakeetReady = parakeet.kind === 'downloaded' || parakeet.kind === 'loaded';
          const fastToggle = toggle(fast, (value) => {
            void store.write('fastEnglish', value);
          }, t('lang.fastEnglishAria'));
          cards = {
              en: !on('en') ? offCard('en', 'Parakeet Ultra') : engineCard({
                code: 'EN',
                name: speechPickerName('en'),
                // D-W25: Parakeet is the engine; until it lands English waits for it (or Fast
                // English's small.en, or turbo on a PC that has it for Turkish or Arabic).
                engine: parakeetReady || !fast ? 'Parakeet Ultra' : 'whisper small.en',
                state: parakeetReady ? { kind: 'ready' } : engineState(fast ? fastEnglish : russian),
                file: null,
                note: parakeetLine(parakeet),
                actions: bundleButton('parakeet_ultra', parakeet, t('lang.downloadParakeet')),
                extra: h('div', { class: 'row' }, [
                  h('div', { class: 'words' }, [
                    h('div', { class: 'title' }, [t('lang.fastEnglish')]),
                    h('div', { class: 'detail-text' }, [t('lang.fastEnglishDetail')]),
                  ]),
                  h('div', { class: 'control' }, [fastToggle.element]),
                ]),
              }),
              ru: !on('ru') ? offCard('ru', 'Parakeet Ultra') : engineCard({
                code: 'RU',
                name: speechPickerName('ru'),
                engine: 'Parakeet Ultra',
                state: parakeetReady ? { kind: 'ready' } : engineState(russian),
                file:
                  russian?.resolvedPath === null || russian === null
                    ? null
                    : { name: fileName(russian.resolvedPath), bytes: russian.inspection.bytes },
                note: parakeetReady ? t('lang.ruNoteParakeet') : parakeetLine(parakeet),
                actions: bundleButton('parakeet_ultra', parakeet, t('lang.downloadParakeet')),
              }),
              uz: !on('uz') ? offCard('uz', 'Kotib STT (uzbek_stt_v1)') : engineCard({
                code: 'UZ',
                name: speechPickerName('uz'),
                engine: 'Kotib STT (uzbek_stt_v1)',
                state: engineState(uzbek),
                file:
                  uzbek?.resolvedPath === null || uzbek === null
                    ? null
                    : { name: fileName(uzbek.resolvedPath), bytes: uzbek.inspection.bytes },
                note: uzbek?.inspection.status === 'ready' ? t('lang.uzNoteReady') : t('lang.uzNoteMissing'),
                actions: modelButtons('uzbek', 'uzbek_stt_v1'),
              }),
              tr: !on('tr') ? offCard('tr', 'whisper large-v3-turbo') : engineCard({
                code: 'TR',
                name: speechPickerName('tr'),
                engine: 'whisper large-v3-turbo',
                state: engineState(russian),
                file: null,
                // Its download (turned on = fetched, D-W25) shows in the models list below.
                note: t('lang.tr.note', { size: sizeText(MODEL_CATALOGUE.large_v3_turbo.bytes ?? 0) }),
              }),
              ar: arabicCard(russian),
          };
          paintCards();
          refreshRemovable(repaint);
        };
        scope.watch(['models', 'settings', 'app'], paint);
        return h('div', {}, [root, models]);
      },
    },
  });
}


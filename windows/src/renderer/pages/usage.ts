// Home, History and Statistics — the pages about what Kotiba is doing and has done.
// Ports of HomePane, HistoryPane and StatisticsPane (Sources/KotibaUI/Panes).

import type { HistoryEntry, Language } from '../../contracts/index.js';
import { LANGUAGES } from '../../contracts/index.js';
import type { StatsBucketUnit, StatsPeriod } from '../../core/stats/index.js';
import {
  STATS_PERIODS,
  TYPING_WORDS_PER_MINUTE,
  formatCount,
  formatDuration,
  formatMillis,
  indexBySecond,
  recordForEntry,
  releaseToPasteMillis,
  resolveStatsPeriod,
  usageStats,
} from '../../core/stats/index.js';
import { keycapLabels } from '../../core/hotkey/index.js';
import { formatDecimal, speechPickerName, t, tn } from '../../core/i18n/index.js';
import { quietMicKind } from '../../core/input-device/index.js';
import { countFormat, durationFormat, millisFormat } from '../../main/count-up.js';
import { IPC_INVOKE } from '../../main/ipc.js';
import { wantedDownloads } from '../../main/downloads-model.js';
import { liveStatus } from '../../main/live-status.js';
import { languageCode, pillState } from '../../main/pill-model.js';
import type { SectionId } from '../../main/settings-model.js';
import { appSections, greeting } from '../../main/settings-model.js';

import { invoke } from '../bridge.js';
import { createPromoGlobe } from '../promo-globe.js';
import type { PromoWords } from '../promo-globe.js';
import { readinessCard } from './downloads.js';
import { pageLanguageOrder } from '../language-order.js';
import {
  badge,
  boundToggle,
  button,
  flashCopied,
  footnote,
  grid,
  h,
  hotkeyCap,
  hotkeyWords,
  iconButton,
  keycap,
  segmented,
  statTile,
  statusDot,
  withNode,
} from '../components.js';
import { periodChart, shareBars, stageChart } from '../charts.js';
import { icon } from '../icons.js';
import { createPill } from '../pill.js';
import { Scope, livePillStyle, store } from '../store.js';

import type { Page } from './common.js';
import { languageName, longDate, modeName, shortDateTime } from './common.js';
import { renderSection } from './section.js';

function section(id: SectionId) {
  const found = appSections().find((each) => each.id === id);
  if (found === undefined) throw new Error(`no section ${id}`);
  return found;
}

// ---------------------------------------------------------------------------------
// Shared cards: the blockers and the two quick pickers
// ---------------------------------------------------------------------------------

/** A notice's glyph, from the renderer's icon set. */
function noticeIcon(id: string): string {
  switch (id) {
    case 'microphone':
      return 'mic';
    case 'hotkey':
      return 'keyboard';
    case 'uzbek-model':
    case 'russian-model':
    case 'detector-model':
      return 'globe';
    default:
      return 'alert';
  }
}

/**
 * What the user has to do, if anything: one small, calm row each, animated in and out as
 * they appear and clear — the Mac's `Notices` / `NoticeRow`. Replaced the "Needs your
 * attention" panel (owner's review, 2026-09-30); `store.app.blockers` holds only what needs
 * the user. The microphone is the one permission Windows has, and "Allow" opens its page.
 */
export function blockersView(scope: Scope, emptyText: string | null): HTMLElement {
  const list = h('div', { class: 'notices' });
  const rows = new Map<string, HTMLElement>();
  const check = button(t('blockers.checkAgain'), 'link', undefined, true);
  check.addEventListener('click', () => {
    check.disabled = true;
    check.textContent = t('blockers.checking');
    void invoke(IPC_INVOKE.recheck).finally(() => {
      check.disabled = false;
      check.textContent = t('blockers.checkAgain');
    });
  });
  const empty = h('div');
  const root = h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '8px' } }, [
    empty,
    list,
    h('div', { style: { display: 'flex', 'justify-content': 'flex-end' } }, [check]),
  ]);
  scope.watch(['app'], () => {
    const blockers = store.app.blockers;
    const ids = new Set<string>(blockers.map((blocker) => blocker.id));
    // Out: fade and shrink, then go — rather than vanishing under the pointer.
    for (const [id, row] of rows) {
      if (ids.has(id)) continue;
      rows.delete(id);
      row.classList.add('leaving');
      setTimeout(() => row.remove(), 200);
    }
    for (const blocker of blockers) {
      const detail = h('div', { class: 'detail selectable' }, [blocker.detail ?? '']);
      detail.hidden = blocker.detail === null;
      detail.addEventListener('click', () => detail.classList.toggle('open'));
      const row = h('div', { class: 'notice' }, [
        h('span', { class: 'glyph' }, [icon(noticeIcon(blocker.id), 12, 2.2)]),
        h('div', { class: 'words' }, [h('div', { class: 'title' }, [blocker.headline]), detail]),
        blocker.id === 'microphone'
          ? button(t('blockers.allow'), 'default', () => void invoke(IPC_INVOKE.openMicrophoneSettings), true)
          : null,
      ]);
      const existing = rows.get(blocker.id);
      if (existing === undefined) list.append(row);
      else existing.replaceWith(row);
      if (existing !== undefined) row.classList.add('settled');
      rows.set(blocker.id, row);
    }
    check.hidden = blockers.length === 0;
    empty.replaceChildren(blockers.length === 0 && emptyText !== null ? statusDot(emptyText, 'good') : '');
    root.hidden = blockers.length === 0 && emptyText === null;
  });
  return root;
}

/**
 * A microphone that barely registered a real hold: which one, what kind of input it is, and
 * the button for Sound settings — the Mac's `QuietMicNotice`. One calm row, like the
 * blockers', sent away by its ✕ or by the next dictation that comes out as text.
 */
export function quietMicView(scope: Scope): HTMLElement {
  const root = h('div', { class: 'notices' });
  root.hidden = true;
  scope.watch(['app'], () => {
    const device = store.app.quietMic;
    root.hidden = device === null;
    if (device === null) {
      root.replaceChildren();
      return;
    }
    const kind = quietMicKind(device);
    const detail = h('div', { class: 'detail selectable' }, [
      t(kind === 'continuity' ? 'home.quietMic.continuity' : kind === 'builtIn' ? 'home.quietMic.builtIn' : 'home.quietMic.external'),
    ]);
    detail.addEventListener('click', () => detail.classList.toggle('open'));
    root.replaceChildren(
      h('div', { class: 'notice settled' }, [
        h('span', { class: 'glyph' }, [icon('mic', 12, 2.2)]),
        h('div', { class: 'words' }, [h('div', { class: 'title' }, [t('home.quietMic.title', { device: device.name })]), detail]),
        button(t('home.quietMic.open'), 'default', () => void invoke(IPC_INVOKE.openSoundSettings), true),
        iconButton('x', t('common.dismiss'), () => void invoke(IPC_INVOKE.quietMicDismiss)),
      ]),
    );
  });
  return root;
}

const AUTOMATIC = '__automatic';

/** Mode — the tray's semantics: a pick pins, Automatic exists only while the app decides. */
export function modePicker(scope: Scope): HTMLElement {
  let options: { value: string; label: string }[] = [];
  let picker: ReturnType<typeof segmented<string>> | null = null;
  const holder = h('div', { style: { 'min-width': '0', display: 'flex', 'justify-content': 'flex-end' } });
  const build = (): void => {
    const follows = store.settings.modeFollowsApp;
    const next = [
      ...(follows ? [{ value: AUTOMATIC, label: t('common.automatic') }] : []),
      ...(['super', 'note', 'message'] as const).map((key) => ({ value: key as string, label: modeName(key) })),
    ];
    if (JSON.stringify(next) !== JSON.stringify(options) || picker === null) {
      options = next;
      picker = segmented(options, null, (value) => {
        if (value === AUTOMATIC) void invoke(IPC_INVOKE.modeClear);
        else void invoke(IPC_INVOKE.modeSet, value);
      });
      holder.replaceChildren(picker.element);
    }
    const picked = store.app.userPickedMode;
    picker.set(follows ? (picked ?? AUTOMATIC) : (picked ?? store.settings.defaultModeKey));
  };
  scope.watch(['settings', 'app'], build);
  return holder;
}

/**
 * Language — the pin. Only languages whose model resolves can be pinned, and an optional one
 * (Turkish, Arabic — C4) is not listed at all until it is turned on in the Languages page; the
 * picker is rebuilt when that set changes, so turning one on shows it here at once.
 */
export function languagePicker(scope: Scope): HTMLElement {
  const labelled = (code: Language): { value: string; label: string } => ({ value: code, label: speechPickerName(code) });
  const shown = (): Language[] =>
    order.filter((code) => store.settings.enabledLanguages.includes(code));
  let order = pageLanguageOrder(scope, (next) => {
    order = next;
    picker.reorder([AUTOMATIC, ...shown()]);
  });
  const holder = h('div', { style: { display: 'contents' } });
  let listed = '';
  const build = (): ReturnType<typeof segmented<string>> =>
    // Automatic first, then every language in the page's order (default, then recent use).
    segmented([{ value: AUTOMATIC, label: t('common.automatic') }, ...shown().map(labelled)], AUTOMATIC, (value) => {
      void invoke(IPC_INVOKE.languagePin, value === AUTOMATIC ? null : value);
    });
  let picker = build();
  holder.append(picker.element);
  scope.watch(['app', 'settings'], () => {
    const now = shown().join();
    if (listed !== '' && now !== listed) {
      picker = build();
      holder.replaceChildren(picker.element);
    }
    listed = now;
    const pinnable = new Set<string>(store.app.pinnableLanguages);
    const disabled = new Set<string>(LANGUAGES.filter((code) => !pinnable.has(code)));
    picker.set(store.app.pinnedLanguage ?? AUTOMATIC, disabled);
  });
  return holder;
}

function pickerRow(title: string, detail: string, control: HTMLElement): { row: HTMLElement; detailNode: HTMLElement } {
  const detailNode = h('div', { class: 'detail-text' }, [detail]);
  const row = h('div', { class: 'row' }, [
    h('div', { class: 'words' }, [h('div', { class: 'title' }, [title]), detailNode]),
    h('div', { class: 'control', style: { 'min-width': '0', 'flex-shrink': '1' } }, [control]),
  ]);
  return { row, detailNode };
}

// ---------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------

export function homePage(navigate: (id: SectionId) => void): Page {
  const pills: ReturnType<typeof createPill>[] = [];
  const page = renderSection(section('home'), {
    decorate: (scope, frame) => {
      const update = (): void => {
        frame.titleNode.textContent = greeting(new Date().getHours());
      };
      update();
      const timer = setInterval(update, 60_000);
      scope.add(() => clearInterval(timer));
    },
    customs: {
      // The V19 "Globe" promo, first row (Mac: PromoGlobePanel). Its frame loop stops whenever it
      // cannot be seen, and with the page: the scope disposes it when Home goes.
      promo: (scope) => {
        const words = (): PromoWords => ({
          modes: { Raw: t('mode.raw'), Super: t('mode.super'), Message: t('mode.message'), Note: t('mode.note') },
          hotkey: keycapLabels(store.settings.hotkey.vk).at(-1) ?? '',
        });
        const player = createPromoGlobe(words(), t('home.promo.label'));
        scope.add(() => player.dispose());
        scope.watch(['settings'], () => player.setWords(words()), false);
        return player.element;
      },
      hero: (scope) => {
        const dot = h('span');
        const detail = h('div', { class: 't-title' });
        const how = h('div', { class: 'how with-key' });
        const visual = h('div', { class: 'visual' });
        const pill = createPill({ style: livePillStyle });
        pills.push(pill);
        const cap = h('span');
        visual.append(pill.element, cap);
        const wash = h('div', { class: 'hero-wash' });
        const root = h('section', { class: 'card', style: { 'container-type': 'inline-size' } }, [
          wash,
          h('div', { class: 'hero' }, [h('div', { class: 'words' }, [dot, detail, how]), visual]),
        ]);
        scope.watch(['app', 'settings'], () => {
          const vk = store.settings.hotkey.vk;
          const live = liveStatus(store.app.status, store.app.blockers, hotkeyWords(vk));
          dot.replaceChildren(statusDot(live.title, live.tone, live.busy));
          detail.textContent = live.detail;
          how.replaceChildren(...withNode(t('home.how'), hotkeyCap(vk)));
          const busy = live.busy;
          const state = pillState(store.app.status, store.app.lastRecord);
          pill.set(state.kind === 'hidden' ? { kind: 'listening' } : state, busy);
          pill.element.style.position = busy ? 'relative' : 'absolute';
          cap.hidden = busy;
          cap.replaceChildren(keycap(keycapLabels(vk).at(-1) ?? '', true));
          wash.style.setProperty(
            '--wash',
            live.tone === 'warning' ? 'rgba(255,192,97,0.10)' : busy ? 'rgba(126,240,200,0.22)' : 'rgba(126,240,200,0.08)',
          );
        });
        // The pill in the hero is the live meter while listening. The level arrives at
        // 20 Hz; the pill's own frame loop (running only while it shows bars) smooths it.
        scope.watch(['level'], () => pill.setLevel(store.level), false);
        return root;
      },
      // D-W25: while the core is still arriving, one calm "Getting Kotiba ready" bar above the
      // notices (it hides itself once Parakeet and Qwen are here).
      blockers: (scope) =>
        h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '12px' } }, [
          readinessCard(scope, () => {
            void invoke(IPC_INVOKE.downloadsAccept, wantedDownloads(store.settings.enabledLanguages)).catch(() => undefined);
          }),
          blockersView(scope, null),
        ]),
      quickPickers: (scope) => {
        const mode = pickerRow(t('menu.mode'), t('home.mode.detail'), modePicker(scope));
        const language = pickerRow(t('menu.language'), t('home.language.detail'), languagePicker(scope));
        scope.watch(['settings'], () => {
          mode.detailNode.textContent = store.settings.modeFollowsApp ? t('home.mode.follows') : t('home.mode.detail');
        });
        return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '12px' } }, [
          mode.row,
          h('hr', { class: 'hairline' }),
          language.row,
        ]);
      },
      lastDictation: (scope) => {
        // `dir="auto"` (C4 §9.5): an Arabic transcript reads right to left, with its punctuation at
        // the right end, inside an otherwise left-to-right window. The TEXT carries no bidi marks.
        const text = h('div', { class: 'transcript clamp-6 selectable', attrs: { dir: 'auto' } });
        const meta = h('div', { style: { display: 'flex', gap: '6px', 'align-items': 'center', 'flex-wrap': 'wrap' } });
        const root = h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } }, [text, meta]);
        scope.watch(['app', 'history'], () => {
          const transcript = store.app.lastTranscript ?? store.history[0]?.polished ?? store.history[0]?.result ?? null;
          root.hidden = transcript === null || transcript.length === 0;
          if (root.hidden) return;
          text.textContent = transcript;
          const record = store.app.lastRecord;
          const copy = button(t('common.copy'), 'default', () => {
            void invoke(IPC_INVOKE.historyCopy, transcript);
            copy.textContent = t('common.copied');
            setTimeout(() => {
              copy.textContent = t('common.copy');
            }, 1_400);
          }, true);
          const millis = record === null ? null : releaseToPasteMillis(record);
          meta.replaceChildren(
            ...[
              record?.route?.language === undefined ? null : badge(languageName(record.route.language).toUpperCase()),
              record?.modeKey === undefined ? null : badge(modeName(record.modeKey).toUpperCase()),
              millis === null ? null : badge(formatMillis(millis), 'accent'),
            ].filter((node): node is HTMLElement => node !== null),
            h('span', { style: { flex: '1' } }),
            copy,
          );
        });
        return root;
      },
      quietMic: (scope) => quietMicView(scope),
      todayTiles: (scope) => {
        const root = h('div', { class: 'tiles-clickable', attrs: { role: 'button', title: t('home.openStatistics') } });
        root.addEventListener('click', () => navigate('statistics'));
        // Counted up once, the first time there are records to count: a later push (a new
        // dictation) redraws the numbers in place rather than counting from zero again.
        let counted = false;
        scope.watch(['records'], () => {
          const stats = usageStats(store.records);
          const count = store.recordsLoaded && !counted;
          if (store.recordsLoaded) counted = true;
          const latency = stats.latencyMedianMillis;
          root.replaceChildren(
            grid(138, [
              statTile(t('s.today'), formatCount(stats.todayDictations), tn('tile.dictations', stats.todayDictations), 'mic',
                count ? { number: stats.todayDictations, format: countFormat(), order: 0 } : undefined),
              statTile(t('tile.wordsToday'), formatCount(stats.todayWords), t('tile.typedForYou'), 'words',
                count ? { number: stats.todayWords, format: countFormat(), order: 1 } : undefined),
              statTile(t('tile.keyUpToText'), formatMillis(latency), t('tile.median'), 'bolt',
                count && latency !== null ? { number: latency, format: millisFormat(latency), order: 2 } : undefined),
              statTile(t('tile.streak'), String(stats.streakDays), tn('tile.days', stats.streakDays), 'flame',
                count ? { number: stats.streakDays, format: countFormat(), order: 3 } : undefined),
            ]),
          );
        });
        return root;
      },
    },
  });
  return {
    root: page.root,
    dispose: () => {
      for (const pill of pills) pill.dispose();
      page.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------

export function historyPage(): Page {
  let query = '';
  let results: readonly HistoryEntry[] | null = null;
  return renderSection(section('history'), {
    decorate: (scope, frame) => {
      scope.watch(['history'], () => {
        frame.subtitleNode.textContent = tn('history.subtitle', store.history.length, { shown: formatCount(store.history.length) });
      });
    },
    customs: {
      historyList: (scope) => {
        const input = h('input', { attrs: { type: 'search', placeholder: t('copy.historySearch'), spellcheck: 'false' } });
        const clear = h('button', { class: 'btn link', attrs: { type: 'button', 'aria-label': t('common.clear') } }, [icon('close', 14, 1.8)]);
        clear.hidden = true;
        const searchBox = h('div', { class: 'search' }, [icon('search', 14, 2), input, clear]);
        const list = h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '8px' } });
        let pending = 0;
        const runSearch = (): void => {
          query = input.value;
          clear.hidden = query.length === 0;
          const mine = (pending += 1);
          if (query.length === 0) {
            results = null;
            paint();
            return;
          }
          void invoke<{ entries: readonly HistoryEntry[] }>(IPC_INVOKE.historySearch, query).then((page) => {
            if (mine !== pending) return;
            results = page.entries;
            paint();
          });
        };
        input.addEventListener('input', runSearch);
        clear.addEventListener('click', () => {
          input.value = '';
          runSearch();
        });
        const paint = (): void => {
          const shown = results ?? store.history;
          if (shown.length === 0) {
            list.replaceChildren(
              h('div', { class: 'empty' }, [
                icon(query.length === 0 ? 'quote' : 'search', 28, 1.4),
                h('div', { class: 't-headline' }, [query.length === 0 ? t('history.nothingYet') : t('history.noMatches')]),
                h('div', { class: 't-callout c-secondary' }, [
                  query.length === 0
                    ? store.settings.keepHistory
                      ? t('history.emptyHint', { key: hotkeyWords(store.settings.hotkey.vk) })
                      : t('history.off')
                    : t('history.searchCovers'),
                ]),
              ]),
            );
            return;
          }
          const index = indexBySecond(store.records);
          list.replaceChildren(...shown.map((entry) => historyRow(entry, index)));
        };
        scope.watch(['history', 'records', 'settings'], paint);
        const keep = boundToggle(scope, 'keepHistory', t('history.keep'), null);
        keep.style.flex = 'none';
        keep.style.gap = '10px';
        return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '16px' } }, [
          h('div', { style: { display: 'flex', gap: '12px', 'align-items': 'center' } }, [searchBox, keep]),
          list,
        ]);
      },
    },
  });
}

function historyRow(entry: HistoryEntry, index: ReturnType<typeof indexBySecond>): HTMLElement {
  const record = recordForEntry(entry, index);
  const text = entry.polished ?? entry.result;
  const body = h('div', { class: 'transcript clamp-3 selectable', attrs: { dir: 'auto' } }, [text]);
  body.addEventListener('dblclick', () => body.classList.toggle('clamp-3'));
  const actions = h('div', { class: 'actions' });
  const row = h('div', { class: 'history-row' }, [
    body,
    h('div', { class: 'meta' }, [
      shortDateTime(entry.startedAt),
      badge(languageCode(entry.language as Language)),
      record?.modeKey === undefined ? null : badge(modeName(record.modeKey).toUpperCase()),
      (() => {
        const millis = record === null ? null : releaseToPasteMillis(record);
        return millis === null ? null : badge(formatMillis(millis), 'accent');
      })(),
      t('history.spoken', { seconds: formatDecimal(entry.audioSeconds, 1) }),
      actions,
    ]),
  ]);
  actions.append(
    iconButton('copy', t('common.copy'), () => {
      void invoke(IPC_INVOKE.historyCopy, text);
      flashCopied(actions);
    }),
    iconButton('trash', t('common.delete'), () => {
      row.classList.add('removing');
      setTimeout(() => {
        void invoke(IPC_INVOKE.historyDelete, entry.id).then(() => store.reloadHistory());
      }, 180);
    }, 'danger'),
  );
  return row;
}

// ---------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------

export function statisticsPage(): Page {
  // One period drives the page — the Mac's `StatisticsPane`. Every custom below reads it from
  // the setting, so a switch re-renders the tiles (counting from the old numbers to the new),
  // the chart (growing in again, cut to the period), the splits and the timings together.
  const period = (): StatsPeriod => resolveStatsPeriod(store.settings.statsPeriod);
  const periodStats = (): ReturnType<typeof usageStats> => usageStats(store.records, { period: period() });
  return renderSection(section('statistics'), {
    decorate: (scope, frame) => {
      scope.watch(['records'], () => {
        const stats = usageStats(store.records);
        frame.subtitleNode.hidden = false;
        frame.subtitleNode.textContent =
          stats.earliest === null
            ? store.recordsLoaded
              ? t('stats.nothingYet')
              : t('stats.reading')
            : t('stats.since', { date: longDate(stats.earliest) });
      });
    },
    customs: {
      statsPeriod: (scope, control) => {
        const picker = segmented(
          STATS_PERIODS.map((value) => ({ value, label: periodName(value) })),
          period(),
          (value) => {
            picker.set(value);
            if (value !== period()) void store.write('statsPeriod', value);
          },
        );
        picker.element.style.justifyContent = 'flex-start';
        picker.element.setAttribute('aria-label', control.label);
        scope.watch(['settings'], () => picker.set(period()), false);
        requestAnimationFrame(() => picker.set(period()));
        return h('div', { style: { display: 'flex' } }, [picker.element]);
      },
      statTiles: (scope) => {
        const root = h('div');
        let counted = false;
        let shownPeriod: StatsPeriod | null = null;
        let last: ReturnType<typeof usageStats> | null = null;
        scope.watch(['records', 'settings'], () => {
          const stats = periodStats();
          const all = usageStats(store.records);
          const switched = shownPeriod !== null && shownPeriod !== period();
          if (!switched && last !== null && shownPeriod === period() && sameTotals(last, stats)) return;
          const first = store.recordsLoaded && !counted;
          if (store.recordsLoaded) counted = true;
          const count = first || switched;
          const from = switched && last !== null ? last : null;
          shownPeriod = period();
          last = stats;
          const latency = stats.latencyMedianMillis;
          root.replaceChildren(
            grid(138, [
              statTile(t('tile.wordsDictated'), formatCount(stats.words), tn('tile.across', stats.dictations, { shown: formatCount(stats.dictations) }), 'words',
                count ? { number: stats.words, format: countFormat(), order: 0, ...(from ? { from: from.words } : {}) } : undefined),
              statTile(t('tile.timeSaved'), formatDuration(stats.savedSeconds), t('tile.vsTyping', { wpm: String(TYPING_WORDS_PER_MINUTE) }), 'hourglass',
                count ? { number: stats.savedSeconds, format: durationFormat(stats.savedSeconds), order: 1, ...(from ? { from: from.savedSeconds } : {}) } : undefined),
              statTile(
                t('tile.keyUpToText'),
                formatMillis(latency),
                t('tile.medianP90', { p90: formatMillis(stats.latencyP90Millis) }),
                'bolt',
                count && latency !== null
                  ? { number: latency, format: millisFormat(latency), order: 2, ...(from !== null && from.latencyMedianMillis !== null ? { from: from.latencyMedianMillis } : {}) }
                  : undefined,
              ),
              // The streak is not a period's: a run of days is a run of days.
              statTile(t('tile.streak'), String(all.streakDays), tn('tile.daysInARow', all.streakDays), 'flame',
                first ? { number: all.streakDays, format: countFormat(), order: 3 } : undefined),
            ]),
          );
        });
        return root;
      },
      periodChart: (scope) => {
        const title = h('div', { class: 't-headline' });
        const chart = h('div');
        let drawn = '';
        const paint = (): void => {
          const stats = periodStats();
          const key = JSON.stringify([stats.period, stats.bars]);
          if (key === drawn) return;
          drawn = key;
          title.textContent = chartTitle(stats.barUnit);
          chart.replaceChildren(periodChart(stats.bars, stats.barUnit, emptyText(period()), title.textContent));
        };
        scope.watch(['records', 'settings'], paint);
        return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '12px' } }, [
          h('div', { class: 'card-head' }, [icon('bars', 15, 2), title]),
          chart,
        ]);
      },
      shareBars: (scope) => {
        const root = h('div');
        let drawn = '';
        scope.watch(['records', 'settings'], () => {
          const stats = periodStats();
          const key = JSON.stringify([stats.period, stats.byLanguage, stats.byMode]);
          if (key === drawn) return;
          drawn = key;
          root.replaceChildren(
            grid(280, [
              h('section', { class: 'card' }, [
                h('div', { class: 'card-head' }, [icon('globe', 15, 2), h('div', { class: 't-headline' }, [t('stats.byLanguage')])]),
                shareBars(stats.byLanguage, languageName),
              ]),
              h('section', { class: 'card' }, [
                h('div', { class: 'card-head' }, [icon('wand', 15, 2), h('div', { class: 't-headline' }, [t('stats.byMode')])]),
                shareBars(stats.byMode, modeName),
              ]),
            ]),
          );
        });
        return root;
      },
      stageChart: (scope) => {
        const root = h('div');
        let drawn = '';
        scope.watch(['records', 'settings'], () => {
          const stats = periodStats();
          const key = JSON.stringify([stats.period, stats.stageMedians]);
          if (key === drawn) return;
          drawn = key;
          root.replaceChildren(stageChart(stats.stageMedians));
        });
        return root;
      },
      statsFootnote: (scope) => {
        const root = footnote('');
        scope.watch(['records'], () => {
          const stats = usageStats(store.records);
          root.textContent = t('stats.footnote', {
            records: formatCount(store.records.length),
            heardNothing: formatCount(stats.heardNothing),
            failed: formatCount(stats.failed),
            wpm: String(TYPING_WORDS_PER_MINUTE),
          });
        });
        return root;
      },
    },
  });
}

function sameTotals(a: ReturnType<typeof usageStats>, b: ReturnType<typeof usageStats>): boolean {
  return (
    a.words === b.words &&
    a.dictations === b.dictations &&
    a.savedSeconds === b.savedSeconds &&
    a.latencyMedianMillis === b.latencyMedianMillis &&
    a.latencyP90Millis === b.latencyP90Millis &&
    a.streakDays === b.streakDays
  );
}

function periodName(period: StatsPeriod): string {
  switch (period) {
    case 'today':
      return t('stats.period.today');
    case 'week':
      return t('stats.period.week');
    case 'month':
      return t('stats.period.month');
    case 'all':
      return t('stats.period.all');
  }
}

function chartTitle(unit: StatsBucketUnit): string {
  switch (unit) {
    case 'hour':
      return t('stats.chart.hour');
    case 'day':
      return t('s.dictations_per_day');
    case 'week':
      return t('stats.chart.week');
    case 'month':
      return t('stats.chart.month');
  }
}

function emptyText(period: StatsPeriod): string {
  switch (period) {
    case 'today':
      return t('stats.empty.today');
    case 'week':
      return t('stats.empty.week');
    case 'month':
      return t('stats.empty.month');
    case 'all':
      return t('stats.empty.all');
  }
}

// The app window: a sidebar and seven sections, on pure black — the port of
// `MainWindowView` (Sources/KotibaUI/MainWindow.swift). Loaded by `main.html` as a module;
// it mounts itself.
//
// The frame is Windows-native where it matters: the window is frameless with
// `titleBarOverlay`, so the minimise, maximise (with Snap Layouts on hover) and close
// buttons are the system's own, drawn over our black title strip, and the strip is a
// drag region — snap, double-click-to-maximise and Aero Shake all behave as they do in
// any Windows app.

import { inlineName } from '../core/hotkey/index.js';
import { IPC_INVOKE, IPC_SEND } from '../main/ipc.js';
import { liveStatus } from '../main/live-status.js';
import { springCustomProperties } from '../main/motion.js';
import { onAppLanguageChange, t } from '../core/i18n/index.js';
import type { SectionId } from '../main/settings-model.js';
import { APP_SECTIONS, RAIL_BELOW, SECTION_IDS, appSections } from '../main/settings-model.js';

import { invoke, on } from './bridge.js';
import { BRAND_ICON } from './brand-icon.js';
import { h, statusDot } from './components.js';
import { icon } from './icons.js';
import { syncLanguage } from './language.js';
import { mountOnboarding } from './onboarding.js';
import type { Page } from './pages/common.js';
import { hotkeyPage, settingsPage } from './pages/control.js';
import { languagesPage, modesPage } from './pages/setup.js';
import { historyPage, homePage, statisticsPage } from './pages/usage.js';
import { Scope, store } from './store.js';

const ICONS: Readonly<Record<SectionId, string>> = {
  home: 'home',
  history: 'history',
  statistics: 'chart',
  modes: 'wand',
  languages: 'globe',
  hotkey: 'keyboard',
  settings: 'gear',
};

export function mountApp(root: HTMLElement): void {
  for (const [name, value] of Object.entries(springCustomProperties())) {
    document.documentElement.style.setProperty(name, value);
  }

  const scope = new Scope();
  let current: SectionId = 'home';
  let page: Page | null = null;
  let userFolded = false;
  let onboardingOpen = false;

  // ---- the sidebar ------------------------------------------------------------------
  const selection = h('div', { class: 'nav-selection' });
  const rows = new Map<SectionId, HTMLButtonElement>();
  const rowLabels = new Map<SectionId, HTMLElement>();
  // A small dot, not a count in an orange capsule: there is something on Home for you to do,
  // and Home says what. Blockers hold only what needs the user, so a state that heals itself
  // never lights it.
  const badgeNode = h('span', { class: 'badge-dot rail-hide', attrs: {} });
  for (const section of APP_SECTIONS) {
    const label = h('span', { class: 'rail-hide' });
    const row = h(
      'button',
      {
        class: 'nav-row',
        attrs: { type: 'button' },
        on: { click: () => show(section.id) },
      },
      [icon(ICONS[section.id], 15, 1.9), label, section.id === 'home' ? badgeNode : null],
    );
    rows.set(section.id, row);
    rowLabels.set(section.id, label);
  }
  const nav = h('nav', { style: { position: 'relative', display: 'flex', 'flex-direction': 'column', gap: '2px' } }, [
    selection,
    ...rows.values(),
  ]);
  const foldButton = h(
    'button',
    { class: 'btn link rail-hide', attrs: { type: 'button' } },
    [icon('sidebar', 15, 1.7)],
  );
  const brandMark = h('img', { class: 'brand-mark', attrs: { src: BRAND_ICON, alt: 'Kotiba', title: 'Kotiba', draggable: 'false' } });
  const footerDot = h('span', { class: 'dot' });
  const footerTitle = h('div', { class: 't-callout', style: { 'font-weight': '500' } });
  const footerHint = h('div', { class: 't-caption c-tertiary' });
  const tagline = h('span', { class: 't-caption c-tertiary' });
  const sidebar = h('aside', { class: 'sidebar' }, [
    h('div', { class: 'fold' }, [foldButton]),
    h('div', { class: 'brand' }, [
      brandMark,
      h('div', { class: 'rail-hide', style: { display: 'flex', 'flex-direction': 'column' } }, [
        h('span', { class: 'brand-name' }, ['Kotiba']),
        tagline,
      ]),
    ]),
    nav,
    h('div', { class: 'sidebar-footer' }, [
      footerDot,
      h('div', { class: 'rail-hide', style: { display: 'flex', 'flex-direction': 'column', 'min-width': '0' } }, [footerTitle, footerHint]),
    ]),
  ]);

  /** Every word the frame itself shows, in the current language. Pages word themselves. */
  function relabel(): void {
    for (const section of appSections()) {
      const row = rows.get(section.id);
      rowLabels.get(section.id)?.replaceChildren(section.title);
      row?.setAttribute('title', section.title);
      row?.setAttribute('aria-label', section.title);
    }
    foldButton.title = t('app.foldSidebar');
    foldButton.setAttribute('aria-label', t('app.foldSidebar'));
    badgeNode.setAttribute('aria-label', t('app.homeNeedsYou'));
    tagline.textContent = t('app.tagline');
    tagline.title = tagline.textContent;
    paintFooter();
  }

  const detail = h('main', { class: 'detail' });
  const app = h('div', { class: 'app' }, [h('div', { class: 'titlebar' }), sidebar, h('div', { class: 'divider' }), detail]);
  root.replaceChildren(app);

  foldButton.addEventListener('click', () => {
    userFolded = true;
    layout();
  });
  brandMark.addEventListener('click', () => {
    if (app.classList.contains('rail')) {
      userFolded = false;
      layout();
    }
  });

  function layout(): void {
    const rail = userFolded || window.innerWidth < RAIL_BELOW;
    app.classList.toggle('rail', rail);
    placeSelection();
  }

  function placeSelection(): void {
    const row = rows.get(current);
    if (row === undefined) return;
    selection.style.transform = `translateY(${String(row.offsetTop)}px)`;
    for (const [id, each] of rows) each.classList.toggle('selected', id === current);
  }

  // ---- sections -----------------------------------------------------------------------
  function build(id: SectionId): Page {
    switch (id) {
      case 'home':
        return homePage(show);
      case 'history':
        return historyPage();
      case 'statistics':
        return statisticsPage();
      case 'modes':
        return modesPage();
      case 'languages':
        return languagesPage();
      case 'hotkey':
        return hotkeyPage();
      case 'settings':
        return settingsPage(openOnboarding);
    }
  }

  function show(id: SectionId, force = false): void {
    if (id === current && page !== null && !force) return;
    const leaving = page;
    current = id;
    placeSelection();
    page = build(id);
    page.root.classList.add('entering');
    detail.append(page.root);
    if (leaving !== null) {
      leaving.root.classList.add('leaving');
      leaving.dispose();
      setTimeout(() => leaving.root.remove(), 160);
    }
    // What the old Settings window did on close, done on leaving a page: nothing — every
    // control has already written and saved.
  }

  function openOnboarding(): void {
    if (onboardingOpen) return;
    onboardingOpen = true;
    mountOnboarding(app, () => {
      onboardingOpen = false;
      show('home');
    });
  }

  // ---- live state ---------------------------------------------------------------------
  function paintFooter(): void {
    const blockers = store.app.blockers;
    badgeNode.hidden = blockers.length === 0;
    const live = liveStatus(store.app.status, blockers, inlineName(store.settings.hotkey.vk));
    footerDot.className = `dot${live.tone === 'good' ? '' : ` ${live.tone}`}${live.busy ? ' pulsing' : ''}`;
    footerTitle.textContent = live.title;
    footerHint.textContent = t('app.holdToDictate', { key: inlineName(store.settings.hotkey.vk) });
    footerHint.title = footerHint.textContent;
    sidebar.title = live.title;
  }
  scope.watch(['app', 'settings'], paintFooter);

  // The interface language. A switch — from Settings or onboarding's first step — re-words
  // the frame and rebuilds the page on screen; onboarding re-renders itself.
  scope.watch(['settings'], () => {
    if (!syncLanguage()) return;
  });
  scope.add(
    onAppLanguageChange(() => {
      relabel();
      if (page !== null) show(current, true);
    }),
  );

  on<string>(IPC_SEND.showTab, (tab) => {
    if ((SECTION_IDS as readonly string[]).includes(tab)) show(tab as SectionId);
  });

  window.addEventListener('resize', layout);
  // Ctrl+Q: Quit, which with Always on means "hide". Main decides.
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && (event.key === 'q' || event.key === 'Q')) {
      event.preventDefault();
      void invoke(IPC_INVOKE.quit);
    }
  });

  store.listen();
  relabel();
  void store.load().then(() => {
    syncLanguage();
    relabel();
    layout();
    show('home');
    if (!store.settings.onboardingCompleted) openOnboarding();
  });
  layout();
  void statusDot;
}

const mount = document.getElementById('root');
if (mount !== null) mountApp(mount);

// First run, inside the app window: the interface language → welcome → microphone → hotkey → languages →
// Always on → done. The port of `OnboardingView` (Sources/KotibaUI/Onboarding.swift). It covers the
// window until finished or skipped, and `onboardingCompleted` keeps it from coming back.
//
// ONE permission, where the Mac has three: Windows needs no Accessibility or Input
// Monitoring grant for `SendInput` and a keyboard hook (D-W8). The microphone row is live
// — it re-reads the blocker list while the step is on screen, so switching Kotiba on in
// Windows' privacy settings flips the row here without a click.
//
// Always on is PRE-SET ON and marked recommended, as the brief asks; it is written to the
// settings only when the user finishes or skips.
//
// No model checklist (D-W25): leaving "Your languages" forwards starts everything those languages
// need — the core (Parakeet, Qwen) for everyone, Turkish's or Arabic's files if switched on — in
// the background, one after another, and the page says the total first. Always on and the last
// page show one "Getting Kotiba ready" bar. A skip fetches the same, from `onboardingDone`.

import { inlineName, keycapLabels } from '../core/hotkey/index.js';
import { defaultLanguageOrder } from '../core/languages/order.js';
import type { AppLanguage } from '../core/i18n/index.js';
import { LANGUAGE_CHOICES, appLanguage, onAppLanguageChange, speechPickerName, t } from '../core/i18n/index.js';
import { IPC_INVOKE } from '../main/ipc.js';
import type { OnboardingStepId } from '../main/onboarding-model.js';
import { ONBOARDING_ALWAYS_ON_PRESET, ONBOARDING_STEP_IDS } from '../main/onboarding-model.js';
import { DOWNLOAD_COPY, isPresent, languageDownloadBytes, megabytes, wantedDownloads } from '../main/downloads-model.js';
import { canTurnOff, languageSubset, orderedLanguages, presetLanguages, settingLanguage, type LanguageSubset } from '../core/routing/language-subset.js';

import { invoke } from './bridge.js';
import { badge, button, card, footnote, h, hairline, keycap, statusDot, toggle, withNode } from './components.js';
import { icon } from './icons.js';
import { flag } from './flags.js';
import { readinessCard } from './pages/downloads.js';
import { BRAND_ICON } from './brand-icon.js';
import { checkMark, createPill } from './pill.js';
import { Scope, livePillStyle, store } from './store.js';

const STEPS = ONBOARDING_STEP_IDS;
type Step = OnboardingStepId;

export function mountOnboarding(host: HTMLElement, finished: () => void): () => void {
  /** Per step: a step's watchers go with it, so nothing updates a page that is gone. */
  let scope = new Scope();
  let step: Step = 'language';
  /** A language switch re-renders the step in place, without the slide between steps. */
  let entering = true;
  let forward = true;
  let alwaysOn = ONBOARDING_ALWAYS_ON_PRESET;
  /**
   * "Which languages do you dictate in?" — the five toggles. Uzbek, English and Russian on;
   * Turkish or Arabic on only when Windows itself is in it (its FIRST preferred language), or
   * what is already on when setup runs again. Written when the step is left forwards.
   */
  let chosen: LanguageSubset | null = null;
  const pills: ReturnType<typeof createPill>[] = [];
  const timers: number[] = [];

  const dots = h('div', { class: 'steps' }, STEPS.map(() => h('span')));
  const skip = button('', 'link', () => void finish());
  const stage = h('div', { class: 'stage' });
  const back = button('', 'ghost', () => go(-1));
  const primary = button('', 'primary', () => void advance());
  const root = h('div', { class: 'onboarding', attrs: { role: 'dialog' } }, [
    // The app's own icon, so the first thing a new user sees is which app this is; the step
    // dots sit centred between it and "Skip setup", as on the Mac.
    h('div', { class: 'head no-drag' }, [
      h('div', { class: 'brand-row' }, [
        h('img', { class: 'brand-mark small', attrs: { src: BRAND_ICON, alt: '', draggable: 'false' } }),
        h('span', { class: 't-headline' }, ['Kotiba']),
      ]),
      h('span', { style: { flex: '1' } }),
      dots,
      h('span', { style: { flex: '1' } }),
      h('div', { class: 'brand-row end' }, [skip]),
    ]),
    stage,
    h('div', { class: 'footer' }, [back, h('span', { style: { flex: '1' } }), primary]),
  ]);
  host.append(root);

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.repeat) return;
    // preventDefault is what makes this ONE step. The primary button keeps the focus after
    // a click (the footer is never re-rendered), so Chromium's own Enter-on-a-button click
    // fired too and `advance()` ran twice: one Enter skipped a step (under D-W23 it went
    // straight through Download models, accepting 1.95 GB the user never saw).
    event.preventDefault();
    primary.click();
  };
  window.addEventListener('keydown', onKey);

  /** A double-click, or a click racing Enter, must not advance twice. */
  let advancing = false;
  async function advance(): Promise<void> {
    if (advancing) return;
    advancing = true;
    try {
      if (step === 'done') {
        await finish();
        return;
      }
      // Leaving the first step fixes the choice: a language that was only the system's
      // default is written down, so the app does not change language under the user later.
      if (step === 'language' && store.settings.appLanguage !== appLanguage()) {
        await store.write('appLanguage', appLanguage()).catch(() => undefined);
      }
      if (step === 'languages' && chosen !== null) {
        const next = orderedLanguages(chosen);
        if (next.join() !== store.settings.enabledLanguages.join()) {
          await store.write('enabledLanguages', next).catch(() => undefined);
        }
        // D-W25: what these languages need starts now, so it is under way while setup ends. A
        // failure must not trap the user here; the launch resume and Try again fetch it later.
        await invoke(IPC_INVOKE.downloadsAccept, wantedDownloads(next)).catch(() => undefined);
      }
      go(1);
    } finally {
      advancing = false;
    }
  }

  function go(delta: number): void {
    const index = STEPS.indexOf(step) + delta;
    const next = STEPS[index];
    if (next === undefined) return;
    forward = delta > 0;
    step = next;
    entering = true;
    render();
  }

  async function finish(): Promise<void> {
    await invoke(IPC_INVOKE.onboardingDone, { alwaysOn });
    root.classList.add('leaving');
    setTimeout(() => {
      dispose();
      finished();
    }, 420);
  }

  // Every word on screen is the current language's; a switch re-renders the step in place.
  const offLanguage = onAppLanguageChange(() => {
    entering = false;
    render();
  });

  function dispose(): void {
    offLanguage();
    window.removeEventListener('keydown', onKey);
    for (const pill of pills) pill.dispose();
    for (const timer of timers) clearTimeout(timer);
    scope.dispose();
    root.remove();
  }

  function title(text: string, detail: string, centred = false): HTMLElement {
    return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '8px', 'text-align': centred ? 'center' : 'left' } }, [
      h('h1', {}, [text]),
      h('p', {}, [detail]),
    ]);
  }

  function page(current: Step): HTMLElement {
    const vk = store.settings.hotkey.vk;
    switch (current) {
      case 'language': {
        // Four cards, each in its own language, so everyone can find theirs. A press
        // switches the whole window at once — this step included — and is saved.
        const cards = LANGUAGE_CHOICES.map((choice) => {
          const on = choice.id === appLanguage();
          const card = h(
            'button',
            {
              class: `lang-card${on ? ' on' : ''}`,
              attrs: { type: 'button', role: 'radio', 'aria-checked': String(on), lang: choice.id },
              on: { click: () => void choose(choice.id) },
            },
            [
              flag(choice.flag, 54),
              h('span', { class: 'names' }, [
                h('span', { class: 'native' }, [choice.name]),
                h('span', { class: 'subline' }, [choice.subline]),
              ]),
              h('span', { class: 'lang-check' }, [icon('check', 12, 3)]),
            ],
          );
          return card;
        });
        return h('div', { class: 'step' }, [
          title(t('onb.language.title'), t('onb.language.detail')),
          h('div', { class: 'lang-grid', attrs: { role: 'radiogroup', 'aria-label': t('onb.language.title') } }, cards),
          footnote(t('onb.language.footnote')),
        ]);
      }
      case 'welcome': {
        const pill = createPill({ style: livePillStyle });
        pills.push(pill);
        pill.set({ kind: 'listening' }, true);
        pill.setLevel(0.08);
        pill.element.style.transform = 'scale(1.5)';
        return h('div', { class: 'step centred' }, [
          h('div', { style: { height: '70px', display: 'grid', 'place-items': 'center' } }, [pill.element]),
          h('h1', { class: 'hero-title' }, [t('onb.welcome.title')]),
          h('p', {}, [t('onb.welcome.detail')]),
          h('div', { class: 't-callout c-tertiary' }, [t('onb.welcome.time')]),
        ]);
      }
      case 'microphone': {
        const status = h('span');
        const allow = button(t('onb.mic.openSettings'), 'primary', () => void invoke(IPC_INVOKE.openMicrophoneSettings));
        const note = h('div');
        const row = h('div', { class: 'row' }, [
          h('div', { class: 'glyph-tile on' }, [icon('mic', 15, 2)]),
          h('div', { class: 'words' }, [
            h('div', { class: 'title', style: { 'font-weight': '600' } }, [t('onb.mic.title')]),
            h('div', { class: 'detail-text' }, [t('onb.mic.detail')]),
          ]),
          status,
        ]);
        const paint = (): void => {
          const blocked = store.app.blockers.some((blocker) => blocker.id === 'microphone');
          status.replaceChildren(blocked ? allow : statusDot(t('onb.mic.allowed'), 'good'));
          note.replaceChildren(
            blocked
              ? footnote(t('onb.mic.howTo'))
              : statusDot(t('onb.mic.allSet'), 'good'),
          );
          primary.textContent = blocked ? t('onb.continueAnyway') : t('onb.continue');
        };
        scope.watch(['app'], paint);
        const poll = window.setInterval(() => void invoke(IPC_INVOKE.recheck), 3_000);
        timers.push(poll);
        return h('div', { class: 'step' }, [
          title(t('onb.mic.stepTitle'), t('onb.mic.stepDetail')),
          card({}, [row]),
          note,
        ]);
      }
      case 'hotkey': {
        const cap = keycap(keycapLabels(vk).at(-1) ?? '', true);
        const pill = createPill({ style: livePillStyle });
        pills.push(pill);
        pill.element.style.position = 'relative';
        // The key going down, the pill listening, the key coming up, the check — on a loop.
        let phase = 0;
        const tick = (): void => {
          phase = (phase + 1) % 4;
          cap.classList.toggle('pressed', phase === 1);
          if (phase === 0) pill.set({ kind: 'hidden' }, false);
          if (phase === 1) {
            pill.set({ kind: 'listening' }, true);
            pill.setLevel(0.12);
          }
          if (phase === 2) pill.set({ kind: 'processing' }, true);
          if (phase === 3) pill.set({ kind: 'success', millis: 180 }, true);
          timers.push(window.setTimeout(tick, [1_200, 1_800, 700, 1_200][phase] ?? 1_200));
        };
        timers.push(window.setTimeout(tick, 500));
        return h('div', { class: 'step centred' }, [
          title(t('onb.hotkey.title'), t('onb.hotkey.detail', { key: inlineName(vk) }), true),
          h('div', { style: { display: 'flex', 'align-items': 'center', gap: '24px', height: '80px' } }, [
            cap,
            icon('arrow', 14, 2),
            h('div', { style: { width: '170px', height: '50px', display: 'grid', 'place-items': 'center' } }, [pill.element]),
          ]),
          footnote(t('onb.hotkey.footnote')),
        ]);
      }
      case 'languages': {
        chosen ??= store.settings.onboardingCompleted
          ? languageSubset(store.settings.enabledLanguages)
          : presetLanguages(navigator.languages.slice(0, 1));
        const list = h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } });
        const total = footnote('');
        const paint = (): void => {
          const on = chosen ?? languageSubset([]);
          const items: HTMLElement[] = [];
          // One row per dictation language, in the DEFAULT order (Uzbek, English, Russian, …) —
          // a first run has no usage to order by.
          defaultLanguageOrder().forEach((code, index) => {
            if (index > 0) items.push(hairline());
            const isOn = on.languages.has(code);
            const control = toggle(isOn, (value) => {
              chosen = settingLanguage(chosen ?? on, code, value);
              paint();
            }, speechPickerName(code));
            // The last one on stays on: Kotiba needs a language to type in.
            control.set(isOn, !canTurnOff(on, code));
            // Turkish and Arabic carry nothing until turned on: say what that downloads first.
            const extra = languageDownloadBytes(code, store.app.downloads);
            items.push(
              h('div', { class: 'row' }, [
                h('div', { class: `glyph-tile ${isOn ? 'on' : 'off'}` }, [code.toUpperCase()]),
                h('div', { class: 'words' }, [
                  h('div', { class: 'title', style: { 'font-weight': '600' } }, [speechPickerName(code)]),
                  extra > 0 ? h('div', { class: 'detail-text' }, [t('lang.toggles.downloads', { size: megabytes(extra) })]) : null,
                ]),
                h('div', { class: 'control' }, [control.element]),
              ]),
            );
          });
          list.replaceChildren(...items);
          // Everything leaving this step starts, said once, before it does.
          const bytes = wantedDownloads(orderedLanguages(on))
            .filter((id) => {
              const row = store.app.downloads.find((each) => each.id === id);
              return row === undefined || !isPresent(row.state);
            })
            .reduce((sum, id) => sum + DOWNLOAD_COPY[id].bytes, 0);
          total.textContent = bytes > 0 ? t('onb.languages.downloads', { size: megabytes(bytes) }) : '';
          total.hidden = bytes === 0;
        };
        // The rows' states arrive with the app snapshot; the sizes follow them.
        scope.watch(['app'], paint);
        return h('div', { class: 'step' }, [
          title(t('onb.languages.title'), t('onb.languages.detail')),
          card({}, [list]),
          footnote(t('lang.toggles.footnote')),
          total,
        ]);
      }
      case 'alwaysOn': {
        const control = toggle(alwaysOn, (value) => {
          alwaysOn = value;
        }, t('life.alwaysOnTitle'));
        return h('div', { class: 'step' }, [
          title(t('onb.alwaysOn.title'), t('onb.alwaysOn.detail')),
          card({}, [
            h('div', { style: { display: 'flex', gap: '12px', 'align-items': 'flex-start' } }, [
              h('span', { class: 'c-accent', style: { 'margin-top': '1px' } }, [icon('infinity', 20, 2)]),
              h('div', { style: { flex: '1', display: 'flex', 'flex-direction': 'column', gap: '4px' } }, [
                h('div', { style: { display: 'flex', gap: '8px', 'align-items': 'center' } }, [
                  h('span', { class: 't-headline' }, [t('life.alwaysOnTitle')]),
                  badge(t('onb.alwaysOn.recommended'), 'filled'),
                ]),
                h('div', { class: 't-callout c-secondary' }, [
                  t('onb.alwaysOn.card'),
                ]),
              ]),
              control.element,
            ]),
          ]),
          readinessCard(scope, retry),
        ]);
      }
      case 'done': {
        const check = h('div', { class: 'big-check' }, [checkMark(34)]);
        return h('div', { class: 'step centred' }, [
          check,
          h('h1', { style: { 'font-size': '30px' } }, [t('onb.done.title')]),
          h('p', { class: 'with-key' }, [
            ...withNode(t('onb.done.line'), keycap(inlineName(vk))),
          ]),
          readinessCard(scope, retry),
        ]);
      }
    }
  }

  function render(): void {
    scope.dispose();
    scope = new Scope();
    for (const pill of pills.splice(0)) pill.dispose();
    for (const timer of timers.splice(0)) clearTimeout(timer);
    const index = STEPS.indexOf(step);
    [...dots.children].forEach((dot, i) => {
      dot.className = i < index ? 'done' : i === index ? 'current' : '';
    });
    skip.hidden = step === 'done';
    skip.textContent = t('onb.skip');
    back.textContent = t('onb.back');
    root.setAttribute('aria-label', t('onb.dialogLabel'));
    back.style.visibility = step === 'language' || step === 'done' ? 'hidden' : 'visible';
    primary.textContent =
      step === 'welcome' ? t('onb.getStarted') : step === 'done' ? t('onb.startDictating') : t('onb.continue');
    const next = page(step);
    // Between steps the page slides; a language switch only cross-fades the words in place.
    next.classList.add(entering ? (forward ? 'in-forward' : 'in-back') : 'relang');
    stage.replaceChildren(next);
  }

  /** The readiness card's Try again: the same downloads, resumed where they stopped. */
  function retry(): void {
    void invoke(IPC_INVOKE.downloadsAccept, wantedDownloads(store.settings.enabledLanguages)).catch(() => undefined);
  }

  /** The first step's choice: switch now (the whole window follows), save it. */
  async function choose(language: AppLanguage): Promise<void> {
    await store.write('appLanguage', language).catch(() => undefined);
  }

  render();
  return dispose;
}

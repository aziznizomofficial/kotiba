// Hotkey and Settings — which key you hold, and how Kotiba lives on this PC. Ports of
// HotkeyPane and GeneralPane (Sources/KotibaUI/Panes).

import type { HotkeyRecordingResult } from '../../contracts/index.js';
import {
  HOTKEY_PRESETS,
  bindingFor,
  hotkeyName,
  hotkeyWarnings,
  inlineName,
  isModifierCode,
  keycapLabels,
} from '../../core/hotkey/index.js';
import { LANGUAGE_CHOICES, appLanguage, t } from '../../core/i18n/index.js';
import type { Credit } from '../../main/about-model.js';
import { LIBRARY_CREDITS, MODEL_CREDITS, NOTICES_URL, SOURCE_URL, creditLinkLabel, creditTitle, isAllowedExternalLink } from '../../main/about-model.js';
import { IPC_INVOKE, IPC_SEND } from '../../main/ipc.js';
import { LIFECYCLE_COPY } from '../../main/lifecycle.js';
import type { SectionId } from '../../main/settings-model.js';
import { appSections } from '../../main/settings-model.js';
import { PILL_ANIMATION_STYLES, pillStyleName } from '../../main/pill-model.js';

import { invoke, on } from '../bridge.js';
import { BRAND_ICON } from '../brand-icon.js';
import { button, collapsible, footnote, h, hairline, keycap } from '../components.js';
import { flag } from '../flags.js';
import { icon } from '../icons.js';
import { createPill } from '../pill.js';
import { Scope, livePillStyle, store } from '../store.js';

import type { Page } from './common.js';
import { renderSection } from './section.js';
import { blockersView } from './usage.js';

function section(id: SectionId) {
  const found = appSections().find((each) => each.id === id);
  if (found === undefined) throw new Error(`no section ${id}`);
  return found;
}

// ---------------------------------------------------------------------------------
// Hotkey
// ---------------------------------------------------------------------------------

export function hotkeyPage(): Page {
  let recording = false;
  let stopListening: (() => void) | null = null;
  const stopRecording = (): void => {
    if (!recording) return;
    recording = false;
    stopListening?.();
    stopListening = null;
    void invoke(IPC_INVOKE.hotkeyRecordStop);
  };

  const page = renderSection(section('hotkey'), {
    customs: {
      hotkeyRecorder: (scope) => {
        const caps = h('div', { class: 'caps' });
        const title = h('div', { class: 't-title' });
        const detail = h('div', { class: 't-callout c-secondary', style: { 'max-width': '520px' } });
        const action = button(t('s.record_new_key'), 'primary');
        const message = footnote('', 'amber');
        message.hidden = true;

        const paint = (): void => {
          const vk = store.settings.hotkey.vk;
          caps.replaceChildren(
            ...(recording ? [keycap('…', true)] : keycapLabels(vk).map((label) => keycap(label, true))),
          );
          title.textContent = recording ? t('hotkey.pressKey') : t('hotkey.hold', { key: inlineName(vk) });
          detail.textContent = recording ? t('hotkey.recordingDetail') : t('hotkey.idleDetail');
          action.textContent = recording ? t('common.cancel') : t('s.record_new_key');
          action.className = `btn${recording ? '' : ' primary'}`;
        };

        action.addEventListener('click', () => {
          if (recording) {
            stopRecording();
            paint();
            return;
          }
          message.hidden = true;
          recording = true;
          // The recorder is fed by the HOOK, not by this window's key events: what is
          // recorded is exactly the code the hook will later report, sided, F13–F24
          // included — and the live hotkey is suspended meanwhile, so pressing the current
          // key to re-record it does not dictate.
          stopListening = on<HotkeyRecordingResult>(IPC_SEND.hotkeyRecording, (result) => {
            if (result.kind === 'recorded') {
              recording = false;
              stopListening?.();
              stopListening = null;
              void store.write('hotkey', result.binding);
            } else if (result.kind === 'cancelled') {
              recording = false;
              stopListening?.();
              stopListening = null;
            } else if (result.kind === 'rejected') {
              message.textContent = result.message;
              message.hidden = false;
            }
            paint();
          });
          void invoke(IPC_INVOKE.hotkeyRecordStart);
          paint();
        });

        scope.watch(['settings'], paint);
        return h('div', { class: 'recorder' }, [caps, title, detail, action, message]);
      },
      hotkeyPresets: (scope) => {
        const root = h('div', { style: { display: 'flex', 'flex-direction': 'column' } });
        scope.watch(['settings'], () => {
          const current = store.settings.hotkey.vk;
          const rows: HTMLElement[] = [];
          HOTKEY_PRESETS.forEach((vk, index) => {
            if (index > 0) rows.push(h('hr', { class: 'hairline' }));
            rows.push(
              h(
                'button',
                {
                  class: 'preset',
                  attrs: { type: 'button' },
                  on: {
                    click: () => {
                      if (vk !== current) void store.write('hotkey', bindingFor(vk));
                    },
                  },
                },
                [
                  ...keycapLabels(vk).map((label) => keycap(label)),
                  h('span', { class: 't-body' }, [hotkeyName(vk)]),
                  isModifierCode(vk) ? null : h('span', { class: 't-caption c-tertiary' }, [t('hotkey.swallowedWhileHeld')]),
                  vk === current ? h('span', { class: 'check' }, [icon('check', 14, 2.6)]) : null,
                ],
              ),
            );
          });
          root.replaceChildren(...rows);
        });
        return root;
      },
      hotkeyWarnings: (scope) => {
        const root = h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '8px' } });
        scope.watch(['settings'], () => {
          const warnings = hotkeyWarnings(store.settings.hotkey.vk);
          root.replaceChildren(...warnings.map((warning) => footnote(warning, 'amber')));
          root.hidden = warnings.length === 0;
        });
        return root;
      },
      note: (_scope, control) => footnote(control.caption ?? ''),
    },
  });
  return {
    root: page.root,
    dispose: () => {
      stopRecording();
      page.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------

export function settingsPage(onRunSetup: () => void): Page {
  const page = renderSection(section('settings'), {
    customs: {
      // The interface language: the four choices onboarding's first step offers, as a compact
      // list. A press switches every window at once (the app frame rebuilds this page in the
      // new language) and is saved.
      appLanguage: (scope, control) => {
        const choices = h('div', { class: 'lang-list', attrs: { role: 'radiogroup', 'aria-label': control.label } });
        const paint = (): void => {
          choices.replaceChildren(
            ...LANGUAGE_CHOICES.map((choice) => {
              const on = choice.id === appLanguage();
              return h(
                'button',
                {
                  class: `lang-chip${on ? ' on' : ''}`,
                  attrs: { type: 'button', role: 'radio', 'aria-checked': String(on), lang: choice.id, title: choice.subline },
                  on: {
                    click: () => {
                      if (choice.id !== appLanguage() || store.settings.appLanguage !== choice.id) void store.write('appLanguage', choice.id);
                    },
                  },
                },
                [flag(choice.flag, 24), h('span', {}, [choice.name])],
              );
            }),
          );
        };
        // Drawn once: a switch rebuilds the whole page in the new language (app.ts), so
        // there is nothing to update in place — and a repaint would replay the chip's spring.
        paint();
        void scope;
        return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } }, [
          choices,
          control.caption === null ? null : footnote(control.caption),
        ]);
      },
      // The pill's voice animation: the three the owner kept, side by side, each one moving —
      // a name is no way to choose an animation. Each preview speaks a simulated voice while
      // nobody is dictating and the real one while somebody is; a click writes `pillStyle`,
      // which every pill reads live, and the highlight springs to the chosen card.
      pillStyle: (scope, control) => {
        const dictating = (): boolean => store.app.status.kind === 'listening';
        const cards = PILL_ANIMATION_STYLES.map((style) => {
          const pill = createPill({ style, simulated: () => !dictating() });
          pill.set({ kind: 'listening' }, true);
          scope.add(() => pill.dispose());
          const card = h(
            'button',
            {
              class: 'pill-choice',
              attrs: { type: 'button', role: 'radio', 'aria-label': pillStyleName(style) },
              on: {
                click: () => {
                  if (livePillStyle() !== style) void store.write('pillStyle', style);
                },
              },
            },
            [h('div', { class: 'pill-choice-stage' }, [pill.element]), h('div', { class: 'pill-choice-name' }, [h('span', { class: 'radio-dot' }), h('span', {}, [pillStyleName(style)])])],
          );
          return { style, card, pill };
        });
        scope.watch(['level'], () => {
          for (const each of cards) each.pill.setLevel(store.level);
        }, false);
        scope.watch(['settings'], () => {
          const chosen = livePillStyle();
          for (const each of cards) {
            const on = each.style === chosen;
            each.card.classList.toggle('on', on);
            each.card.setAttribute('aria-checked', String(on));
          }
        });
        return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } }, [
          control.caption === null ? null : footnote(control.caption),
          h('div', { class: 'pill-choices', attrs: { role: 'radiogroup', 'aria-label': control.label } }, cards.map((each) => each.card)),
        ]);
      },
      quitForReal: (scope, control) => {
        const row = h('div', { class: 'row' }, [
          h('div', { class: 'words' }, [
            h('div', { class: 'title' }, [control.label]),
            h('div', { class: 'detail-text' }, [control.caption ?? '']),
          ]),
          h('div', { class: 'control' }, [
            button(LIFECYCLE_COPY.quitForRealButton, 'destructive', () => void invoke(IPC_INVOKE.quitForReal)),
          ]),
        ]);
        const fold = collapsible(row);
        scope.watch(['settings'], () => {
          fold.set(store.settings.alwaysOn);
          fold.element.hidden = !store.settings.alwaysOn;
        });
        return fold.element;
      },
      blockers: (scope, control) => blockersView(scope, control.caption),
      diagnosticsReport: (scope) => {
        let shown = false;
        const text = h('pre', {
          class: 't-mono c-secondary selectable',
          style: {
            margin: '0',
            padding: '12px',
            height: '220px',
            overflow: 'auto',
            background: 'var(--bg)',
            border: '1px solid var(--hairline)',
            'border-radius': 'var(--radius-control)',
            'white-space': 'pre-wrap',
          },
        });
        const fold = collapsible(text);
        fold.set(false);
        const load = (): void => {
          text.textContent = t('common.loading');
          void invoke<string>(IPC_INVOKE.diagnosticsSummary).then((summary) => {
            text.textContent = summary;
          });
        };
        const toggleButton = button(t('diag.showSummary'), 'default', () => {
          shown = !shown;
          toggleButton.textContent = shown ? t('diag.hideSummary') : t('diag.showSummary');
          refresh.hidden = !shown;
          fold.set(shown);
          if (shown) load();
        }, true);
        const refresh = button(t('common.refresh'), 'default', load, true);
        refresh.hidden = true;
        const reveal = button(t('diag.showFolder'), 'default', () => void invoke(IPC_INVOKE.diagnosticsReveal), true);
        void scope;
        return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } }, [
          h('div', { style: { display: 'flex', gap: '8px' } }, [toggleButton, refresh, reveal]),
          fold.element,
        ]);
      },
      // The short form of THIRD_PARTY_NOTICES.md, as on the Mac (AboutPane.swift): version,
      // licence, the model credits (Parakeet's CC BY 4.0 attribution in full) and the
      // libraries. Every link goes through `app:open-external`, which main checks against
      // the same allow-list (`about-model.ts`) before handing it to the browser.
      about: (_scope, control) => {
        const open = (url: string): void => {
          if (isAllowedExternalLink(url)) void invoke(IPC_INVOKE.openExternal, url);
        };
        const linkButton = (label: string, url: string): HTMLElement => {
          const link = button(label, 'link', () => open(url), true);
          link.title = url;
          return link;
        };
        const line = (credit: Credit): HTMLElement =>
          h('div', { class: 'row' }, [
            h('div', { class: 'words' }, [
              h('div', { class: 'title' }, [creditTitle(credit)]),
              h('div', { class: 'detail-text selectable' }, [credit.detail]),
            ]),
            h('div', { class: 'control' }, [linkButton(creditLinkLabel(credit), credit.link)]),
          ]);
        const version = h('div', { class: 'title' }, ['Kotiba']);
        void invoke<string>(IPC_INVOKE.appVersion).then((value) => {
          version.textContent = `Kotiba ${value}`;
        });
        return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } }, [
          h('div', { class: 'row' }, [
            h('img', { class: 'brand-mark large', attrs: { src: BRAND_ICON, alt: '', draggable: 'false' } }),
            h('div', { class: 'words' }, [
              version,
              h('div', { class: 'detail-text' }, [`${control.label}. ${control.caption ?? ''}`]),
            ]),
            h('div', { class: 'control' }, [linkButton(t('about.source'), SOURCE_URL)]),
          ]),
          hairline(),
          ...MODEL_CREDITS.map(line),
          hairline(),
          ...LIBRARY_CREDITS.map(line),
          h('div', { class: 'row' }, [
            h('div', { class: 'words' }, [
              h('div', { class: 'detail-text' }, [t('about.everyLicence')]),
            ]),
            h('div', { class: 'control' }, [linkButton('THIRD_PARTY_NOTICES.md', NOTICES_URL)]),
          ]),
        ]);
      },
      runSetupAgain: (_scope, control) =>
        h('div', { class: 'row' }, [
          h('div', { class: 'words' }, [
            h('div', { class: 'title' }, [control.label]),
            h('div', { class: 'detail-text' }, [control.caption ?? '']),
          ]),
          h('div', { class: 'control' }, [
            button(t('common.start'), 'default', () => {
              void invoke(IPC_INVOKE.onboardingRestart).then(onRunSetup);
            }),
          ]),
        ]),
    },
  });

  // The rows the table renders generically but whose state depends on another key:
  // "Open at login" reads on and disabled while Always on includes it, and "Lower to" is
  // there only while ducking is.
  const scope = new Scope();
  requestAnimationFrame(() => {
    const login = page.root.querySelector<HTMLButtonElement>('[data-setting="launchAtLogin"]');
    const loginDetail = login?.closest('.row')?.querySelector<HTMLElement>('.detail-text') ?? null;
    const duck = page.root.querySelector<HTMLInputElement>('input[data-setting="duckLevel"]')?.closest<HTMLElement>('.slider-row') ?? null;
    let duckFold: ReturnType<typeof collapsible> | null = null;
    if (duck !== null && duck.parentElement !== null) {
      const placeholder = document.createComment('duck');
      duck.replaceWith(placeholder);
      duckFold = collapsible(duck);
      placeholder.replaceWith(duckFold.element);
    }
    scope.watch(['settings'], () => {
      const alwaysOn = store.settings.alwaysOn;
      if (login !== null) {
        login.setAttribute('aria-checked', String(alwaysOn || store.settings.launchAtLogin));
        login.disabled = alwaysOn;
      }
      if (loginDetail !== null) {
        loginDetail.textContent = alwaysOn ? LIFECYCLE_COPY.loginIncluded : LIFECYCLE_COPY.loginDetail;
      }
      duckFold?.set(store.settings.duckingEnabled);
    });
  });

  return {
    root: page.root,
    dispose: () => {
      scope.dispose();
      page.dispose();
    },
  };
}

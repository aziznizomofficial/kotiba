// What every page shares: the scroll container, the title, the names of things, and the
// generic renderer for a table-driven control (`src/main/settings-model.ts`).

import type { Language, Settings } from '../../contracts/index.js';
import { builtInModeName, formatDecimal, formatLongDate, formatShortDateTime, speechPickerName, t } from '../../core/i18n/index.js';
import type { SettingsControl } from '../../main/settings-model.js';
import { IPC_INVOKE } from '../../main/ipc.js';

import { invoke } from '../bridge.js';
import {
  boundText,
  boundToggle,
  button,
  collapsible,
  footnote,
  h,
  iconButton,
  segmented,
} from '../components.js';
import { icon } from '../icons.js';
import { pageLanguageOrder } from '../language-order.js';
import { Scope, store } from '../store.js';

export interface Page {
  readonly root: HTMLElement;
  dispose(): void;
}

/** A page's frame: the scroller, the readable column, the title and its subtitle. */
export function pageFrame(title: string, subtitle: string | null): {
  readonly root: HTMLElement;
  readonly inner: HTMLElement;
  readonly titleNode: HTMLElement;
  readonly subtitleNode: HTMLElement;
} {
  const titleNode = h('h1', { class: 't-display' }, [title]);
  const subtitleNode = h('div', { class: 'subtitle' }, [subtitle ?? '']);
  if (subtitle === null) subtitleNode.hidden = true;
  const inner = h('div', { class: 'page-inner' }, [h('header', { class: 'page-header' }, [titleNode, subtitleNode])]);
  const root = h('div', { class: 'page' }, [inner]);
  return { root, inner, titleNode, subtitleNode };
}

/** The dictation languages, as the window names them — in English, the Mac's native names. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  get en(): string {
    return speechPickerName('en');
  },
  get ru(): string {
    return speechPickerName('ru');
  },
  get uz(): string {
    return speechPickerName('uz');
  },
  get tr(): string {
    return speechPickerName('tr');
  },
  get ar(): string {
    return speechPickerName('ar');
  },
};

export function languageName(code: string): string {
  return (LANGUAGE_NAMES as Readonly<Record<string, string>>)[code] ?? t('speech.unknown');
}

/** A mode's name, or "Unrecorded" for records written before modes were recorded. */
export function modeName(key: string): string {
  if (key === 'unknown') return t('mode.unrecorded');
  const builtIn = builtInModeName(key);
  if (builtIn !== null) return builtIn;
  const found = store.modes.find((mode) => mode.key === key);
  return found?.name ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** "29 Sep at 15:17". */
export function shortDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return formatShortDateTime(date);
}

/** "7 August 2026". */
export function longDate(epochMillis: number): string {
  // Not `toLocaleDateString`: Chromium's ICU has no Uzbek month names (it prints «M09»).
  return formatLongDate(new Date(epochMillis));
}

/** The printed value of a slider. */
function formatSlider(format: 'percent' | 'seconds' | 'threshold', value: number): string {
  if (format === 'percent') return `${String(Math.round(value * 100))}%`;
  if (format === 'seconds') return t('unit.s', { value: String(Math.round(value)) });
  return formatDecimal(value, 3);
}

/** A generic table control. Custom cards are the page's business and return `null` here. */
export function renderControl(scope: Scope, control: SettingsControl): HTMLElement | null {
  switch (control.kind) {
    case 'toggle':
      return boundToggle(scope, control.settingKey, control.label, control.caption);
    case 'slider': {
      const key = control.settingKey;
      const input = h('input', {
        attrs: {
          type: 'range',
          min: String(control.min),
          max: String(control.max),
          step: String(control.step),
          'aria-label': control.label,
          'data-setting': String(key),
        },
      });
      const value = h('span', { class: 't-callout c-accent num' });
      const paint = (): void => {
        const current = Number(store.settings[key]);
        input.value = String(current);
        value.textContent = formatSlider(control.format, current);
        const fill = ((current - control.min) / (control.max - control.min)) * 100;
        input.style.setProperty('--fill', `${String(fill)}%`);
      };
      input.addEventListener('input', () => {
        value.textContent = formatSlider(control.format, Number(input.value));
        const fill = ((Number(input.value) - control.min) / (control.max - control.min)) * 100;
        input.style.setProperty('--fill', `${String(fill)}%`);
      });
      input.addEventListener('change', () => {
        const rounded = Math.round(Number(input.value) / control.step) * control.step;
        void store.write(key, Number(rounded.toFixed(4)) as never);
      });
      scope.watch(['settings'], paint);
      return h('div', { class: 'slider-row' }, [
        h('div', { class: 'head' }, [h('span', { class: 't-body' }, [control.label]), value]),
        input,
        control.caption === null ? null : footnote(control.caption),
      ]);
    }
    case 'picker': {
      const key = control.settingKey;
      if (control.style === 'menu') {
        const select = h(
          'select',
          { class: 'menu-select', attrs: { 'aria-label': control.label } },
          control.options.map((option) => h('option', { attrs: { value: String(option.value) } }, [option.label])),
        );
        select.addEventListener('change', () => {
          const found = control.options.find((option) => String(option.value) === select.value);
          if (found !== undefined) void store.write(key, found.value as never);
        });
        scope.watch(['settings'], () => {
          select.value = String(store.settings[key]);
        });
        return rowWith(control.label, control.caption, select);
      }
      // The fallback-language picker lists languages in the page's order (default, then use).
      const languageOrdered = control.id === 'languages.defaultLanguage';
      const rank = (order: readonly string[]) => (value: string | number): number => {
        const at = order.indexOf(String(value));
        return at < 0 ? order.length : at;
      };
      const firstOrder: readonly string[] = languageOrdered ? pageLanguageOrder(scope, (next) => picker.reorder(sortedValues(next))) : [];
      const sortedValues = (order: readonly string[]): (string | number)[] =>
        control.options.map((option) => option.value).sort((a, b) => rank(order)(a) - rank(order)(b));
      const picker = segmented(
        languageOrdered ? [...control.options].sort((a, b) => rank(firstOrder)(a.value) - rank(firstOrder)(b.value)) : control.options,
        null,
        (value) => {
          void store.write(key, value as never);
        },
      );
      const titleNode = h('div', { class: 'title' }, [control.label]);
      const row = h('div', { class: 'row' }, [
        h('div', { class: 'words' }, [titleNode, control.caption === null ? null : h('div', { class: 'detail-text' }, [control.caption])]),
        h('div', { class: 'control', style: { 'min-width': '0', 'flex-shrink': '1' } }, [picker.element]),
      ]);
      scope.watch(['settings'], () => {
        picker.set(store.settings[key] as string | number);
      });
      return row;
    }
    case 'text':
      return h('label', { style: { display: 'flex', 'flex-direction': 'column', gap: '4px', flex: '1' } }, [
        h('span', { class: 't-micro c-tertiary' }, [control.label.toUpperCase()]),
        boundText(control.settingKey, control.placeholder),
      ]);
    case 'secret':
      return secretField(control.label, control.caption);
    case 'vocabulary':
      return vocabularyEditor(scope);
    case 'replacements':
      return replacementsEditor(scope, control.caption);
    case 'custom':
      return null;
  }
}

function rowWith(title: string, detail: string | null, control: Node): HTMLElement {
  return h('div', { class: 'row' }, [
    h('div', { class: 'words' }, [
      h('div', { class: 'title' }, [title]),
      detail === null ? null : h('div', { class: 'detail-text' }, [detail]),
    ]),
    h('div', { class: 'control' }, [control]),
  ]);
}

/**
 * The API key. The key itself never crosses into this page after it is saved — only
 * whether one is present. A failed delete is shown in red, never swallowed: a key that
 * looks deleted and is not keeps sending text to the endpoint.
 */
function secretField(label: string, caption: string | null): HTMLElement {
  const input = h('input', { class: 'well mono', attrs: { type: 'password', placeholder: label, autocomplete: 'off' } });
  const save = button(t('common.save'), 'primary');
  const remove = button(t('common.remove'), 'destructive');
  const error = footnote('', 'danger');
  error.hidden = true;
  const paint = (): void => {
    input.placeholder = store.secretPresent ? t('secret.saved') : label;
    save.textContent = store.secretPresent ? t('secret.replace') : t('common.save');
    remove.hidden = !store.secretPresent;
    save.disabled = input.value.length === 0;
  };
  input.addEventListener('input', paint);
  save.addEventListener('click', () => {
    void invoke<boolean>(IPC_INVOKE.secretSet, input.value)
      .then((present) => {
        store.secretPresent = present;
        input.value = '';
        error.hidden = true;
        paint();
      })
      .catch((reason: unknown) => {
        error.textContent = reason instanceof Error ? reason.message : String(reason);
        error.hidden = false;
      });
  });
  remove.addEventListener('click', () => {
    void invoke<boolean>(IPC_INVOKE.secretRemove)
      .then((present) => {
        store.secretPresent = present;
        error.hidden = true;
        paint();
      })
      .catch((reason: unknown) => {
        error.textContent = reason instanceof Error ? reason.message : String(reason);
        error.hidden = false;
      });
  });
  paint();
  return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '8px' } }, [
    h('div', { style: { display: 'flex', gap: '8px', 'align-items': 'center' } }, [input, save, remove]),
    error,
    caption === null ? null : footnote(caption),
  ]);
}

function vocabularyEditor(scope: Scope): HTMLElement {
  const lists = h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '8px' } });
  const language = h('select', { class: 'menu-select', attrs: { 'aria-label': t('menu.language') } }, [
    h('option', { attrs: { value: 'en' } }, ['EN']),
    h('option', { attrs: { value: 'ru' } }, ['RU']),
    h('option', { attrs: { value: 'uz' } }, ['UZ']),
  ]);
  const term = h('input', { class: 'well', attrs: { type: 'text', placeholder: t('vocab.placeholder'), spellcheck: 'false' } });
  const add = button(t('common.add'), 'primary');
  const addTerm = (): void => {
    const value = term.value.trim();
    if (value.length === 0) return;
    const code = language.value;
    const existing = store.settings.vocabulary[code] ?? [];
    term.value = '';
    add.disabled = true;
    if (existing.includes(value)) return;
    void store.write('vocabulary', { ...store.settings.vocabulary, [code]: [...existing, value] });
  };
  add.disabled = true;
  term.addEventListener('input', () => {
    add.disabled = term.value.trim().length === 0;
  });
  term.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') addTerm();
  });
  add.addEventListener('click', addTerm);
  scope.watch(['settings'], () => {
    const vocabulary: Settings['vocabulary'] = store.settings.vocabulary;
    lists.replaceChildren(
      ...(['en', 'ru', 'uz'] as const)
        .filter((code) => (vocabulary[code] ?? []).length > 0)
        .map((code) =>
          h('div', { style: { display: 'flex', gap: '8px', 'align-items': 'flex-start' } }, [
            h('span', { class: 'badge' }, [code.toUpperCase()]),
            h(
              'div',
              { class: 'tags' },
              (vocabulary[code] ?? []).map((word) =>
                h('span', { class: 'tag' }, [
                  word,
                  h(
                    'button',
                    {
                      attrs: { type: 'button', 'aria-label': t('vocab.removeWord', { word }) },
                      on: {
                        click: () => {
                          const left = (store.settings.vocabulary[code] ?? []).filter((each) => each !== word);
                          const next: Record<string, readonly string[]> = { ...store.settings.vocabulary };
                          if (left.length === 0) delete next[code];
                          else next[code] = left;
                          void store.write('vocabulary', next);
                        },
                      },
                    },
                    [icon('x', 10, 2.4)],
                  ),
                ]),
              ),
            ),
          ]),
        ),
    );
  });
  return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } }, [
    lists,
    h('div', { style: { display: 'flex', gap: '8px', 'align-items': 'center' } }, [language, term, add]),
  ]);
}

function replacementsEditor(scope: Scope, caption: string | null): HTMLElement {
  const list = h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '6px' } });
  const find = h('input', { class: 'well', attrs: { type: 'text', placeholder: t('repl.find'), spellcheck: 'false' } });
  const replaceWith = h('input', { class: 'well', attrs: { type: 'text', placeholder: t('repl.replaceWith'), spellcheck: 'false' } });
  const add = button(t('common.add'), 'primary');
  add.disabled = true;
  find.addEventListener('input', () => {
    add.disabled = find.value.length === 0;
  });
  add.addEventListener('click', () => {
    if (find.value.length === 0) return;
    // The two flags the Mac's UI never varies: always written false / true.
    const rule = { find: find.value, replaceWith: replaceWith.value, matchCase: false, wholeWord: true };
    find.value = '';
    replaceWith.value = '';
    add.disabled = true;
    void store.write('replacements', [...store.settings.replacements, rule]);
  });
  scope.watch(['settings'], () => {
    list.replaceChildren(
      ...store.settings.replacements.map((rule, index) =>
        h('div', { class: 'replacement' }, [
          h('span', { class: 't-mono' }, [rule.find]),
          icon('arrow', 11, 2),
          h('span', { class: 't-mono' }, [rule.replaceWith]),
          h('span', { style: { flex: '1' } }),
          iconButton('minus', t('common.remove'), () => {
            void store.write(
              'replacements',
              store.settings.replacements.filter((_, i) => i !== index),
            );
          }, 'danger'),
        ]),
      ),
    );
  });
  return h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '8px' } }, [
    h('div', { class: 't-body' }, [t('s.replacements')]),
    list,
    h('div', { style: { display: 'flex', gap: '8px', 'align-items': 'center' } }, [find, icon('arrow', 11, 2), replaceWith, add]),
    caption === null ? null : footnote(caption),
  ]);
}

export { collapsible };

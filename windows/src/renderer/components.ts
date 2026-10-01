// The pieces every page is built from — the port of `Components.swift`: cards, rows, the
// accent switch, the sliding chip picker that falls back to a menu, buttons, badges,
// status dots, key caps and stat tiles. Plain DOM; the motion is CSS on the Mac's springs.

import type { Settings } from '../contracts/index.js';
import { hotkeyName, inlineName } from '../core/hotkey/index.js';
import { COUNT_UP_MS, COUNT_UP_STAGGER_MS, countEase } from '../main/count-up.js';

import { icon } from './icons.js';
import { Scope, store } from './store.js';

type Child = Node | string | null | undefined | false;

/** Build an element. Text goes in as TEXT, never as markup — transcripts are user content. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: {
    readonly class?: string;
    readonly attrs?: Readonly<Record<string, string>>;
    readonly on?: Readonly<Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>>;
    readonly style?: Readonly<Record<string, string>>;
  } = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class !== undefined) node.className = props.class;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const [name, value] of Object.entries(props.style ?? {})) node.style.setProperty(name, value);
  for (const [name, handler] of Object.entries(props.on ?? {})) {
    if (handler !== undefined) node.addEventListener(name, handler);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function hairline(): HTMLElement {
  return h('hr', { class: 'hairline' });
}

export function footnote(text: string, tone: 'plain' | 'amber' | 'danger' = 'plain'): HTMLElement {
  return h('div', { class: `footnote${tone === 'plain' ? '' : ` ${tone}`} selectable` }, [text]);
}

/** A card, optionally titled. */
export function card(
  options: { readonly title?: string | null; readonly subtitle?: string; readonly icon?: string },
  body: readonly Child[],
): HTMLElement {
  const head =
    options.title === undefined || options.title === null
      ? null
      : h('div', { class: 'card-head' }, [
          options.icon === undefined ? null : icon(options.icon, 15, 2),
          h('div', { class: 'titles' }, [
            h('div', { class: 't-headline' }, [options.title]),
            options.subtitle === undefined ? null : h('div', { class: 'subtitle' }, [options.subtitle]),
          ]),
        ]);
  return h('section', { class: 'card' }, [head, ...body]);
}

/** Title and detail on the left, a control on the right. */
export function settingRow(title: string, detail: string | null, control: Node | null): HTMLElement {
  return h('div', { class: 'row' }, [
    h('div', { class: 'words' }, [
      h('div', { class: 'title' }, [title]),
      detail === null ? null : h('div', { class: 'detail-text' }, [detail]),
    ]),
    control === null ? null : h('div', { class: 'control' }, [control]),
  ]);
}

/** The accent switch. `onChange` gets the new value; `set` moves it without firing. */
export function toggle(
  checked: boolean,
  onChange: (value: boolean) => void,
  label: string,
): { readonly element: HTMLButtonElement; set(value: boolean, disabled?: boolean): void } {
  const element = h('button', {
    class: 'switch',
    attrs: { role: 'switch', 'aria-checked': String(checked), 'aria-label': label, type: 'button' },
  });
  element.addEventListener('click', () => {
    const next = element.getAttribute('aria-checked') !== 'true';
    element.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return {
    element,
    set(value: boolean, disabled = false) {
      element.setAttribute('aria-checked', String(value));
      element.disabled = disabled;
    },
  };
}

/** A switch bound to one settings key. Persists on change. */
export function boundToggle(
  scope: Scope,
  key: keyof Settings,
  title: string,
  detail: string | null,
  options: { readonly checked?: (settings: Settings) => boolean; readonly disabled?: (settings: Settings) => boolean } = {},
): HTMLElement {
  const control = toggle(Boolean(store.settings[key]), (value) => {
    void store.write(key, value as never);
  }, title);
  // Found by the key it writes, never by its label: the label is in the interface language.
  control.element.dataset['setting'] = String(key);
  const detailNode = h('div', { class: 'detail-text' }, [detail ?? '']);
  const row = h('div', { class: 'row' }, [
    h('div', { class: 'words' }, [h('div', { class: 'title' }, [title]), detail === null ? null : detailNode]),
    h('div', { class: 'control' }, [control.element]),
  ]);
  scope.watch(['settings'], () => {
    const settings = store.settings;
    control.set(options.checked?.(settings) ?? Boolean(settings[key]), options.disabled?.(settings) ?? false);
  });
  return row;
}

/**
 * FLIP: run `mutate` (which reorders or replaces `items`' elements), then glide every element
 * that has a counterpart from where it was to where it is. Counterparts are matched by
 * `data-key`; a new element with no old one simply appears. Softly — 220 ms, ease-out — and not at
 * all when the system asks for reduced motion.
 */
export function flip(container: HTMLElement, mutate: () => void): void {
  const keyed = (): Map<string, DOMRect> => {
    const rects = new Map<string, DOMRect>();
    for (const child of container.children) {
      const key = child.getAttribute('data-key');
      if (key !== null) rects.set(key, child.getBoundingClientRect());
    }
    return rects;
  };
  const before = keyed();
  mutate();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const child of container.children) {
    const key = child.getAttribute('data-key');
    const from = key === null ? undefined : before.get(key);
    if (from === undefined || !(child instanceof HTMLElement)) continue;
    const to = child.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (dx === 0 && dy === 0) continue;
    child.animate(
      [{ transform: `translate(${String(dx)}px, ${String(dy)}px)` }, { transform: 'none' }],
      { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }
}

export interface SegmentedOption<V> {
  readonly value: V;
  readonly label: string;
}

/**
 * The sliding chip picker — one accent thumb that springs between chips. When the chips
 * do not fit, it becomes a drop-down, as the Mac's `AdaptivePicker` falls back to a menu.
 */
export function segmented<V extends string | number>(
  initial: readonly SegmentedOption<V>[],
  selected: V | null,
  onSelect: (value: V) => void,
): {
  readonly element: HTMLElement;
  set(value: V | null, disabled?: ReadonlySet<V>): void;
  /** Put the chips in this order (values not listed keep their relative place, last). Glides. */
  reorder(values: readonly V[]): void;
} {
  let options = [...initial];
  let disabledNow: ReadonlySet<V> | undefined;
  const thumb = h('span', { class: 'thumb' });
  let buttons = options.map((option) =>
    h(
      'button',
      {
        attrs: { type: 'button', 'data-value': String(option.value), 'data-key': String(option.value) },
        on: { click: () => onSelect(option.value) },
      },
      [option.label],
    ),
  );
  const chips = h('div', { class: 'segmented', attrs: { role: 'radiogroup' } }, [thumb, ...buttons]);
  const menu = h('select', { class: 'menu-select', attrs: { hidden: '' } }, options.map((option) =>
    h('option', { attrs: { value: String(option.value) } }, [option.label]),
  ));
  menu.addEventListener('change', () => {
    const found = options.find((option) => String(option.value) === menu.value);
    if (found !== undefined) onSelect(found.value);
  });
  const element = h('div', { class: 'no-drag', style: { 'min-width': '0', display: 'flex', 'justify-content': 'flex-end' } }, [chips, menu]);

  let current: V | null = selected;
  let placedOnce = false;
  const place = (): void => {
    const index = options.findIndex((option) => option.value === current);
    buttons.forEach((button, i) => {
      button.classList.toggle('on', i === index);
      button.setAttribute('aria-checked', String(i === index));
    });
    menu.value = current === null ? '' : String(current);
    const target = buttons[index];
    if (target === undefined || target.offsetWidth === 0) {
      chips.classList.add('no-thumb');
      return;
    }
    chips.classList.remove('no-thumb');
    if (!placedOnce) thumb.style.transition = 'none';
    thumb.style.width = `${String(target.offsetWidth)}px`;
    thumb.style.transform = `translateX(${String(target.offsetLeft)}px)`;
    if (!placedOnce) {
      void thumb.offsetWidth;
      thumb.style.transition = '';
      placedOnce = true;
    }
  };
  // Fit: chips when they fit the space the row gives them, a menu when they do not.
  const fit = (): void => {
    const parent = element.parentElement;
    if (parent === null) return;
    chips.hidden = false;
    menu.hidden = true;
    const available = parent.clientWidth;
    if (available > 0 && chips.scrollWidth > available) {
      chips.hidden = true;
      menu.hidden = false;
    }
    place();
  };
  const observer = new ResizeObserver(() => fit());
  requestAnimationFrame(() => {
    if (element.parentElement !== null) observer.observe(element.parentElement);
    fit();
  });
  const apply = (value: V | null, disabled?: ReadonlySet<V>): void => {
    current = value;
    disabledNow = disabled;
    buttons.forEach((button, i) => {
      const option = options[i];
      button.disabled = option !== undefined && disabled?.has(option.value) === true;
    });
    for (const [i, option] of [...menu.options].entries()) {
      const source = options[i];
      option.disabled = source !== undefined && disabled?.has(source.value) === true;
    }
    place();
  };
  return {
    element,
    reorder(values: readonly V[]) {
      const rank = (option: SegmentedOption<V>): number => {
        const at = values.indexOf(option.value);
        return at < 0 ? values.length : at;
      };
      const next = [...options].sort((a, b) => rank(a) - rank(b));
      if (next.every((option, i) => option === options[i])) return;
      const buttonOf = new Map(options.map((option, i) => [option.value, buttons[i]] as const));
      flip(chips, () => {
        options = next;
        buttons = next.map((option) => buttonOf.get(option.value) as HTMLButtonElement);
        chips.append(...buttons);
        menu.replaceChildren(
          ...next.map((option) => h('option', { attrs: { value: String(option.value) } }, [option.label])),
        );
      });
      apply(current, disabledNow);
    },
    set: apply,
  };
}

export function button(
  label: string,
  kind: 'default' | 'primary' | 'ghost' | 'destructive' | 'link' = 'default',
  onClick?: () => void,
  small = false,
): HTMLButtonElement {
  return h(
    'button',
    {
      class: `btn${kind === 'default' ? '' : ` ${kind}`}${small ? ' small' : ''}`,
      attrs: { type: 'button' },
      ...(onClick === undefined ? {} : { on: { click: () => onClick() } }),
    },
    [label],
  );
}

export function iconButton(name: string, label: string, onClick: () => void, tone: '' | 'danger' | 'accent' = ''): HTMLButtonElement {
  return h(
    'button',
    { class: `icon-btn${tone === '' ? '' : ` ${tone}`}`, attrs: { type: 'button', title: label, 'aria-label': label }, on: { click: () => onClick() } },
    [icon(name, 13, 2)],
  );
}

export function badge(text: string, tone: 'plain' | 'accent' | 'filled' = 'plain'): HTMLElement {
  return h('span', { class: `badge${tone === 'plain' ? '' : ` ${tone}`}` }, [text]);
}

export type Tone = 'good' | 'warning' | 'bad' | 'neutral';

export function statusDot(text: string, tone: Tone, pulsing = false): HTMLElement {
  const toneClass = tone === 'good' ? '' : ` ${tone}`;
  return h('span', { class: `status${toneClass}` }, [
    h('span', { class: `dot${toneClass}${pulsing ? ' pulsing' : ''}` }),
    text,
  ]);
}

export function keycap(label: string, large = false): HTMLElement {
  return h('span', { class: `keycap${large ? ' large' : ''}` }, [label]);
}

/**
 * A sentence with a node in it: `template` holds `{key}` where `node` goes. Word order differs
 * by language ("Hold [key] anywhere" / "[key] tugmasini bosib turing"), so the key cap's place
 * is the translation's to decide, not the page's.
 */
export function withNode(template: string, node: Node): (Node | string)[] {
  const at = template.indexOf('{key}');
  if (at < 0) return [template, node];
  return [template.slice(0, at).trimEnd(), node, template.slice(at + '{key}'.length).trimStart()].filter(
    (part) => part !== '',
  );
}

/** "Hold [right Ctrl] speak…": the bound key, in words, as one key cap. */
export function hotkeyCap(vk: number): HTMLElement {
  return keycap(inlineName(vk));
}

export function hotkeyWords(vk: number): string {
  return inlineName(vk);
}

export function hotkeyTitle(vk: number): string {
  return hotkeyName(vk);
}

/** A tile's number, and how to format any value on the way to it. */
export interface Counting {
  readonly number: number;
  readonly format: (value: number) => string;
  /** Position in its row, for the stagger. */
  readonly order: number;
  /**
   * Count from here instead of from zero, and do not rise in: the tile was already on screen
   * with this number (Statistics switching period), so it changes in place.
   */
  readonly from?: number;
}

/**
 * A big number with a label. Given `counting`, it counts up to its number the first time it
 * appears — ~0.85 s, eased, staggered by `order` — and fades and rises into place with it. The
 * figures are tabular and the tile's height fixed, so nothing around it moves while it counts.
 * Reduced motion shows the number at once.
 */
export function statTile(title: string, value: string, caption: string, iconName: string, counting?: Counting): HTMLElement {
  const metric = h('div', { class: 't-metric' }, [value]);
  const tile = h('div', { class: 'tile' }, [
    h('div', { class: 'label' }, [icon(iconName, 12, 2), title]),
    metric,
    h('div', { class: 'caption' }, [caption]),
  ]);
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (counting === undefined || reduce) return tile;
  const from = counting.from ?? 0;
  const delay = counting.from === undefined ? counting.order * COUNT_UP_STAGGER_MS : 0;
  if (counting.from === undefined) {
    tile.classList.add('tile-in');
    tile.style.animationDelay = `${String(delay)}ms`;
  }
  metric.textContent = counting.format(from);
  let start: number | null = null;
  const step = (now: number): void => {
    start ??= now + delay + 50;
    const progress = Math.max(0, now - start) / COUNT_UP_MS;
    metric.textContent = progress >= 1 ? value : counting.format(from + (counting.number - from) * countEase(progress));
    if (progress < 1 && tile.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return tile;
}

export function grid(minColumn: number, children: readonly Child[]): HTMLElement {
  return h('div', { class: 'grid', style: { '--min-col': `${String(minColumn)}px` } }, children);
}

/** Show or hide with the smooth spring, by collapsing its row to zero height. */
export function collapsible(child: Node): { readonly element: HTMLElement; set(open: boolean): void } {
  const element = h('div', { class: 'collapsible' }, [h('div', {}, [child])]);
  return {
    element,
    set(open: boolean) {
      element.classList.toggle('collapsed', !open);
      element.setAttribute('aria-hidden', String(!open));
    },
  };
}

/** A text field bound to one settings key; persists when focus leaves or Enter is pressed. */
export function boundText(key: keyof Settings, placeholder: string, mono = true): HTMLInputElement {
  const input = h('input', {
    class: `well${mono ? ' mono' : ''}`,
    attrs: { type: 'text', placeholder, spellcheck: 'false' },
  });
  input.value = String(store.settings[key] ?? '');
  const commit = (): void => {
    if (input.value !== store.settings[key]) void store.write(key, input.value as never);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') input.blur();
  });
  return input;
}

/** Copied! for a moment, then back. */
export function flashCopied(target: HTMLElement): void {
  target.classList.add('shown');
  setTimeout(() => target.classList.remove('shown'), 1_200);
}

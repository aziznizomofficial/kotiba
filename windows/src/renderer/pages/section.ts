// A section of the app window, built from its table (`APP_SECTIONS`). The generic
// controls render themselves; each page supplies its custom cards. A custom control a
// page does not supply is an error the page shows rather than a hole it hides.

import type { AppSection, CustomKind, SettingsControl } from '../../main/settings-model.js';

import { card, footnote, h, hairline } from '../components.js';
import { Scope } from '../store.js';

import type { Page } from './common.js';
import { pageFrame, renderControl } from './common.js';

export type CustomRenderer = (scope: Scope, control: Extract<SettingsControl, { kind: 'custom' }>) => HTMLElement;

export interface SectionOptions {
  readonly customs: Partial<Record<CustomKind, CustomRenderer>>;
  /** Called once the frame exists, for pages whose title or subtitle is live. */
  readonly decorate?: (scope: Scope, frame: ReturnType<typeof pageFrame>) => void;
}

export function renderSection(section: AppSection, options: SectionOptions): Page {
  const scope = new Scope();
  const frame = pageFrame(section.title, section.subtitle);
  options.decorate?.(scope, frame);

  for (const cardSpec of section.cards) {
    const body: HTMLElement[] = [];
    cardSpec.controls.forEach((control) => {
      let node: HTMLElement | null;
      if (control.kind === 'custom') {
        const render = options.customs[control.custom];
        node = render === undefined ? footnote(`Missing view: ${control.custom}`, 'danger') : render(scope, control);
      } else {
        node = renderControl(scope, control);
      }
      if (node === null) return;
      // A custom card may decide to render nothing right now (a blocker list with no
      // blockers); it hides itself and the hairline before it goes with it.
      if (body.length > 0 && !cardSpec.bare) {
        const line = hairline();
        const target = node;
        const sync = (): void => {
          line.hidden = target.hidden;
        };
        new MutationObserver(sync).observe(target, { attributes: true, attributeFilter: ['hidden'] });
        sync();
        body.push(line);
      }
      body.push(node);
    });
    const element = cardSpec.bare
      ? h('div', { class: 'bare' }, body)
      : card(
          {
            title: cardSpec.title,
            ...(cardSpec.subtitle === undefined ? {} : { subtitle: cardSpec.subtitle }),
            ...(cardSpec.icon === undefined ? {} : { icon: cardSpec.icon }),
          },
          body,
        );
    // A card whose only content is hidden hides with it.
    if (body.length === 1) {
      const only = body[0];
      if (only !== undefined) {
        const sync = (): void => {
          element.hidden = only.hidden;
        };
        new MutationObserver(sync).observe(only, { attributes: true, attributeFilter: ['hidden'] });
        sync();
      }
    }
    frame.inner.append(element);
  }

  return {
    root: frame.root,
    dispose: () => scope.dispose(),
  };
}

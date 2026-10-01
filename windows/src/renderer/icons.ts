// The icon set, as inline SVG — no icon font, no network, no external file. Drawn for
// this app on a 24-unit grid with round 1.8-unit strokes, to sit where the Mac uses SF
// Symbols. Each entry is the SVG body; `icon()` wraps it.

const ICONS: Readonly<Record<string, string>> = {
  home: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v11h13V9"/><path d="M10 20v-5.5h4V20"/>',
  history:
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v4.5H8"/><path d="M12 7.5V12l3 2"/>',
  chart: '<path d="M4 20h16"/><path d="M6.5 16v-5"/><path d="M10.5 16V6"/><path d="M14.5 16v-7"/><path d="M18.5 16v-3"/>',
  bars: '<rect x="4" y="11" width="4" height="9" rx="1"/><rect x="10" y="6" width="4" height="14" rx="1"/><rect x="16" y="9" width="4" height="11" rx="1"/>',
  wand: '<path d="M4 20 15 9"/><path d="m13 7 4 4"/><path d="M18 3v3M16.5 4.5h3"/><path d="M8 3.5v2M7 4.5h2"/><path d="M20 12v2M19 13h2"/>',
  globe:
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5z"/>',
  keyboard:
    '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10"/>',
  command:
    '<path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9zm0 0h6m-6 0v6m6-6V6.5A2.5 2.5 0 1 1 17.5 9H15zm0 0v6m0 0h2.5a2.5 2.5 0 1 1-2.5 2.5V15zm0 0H9m0 0v2.5A2.5 2.5 0 1 1 6.5 15H9z"/>',
  gear:
    '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2 1.2M17.8 15.3l2 1.2M4.2 16.5l2-1.2M17.8 8.7l2-1.2"/><circle cx="12" cy="12" r="6.8"/>',
  sparkles:
    '<path d="M10 3.5 11.6 8 16 9.6 11.6 11.2 10 15.6 8.4 11.2 4 9.6 8.4 8z"/><path d="M17.5 13.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  bubble: '<path d="M4 5.5h16v10H10l-4 3.5v-3.5H4z"/>',
  note: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8 9h8M8 12.5h8M8 16h5"/>',
  cursor: '<path d="M8 4.5h8M8 19.5h8M12 4.5v15"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/>',
  words: '<path d="M4 6h16M4 10h10M4 14h16M4 18h8"/>',
  bolt: '<path d="M13 2.5 5 13.5h6l-1 8 8-11h-6z"/>',
  flame: '<path d="M12 21c3.9 0 6.5-2.6 6.5-6.2 0-3.9-3.2-6.4-4.4-10.3-2 1.7-3.1 3.7-3.1 5.8-1-.6-1.7-1.6-2-2.8-1.7 1.7-2.5 4-2.5 6.5 0 4 2.6 7 5.5 7z"/>',
  hourglass: '<path d="M6.5 3h11M6.5 21h11"/><path d="M7.5 3c0 4.5 4.5 5.5 4.5 9s-4.5 4.5-4.5 9M16.5 3c0 4.5-4.5 5.5-4.5 9s4.5 4.5 4.5 9"/>',
  stopwatch: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9.5M10 2.5h4M18 6l1.5-1.5"/>',
  speaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  infinity:
    '<path d="M7.2 8.2C4.8 8.2 3 9.9 3 12s1.8 3.8 4.2 3.8c3.4 0 6.2-7.6 9.6-7.6 2.4 0 4.2 1.7 4.2 3.8s-1.8 3.8-4.2 3.8c-3.4 0-6.2-7.6-9.6-7.6z"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  stethoscope:
    '<path d="M6 3.5v5a4 4 0 0 0 8 0v-5"/><path d="M10 12.5V15a5 5 0 0 0 10 0v-1.5"/><circle cx="20" cy="11.5" r="2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.7v.3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/>',
  trash: '<path d="M4.5 6.5h15"/><path d="M9.5 6.5V4h5v2.5"/><path d="M6.5 6.5 7.5 20h9l1-13.5"/><path d="M10 10.5v6M14 10.5v6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  warning: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16v.4"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
  box: '<path d="M12 3 4 7v10l8 4 8-4V7z"/><path d="M4 7l8 4 8-4M12 11v10"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  close: '<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6m0-6-6 6"/>',
  x: '<path d="m7 7 10 10M17 7 7 17"/>',
  minus: '<path d="M6 12h12"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  quote: '<path d="M4 15.5c0-4 1.8-6.8 5-8l.8 1.3C8 9.9 7.3 11.3 7.3 13H10v5H4zm9 0c0-4 1.8-6.8 5-8l.8 1.3c-1.8 1.1-2.5 2.5-2.5 4.2H19v5h-6z"/>',
  app: '<rect x="4" y="4" width="16" height="16" rx="4"/>',
  waveform:
    '<path d="M3 11v2M6.5 8v8M10 4.5v15M13.5 7v10M17 9.5v5M20.5 11v2"/>',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An icon element. `stroke` icons use currentColor, so CSS colours them. */
export function icon(name: string, size = 16, strokeWidth = 1.8): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  // The bodies are compile-time constants in this file, never data — so innerHTML on an
  // SVG element here is not a path for user text.
  svg.innerHTML = ICONS[name] ?? ICONS['app'] ?? '';
  return svg;
}

export function hasIcon(name: string): boolean {
  return ICONS[name] !== undefined;
}

export const ICON_NAMES: readonly string[] = Object.keys(ICONS);

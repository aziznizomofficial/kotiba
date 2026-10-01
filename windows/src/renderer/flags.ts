// The three flags the language picker shows, drawn as inline SVG.
//
// Not emoji: Windows ships no flag emoji at all — 🇬🇧 renders as the two letters "GB" in a
// box — and not image files, which the page would have to load past its content policy. Each
// is drawn at 3:2 in a rounded frame, so the three sit as one set: the Union Jack is the
// 1:2 flag cropped to 3:2 (as every flag set does), Uzbekistan's 1:2 is redrawn at 3:2 with
// its 15:1:10:1:15 bands and the crescent and twelve stars kept to scale.

const SVG_NS = 'http://www.w3.org/2000/svg';

export type FlagId = 'gb' | 'ru' | 'uz';

/** Clip-path ids must be unique per page, and a page draws the same flag more than once. */
let serial = 0;

function el(tag: string, attrs: Readonly<Record<string, string | number>>, children: readonly Element[] = []): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  for (const child of children) node.append(child);
  return node;
}

function unionJack(): SVGElement {
  serial += 1;
  const field = `flag-gb-${String(serial)}`;
  const diag = `flag-gb-d-${String(serial)}`;
  return el('svg', { viewBox: '0 0 60 30', preserveAspectRatio: 'xMidYMid slice' }, [
    el('defs', {}, [
      el('clipPath', { id: field }, [el('path', { d: 'M0,0 v30 h60 v-30 z' })]),
      // The red saltire is counterchanged: each arm sits on the clockwise side of the white.
      el('clipPath', { id: diag }, [el('path', { d: 'M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z' })]),
    ]),
    el('g', { 'clip-path': `url(#${field})` }, [
      el('path', { d: 'M0,0 v30 h60 v-30 z', fill: '#012169' }),
      el('path', { d: 'M0,0 L60,30 M60,0 L0,30', stroke: '#FFFFFF', 'stroke-width': 6 }),
      el('path', { d: 'M0,0 L60,30 M60,0 L0,30', stroke: '#C8102E', 'stroke-width': 4, 'clip-path': `url(#${diag})` }),
      el('path', { d: 'M30,0 v30 M0,15 h60', stroke: '#FFFFFF', 'stroke-width': 10 }),
      el('path', { d: 'M30,0 v30 M0,15 h60', stroke: '#C8102E', 'stroke-width': 6 }),
    ]),
  ]);
}

function russia(): SVGElement {
  return el('svg', { viewBox: '0 0 60 40', preserveAspectRatio: 'none' }, [
    el('rect', { width: 60, height: 40, fill: '#FFFFFF' }),
    el('rect', { y: 13.333, width: 60, height: 13.334, fill: '#0039A6' }),
    el('rect', { y: 26.667, width: 60, height: 13.333, fill: '#D52B1E' }),
  ]);
}

/** A five-pointed star, point up, centred on (cx, cy). */
function star(cx: number, cy: number, r: number): SVGElement {
  const points: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? r : r * 0.4;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    points.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return el('polygon', { points: points.join(' '), fill: '#FFFFFF' });
}

function uzbekistan(): SVGElement {
  serial += 1;
  const crescent = `flag-uz-${String(serial)}`;
  // Bands 15:1:10:1:15 of the height.
  const unit = 40 / 42;
  const stars: SVGElement[] = [];
  // Three rows — 3, 4 and 5 stars — right-aligned beside the crescent, as on the flag.
  const rows: readonly [number, number][] = [
    [3, 3.4],
    [4, 7.15],
    [5, 10.9],
  ];
  for (const [count, y] of rows) {
    for (let i = 0; i < count; i += 1) stars.push(star(30.2 - (count - 1 - i) * 3.55, y, 1.15));
  }
  return el('svg', { viewBox: '0 0 60 40', preserveAspectRatio: 'none' }, [
    el('defs', {}, [
      el('mask', { id: crescent }, [
        el('rect', { width: 60, height: 40, fill: '#000' }),
        el('circle', { cx: 8.6, cy: 7.15, r: 4.9, fill: '#FFF' }),
        el('circle', { cx: 10.4, cy: 7.15, r: 4.25, fill: '#000' }),
      ]),
    ]),
    el('rect', { width: 60, height: 15 * unit, fill: '#0099B5' }),
    el('rect', { y: 15 * unit, width: 60, height: unit, fill: '#CE1126' }),
    el('rect', { y: 16 * unit, width: 60, height: 10 * unit, fill: '#FFFFFF' }),
    el('rect', { y: 26 * unit, width: 60, height: unit, fill: '#CE1126' }),
    el('rect', { y: 27 * unit, width: 60, height: 15 * unit, fill: '#1EB53A' }),
    el('rect', { width: 60, height: 40, fill: '#FFFFFF', mask: `url(#${crescent})` }),
    ...stars,
  ]);
}

/** A flag in its rounded frame, `width` px wide at 3:2. Decorative: the name beside it speaks. */
export function flag(id: FlagId, width: number): HTMLElement {
  const frame = document.createElement('span');
  frame.className = 'flag';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.width = `${String(width)}px`;
  frame.style.height = `${String(Math.round((width * 2) / 3))}px`;
  frame.append(id === 'gb' ? unionJack() : id === 'ru' ? russia() : uzbekistan());
  return frame;
}

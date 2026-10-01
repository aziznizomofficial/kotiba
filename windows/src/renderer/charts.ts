// The charts, as SVG — the port of the Mac's Swift Charts: dictations per day, the
// per-language and per-mode proportion bars, and "where the time goes". Hand-drawn so
// there is no charting dependency; animated with the smooth spring as bars grow in.

import { t, tn } from '../core/i18n/index.js';
import { capitaliseStage, stageName } from '../main/live-status.js';
import type { Bar, Share, StageTime, StatsBucketUnit } from '../core/stats/index.js';
import { barLabel, formatCount, formatMillis, labelledBars } from '../core/stats/index.js';

import { h } from './components.js';
import { icon } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string | number>>,
  children: readonly SVGElement[] = [],
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  for (const child of children) node.append(child);
  return node;
}

/** Round numbers for about `count` ticks up to at least `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) ?? raw;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 0.999; value += step) ticks.push(Math.round(value * 1000) / 1000);
  return ticks;
}

/**
 * The period's bars — one per hour, day, week or month — as gradient accent bars on a
 * hairline grid, the bar "now" is in lit brighter and its label in the accent. Every bar grows
 * in on the smooth spring, so a new period arrives as one motion. A period with no dictation
 * keeps its axes and says so, calmly, in the middle.
 */
export function periodChart(bars: readonly Bar[], unit: StatsBucketUnit, empty: string, label: string, height = 180): HTMLElement {
  const width = 640;
  const left = 34;
  const bottom = 22;
  const plotHeight = height - bottom - 6;
  const max = Math.max(1, ...bars.map((bar) => bar.dictations));
  const ticks = niceTicks(max);
  const top = ticks.at(-1) ?? max;
  const slot = (width - left) / Math.max(1, bars.length);
  const barWidth = Math.max(2, slot * 0.62);

  const id = String(Math.random()).slice(2, 8);
  const gradient = (name: string, from: number, to: number): SVGElement =>
    svg('linearGradient', { id: name, x1: 0, x2: 0, y1: 0, y2: 1 }, [
      svg('stop', { offset: '0%', 'stop-color': '#7EF0C8', 'stop-opacity': from }),
      svg('stop', { offset: '100%', 'stop-color': '#7EF0C8', 'stop-opacity': to }),
    ]);
  const defs = svg('defs', {}, [gradient(`bar-${id}`, 0.78, 0.38), gradient(`now-${id}`, 1, 0.7)]);
  const grid = ticks.map((tick) => {
    const y = 6 + plotHeight - (tick / top) * plotHeight;
    return svg('g', {}, [
      svg('line', { x1: left, x2: width, y1: y, y2: y, stroke: 'rgba(255,255,255,0.08)' }),
      Object.assign(svg('text', { x: 0, y: y + 4, fill: 'rgba(255,255,255,0.38)', 'font-size': 11 }), {
        textContent: formatCount(tick),
      }),
    ]);
  });
  const marks = bars.map((bar) => {
    const barHeight = (bar.dictations / top) * plotHeight;
    const x = left + bar.index * slot + (slot - barWidth) / 2;
    const rect = svg('rect', {
      class: 'bar',
      x,
      y: 6 + plotHeight - barHeight,
      width: barWidth,
      height: Math.max(0, barHeight),
      rx: Math.min(3, barWidth / 2),
      fill: `url(#${bar.isCurrent ? 'now' : 'bar'}-${id})`,
    });
    rect.style.animationDelay = `${String(Math.min(bar.index * 12, 240))}ms`;
    const title = svg('title', {});
    title.textContent = t('chart.dayTitle', {
      day: barLabel(bar, unit),
      dictations: tn('chart.dictations', bar.dictations),
      words: tn('chart.words', bar.words),
    });
    rect.append(title);
    return rect;
  });
  const shown = labelledBars(bars.length, unit);
  const labels = shown.map((index) => {
    const bar = bars[index];
    // The latest bar sits at the plot's right edge: its label hangs left rather than centring,
    // or the edge cuts it off.
    const latest = unit !== 'hour' && index === bars.length - 1;
    return Object.assign(
      svg('text', {
        x: latest ? width : left + index * slot + slot / 2,
        y: height - 4,
        'text-anchor': latest ? 'end' : 'middle',
        fill: bar?.isCurrent === true ? '#7EF0C8' : 'rgba(255,255,255,0.38)',
        'font-size': 11,
      }),
      { textContent: bar === undefined ? '' : barLabel(bar, unit) },
    );
  });
  const chart = svg('svg', { viewBox: `0 0 ${String(width)} ${String(height)}`, height, role: 'img' }, [defs, ...grid, ...marks, ...labels]);
  chart.setAttribute('aria-label', label);
  const quiet = bars.every((bar) => bar.dictations === 0);
  return h('div', { class: 'chart', style: { position: 'relative' } }, [
    chart,
    quiet ? h('div', { class: 'chart-empty' }, [icon('bars', 20, 1.4), h('div', {}, [empty])]) : null,
  ]);
}

const SERIES = ['#7EF0C8', '#5FB3F5', '#C9A6FF', '#FFC061'];

/** A horizontal proportion bar per key: label, bar, count and percent. */
export function shareBars(shares: readonly Share[], name: (key: string) => string): HTMLElement {
  if (shares.length === 0) return h('div', { class: 'footnote' }, [t('chart.noDictations')]);
  return h(
    'div',
    { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } },
    shares.slice(0, 5).map((share, index) =>
      h('div', { class: 'share' }, [
        h('div', { class: 'head' }, [
          h('span', { style: { 'font-weight': '500' } }, [name(share.key)]),
          h('span', { class: 'value' }, [`${formatCount(share.count)} · ${String(Math.round(share.fraction * 100))}%`]),
        ]),
        h('div', { class: 'track' }, [
          h('div', {
            class: 'fill',
            style: {
              width: `${String(Math.max(0.5, share.fraction * 100))}%`,
              background: SERIES[index % SERIES.length] ?? '#7EF0C8',
              'animation-delay': `${String(index * 40)}ms`,
            },
          }),
        ]),
      ]),
    ),
  );
}

/** Median milliseconds per stage, as capsules; polishing in the third series colour. */
export function stageChart(stages: readonly StageTime[]): HTMLElement {
  if (stages.length === 0) return h('div', { class: 'footnote' }, [t('chart.noTimings')]);
  const max = Math.max(1, ...stages.map((stage) => stage.medianMillis));
  return h(
    'div',
    { style: { display: 'grid', 'grid-template-columns': 'auto 1fr', gap: '10px 12px', 'align-items': 'center' } },
    stages.flatMap((stage, index) => [
      h('span', { class: 't-callout c-secondary' }, [capitaliseStage(stageName(stage.stage))]),
      h('div', { style: { display: 'flex', 'align-items': 'center', gap: '6px' } }, [
        h('div', {
          class: 'share-fill',
          style: {
            height: '14px',
            'border-radius': '999px',
            width: `${String(Math.max(1, (stage.medianMillis / max) * 82))}%`,
            background: stage.stage === 'polishing' ? '#C9A6FF' : '#7EF0C8',
            'transform-origin': 'left',
            animation: `grow-x var(--spring-smooth-ms) var(--spring-smooth) ${String(index * 40)}ms both`,
          },
        }),
        h('span', { class: 't-caption c-secondary num' }, [formatMillis(stage.medianMillis)]),
      ]),
    ]),
  );
}

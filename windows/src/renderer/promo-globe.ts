// Home's first panel: promo V19 "Globe", the owner's pick of 2026-10-02 — the port of the Mac's
// PromoGlobe.swift, and like it a faithful copy of the web original's drawing code (setd.js
// `drawV19` and the shared helpers it calls, from kotiba-promo-set-d.html), typed. The names,
// constants, timings and easings are the page's own so the two stay diffable.
//
// A dotted Earth sits in the middle; the five language names orbit it and the globe turns to
// where each is spoken; the four modes orbit the other way; the camera pulls back, the globe parks
// left, the hotkey goes down, the pill listens, ripples come from the city, and the result lands
// in its mode's form. 20 s, seamless, drawn live on a canvas — no video, no library, no inline
// script (the page's CSP is `script-src 'self'`; this is an ordinary module).
//
// Cheap: one requestAnimationFrame loop at most 60 Hz, running only while the panel is on screen,
// the window is visible and Home is mounted; a still poster under prefers-reduced-motion.

import { LAND_BITS } from './promo-land.js';

const TAU = Math.PI * 2, LOOP = 20, BEAT = 4, H = 190;
/** The Reduce Motion still: Uzbek, the globe parked, the result landed. */
export const POSTER = 3.5;
export const PROMO_HEIGHT = H;

type Ctx = CanvasRenderingContext2D;
type RGB = readonly [number, number, number];

// ───────────────────────── shared maths ─────────────────────────
const clamp = (x: number, a = 0, b = 1): number => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const prog = (t: number, a: number, b: number): number => clamp((t - a) / (b - a));
const mod = (a: number, n: number): number => ((a % n) + n) % n;
const hash = (n: number): number => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
function bez(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const B = (u: number, p1: number, p2: number): number => 3 * (1 - u) * (1 - u) * u * p1 + 3 * (1 - u) * u * u * p2 + u * u * u;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let lo = 0, hi = 1, u = x;
    for (let i = 0; i < 22; i++) { u = (lo + hi) / 2; if (B(u, x1, x2) < x) lo = u; else hi = u; }
    return B(u, y1, y2);
  };
}
// Material 3 emphasized tokens.
const E = { out: bez(0.05, 0.7, 0.1, 1), acc: bez(0.3, 0, 0.8, 0.15), io: bez(0.2, 0, 0, 1) };
const spring = (p: number): number => p <= 0 ? 0 : p >= 1 ? 1 : 1 - Math.exp(-7 * p) * Math.cos(10.5 * p);
const smooth = (p: number): number => p * p * (3 - 2 * p);
const acc = (a: number): string => `rgba(126,240,200,${a})`;
const wht = (a: number): string => `rgba(255,255,255,${a})`;
const mix = (c1: RGB, c2: RGB, t: number, a = 1): string =>
  `rgba(${Math.round(lerp(c1[0], c2[0], t))},${Math.round(lerp(c1[1], c2[1], t))},${Math.round(lerp(c1[2], c2[2], t))},${a})`;
const ACC: RGB = [126, 240, 200], WHITE: RGB = [242, 245, 244];
// No remote fonts here (CSP): the window's own face, with Segoe UI carrying Arabic on Windows.
const FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const AFONT = '"Segoe UI", "Noto Sans Arabic", "Geeza Pro", sans-serif';
const f = (size: number, weight = 500, style = ''): string => `${style} ${weight} ${size}px ${FONT}`;

// ───────────────────────── story ─────────────────────────
type ModeName = 'Raw' | 'Super' | 'Message' | 'Note';
interface Stop { code: 'UZ' | 'EN' | 'RU' | 'AR' | 'TR'; name: string; mode: ModeName; raw: string; out: string | readonly string[]; rtl?: boolean }
// The demonstration content, in its own languages, in the owner's order.
export const SEQ: readonly Stop[] = [
  { code: 'UZ', name: 'Oʻzbekcha', mode: 'Message', raw: 'ee salom ertaga oʻsha joyda uchrashamizmi', out: 'Salom! Ertaga oʻsha joyda uchrashamizmi?' },
  { code: 'EN', name: 'English', mode: 'Note', raw: 'um so tomorrow I need to buy milk and bread and uh call mom', out: ['Buy milk and bread', 'Call Mom'] },
  { code: 'RU', name: 'Русский', mode: 'Raw', raw: 'ну короче я буду минут через десять', out: 'ну короче я буду минут через десять' },
  { code: 'AR', name: 'العربية', mode: 'Super', rtl: true, raw: 'يعني سأرسل التقرير غدًا صباحًا', out: 'سأرسل التقرير غدًا صباحًا.' },
  { code: 'TR', name: 'Türkçe', mode: 'Super', raw: 'şey yarın İstanbul\'a dönüyorum çay içelim mi', out: 'Yarın İstanbul\'a dönüyorum, çay içelim mi?' },
];
const MODES: readonly ModeName[] = ['Raw', 'Super', 'Message', 'Note'];
const REG: Readonly<Record<Stop['code'], readonly [number, number]>> = {
  UZ: [41.3, 69.2], EN: [51.5, -0.1], RU: [55.75, 37.6], AR: [24.7, 46.7], TR: [41.0, 29.0],
};

/** The words on screen that are interface, not demonstration: the mode names and the key. */
export interface PromoWords { readonly modes: Readonly<Record<ModeName, string>>; readonly hotkey: string }

interface Beat { kd: number; pin: number; sa: number; sb: number; ku: number; res: number }
const B19: Beat = { kd: 1.94, pin: 1.74, sa: 2.04, sb: 2.66, ku: 2.76, res: 2.9 };
const beatOf = (t: number): { n: number; tau: number } => { const n = Math.floor(t / BEAT); return { n, tau: t - n * BEAT }; };
// Every stop spins through the WHOLE list: languages +6 (all five, then one more), modes +4…+5.
const langBase = (n: number): number => 6 * n;
const modeBase = (n: number): number => 24 * Math.floor(n / 5) + ([2, 7, 12, 17, 21][mod(n, 5)] ?? 0);
const langAt = (k: number): Stop => SEQ[mod(Math.round(k), 5)] as Stop;
const modeAt = (k: number): ModeName => MODES[mod(Math.round(k), 4)] as ModeName;
// Momentum spin: quartic deceleration + a small overshoot that settles back.
export function spin(t: number, base: (n: number) => number, a: number, b: number): number {
  const { n, tau } = beatOf(t), p0 = base(n - 1), p1 = base(n), u = prog(tau, a, b);
  const v = prog(u, 0.7, 1);
  return p0 + (p1 - p0) * (1 - Math.pow(1 - u, 4)) + 0.26 * Math.sin(Math.PI * v) * (1 - v);
}
const spinVel = (t: number, base: (n: number) => number, a: number, b: number): number => (spin(t, base, a, b) - spin(t - 1 / 120, base, a, b)) * 120;
const langFrac = (t: number, a: number, b: number): number => { const { n } = beatOf(t); return (spin(t, langBase, a, b) - langBase(n - 1)) / (langBase(n) - langBase(n - 1)); };
const keyPress = (tau: number, b: Beat): number => E.out(prog(tau, b.kd, b.kd + 0.12)) * (1 - E.out(prog(tau, b.ku, b.ku + 0.12)));
function voice(tau: number, seed: number, b: Beat): number {
  const env = prog(tau, b.sa, b.sa + 0.15) * (1 - prog(tau, b.sb - 0.1, b.sb + 0.05));
  if (env <= 0) return 0;
  const syl = 0.5 + 0.5 * Math.sin(tau * TAU * 3.1 + seed * 2.1), word = 0.55 + 0.45 * Math.sin(tau * TAU * 0.9 + seed);
  return clamp(env * (0.25 + 0.75 * syl) * word * (0.75 + 0.25 * Math.sin(tau * 23 + seed * 5)) * 1.15);
}
function spokenSoFar(raw: string, tau: number, b: Beat, maxWords: number): { s: string; fresh: number; more: boolean } | null {
  const ws = raw.split(' '), n = ws.length, span = b.sb - b.sa - 0.12;
  const k = Math.min(n, Math.floor((tau - b.sa - 0.04) / span * n) + 1);
  if (k <= 0) return null;
  const at = b.sa + 0.04 + ((k - 1) / n) * span;
  return { s: ws.slice(Math.max(0, k - maxWords), k).join(' '), fresh: E.out(prog(tau, at, at + 0.22)), more: k > maxWords };
}

// ───────────────────────── text ─────────────────────────
const mcache = new Map<string, { xs: number[]; w: number }>();
function measure(ctx: Ctx, font: string, s: string): { xs: number[]; w: number } {
  const key = font + '|' + s;
  let m = mcache.get(key);
  if (!m) {
    ctx.font = font;
    const xs: number[] = []; for (let i = 0; i <= s.length; i++) xs.push(ctx.measureText(s.slice(0, i)).width);
    m = { xs, w: xs[s.length] ?? 0 }; mcache.set(key, m);
    if (mcache.size > 400) mcache.clear();
  }
  return m;
}
const tFont = (L: Stop, fs: number, wt = 600): string => L.rtl ? `${wt} ${Math.round(fs * 1.06 * 10) / 10}px ${AFONT}` : f(fs, wt);
const nameFont = (L: Stop, px: number, wt = 700): string => L.rtl ? `${wt} ${px * 1.02}px ${AFONT}` : f(px, wt);
const lines = (L: Stop): readonly string[] => typeof L.out === 'string' ? [L.out] : L.out;
const first = (L: Stop): string => lines(L)[0] ?? '';
// Draw a whole run (Arabic is never split — shaping stays intact).
function run(ctx: Ctx, L: Stop, s: string, x: number, w: number, y: number): void {
  if (L.rtl) { ctx.direction = 'rtl'; ctx.textAlign = 'right'; ctx.fillText(s, x + w, y); ctx.direction = 'ltr'; }
  else { ctx.textAlign = 'left'; ctx.fillText(s, x, y); }
}
interface Box { w: number; h: number; nf?: string; tf?: string; tw: number }
function resultBox(ctx: Ctx, L: Stop, fs: number): Box {
  if (L.mode === 'Note') {
    const nf = tFont(L, fs * 0.9, 500), mw = Math.max(...lines(L).map((s) => measure(ctx, nf, s).w));
    return { w: mw + fs * 1.15, h: fs * 1.5 * lines(L).length, nf, tw: mw };
  }
  const tf = tFont(L, fs, L.mode === 'Raw' ? 500 : 600), tw = measure(ctx, tf, first(L)).w;
  if (L.mode === 'Message') return { w: tw + fs * 1.3, h: fs * 1.8, tf, tw };
  return { w: tw, h: fs * 1.3, tf, tw };
}
function fitFs(ctx: Ctx, L: Stop, fsMax: number, maxW: number): number { const b = resultBox(ctx, L, fsMax); return b.w <= maxW ? fsMax : Math.floor(fsMax * maxW / b.w * 2) / 2; }
// The mode-specific result, centred. x = left of its box, cy = vertical centre, age = s since it landed.
function drawResult(ctx: Ctx, L: Stop, x: number, cy: number, fs: number, age: number): void {
  if (age < 0) return;
  const b = resultBox(ctx, L, fs);
  ctx.save(); ctx.textBaseline = 'middle';
  const clipTo = (bx: number, bw: number, p: number): void => {
    ctx.beginPath(); ctx.rect(bx + bw * (1 - p) / 2 - 3, cy - 300, bw * p + 6, 600); ctx.clip();
  };
  if (L.mode === 'Note') {
    lines(L).forEach((s, li) => {
      const la = E.out(clamp((age - li * 0.16) / 0.42)); if (la <= 0) return;
      const ly = cy - b.h / 2 + fs * 1.5 * (li + 0.5) + (1 - la) * fs * 0.3, bs = fs * 0.6;
      ctx.save(); ctx.globalAlpha *= la;
      const bx = L.rtl ? x + b.w - bs : x;
      ctx.strokeStyle = acc(0.95); ctx.lineWidth = Math.max(1.2, fs * 0.075);
      ctx.beginPath(); ctx.roundRect(bx, ly - bs / 2, bs, bs, bs * 0.3); ctx.stroke();
      ctx.font = b.nf ?? ''; ctx.fillStyle = wht(0.94);
      run(ctx, L, s, L.rtl ? x : x + fs * 1.15, b.w - fs * 1.15, ly + 0.5);
      ctx.restore();
    });
  } else if (L.mode === 'Message') {
    const s = lerp(0.82, 1, spring(clamp(age / 0.5))), a = clamp(age / 0.12);
    const ox = L.rtl ? x : x + b.w, oy = cy + b.h / 2;
    ctx.translate(ox, oy); ctx.scale(s, s); ctx.translate(-ox, -oy);
    ctx.globalAlpha *= a;
    const r = b.h / 2;
    ctx.fillStyle = acc(1); ctx.beginPath(); ctx.roundRect(x, cy - b.h / 2, b.w, b.h, L.rtl ? [r, r, r, 5] : [r, r, 5, r]); ctx.fill();
    const tp = E.out(clamp((age - 0.08) / 0.36));
    ctx.save(); clipTo(x + fs * 0.65, b.tw, tp);
    ctx.font = b.tf ?? ''; ctx.fillStyle = '#03140e'; run(ctx, L, first(L), x + fs * 0.65, b.tw, cy + 0.5);
    ctx.restore();
  } else {
    const p = E.out(clamp(age / 0.38)), out = first(L), tf = b.tf ?? '';
    ctx.save(); clipTo(x, b.tw, p);
    ctx.font = tf; ctx.fillStyle = L.mode === 'Raw' ? wht(0.6) : wht(0.96);
    run(ctx, L, out, x, b.tw, cy + 0.5);
    if (L.mode === 'Super' && !L.rtl) { // what Super added (punctuation, casing, digits) glows green
      const m = measure(ctx, tf, out);
      ctx.fillStyle = acc(1); ctx.textAlign = 'left';
      added(L).forEach((on, i) => { if (on) ctx.fillText(out[i] ?? '', x + (m.xs[i] ?? 0), cy + 0.5); });
    }
    if (L.mode === 'Super' && L.rtl) { // final full stop is the leftmost glyph in RTL
      const dot = measure(ctx, tf, '.').w; ctx.save(); ctx.beginPath(); ctx.rect(x - 2, cy - 100, dot + 2, 200); ctx.clip();
      ctx.fillStyle = acc(1); run(ctx, L, out, x, b.tw, cy + 0.5); ctx.restore();
    }
    ctx.restore();
  }
  ctx.restore();
}
/** Which characters Super added: punctuation, digits, and the capital of a word said in lower case. */
export function added(L: Stop): boolean[] {
  const out = first(L), rawW = new Set((L.raw || '').split(' '));
  const flags: boolean[] = [];
  let wordStart = 0;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i] ?? '';
    if (ch === ' ') { wordStart = i + 1; flags.push(false); continue; }
    let on = /[0-9!?.,:—]/.test(ch);
    if (!on && i === wordStart && ch !== ch.toLowerCase()) { const wd = out.slice(i).split(/[ ,.!?:]/)[0] ?? ''; on = rawW.has(wd.toLowerCase()); }
    flags.push(on);
  }
  return flags;
}
// Grey "what you said" line, growing word by word (large, centred).
function saidLine(ctx: Ctx, L: Stop, tau: number, b: Beat, x: number, y: number, px: number, alpha: number): void {
  const sp = spokenSoFar(L.raw, tau, b, 7); if (!sp || alpha <= 0) return;
  ctx.save(); ctx.globalAlpha = alpha;
  txt(ctx, L.rtl ? sp.s + (sp.more ? ' …' : '') : (sp.more ? '… ' : '') + sp.s, x, y + (1 - sp.fresh) * 3, L.rtl ? `400 ${px * 1.05}px ${AFONT}` : f(px, 400, 'italic'), wht(0.5), L.rtl);
  ctx.restore();
}
function result(ctx: Ctx, L: Stop, cx: number, cy: number, fs: number, age: number): void {
  const b = resultBox(ctx, L, fs);
  drawResult(ctx, L, cx - b.w / 2, cy, fs, age);
  if (L.mode === 'Super' && age > 0.25) burstAdded(ctx, L, cx - b.w / 2, cy, fs, age - 0.25);
}
// Little sparks off the characters Super added.
function burstAdded(ctx: Ctx, L: Stop, x: number, cy: number, fs: number, age: number): void {
  if (age > 0.5) return;
  if (L.rtl) { burst(ctx, x + 3, cy, age, 9, 8, 22, 0.5); return; }
  const out = first(L), m = measure(ctx, tFont(L, fs, 600), out);
  const raw = new Set(L.raw.split(' '));
  for (let i = 0; i < out.length; i++) {
    const ch = out[i] ?? '';
    const isAdded = /[!?.,:]/.test(ch) || ((i > 0 && out[i - 1] === ' ') || i === 0) && ch !== ch.toLowerCase() && raw.has((out.slice(i).split(/[ ,.!?]/)[0] ?? '').toLowerCase());
    if (isAdded) burst(ctx, x + ((m.xs[i] ?? 0) + (m.xs[i + 1] ?? 0)) / 2, cy, age, i + 3, 7, 18, 0.5);
  }
}
function txt(ctx: Ctx, s: string, x: number, y: number, font: string, fill: string, rtl = false, align: CanvasTextAlign = 'center'): void {
  ctx.font = font; ctx.fillStyle = fill; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.fillText(s, x, y); ctx.direction = 'ltr';
}
function textOut(ctx: Ctx, s: string, x: number, y: number, font: string, fill: string, rtl: boolean, lw: number): void { // text with a black keyline so it reads over geometry
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = rtl ? 'rtl' : 'ltr';
  if (lw > 0) { ctx.lineJoin = 'round'; ctx.lineWidth = lw; ctx.strokeStyle = '#000'; ctx.strokeText(s, x, y); }
  ctx.fillStyle = fill; ctx.fillText(s, x, y); ctx.direction = 'ltr';
}

// ───────────────────────── pill · key · sparks ─────────────────────────
const LCOL: readonly RGB[] = [[126, 240, 200], [70, 200, 180], [200, 255, 235]];
function lobes(ctx: Ctx, x0: number, span: number, cy: number, h: number, t: number, lvl: number, alpha: number, glow: number): void {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  if (glow) { ctx.shadowColor = acc(0.55 * alpha); ctx.shadowBlur = glow; }
  for (let k = 0; k < 4; k++) {
    const P = 0.625 + 0.25 * k, u = t / P + k * 0.31, n = Math.floor(u), life = u - n; // periods divide 20 s
    const r1 = hash(k * 13.7 + n * 1.93), r2 = hash(k * 7.1 + n * 3.7 + 1), r3 = hash(k * 5.3 + n * 9.1 + 2);
    const a = Math.sin(life * Math.PI) * (0.1 + lvl), lw = span * (0.1 + 0.16 * r2);
    const lx = x0 + lw + (span - 2 * lw) * (0.15 + 0.7 * r1);
    ctx.beginPath();
    for (let j = 0; j <= 28; j++) { const q = j / 28; ctx.lineTo(lx - lw + 2 * lw * q, cy - Math.sin(q * Math.PI) ** 2 * h * 0.4 * a); }
    for (let j = 28; j >= 0; j--) { const q = j / 28; ctx.lineTo(lx - lw + 2 * lw * q, cy + Math.sin(q * Math.PI) ** 2 * h * 0.4 * a); }
    const [r, g, bb] = LCOL[Math.floor(r3 * 3)] ?? ACC;
    ctx.fillStyle = `rgba(${r},${g},${bb},${0.55 * alpha})`; ctx.fill();
  }
  ctx.restore();
}
function pill(ctx: Ctx, cx: number, cy: number, s: number, t: number, lvl: number, appear: number, proc: number): void {
  if (appear <= 0.001) return;
  const ph = 36 * s, pw = lerp(36, 160, clamp(appear, 0, 1.2)) * s, a = clamp(appear * 2.5);
  ctx.save(); ctx.globalAlpha *= a;
  ctx.shadowColor = acc(0.22); ctx.shadowBlur = 22 * s;
  ctx.fillStyle = '#000'; ctx.beginPath(); ctx.roundRect(cx - pw / 2, cy - ph / 2, pw, ph, ph / 2); ctx.fill();
  ctx.shadowBlur = 0; ctx.lineWidth = 1; ctx.strokeStyle = acc(0.22); ctx.stroke();
  ctx.clip();
  const inset = ph * 0.6, span = pw - inset * 2, inner = clamp((appear - 0.45) * 2.2);
  if (span > 2 && inner > 0) {
    ctx.globalAlpha *= inner;
    ctx.lineWidth = Math.max(1, ph * 0.03); ctx.strokeStyle = acc(0.3);
    ctx.beginPath(); ctx.moveTo(cx - span / 2, cy); ctx.lineTo(cx + span / 2, cy); ctx.stroke();
    lobes(ctx, cx - span / 2, span, cy, ph, t, lvl * (1 - proc), 1, ph * 0.35);
    if (proc > 0) {
      const sx = cx - span / 2 + span * ((t * 2) % 1), g = ctx.createRadialGradient(sx, cy, 0, sx, cy, ph * 0.55);
      g.addColorStop(0, acc(0.55 * proc)); g.addColorStop(1, acc(0)); ctx.fillStyle = g; ctx.fillRect(sx - ph, cy - ph, ph * 2, ph * 2);
    }
  }
  ctx.restore();
}
function keycap(ctx: Ctx, x: number, y: number, kw: number, kh: number, press: number, r: number, depth: number, glyph: string): void {
  const glow = press, dy = press * depth * 0.8;
  ctx.save();
  ctx.fillStyle = '#020303'; ctx.beginPath(); ctx.roundRect(x, y + depth, kw, kh, r); ctx.fill();
  ctx.fillStyle = '#0b0d0c'; ctx.beginPath(); ctx.roundRect(x + 0.5, y + depth * 0.55 + dy * 0.4, kw - 1, kh, r); ctx.fill();
  if (glow > 0) { ctx.shadowColor = acc(0.6 * glow); ctx.shadowBlur = kh * 0.45 * glow; }
  const g = ctx.createLinearGradient(0, y + dy, 0, y + dy + kh);
  g.addColorStop(0, mix([34, 38, 37], [22, 34, 30], press)); g.addColorStop(1, mix([19, 21, 20], [12, 18, 16], press));
  ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(x, y + dy, kw, kh, r); ctx.fill();
  ctx.shadowBlur = 0; ctx.lineWidth = 1; ctx.strokeStyle = glow > 0 ? acc(0.12 + 0.6 * glow) : wht(0.075); ctx.stroke();
  const sh = ctx.createLinearGradient(0, y + dy, 0, y + dy + kh * 0.5);
  sh.addColorStop(0, wht(0.06 * (1 - press * 0.6))); sh.addColorStop(1, wht(0));
  ctx.fillStyle = sh; ctx.beginPath(); ctx.roundRect(x + 1, y + dy + 1, kw - 2, kh * 0.5, [r - 1, r - 1, 0, 0]); ctx.fill();
  // The user's own key ("Ctrl" by default here), shrunk to fit the cap.
  let size = kh * 0.44;
  const wide = measure(ctx, f(size, 500), glyph).w, fit = kw * 0.78;
  if (wide > fit) size *= fit / wide;
  ctx.textBaseline = 'middle'; ctx.fillStyle = mix(WHITE, ACC, glow, 0.88);
  ctx.font = f(size, 500); ctx.textAlign = 'center'; ctx.fillText(glyph, x + kw / 2, y + dy + kh / 2 + 0.5);
  ctx.restore();
}
function glowAt(ctx: Ctx, x: number, y: number, r: number, a: number): void { if (a <= 0) return; const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, acc(a)); g.addColorStop(1, acc(0)); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r); }
// Particles: a deterministic spark burst.
function burst(ctx: Ctx, x: number, y: number, age: number, seed: number, n = 16, radius = 70, life = 0.55): void {
  if (age < 0 || age > life) return;
  const p = age / life, e = E.out(p);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU + hash(seed * 7 + k) * 0.6, d = radius * (0.5 + 0.6 * hash(seed + k * 3.1)) * e;
    const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d * 0.7, r = (1.2 + 1.8 * hash(k + seed)) * (1 - p);
    ctx.fillStyle = acc(0.9 * (1 - p)); ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill();
  }
  glowAt(ctx, x, y, radius * 0.9, 0.22 * (1 - p));
  ctx.restore();
}
// Squash-and-stretch pop: returns [sx, sy].
function pop(p: number): [number, number] { const s = spring(p), q = Math.sin(Math.PI * clamp(p * 1.6)) * (1 - p) * 0.22; return [s * (1 + q), s * (1 - q)]; }
function keyAndPill(ctx: Ctx, cx: number, cy: number, sc: number, t: number, tau: number, b: Beat, seed: number, appearP: number, glyph: string): void {
  if (appearP <= 0.001) return;
  const press = keyPress(tau, b), lvl = voice(tau, seed, b), proc = prog(tau, b.ku, b.ku + 0.05) * (1 - prog(tau, b.res, b.res + 0.15));
  const [sx, sy] = pop(appearP);
  ctx.save(); ctx.translate(cx, cy); ctx.scale(sx * sc, sy * sc);
  const kw = 46, gap = 18, pw = 160, tot = kw + gap + pw, kx = -tot / 2;
  glowAt(ctx, kx + kw / 2, 0, 70, 0.16 * press);
  keycap(ctx, kx, -24, kw, 44, press, 10, 5, glyph);
  ctx.strokeStyle = acc(0.12 + 0.35 * press); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(kx + kw + 3, 0); ctx.lineTo(kx + kw + gap - 3, 0); ctx.stroke();
  glowAt(ctx, kx + kw + gap + pw / 2, 0, 110, 0.12 * Math.max(press, proc));
  pill(ctx, kx + kw + gap + pw / 2, 0, 1, t, lvl, 1, proc);
  ctx.restore();
}
function vignette(ctx: Ctx, w: number, h: number): void {
  const vg = ctx.createLinearGradient(0, 0, w, 0);
  const e = Math.min(0.12, 90 / w);
  vg.addColorStop(0, 'rgba(0,0,0,0.9)'); vg.addColorStop(e, 'rgba(0,0,0,0)'); vg.addColorStop(1 - e, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.9)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
  const vv = ctx.createLinearGradient(0, 0, 0, h); vv.addColorStop(0, 'rgba(0,0,0,0.55)'); vv.addColorStop(0.2, 'rgba(0,0,0,0)'); vv.addColorStop(0.8, 'rgba(0,0,0,0)'); vv.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vv; ctx.fillRect(0, 0, w, h);
}

// ───────────────────────── V19 · Globe ─────────────────────────
type V3 = readonly [number, number, number];
/** The land dots, decoded once: 1,207 unit vectors. */
export const GLOBE: readonly V3[] = (() => { // Natural Earth 110 m land, sampled every 3° (equal-area rows), 1 bit per sample
  const raw = atob(LAND_BITS), pts: V3[] = [];
  let i = 0;
  for (let lat = -57; lat < 82; lat += 3) {
    const n = Math.max(6, Math.round(120 * Math.cos(lat * Math.PI / 180)));
    for (let j = 0; j < n; j++, i++) {
      if (!((raw.charCodeAt(i >> 3) >> (i & 7)) & 1)) continue;
      const lo = (-180 + (j + 0.5) * 360 / n) * Math.PI / 180, la = lat * Math.PI / 180;
      pts.push([Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)]);
    }
  }
  return pts;
})();
const unit = (lat: number, lon: number): V3 => { const la = lat * Math.PI / 180, lo = lon * Math.PI / 180; return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)]; };
function globe(ctx: Ctx, gx: number, gy: number, R: number, lat0: number, lon0: number, hiCode: Stop['code'], hiA: number, t: number, pinA: number): { x: number; y: number; z: number } {
  const cl = Math.cos(lon0), sl = Math.sin(lon0), cp = Math.cos(lat0), sp = Math.sin(lat0);
  const P = (v: V3): V3 => { const x1 = v[0] * cl - v[2] * sl, z1 = v[0] * sl + v[2] * cl; return [x1, v[1] * cp - z1 * sp, v[1] * sp + z1 * cp]; };
  ctx.save();
  const halo = ctx.createRadialGradient(gx, gy, R * 0.92, gx, gy, R * 1.5);
  halo.addColorStop(0, acc(0.13)); halo.addColorStop(0.35, acc(0.04)); halo.addColorStop(1, acc(0));
  ctx.fillStyle = halo; ctx.fillRect(gx - R * 1.5, gy - R * 1.5, R * 3, R * 3);
  ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(gx, gy, R, 0, TAU); ctx.fill();
  const sh = ctx.createRadialGradient(gx - R * 0.4, gy - R * 0.45, 0, gx, gy, R * 1.05);
  sh.addColorStop(0, acc(0.075)); sh.addColorStop(1, acc(0.01)); ctx.fillStyle = sh; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = acc(0.28); ctx.stroke();
  const hi = REG[hiCode], hv = unit(hi[0], hi[1]), ds = Math.max(1.1, R / 40);
  for (const v of GLOBE) {
    const [x, y, z] = P(v); if (z <= 0.03) continue;
    const near = clamp((v[0] * hv[0] + v[1] * hv[1] + v[2] * hv[2] - 0.975) / 0.02) * hiA, s = ds * (0.65 + 0.45 * z);
    ctx.fillStyle = near > 0.02 ? mix([150, 175, 168], ACC, near, 0.35 + 0.6 * z) : `rgba(150,175,168,${(0.12 + 0.5 * z).toFixed(3)})`;
    ctx.fillRect(gx + x * R - s / 2, gy - y * R - s / 2, s, s);
  }
  // the five speaking regions
  for (const code of Object.keys(REG) as Stop['code'][]) {
    const reg = REG[code], [x, y, z] = P(unit(reg[0], reg[1])); if (z <= 0.05) continue;
    const isHi = code === hiCode, px = gx + x * R, py = gy - y * R;
    if (isHi && pinA > 0) {
      glowAt(ctx, px, py, R * 0.45, 0.35 * pinA * z);
      for (let k = 0; k < 2; k++) { const ph = mod(t * 1.25 + k * 0.5, 1); ctx.strokeStyle = acc(0.6 * (1 - ph) * pinA * z); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(px, py, 3 + ph * R * 0.32, 0, TAU); ctx.stroke(); }
    }
    ctx.fillStyle = isHi ? mix(WHITE, ACC, pinA, 0.55 + 0.45 * z) : acc(0.45 * z);
    ctx.beginPath(); ctx.arc(px, py, (isHi ? lerp(1.8, 3.4, pinA) : 1.7) * Math.max(0.8, R / 60), 0, TAU); ctx.fill();
  }
  ctx.restore();
  const [x, y, z] = P(hv); return { x: gx + x * R, y: gy - y * R, z };
}
interface Orbit { gx: number; gy: number; rx: number; ry: number; pos: number; vel: number; count: number; dir: number; item: (k: number) => { text: string; rtl: boolean }; px: number; alpha: number; hot: number; skip: boolean }
// Labels riding an orbit round the globe. front=false draws the far half (call before the globe).
function orbitRing(ctx: Ctx, o: Orbit, front: boolean): void {
  const { gx, gy, rx, ry, pos, vel, count, dir, item, px, alpha, hot, skip } = o;
  if (alpha <= 0.003) return;
  ctx.save();
  ctx.strokeStyle = acc(0.13 * alpha); ctx.lineWidth = 1; ctx.beginPath();
  ctx.ellipse(gx, gy, rx, ry, 0, front ? 0 : Math.PI, front ? Math.PI : TAU); ctx.stroke();
  const base = Math.round(pos), h0 = Math.floor(count / 2);
  const its: { k: number; d: number; a: number; q: number }[] = [];
  for (let j = -h0; j < count - h0; j++) {
    const k = base + j, d = k - pos, a = Math.PI / 2 + dir * d * TAU / count;
    if ((Math.sin(a) >= 0) !== front) continue;
    its.push({ k, d, a, q: (1 + Math.sin(a)) / 2 });
  }
  its.sort((p, q) => p.q - q.q);
  for (const it of its) {
    const chosen = Math.abs(it.d) < 0.5; if (skip && chosen) continue;
    const I = item(it.k), size = px * lerp(0.42, 1, Math.pow(it.q, 1.3)), a2 = alpha * lerp(0.1, 1, Math.pow(it.q, 2.4));
    const font = I.rtl ? `700 ${size * 1.02}px ${AFONT}` : f(size, 700);
    if (Math.abs(vel) > 1.5) for (let g = 6; g >= 1; g--) { // motion trail back along the orbit
      const ang = it.a + dir * vel * 0.0055 * g * TAU / count;
      txt(ctx, I.text, gx + Math.cos(ang) * rx, gy + Math.sin(ang) * ry, font, wht(a2 * 0.07 * (1 - g / 7)), I.rtl);
    }
    ctx.globalAlpha = a2;
    textOut(ctx, I.text, gx + Math.cos(it.a) * rx, gy + Math.sin(it.a) * ry, font, chosen && hot > 0 ? mix(WHITE, ACC, hot) : wht(1), I.rtl, size * 0.28);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
// Header "Oʻzbekcha · Message": the two slot centres the chosen labels fly into.
function headerSlots(ctx: Ctx, L: Stop, mode: string, cx: number, px: number): { lx: number; mx: number; dot: number } {
  const lw = measure(ctx, nameFont(L, px, 700), L.name).w, mw = measure(ctx, f(px, 600), mode).w, gap = px * 1.5;
  const x0 = cx - (lw + gap + mw) / 2;
  return { lx: x0 + lw / 2, mx: x0 + lw + gap + mw / 2, dot: x0 + lw + gap / 2 };
}
const resFs = (L: Stop, narrow: boolean): number => L.mode === 'Note' ? (narrow ? 21 : 24) : (narrow ? 24 : 30);
// The said line → result (centre x, y).
function speakAndLand(ctx: Ctx, L: Stop, tau: number, b: Beat, x: number, y: number, narrow: boolean, maxW: number, a: number): void {
  if (a <= 0) return;
  ctx.save(); ctx.globalAlpha *= a;
  saidLine(ctx, L, tau, b, x, y, narrow ? 17 : 20, prog(tau, b.sa, b.sa + 0.12) * (1 - prog(tau, b.ku, b.ku + 0.15)));
  if (tau >= b.res) {
    const fs = fitFs(ctx, L, resFs(L, narrow), maxW), age = tau - b.res;
    ctx.save(); ctx.translate(x, y); const s = lerp(0.94, 1, E.out(prog(age, 0, 0.4))); ctx.scale(s, s);
    result(ctx, L, 0, 0, fs, age);
    ctx.restore();
  }
  ctx.restore();
}

/** One frame of the 20 s loop on a `w` × 190 logical canvas. */
export function drawV19(ctx: Ctx, w: number, h: number, rawT: number, words: PromoWords): void {
  const t = mod(rawT, LOOP), { n, tau } = beatOf(t), i = mod(n, 5), L = SEQ[i] as Stop, narrow = w < 760, P = SEQ[mod(n - 1, 5)] as Stop;
  const modeLabel = (m: ModeName): string => words.modes[m];
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  // camera: select (globe centred, big) → work (globe parked left, small) → back
  const cam = E.io(prog(tau, 1.66, 2.02)) * (1 - E.io(prog(tau, 3.66, 4.0)));
  const Rs = narrow ? 50 : 60, Rw = narrow ? 27 : 36, GXw = narrow ? 50 : 104;
  const gx = lerp(w / 2, GXw, cam), gy = lerp(96, 95, cam), R = lerp(Rs, Rw, cam);
  const lb = GXw + Rw + 24, rb = w - (narrow ? 28 : 44), XC = lerp(w / 2, (lb + rb) / 2, cam), maxW = rb - lb;
  // facing: spin from the previous language's region to this one (with an extra turn), synced to the ring
  const fr = langFrac(t, 0, 0.95), [la0, lo0] = REG[P.code], [la1, lo1] = REG[L.code];
  const lon = (lo0 - (mod(lo0 - lo1, 360) + 360) * fr) * Math.PI / 180, lat = lerp(la0, la1, smooth(clamp(fr))) * 0.72 * Math.PI / 180;
  const rx = narrow ? 228 : Math.min(w * 0.36, 350), ry = narrow ? 40 : 44, px = narrow ? 25 : 30;
  const lp = spin(t, langBase, 0, 0.95), lv = spinVel(t, langBase, 0, 0.95);
  const mp = spin(t, modeBase, 1.04, 1.62), mv = spinVel(t, modeBase, 1.04, 1.62);
  const lHot = prog(tau, 0.86, 0.96), mHot = prog(tau, 1.52, 1.62);
  const LR: Orbit = { gx, gy, rx, ry, pos: lp, vel: lv, count: 5, dir: 1, item: (k) => { const S = langAt(k); return { text: S.name, rtl: !!S.rtl }; }, px, alpha: prog(tau, 0, 0.16) * (1 - prog(tau, 0.98, 1.14)), hot: lHot, skip: tau >= 0.98 };
  const MR: Orbit = { gx, gy, rx: rx * 0.88, ry: ry * 0.95, pos: mp, vel: mv, count: 4, dir: -1, item: (k) => ({ text: modeLabel(modeAt(k)), rtl: false }), px: px * 0.92, alpha: prog(tau, 1.0, 1.16) * (1 - prog(tau, 1.62, 1.76)), hot: mHot, skip: tau >= 1.62 };
  orbitRing(ctx, LR, false); orbitRing(ctx, MR, false);
  const pinA = prog(tau, 0.9, 1.1) * (1 - prog(tau, 3.7, 3.95));
  const pin = globe(ctx, gx, gy, R, lat, lon, L.code, prog(tau, 0.8, 1.0) * (1 - prog(tau, 3.7, 3.95)), t, pinA);
  burst(ctx, gx, gy + ry, tau - 0.94, n * 3 + 1, 16, narrow ? 110 : 150);
  burst(ctx, gx, gy + ry * 0.95, tau - 1.6, n * 3 + 2, 12, 100);
  orbitRing(ctx, LR, true); orbitRing(ctx, MR, true);
  // chosen labels fly up into the header
  const endA = 1 - prog(tau, 3.68, 3.86), hpx = narrow ? 15 : 16, hy = 20, mode = modeLabel(L.mode);
  const hs = headerSlots(ctx, L, mode, XC, hpx);
  if (tau >= 0.98 && endA > 0) {
    const p = E.io(prog(tau, 0.98, 1.32));
    ctx.save(); ctx.globalAlpha = endA;
    textOut(ctx, L.name, lerp(gx, hs.lx, p), lerp(gy + ry, hy, p) - Math.sin(Math.PI * p) * 10, nameFont(L, lerp(px, hpx, p), 700), acc(1), !!L.rtl, lerp(px, hpx, p) * 0.28 * (1 - p));
    ctx.restore();
  }
  if (tau >= 1.62 && endA > 0) {
    const p = E.io(prog(tau, 1.62, 1.94));
    ctx.save(); ctx.globalAlpha = endA;
    textOut(ctx, mode, lerp(gx, hs.mx, p), lerp(gy + ry * 0.95, hy, p) - Math.sin(Math.PI * p) * 10, f(lerp(px * 0.92, hpx, p), Math.round(lerp(700, 600, p))), mix(ACC, WHITE, p * 0.9), false, px * 0.26 * (1 - p));
    txt(ctx, '·', hs.dot, hy, f(hpx, 700), wht(0.35 * prog(tau, 1.85, 1.95)));
    ctx.restore();
  }
  // a quiet radio ripple from the region while you speak
  if (cam > 0.9 && pin.z > 0) {
    const lvl = voice(tau, i * 1.3, B19);
    for (let k = 0; k < 3; k++) {
      const ph = mod(t * 1.6 + k / 3, 1), r = 6 + ph * 34;
      ctx.strokeStyle = acc(0.5 * (1 - ph) * clamp(lvl * 1.6) * endA); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(pin.x, pin.y, r, -0.7, 0.7); ctx.stroke();
    }
  }
  ctx.save(); ctx.globalAlpha = endA;
  keyAndPill(ctx, XC, 153, narrow ? 0.78 : 0.85, t, tau, B19, i * 1.3, prog(tau, 1.76, 2.2), words.hotkey || '⌘');
  ctx.restore();
  speakAndLand(ctx, L, tau, B19, XC, 86, narrow, maxW, endA);
  vignette(ctx, w, h);
}

// ───────────────────────── player ─────────────────────────

export interface PromoPlayer {
  readonly element: HTMLElement;
  /** New words (the interface language or the hotkey changed): redraws once. */
  setWords(words: PromoWords): void;
  dispose(): void;
}

/**
 * The panel: a canvas the width of Home and 190 tall, drawn at the device's pixel ratio. It runs
 * its frame loop only while it can be seen — on screen (IntersectionObserver), in a visible window
 * (`document.hidden`: minimised, or hidden to the tray) — and never under reduced motion, where
 * it draws the poster frame once. At most 60 frames a second, whatever the display's rate.
 */
export function createPromoGlobe(words: PromoWords, label: string): PromoPlayer {
  const canvas = document.createElement('canvas');
  canvas.className = 'promo-canvas';
  const element = document.createElement('section');
  element.className = 'promo-globe';
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', label);
  element.append(canvas);
  const ctx = canvas.getContext('2d');
  const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let current = words, cssW = 0, dpr = 0, onScreen = false, raf = 0, last = 0, t = 0, disposed = false;

  const reduced = (): boolean => motion?.matches === true;
  const size = (): void => {
    // 0 until the card is laid out (and while Home is detached): nothing is drawn until it has a width.
    const w = Math.round(element.clientWidth), d = Math.min(3, window.devicePixelRatio || 1);
    if (w === cssW && d === dpr) return;
    cssW = w; dpr = d;
    canvas.width = Math.max(1, Math.round(w * d)); canvas.height = Math.round(H * d);
    mcache.clear();
  };
  const render = (): void => {
    if (!ctx || cssW < 240) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1;
    drawV19(ctx, cssW, H, reduced() ? POSTER : t, current);
  };
  const playing = (): boolean => !disposed && onScreen && !document.hidden && !reduced();
  const frame = (now: number): void => {
    raf = 0;
    if (!playing()) return;
    raf = requestAnimationFrame(frame);
    const dt = (now - last) / 1000;
    if (dt < 1 / 61) return; // a 120 Hz display draws every other frame
    last = now;
    t = (t + Math.min(0.1, dt)) % LOOP;
    render();
  };
  const update = (): void => {
    size();
    if (playing()) {
      if (raf === 0) { last = performance.now(); raf = requestAnimationFrame(frame); }
    } else {
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      render();
    }
  };

  const resize = new ResizeObserver(() => { size(); render(); });
  resize.observe(element);
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) onScreen = entry.isIntersecting;
    update();
  });
  seen.observe(element);
  document.addEventListener('visibilitychange', update);
  motion?.addEventListener('change', update);

  return {
    element,
    setWords(next) { current = next; mcache.clear(); render(); },
    dispose() {
      disposed = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      resize.disconnect(); seen.disconnect();
      document.removeEventListener('visibilitychange', update);
      motion?.removeEventListener('change', update);
    },
  };
}

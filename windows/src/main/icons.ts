// The three tray drawings, in two inks, generated rather than shipped as files.
//
// WHY GENERATED. macOS ships ONE 18x18 asset per drawing with template-rendering intent
// and the OS recolours it for light mode, dark mode and the highlighted menu. WINDOWS
// TRAY ICONS GET NO SUCH TREATMENT — the shell draws the bitmap exactly as given, so a
// dark-ink icon is invisible on a dark taskbar and a light-ink one is invisible on a
// light one. That is six PNGs, at four DPI sizes each, which as checked-in binaries are
// twenty-four files nobody can review in a diff and which will drift from each other.
//
// Drawn from a shared outline, they cannot drift: the ink is a parameter, the slash is
// the same slash, and a test can assert the light and dark variants differ in exactly
// the way they are supposed to.
//
// The glyph is Kotiba's own nib — the same subject as MenuBarNib on the Mac.

import { deflateSync } from 'node:zlib';

import type { TrayImage, TrayTheme } from './tray-state.js';
import { trayInkFor } from './tray-state.js';

/** The sizes Windows asks a tray icon for across the DPI settings people actually use. */
export const TRAY_ICON_SIZES: readonly number[] = [16, 20, 24, 32];

/** Coverage samples per axis inside one pixel. 4 means 16 samples; the edges read clean. */
const SUPERSAMPLE = 4;

type Point = readonly [number, number];

/**
 * The nib, in a unit square, tip down. One outline for all three drawings — `filled`
 * fills it, `nib` strokes it, `nib-slash` strokes it and rules a line across.
 */
const NIB: readonly Point[] = [
  [0.3, 0.1],
  [0.7, 0.1],
  [0.62, 0.6],
  [0.5, 0.93],
  [0.38, 0.6],
];

/** The vent hole and the slit that make a nib read as a nib rather than as an arrow. */
const VENT_CENTRE: Point = [0.5, 0.34];
const VENT_RADIUS = 0.055;
const SLIT_FROM: Point = [0.5, 0.4];
const SLIT_TO: Point = [0.5, 0.86];
const SLIT_WIDTH = 0.05;

const OUTLINE_WIDTH = 0.09;

const SLASH_FROM: Point = [0.14, 0.86];
const SLASH_TO: Point = [0.86, 0.14];
const SLASH_WIDTH = 0.1;
/** The gap knocked out around the slash so it reads as ON TOP of the nib, not through it. */
const SLASH_GAP = 0.2;

// ---------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------

function insidePolygon(polygon: readonly Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    const [ax, ay] = a;
    const [bx, by] = b;
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function distanceToSegment(x: number, y: number, from: Point, to: Point): number {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return Math.hypot(x - px, y - py);
}

function distanceToOutline(polygon: readonly Point[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    best = Math.min(best, distanceToSegment(x, y, a, b));
  }
  return best;
}

/** Whether a unit-square point is inked, for one drawing. */
function isInk(image: TrayImage, x: number, y: number): boolean {
  const nearSlash = distanceToSegment(x, y, SLASH_FROM, SLASH_TO);

  // The slash is drawn last and knocks a gap out of everything under it, so it stays
  // legible at 16 px where a slash drawn merely on top of a stroke turns into mud.
  if (image === 'nib-slash') {
    if (nearSlash <= SLASH_WIDTH / 2) return true;
    if (nearSlash <= SLASH_GAP / 2) return false;
  }

  const inVent = Math.hypot(x - VENT_CENTRE[0], y - VENT_CENTRE[1]) <= VENT_RADIUS;
  const inSlit = distanceToSegment(x, y, SLIT_FROM, SLIT_TO) <= SLIT_WIDTH / 2;

  if (image === 'nib-filled') {
    // Solid body, with the vent and the slit knocked out — otherwise a filled nib at
    // 16 px is an indistinct blob and the recording state stops being recognisable.
    if (inVent || inSlit) return false;
    return insidePolygon(NIB, x, y);
  }

  if (inVent || inSlit) return true;
  return distanceToOutline(NIB, x, y) <= OUTLINE_WIDTH / 2;
}

// ---------------------------------------------------------------------------------
// Rasterising
// ---------------------------------------------------------------------------------

function parseInk(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** RGBA rows, straight (un-premultiplied) alpha, which is what PNG stores. */
export function rasteriseTrayIcon(image: TrayImage, theme: TrayTheme, size: number): Buffer {
  const [r, g, b] = parseInk(trayInkFor(theme));
  const pixels = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          if (isInk(image, x, y)) hits += 1;
        }
      }
      const alpha = Math.round((hits / (SUPERSAMPLE * SUPERSAMPLE)) * 255);
      const at = (py * size + px) * 4;
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = b;
      pixels[at + 3] = alpha;
    }
  }

  return pixels;
}

// ---------------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** A minimal 8-bit RGBA PNG. Filter 0 on every row — these are tiny and incompressible-ish. */
export function encodePng(pixels: Buffer, size: number): Buffer {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** One drawing, one ink, one size, as PNG bytes. */
export function trayIconPng(image: TrayImage, theme: TrayTheme, size: number): Buffer {
  return encodePng(rasteriseTrayIcon(image, theme, size), size);
}

/** A `data:` URL, which is how `nativeImage.createFromDataURL` takes it. */
export function trayIconDataUrl(image: TrayImage, theme: TrayTheme, size: number): string {
  return `data:image/png;base64,${trayIconPng(image, theme, size).toString('base64')}`;
}

/**
 * How much of the icon is inked, 0…1. Not decorative: a drawing that rasterises to
 * nothing is INVISIBLE, and an invisible tray icon looks exactly like a crashed app. A
 * test holds every drawing above a floor, at every size, in both inks.
 */
export function inkCoverage(image: TrayImage, theme: TrayTheme, size: number): number {
  const pixels = rasteriseTrayIcon(image, theme, size);
  let total = 0;
  for (let i = 3; i < pixels.length; i += 4) total += pixels[i] ?? 0;
  return total / (size * size * 255);
}

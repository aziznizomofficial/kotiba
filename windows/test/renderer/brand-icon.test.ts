// The Windows brand mark is the Mac's app icon, byte for byte.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BRAND_ICON, BRAND_ICON_PNG_BASE64 } from '../../src/renderer/brand-icon.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('the brand mark', () => {
  it('is the app icon', () => {
    const icon = readFileSync(join(repo, 'Apps/macOS/Assets.xcassets/AppIcon.appiconset/icon_128x128.png'));
    expect(Buffer.from(BRAND_ICON_PNG_BASE64, 'base64').equals(icon)).toBe(true);
    expect(BRAND_ICON.startsWith('data:image/png;base64,')).toBe(true);
  });
});

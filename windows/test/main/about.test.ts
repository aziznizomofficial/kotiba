// Settings › About: the credits THIRD_PARTY_NOTICES.md owes, and the allow-list that decides
// which addresses the renderer may have opened in a browser.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_LINKS,
  LIBRARY_CREDITS,
  MODEL_CREDITS,
  NOTICES_URL,
  PARAKEET_ATTRIBUTION,
  SOURCE_URL,
  isAllowedExternalLink,
} from '../../src/main/about-model.js';
import { IPC_INVOKE } from '../../src/main/ipc.js';

const notices = readFileSync(join(__dirname, '../../../THIRD_PARTY_NOTICES.md'), 'utf8');
const indexSource = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8');
const controlSource = readFileSync(join(__dirname, '../../src/renderer/pages/control.ts'), 'utf8');

describe('the credits', () => {
  it('gives Parakeet the CC BY 4.0 attribution for the build Windows runs', () => {
    expect(PARAKEET_ATTRIBUTION).toContain('CC BY 4.0');
    expect(PARAKEET_ATTRIBUTION).toContain('moondream');
    expect(PARAKEET_ATTRIBUTION).toContain('parakeet-tdt-0.6b-v3');
    expect(PARAKEET_ATTRIBUTION).toContain('Olicorne');
    expect(PARAKEET_ATTRIBUTION).toContain('Changes were made');
    expect(MODEL_CREDITS[0]?.detail).toBe(PARAKEET_ATTRIBUTION);
  });

  it('credits every model the app runs, each with its licence', () => {
    const titles = MODEL_CREDITS.map((credit) => credit.title).join('\n');
    for (const needle of ['Parakeet Ultra — CC BY 4.0', 'uzbek_stt_v1) — Apache-2.0', 'Whisper — MIT', 'Qwen3-1.7B — Apache-2.0', 'Silero VAD — MIT']) {
      expect(titles).toContain(needle);
    }
    expect(MODEL_CREDITS.map((credit) => credit.detail).join('\n')).toContain('not affiliated with KotibAI');
  });

  it('points at the same sources THIRD_PARTY_NOTICES.md names', () => {
    for (const credit of [...MODEL_CREDITS, ...LIBRARY_CREDITS]) expect(notices).toContain(credit.link);
  });
});

describe('the link allow-list', () => {
  it('holds only https addresses, and all of the card’s', () => {
    for (const url of EXTERNAL_LINKS) expect(url.startsWith('https://')).toBe(true);
    expect(EXTERNAL_LINKS.has(SOURCE_URL)).toBe(true);
    expect(EXTERNAL_LINKS.has(NOTICES_URL)).toBe(true);
    for (const credit of [...MODEL_CREDITS, ...LIBRARY_CREDITS]) expect(isAllowedExternalLink(credit.link)).toBe(true);
  });

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'ms-settings:privacy-microphone',
    'javascript:alert(1)',
    'http://github.com/aziznizomofficial/kotiba',
    'HTTPS://github.com/aziznizomofficial/kotiba',
    'https://github.com/aziznizomofficial/kotiba#x',
    'https://github.com/aziznizomofficial/kotiba/../evil',
    'https://github.com.evil.example/aziznizomofficial/kotiba',
    'https://evil.example/',
    '',
  ])('refuses %j', (url) => {
    expect(isAllowedExternalLink(url)).toBe(false);
  });

  it('refuses what is not a string', () => {
    expect(isAllowedExternalLink(undefined)).toBe(false);
    expect(isAllowedExternalLink({ toString: () => SOURCE_URL })).toBe(false);
    expect(isAllowedExternalLink([SOURCE_URL])).toBe(false);
  });

  it('is enforced in main, in front of the only shell.openExternal a page can reach', () => {
    const handler = indexSource.slice(indexSource.indexOf('IPC_INVOKE.openExternal'));
    expect(handler.slice(0, 300)).toMatch(/if \(!isAllowedExternalLink\(url\)\) throw/u);
    // And the page actually uses the channel — a card with dead links is the old one.
    expect(controlSource).toContain('IPC_INVOKE.openExternal');
    expect(IPC_INVOKE.openExternal).toBe('app:open-external');
  });
});

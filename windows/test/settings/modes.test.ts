// The four modes, checked against the fixture t02's Swift generator produced by
// INVOKING the real `BuiltInModes` — not against anything retyped from a document.
//
// The prompts are the product. A reflow, a tidied-up example block or a hyphen where an
// em dash belongs changes what the model receives, and there is no way to notice
// afterwards except by reading the output next to a Mac's.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_MODE_ORDER,
  REGISTRY_DEFAULT_MODE_KEY,
  SELECTABLE_MODE_ORDER,
  SHIPPED_DEFAULT_MODE_KEY,
  modePolishes,
  type ModeKey,
} from '../../src/contracts/index.js';
import {
  WINDOWS_DEFAULT_SETTINGS,
  appTextFormats,
  builtInModeList,
  builtInModes,
  polishInstructions,
  promptContext,
  renderPrompt,
  selectableModes,
} from '../../src/core/settings/index.js';

interface GoldenMode {
  readonly key: ModeKey;
  readonly name: string;
  readonly prompt: string | null;
  readonly polishes: boolean;
  readonly autocapitalizeInsert: boolean;
  readonly restructures: boolean;
  readonly contextFromSelection: boolean;
  readonly contextFromClipboard: boolean;
  readonly contextFromActiveApplication: boolean;
  readonly language: string | null;
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../fixtures/golden/settings.json', import.meta.url)),
    'utf8',
  ),
) as { readonly modes: readonly GoldenMode[]; readonly textFormats: readonly string[] };

const goldenByKey = new Map(golden.modes.map((mode) => [mode.key, mode]));

describe('the built-in modes match the Swift fixture', () => {
  const modes = builtInModes();

  it('has exactly four, in the fixture order', () => {
    expect(builtInModeList().map((mode) => mode.key)).toEqual([...BUILT_IN_MODE_ORDER]);
    expect(golden.modes.map((mode) => mode.key)).toEqual([...BUILT_IN_MODE_ORDER]);
  });

  for (const key of BUILT_IN_MODE_ORDER) {
    describe(key, () => {
      const expected = goldenByKey.get(key);
      const actual = modes[key];

      it('reproduces the prompt byte for byte', () => {
        expect(expected).toBeDefined();
        expect(actual.prompt).toBe(expected?.prompt ?? null);
      });

      it('reproduces the flags', () => {
        expect({
          name: actual.name,
          language: actual.language,
          contextFromSelection: actual.contextFromSelection,
          contextFromClipboard: actual.contextFromClipboard,
          contextFromActiveApplication: actual.contextFromActiveApplication,
          autocapitalizeInsert: actual.autocapitalizeInsert,
          restructures: actual.restructures,
          polishes: modePolishes(actual),
        }).toEqual({
          name: expected?.name,
          language: expected?.language ?? null,
          contextFromSelection: expected?.contextFromSelection,
          contextFromClipboard: expected?.contextFromClipboard,
          contextFromActiveApplication: expected?.contextFromActiveApplication,
          autocapitalizeInsert: expected?.autocapitalizeInsert,
          restructures: expected?.restructures,
          polishes: expected?.polishes,
        });
      });
    });
  }

  it('carries none of the fields the Mac app never reads', () => {
    // `version`, `voiceModelID`, `polishModelID` and `unknownFields` are written,
    // tested and consulted by nothing. Reintroducing them would put a mode file format
    // into a port that has none.
    for (const mode of builtInModeList()) {
      const keys = Object.keys(mode);
      expect(keys).not.toContain('version');
      expect(keys).not.toContain('voiceModelID');
      expect(keys).not.toContain('polishModelID');
      expect(keys).not.toContain('unknownFields');
    }
  });

  // THE CAPITALISATION TRAP. The flag gates the deterministic sentence-capitaliser, a
  // different layer from anything the model is told — and the Uzbek model emits zero
  // capitals across 24 real dictations, so a mode with it off delivers every Uzbek
  // dictation in lower case. Super, the mode that keeps every word, has it too.
  it('sets autocapitalizeInsert on every mode, including the one that keeps every word', () => {
    expect(modes.super.prompt).toContain('Keep every word the speaker said');
    for (const mode of builtInModeList()) expect(mode.autocapitalizeInsert).toBe(true);
  });

  // The repository is public under MIT: every prompt it ships is this project's own. The
  // whole-dictation templates were rewritten on the Mac in 39ef0eb; these are phrases of
  // the retired wording, which must never come back through a stale copy on Windows.
  it('carries none of the retired template wording', () => {
    for (const mode of builtInModeList()) {
      for (const retired of ['dictation formatter', 'PRIMARY RULE', 'WRONG —', 'Your response must contain ONLY']) {
        expect(mode.prompt ?? '').not.toContain(retired);
      }
    }
  });

  it('leaves transcription prompt-less, which is the whole password defence', () => {
    expect(modes.transcription.prompt).toBeNull();
    expect(modePolishes(modes.transcription)).toBe(false);
    expect(modes.transcription.name).toBe('Raw');
  });
});

describe('the two default keys that disagree', () => {
  // Both macOS tests pass and they assert different answers: the registry says
  // "message", `defaultModeKey` says "super", and the controller overwrites the
  // registry one line after building it. Super is what ships.
  it('keeps both, and ships Super', () => {
    expect(REGISTRY_DEFAULT_MODE_KEY).toBe('message');
    expect(SHIPPED_DEFAULT_MODE_KEY).toBe('super');
    expect(WINDOWS_DEFAULT_SETTINGS.defaultModeKey).toBe('super');
  });

  it('matches the fixture on the registry key', () => {
    const raw = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../fixtures/golden/settings.json', import.meta.url)),
        'utf8',
      ),
    ) as { modeDefaultKeyInRegistry: string; defaults: { defaultModeKey: string } };
    expect(raw.modeDefaultKeyInRegistry).toBe('message');
    expect(raw.defaults.defaultModeKey).toBe('super');
  });
});

describe('the tray list', () => {
  it('is a different order from the settings list and omits transcription', () => {
    expect(selectableModes().map((mode) => mode.key)).toEqual([...SELECTABLE_MODE_ORDER]);
    expect(selectableModes().map((mode) => mode.key)).toEqual(['super', 'note', 'message']);
    expect(selectableModes().map((mode) => mode.key)).not.toContain('transcription');
  });
});

describe('the text-format table', () => {
  it('carries the same nine labels the fixture does', () => {
    const labels = Object.values(appTextFormats())
      .map((copy) => copy.label)
      .sort();
    expect(labels).toEqual([...golden.textFormats].sort());
  });

  it('renders appFormat as "<label>. <guidance>"', () => {
    const context = promptContext({
      appId: 'code',
      language: 'uz',
      datetime: '2026-08-19 12:34',
      locale: 'uz-UZ',
    });
    expect(context.appFormat).toBe(
      'source code. Source code or a code comment. Preserve identifiers exactly.',
    );
  });
});

describe('prompt rendering', () => {
  const context = promptContext({
    appId: 'telegram',
    appName: 'Telegram',
    language: 'uz',
    datetime: '2026-08-19 12:34',
    locale: 'uz-UZ',
    user: 'Aziz',
    field: '',
    names: [],
  });

  it('substitutes the twelve known variables', () => {
    expect(renderPrompt('{{language}} into {{app}}', context)).toBe('uz into Telegram');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderPrompt('{{  language  }}', context)).toBe('uz');
  });

  it('cannot fail on an unclosed placeholder — it copies the rest verbatim', () => {
    expect(renderPrompt('before {{language', context)).toBe('before {{language');
  });

  it('renders the transcript empty, because it goes to the model as the user turn', () => {
    expect(context.transcript).toBe('');
    expect(renderPrompt('[{{transcript}}]', context)).toBe('[]');
  });

  it('renders window empty, because nothing anywhere produces one', () => {
    expect(renderPrompt('[{{window}}]', context)).toBe('[]');
  });

  it('uses the fallback strings that appear in every real prompt', () => {
    expect(context.field).toBe('an unnamed field');
    expect(context.names).toBe('none visible');
    expect(
      promptContext({ appId: null, language: 'en', datetime: '', locale: '' }).app,
    ).toBe('an unknown application');
    expect(promptContext({ appId: null, language: 'en', datetime: '', locale: '' }).user).toBe(
      'the speaker',
    );
  });

  it('returns null instructions for the prompt-less mode', () => {
    const modes = builtInModes();
    expect(polishInstructions({ mode: modes.transcription, context })).toBeNull();
    expect(polishInstructions({ mode: modes.super, context })).toContain('Your only edits');
  });

  it('leaves no placeholder behind in a fully rendered prompt', () => {
    const rendered = polishInstructions({ mode: builtInModes().note, context });
    expect(rendered).not.toBeNull();
    expect(rendered).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
  });
});

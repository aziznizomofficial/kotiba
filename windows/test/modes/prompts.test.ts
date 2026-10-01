// The per-sentence prompts, byte for byte against the Swift.
//
// `fixtures/golden/modes.json` → `prompts` is written by `kotiba-golden`, which CALLS
// `OnDeviceModes.superPrompt`, `.messagePrompt`, `.noteClassifierPrompt` and `.headingPrompt`
// for every language (and reads `droppable` and `superModelLanguages`). Windows sends the same
// Qwen3-1.7B GGUF these strings as ChatML turns, so one character that differs here is a
// different model output on Windows than on the Mac — with no test anywhere else to notice.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LANGUAGES, type Language } from '../../src/contracts/index.js';
import {
  DROPPABLE,
  MESSAGE_BY_PROJECTION,
  SUPER_TAIL_CAP_MS,
  SUPER_MODEL_LANGUAGES,
  trimOpeners,
  headingPrompt,
  messagePrompt,
  noteClassifierPrompt,
  promptName,
  renderPrompt,
  superPrompt,
  type PolishPrompt,
} from '../../src/core/modes/index.js';
import { chatML } from '../../src/polish/llama.js';

interface GoldenPrompt {
  readonly system: string;
  readonly examples: readonly { readonly input: string; readonly output: string }[];
  readonly rendered: string;
}

interface GoldenLanguagePrompts {
  readonly promptName: string;
  readonly super: GoldenPrompt;
  readonly message: GoldenPrompt;
  readonly noteClassifier: GoldenPrompt;
  readonly heading: GoldenPrompt;
  readonly droppable: readonly string[];
  readonly superUsesModel: boolean;
  readonly messageByProjection: boolean;
  readonly superTailCapMs: number | null;
}

const golden = JSON.parse(readFileSync(join(__dirname, '../../fixtures/golden/modes.json'), 'utf8')) as {
  readonly prompts: Readonly<Record<Language, GoldenLanguagePrompts>>;
  readonly openers: readonly { readonly in: string; readonly out: Readonly<Record<Language, string>> }[];
};

const BUILDERS: readonly [keyof GoldenLanguagePrompts & ('super' | 'message' | 'noteClassifier' | 'heading'), (language: Language) => PolishPrompt][] = [
  ['super', superPrompt],
  ['message', messagePrompt],
  ['noteClassifier', noteClassifierPrompt],
  ['heading', headingPrompt],
];

describe('modes.json — the per-sentence prompts', () => {
  it('covers exactly the three languages', () => {
    expect(Object.keys(golden.prompts).sort()).toEqual([...LANGUAGES].sort());
  });

  for (const language of LANGUAGES) {
    describe(language, () => {
      const expected = golden.prompts[language];

      it('names the language as the Mac does', () => {
        expect(promptName(language)).toBe(expected.promptName);
      });

      for (const [key, build] of BUILDERS) {
        it(`${key}: system, examples and rendered text`, () => {
          const actual = build(language);
          expect(actual.system).toBe(expected[key].system);
          expect(actual.examples.map((each) => ({ input: each.input, output: each.output }))).toEqual(expected[key].examples);
          expect(renderPrompt(actual)).toBe(expected[key].rendered);
        });

        it(`${key}: the ChatML head the model tokenises`, () => {
          // What `LlamaPolisher` actually sends, built from the fixture's own strings — so a
          // difference in turn layout, not only in wording, fails here too.
          const fromFixture: PolishPrompt = { system: expected[key].system, examples: expected[key].examples };
          expect(chatML(build(language))).toBe(chatML(fromFixture));
        });
      }

      it('may drop exactly the Mac’s words in Message', () => {
        expect([...DROPPABLE[language]].sort()).toEqual([...expected.droppable].sort());
      });

      it('asks the model to punctuate in Super exactly where the Mac does', () => {
        expect(SUPER_MODEL_LANGUAGES.has(language)).toBe(expected.superUsesModel);
      });

      it('projects Message onto the speaker’s words exactly where the Mac does (C4 §14.5)', () => {
        expect(MESSAGE_BY_PROJECTION.has(language)).toBe(expected.messageByProjection);
      });

      it('caps Super’s wait after release exactly where the Mac does (C4 §14.4)', () => {
        expect(SUPER_TAIL_CAP_MS[language] ?? null).toBe(expected.superTailCapMs);
      });
    });
  }
});

describe('modes.json — Message openers (C4 §14.5)', () => {
  it('trims sentence-initial openers exactly as the Mac does, in every language', () => {
    expect(golden.openers.length).toBeGreaterThan(5);
    for (const row of golden.openers) {
      for (const language of LANGUAGES) {
        expect({ in: row.in, language, out: trimOpeners(row.in, language) }).toEqual({ in: row.in, language, out: row.out[language] });
      }
    }
  });
});

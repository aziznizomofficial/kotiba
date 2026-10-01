// Incremental polish and the built-in modes as a polisher, against a fake model.
//
// The deterministic outputs are pinned byte-for-byte by `test/modes/golden.test.ts`; the
// model's outputs are compared with the Mac's by `scripts/measure/modes-compare.mjs`. What
// is asserted here is the orchestration C3 names as load-bearing: per-sentence fallback,
// one engine in order, the tail deadline, and which languages ask the model at all.

import { describe as suite, expect, test } from 'vitest';

import type { Language } from '../../src/contracts/index.js';
import { builtInModes } from '../../src/core/settings/index.js';
import type { PolishPrompt } from '../../src/core/modes/index.js';
import { messagePrompt, noteClassifierPrompt, superPrompt } from '../../src/core/modes/index.js';
import { chatML, turn } from '../../src/polish/llama.js';
import {
  IncrementalPolish,
  ModePolisher,
  createOnDevicePolishChain,
  type PromptedPolisher,
} from '../../src/polish/index.js';
import { isIncrementalPolisher } from '../../src/session/ports.js';

class FakeModel implements PromptedPolisher {
  readonly id = 'fake-llm';
  readonly supportedLanguages: ReadonlySet<Language> = new Set<Language>(['en', 'ru', 'uz']);
  readonly calls: { text: string; system: string }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  prepared: PolishPrompt[][] = [];
  constructor(
    private readonly answer: (text: string, prompt: PolishPrompt) => string | Error,
    private readonly delayMs = 0,
  ) {}
  async prepare(prompts: readonly PolishPrompt[]): Promise<void> {
    this.prepared.push([...prompts]);
  }
  async generate(text: string, _language: Language, prompt: PolishPrompt, _max: number, signal: AbortSignal): Promise<string> {
    this.calls.push({ text, system: prompt.system });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (signal.aborted) throw new Error('cancelled');
      const out = this.answer(text, prompt);
      if (out instanceof Error) throw out;
      return out;
    } finally {
      this.inFlight -= 1;
    }
  }
}

suite('which modes ask the model', () => {
  test('Super asks only for Uzbek; English and Russian cost nothing after release', async () => {
    const model = new FakeModel((text) => text);
    for (const language of ['en', 'ru'] as const) {
      const session = new IncrementalPolish({ behaviour: 'super', language, engine: model });
      expect(session.prompts).toEqual([]);
      await session.finish('One sentence here. Another sentence there.');
    }
    expect(model.calls).toEqual([]);
    const uzbek = new IncrementalPolish({ behaviour: 'super', language: 'uz', engine: model });
    expect(uzbek.prompts).toEqual([superPrompt('uz')]);
  });

  test('Super keeps only the model\'s punctuation and case — a changed word never lands', async () => {
    const model = new FakeModel(() => 'Xoʻp, qarang, buvim bozorga ketdilar.');
    const session = new IncrementalPolish({ behaviour: 'super', language: 'uz', engine: model });
    const outcome = await session.finish('xoʻp qarang buvim bozorga ketdilar');
    expect(outcome.text).toBe('Xoʻp, qarang, buvim bozorga ketdilar.');
    const invented = new IncrementalPolish({
      behaviour: 'super',
      language: 'uz',
      engine: new FakeModel(() => 'Umuman boshqa gap yozildi bu yerda.'),
    });
    const refused = await invented.finish('xoʻp qarang buvim bozorga ketdilar');
    expect(refused.text).toBe('xoʻp qarang buvim bozorga ketdilar');
    expect(refused.notes[0]).toMatch(/^super: model rewrote a sentence \(\d+% aligned\); kept as spoken$/);
  });

  test('Raw never asks, and never changes a character', async () => {
    const model = new FakeModel(() => 'something else');
    const outcome = await new IncrementalPolish({ behaviour: 'raw', language: 'en', engine: model }).finish('um so yes');
    expect(outcome.text).toBe('um so yes');
    expect(model.calls).toEqual([]);
  });
});

suite('per-sentence fallback and order', () => {
  test('a rewrite the guard refuses costs that sentence alone', async () => {
    const model = new FakeModel((text) =>
      text.startsWith('Apply') ? 'Apply the price increase to all students.' : 'Keep only Telegram.',
    );
    const session = new IncrementalPolish({ behaviour: 'message', language: 'en', engine: model });
    const outcome = await session.finish('Yes, so keep only telegram. Apply the price added to all students.');
    expect(outcome.text).toBe('Keep only Telegram. Apply the price added to all students.');
    expect(outcome.modelSentences).toBe(1);
    expect(outcome.notes).toHaveLength(1);
    expect(outcome.notes[0]).toMatch(/^message: polish deleted words the speaker said «added»; kept as spoken$/);
  });

  test('a model that throws costs that sentence alone, and says which model', async () => {
    const model = new FakeModel((text) => (text.includes('second') ? new Error('decode failed') : text));
    const outcome = await new IncrementalPolish({ behaviour: 'message', language: 'en', engine: model }).finish(
      'This is the first one. This is the second one.',
    );
    expect(outcome.text).toBe('This is the first one. This is the second one.');
    expect(outcome.notes).toEqual(['message: fake-llm failed: decode failed']);
  });

  test('one generation at a time, in commit order', async () => {
    const model = new FakeModel((text) => text, 5);
    const session = new IncrementalPolish({ behaviour: 'message', language: 'en', engine: model });
    session.commit('The first sentence is here. The second sentence is here. ');
    session.commit('The third sentence is here. ');
    await session.finish('And the fourth one arrives.');
    expect(model.maxInFlight).toBe(1);
    expect(model.calls.map((call) => call.text)).toEqual([
      'The first sentence is here.',
      'The second sentence is here.',
      'The third sentence is here.',
      'And the fourth one arrives.',
    ]);
  });

  test('the tail deadline: a slow sentence goes in as spoken, and finish does not wait for it', async () => {
    const model = new FakeModel((text) => text.toUpperCase(), 200);
    const session = new IncrementalPolish({ behaviour: 'message', language: 'en', engine: model });
    const started = performance.now();
    const outcome = await session.finish('This sentence is far too slow.', 30);
    expect(performance.now() - started).toBeLessThan(150);
    expect(outcome.text).toBe('This sentence is far too slow.');
    expect(outcome.notes).toEqual(['sentence not polished within 0.03 seconds; kept as spoken']);
  });

  test('committed sentences are polished DURING the hold; finish is left with the tail', async () => {
    const model = new FakeModel((text) => text, 5);
    const session = new IncrementalPolish({ behaviour: 'message', language: 'en', engine: model });
    session.commit('We bought the seeds yesterday. We plant them on Friday. ');
    await session.idle();
    expect(model.calls).toHaveLength(2);
    const outcome = await session.finish('Then we water them.');
    expect(model.calls).toHaveLength(3);
    expect(outcome.sentences).toBe(3);
  });
});

suite('Note', () => {
  test('the model only labels; the layout is built from the speaker\'s words', async () => {
    const model = new FakeModel((text, prompt) =>
      prompt.system.startsWith('You sort') ? (text.startsWith('Remember') ? 'TASK' : 'POINT') : 'Roses and mulch',
    );
    const outcome = await new IncrementalPolish({ behaviour: 'note', language: 'en', engine: model }).finish(
      'The roses bloomed early. Remember to order mulch. Can you do it yourself?',
    );
    expect(outcome.text).toBe('## Roses and mulch\n\nThe roses bloomed early.\n\n- [ ] Order mulch\n\nCan you do it yourself?');
  });

  test('a heading made of words nobody said is dropped', async () => {
    const model = new FakeModel((_text, prompt) => (prompt.system.startsWith('You sort') ? 'POINT' : 'Quarterly pricing review'));
    const outcome = await new IncrementalPolish({ behaviour: 'note', language: 'en', engine: model }).finish(
      'The roses bloomed early. The fence needs paint.',
    );
    expect(outcome.text).toBe('The roses bloomed early. The fence needs paint.');
  });

  test('key-down prefill asks for the classifier AND the heading prompt', async () => {
    const model = new FakeModel((text) => text);
    await new IncrementalPolish({ behaviour: 'note', language: 'ru', engine: model }).prepare();
    expect(model.prepared[0]?.[0]).toEqual(noteClassifierPrompt('ru'));
    expect(model.prepared[0]).toHaveLength(2);
  });
});

suite('ModePolisher and the chain', () => {
  test('is an incremental polisher, claims every language, and names its model', () => {
    const polisher = new ModePolisher({ behaviour: 'message', engine: new FakeModel((text) => text) });
    expect(isIncrementalPolisher(polisher)).toBe(true);
    expect([...polisher.supportedLanguages].sort()).toEqual(['ar', 'en', 'ru', 'tr', 'uz']);
    expect(polisher.id).toBe('message+fake-llm');
    expect(new ModePolisher({ behaviour: 'super', engine: null }).id).toBe('super+rules');
  });

  test('notes from both paths are drained once', async () => {
    const polisher = new ModePolisher({ behaviour: 'message', engine: new FakeModel(() => new Error('boom')) });
    await polisher.polish('This is a sentence to rewrite.', 'en', 'ignored');
    expect(await polisher.drainNotes()).toEqual(['message: fake-llm failed: boom']);
    expect(await polisher.drainNotes()).toEqual([]);
  });

  test('the chain: built-in modes get a ModePolisher, Raw gets nothing, the model only when asked for', () => {
    const modes = builtInModes();
    const model = new FakeModel((text) => text);
    const chain = createOnDevicePolishChain({ model: () => model });
    const settings = { preferOnDeviceModel: true } as never;
    const message = chain({ mode: modes.message, settings, apiKey: null });
    expect(message.polisher?.id).toBe('message+fake-llm');
    expect(message.notConfigured).toBe(false);
    expect(chain({ mode: modes.transcription, settings, apiKey: null }).polisher).toBeNull();
    const off = chain({ mode: modes.super, settings: { preferOnDeviceModel: false } as never, apiKey: null });
    expect(off.polisher?.id).toBe('super+rules');
    const noModel = createOnDevicePolishChain({ model: () => null })({ mode: modes.note, settings, apiKey: null });
    expect(noModel.polisher?.id).toBe('note+rules');
  });
});

suite('the prompt the GGUF receives', () => {
  test('ChatML with the examples as real turns, and thinking switched off', () => {
    const prompt = messagePrompt('en');
    const head = chatML(prompt);
    expect(head.startsWith(`<|im_start|>system\n${prompt.system}<|im_end|>\n<|im_start|>user\n`)).toBe(true);
    expect(head.split('<|im_start|>assistant\n').length - 1).toBe(prompt.examples.length);
    expect(turn('hi')).toBe('<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n');
  });
});

// wip/cleanup-fix: the clean-up may drop fillers and true stutters and apply unambiguous
// spoken commands, but never delete or rewrite what was said. The golden suite pins these
// byte for byte against the Swift; this file says, rule by rule, why each output is right —
// the same cases as `DictationCleanupTests` on the Mac.

import { describe, expect, it } from 'vitest';

import { cleanUp } from '../../src/core/modes/index.js';

const en = (text: string): string => cleanUp(text, 'en');
const ru = (text: string): string => cleanUp(text, 'ru');

describe('cleanUp never deletes or rewrites real content', () => {
  it('keeps a doubled name or reduplicated word, even opening the sentence', () => {
    expect(en('Bora Bora is lovely')).toBe('Bora Bora is lovely.');
    expect(en('Walla Walla, Washington')).toBe('Walla Walla, Washington.');
    expect(en('the train goes choo choo')).toBe('the train goes choo choo.');
    expect(en('a salad salad, not a fruit salad')).toBe('a salad salad, not a fruit salad.');
    expect(en('I gave her her keys')).toBe('I gave her her keys.');
    expect(ru('белый белый снег')).toBe('белый белый снег.');
    // Function-word stutters still collapse, at a line start too.
    expect(en('first line\nThe The band')).toBe('first line\nThe band');
    expect(ru('в в доме')).toBe('в доме');
  });

  it('keeps a particle doubled after its verb, collapses one opening a clause', () => {
    expect(en('I will sign in in the morning')).toBe('I will sign in in the morning.');
    expect(en('Also, in in the garden it grew')).toBe('Also, in the garden it grew.');
  });

  it('reads a command with nothing before it, or after a determiner, as speech', () => {
    expect(en('full stop, and more')).toBe('full stop, and more.');
    expect(en('new line hello there')).toBe('new line hello there.');
    expect(en('first item\nfull stop here')).toBe('first item\nfull stop here.');
    expect(en('the car came to a full stop and waited')).toBe(
      'the car came to a full stop and waited.',
    );
    expect(en('put a question mark there')).toBe('put a question mark there.');
    expect(en('Dear Sam. New line. Thanks for the seeds')).toBe('Dear Sam.\nThanks for the seeds.');
    expect(en('one full stop two full stop three')).toBe('one. Two. Three.');
  });

  it('reads a command the transcriber capitalised as a name', () => {
    expect(en('visit New Line Cinema today')).toBe('visit New Line Cinema today.');
    expect(en('The New Line opened')).toBe('The New Line opened.');
  });

  it('keeps the capital of a common word inside a name, not of a stray one before it', () => {
    expect(en('we moved to New York last year')).toBe('we moved to New York last year.');
    expect(en('we read Lord Of The Rings')).toBe('we read Lord Of The Rings.');
    expect(en('and Then Maria came')).toBe('and then Maria came.');
  });
});

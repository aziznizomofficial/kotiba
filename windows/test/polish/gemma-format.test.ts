// The Mac's `LlamaEngine.ChatFormat` (C4 §14.5): Arabic's modes model is Gemma 4, written in its
// own turns; every other GGUF here is ChatML.

import { describe, expect, it } from 'vitest';

import { chatFormat, gemma4, gemma4Turn } from '../../src/polish/llama.js';

describe('chat format by architecture', () => {
  it('reads Gemma 4 from general.architecture, ChatML otherwise', () => {
    expect(chatFormat('gemma4')).toBe('gemma4');
    expect(chatFormat('qwen3')).toBe('chatML');
    expect(chatFormat('')).toBe('chatML');
  });

  it('writes the system turn, examples as turns, and opens the model turn', () => {
    expect(gemma4({ system: 'S', examples: [{ input: 'in', output: 'out' }] })).toBe(
      '<bos><|turn>system\nS<turn|>\n<|turn>user\nin<turn|>\n<|turn>model\nout<turn|>\n',
    );
    expect(gemma4Turn('x')).toBe('<|turn>user\nx<turn|>\n<|turn>model\n');
  });
});

// Parakeet's decoder, as arithmetic: the greedy TDT loop, the vocabulary, the text, and the
// language the text is written in. PURE — the ONNX sessions that produce the numbers live
// in `src/engines/parakeet.ts`, which hands this module one decoder step at a time.
//
// PORTED FROM onnx-asr (istupakov/onnx-asr 0.12, MIT: `asr.py` `_AsrWithTransducerDecoding`
// and `models/nemo.py` `NemoConformerTdt`), which is the pipeline C1 §8 measured at
// 5.8 % en / 7.3 % ru on ONNX Runtime with these exact weights — NOT sherpa-onnx's Parakeet
// path, which the same measurement put 3–4 points worse. Every branch below is that code's
// branch, and the order of the three `t` updates is the one place a port goes quietly wrong:
//
//     token != blank  → keep the new decoder state, emit the token
//     duration > 0    → jump that many frames (TDT's whole point)
//     else if blank, or 10 symbols on this frame → one frame
//
// A duration-0 non-blank token therefore stays on the frame, which is how TDT emits several
// tokens for one encoder frame, and the per-frame cap is what stops that looping forever.

/** The per-frame symbol cap (`max_tokens_per_step`, onnx-asr's default for NeMo TDT). */
export const MAX_SYMBOLS_PER_FRAME = 10;

/** One decoder-joint call's answer: token logits, then duration logits, in one vector. */
export interface TdtStep<S> {
  /** `vocabSize` token logits followed by the duration logits (Parakeet v3: 5, durations 0–4). */
  readonly output: ArrayLike<number>;
  /** The prediction network's state after consuming the previous token. */
  readonly state: S;
}

export interface TdtDecoder<S> {
  readonly frames: number;
  readonly vocabSize: number;
  readonly blank: number;
  initialState(): S;
  /** Run the decoder-joint on encoder frame `frame`, conditioned on `previous` and `state`. */
  step(frame: number, previous: number, state: S): Promise<TdtStep<S>>;
}

/** `numpy.argmax`: the FIRST index of the maximum. */
export function argmax(values: ArrayLike<number>, start = 0, end = values.length): number {
  let best = start;
  let bestValue = values[start] ?? -Infinity;
  for (let i = start + 1; i < end; i += 1) {
    const value = values[i]!;
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best - start;
}

/** `argmax` over `[0, end)` skipping every index `suppressed` marks (1). */
function argmaxAllowed(values: ArrayLike<number>, end: number, suppressed: Uint8Array): number {
  let best = -1;
  let bestValue = -Infinity;
  for (let i = 0; i < end; i += 1) {
    if (suppressed[i] === 1) continue;
    const value = values[i]!;
    if (best < 0 || value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best < 0 ? 0 : best;
}

/**
 * Greedy TDT over one utterance. Returns token ids, blank never among them.
 *
 * `suppressed` (one byte per vocabulary id, 1 = never emit) holds the decoder to one script —
 * the language decision's respelling (P4, `scriptSuppression`). The duration head is untouched,
 * and so is the blank: a frame the model would have spent on a forbidden piece is spent on the
 * best allowed one, which is how the same audio comes back in the decided language's letters.
 */
export async function greedyTdt<S>(
  decoder: TdtDecoder<S>,
  maxSymbolsPerFrame = MAX_SYMBOLS_PER_FRAME,
  suppressed: Uint8Array | null = null,
): Promise<number[]> {
  let state = decoder.initialState();
  const tokens: number[] = [];
  let t = 0;
  let emitted = 0;
  while (t < decoder.frames) {
    const previous = tokens.length > 0 ? tokens[tokens.length - 1]! : decoder.blank;
    const { output, state: next } = await decoder.step(t, previous, state);
    const token = suppressed === null ? argmax(output, 0, decoder.vocabSize) : argmaxAllowed(output, decoder.vocabSize, suppressed);
    const duration = argmax(output, decoder.vocabSize, output.length);

    if (token !== decoder.blank) {
      state = next;
      tokens.push(token);
      emitted += 1;
    }
    if (duration > 0) {
      t += duration;
      emitted = 0;
    } else if (token === decoder.blank || emitted === maxSymbolsPerFrame) {
      t += 1;
      emitted = 0;
    }
  }
  return tokens;
}

export interface Vocabulary {
  /** id → piece, with SentencePiece's `▁` already turned into a space. */
  readonly pieces: readonly string[];
  readonly size: number;
  readonly blank: number;
}

/** `vocab.txt`: one `piece id` per line; `<blk>` is the blank. */
export function parseVocabulary(text: string): Vocabulary {
  const pieces: string[] = [];
  let blank = -1;
  let size = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const cut = line.lastIndexOf(' ');
    if (cut <= 0) continue;
    const piece = line.slice(0, cut);
    const id = Number(line.slice(cut + 1));
    if (!Number.isInteger(id) || id < 0) continue;
    pieces[id] = piece.split('▁').join(' ');
    if (piece === '<blk>') blank = id;
    size += 1;
  }
  if (blank < 0) throw new Error('vocab.txt has no <blk> entry');
  return { pieces, size, blank };
}

/**
 * `<unk>`, `<pad>` and the `<|…|>` control tokens never belong in text. The one deliberate
 * difference from onnx-asr, which joins whatever the decoder emits: on FLEURS the decoder
 * emitted `<unk>` once in 400 utterances ("exhale<unk> that is"), and a user must never
 * see that pasted into their document.
 */
function isSpecialPiece(piece: string): boolean {
  return piece === '<unk>' || piece === '<pad>' || (piece.startsWith('<|') && piece.endsWith('|>'));
}

/** Python's `\w` for `str` patterns: letters, digits (any `N`), underscore. */
const PY_WORD = /^[\p{L}\p{N}_]$/u;
const PY_SPACE = /^\s$/u;

/**
 * Pieces into text, exactly as onnx-asr does it: join, then
 * `re.sub(r"\A\s|\s\B|(\s)\b", lambda m: " " if m.group(1) else "", text)`.
 *
 * Written out rather than as a JavaScript regex because JavaScript's `\b` is ASCII-only even
 * with the `u` flag, and Python's is Unicode: a space before a Cyrillic word would be
 * dropped, and every Russian transcript would come back run together.
 */
export function piecesToText(ids: readonly number[], vocabulary: Vocabulary): string {
  const joined = [
    ...ids
      .map((id) => vocabulary.pieces[id] ?? '')
      .filter((piece) => !isSpecialPiece(piece))
      .join(''),
  ];
  let out = '';
  for (let i = 0; i < joined.length; i += 1) {
    const ch = joined[i]!;
    if (!PY_SPACE.test(ch)) {
      out += ch;
      continue;
    }
    if (i === 0) continue; // \A\s
    const next = joined[i + 1];
    // After a space (a non-word character) a boundary means a word character follows.
    if (next !== undefined && PY_WORD.test(next)) out += ' '; // (\s)\b
    // otherwise \s\B: dropped
  }
  return out;
}

export type WrittenLanguage = 'en' | 'ru';

/**
 * Which of its two languages the model actually wrote: whichever script has more letters.
 * The decoder chooses English or Russian per token, so the transcript reports what came
 * out and the session takes that over the router's en/ru guess (a pin still wins).
 * Majority rather than "any Cyrillic": Russian carrying "deploy" is still Russian. Text
 * with no letters says nothing and keeps what was asked for.
 */
export function writtenLanguage<L extends string>(text: string, requested: L): L | WrittenLanguage {
  let latin = 0;
  let cyrillic = 0;
  for (const ch of text) {
    const scalar = ch.codePointAt(0) ?? 0;
    if ((scalar >= 0x41 && scalar <= 0x5a) || (scalar >= 0x61 && scalar <= 0x7a)) latin += 1;
    else if (scalar >= 0x0400 && scalar <= 0x04ff) cyrillic += 1;
  }
  if (latin === 0 && cyrillic === 0) return requested;
  return cyrillic > latin ? 'ru' : 'en';
}

/**
 * The vocabulary pieces a decode held to `language`'s script may not emit (P4's respelling, the
 * Windows twin of FluidAudio's token-language filter): for English every piece holding a Cyrillic
 * letter (U+0400–04FF), for Russian every piece holding a Latin one (A–Z a–z) — the same two
 * classes `writtenLanguage` and the policy's `needsRespelling` count. Punctuation, digits, the
 * word-boundary piece and the blank stay allowed in both. One byte per id, 1 = suppressed.
 */
export function scriptSuppression(vocabulary: Vocabulary, language: WrittenLanguage): Uint8Array {
  const out = new Uint8Array(vocabulary.size);
  for (let id = 0; id < vocabulary.size; id += 1) {
    if (id === vocabulary.blank) continue;
    const piece = vocabulary.pieces[id] ?? '';
    for (const character of piece) {
      const scalar = character.codePointAt(0) ?? 0;
      const latin = (scalar >= 0x41 && scalar <= 0x5a) || (scalar >= 0x61 && scalar <= 0x7a);
      const cyrillic = scalar >= 0x0400 && scalar <= 0x04ff;
      if ((language === 'en' && cyrillic) || (language === 'ru' && latin)) {
        out[id] = 1;
        break;
      }
    }
  }
  return out;
}

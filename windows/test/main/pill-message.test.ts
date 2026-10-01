// The owner saw a long failure sentence spill out of the 160 × 36 pill. What holds it now:
// every message the pill can say is a few words in each of the four languages, and each one
// fits the capsule `fitPillMessage` computes — one line or two, never a word cut in half,
// never wider than the pill may grow. The Mac's PillMessageTests.
//
// There is no canvas here, so the text is measured with a table of Segoe UI 12 px advance
// widths rounded UP and then padded by 8 %: a message that fits by this ruler fits on screen.

import { describe, expect, it } from 'vitest';

import type { DictationError } from '../../src/contracts/index.js';
import { dictationError, dictationErrorHeadline } from '../../src/contracts/index.js';
import { APP_LANGUAGES, CATALOGS, setAppLanguage } from '../../src/core/i18n/index.js';
import type { MessageKey } from '../../src/core/i18n/index.js';
import { quietMicPillName } from '../../src/core/input-device/index.js';
import {
  PILL_HEIGHT,
  PILL_MAX_MESSAGE_WIDTH,
  PILL_MESSAGE,
  PILL_MESSAGE_CHROME,
  PILL_WIDTH,
  fitPillMessage,
  lineCount,
  pillMaxMessageWidth,
  widestWord,
} from '../../src/main/pill-model.js';

const WIDE = new Set('mwMWшщжмюыфШЩЖМЮЫФДЦ—%@');
const NARROW = new Set('iljtfrI.,:;!ʻʼ’\'«»()|');

/** A generous 12 px medium advance: wider than Segoe UI's for every glyph class. */
function measure(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === ' ') width += 3.4;
    else if (WIDE.has(ch)) width += 10.5;
    else if (NARROW.has(ch)) width += 3.9;
    else if (ch !== ch.toLowerCase()) width += 8.4;
    else width += 7.0;
  }
  return width * 1.08;
}

const KEYS = (Object.keys(CATALOGS.en) as MessageKey[]).filter(
  (key) => key === 'pill.heardNothing' || key === 'pill.quietMic' || key.startsWith('pill.failed.'),
);

/** The widest name the pill ever prints (`quietMicPillName`: two words, 14 characters), not "{device}". */
const WORST_DEVICE = quietMicPillName('Wwwwwwwwwww Wwwwwwwwwww');

/** A catalog message as the pill prints it. */
function said(language: (typeof APP_LANGUAGES)[number], key: MessageKey): string {
  return CATALOGS[language][key].replaceAll('{device}', WORST_DEVICE);
}

describe('pill messages', () => {
  it('cover every way a dictation can end badly, and never carry the reason', () => {
    expect(KEYS).toEqual(
      expect.arrayContaining([
        'pill.heardNothing',
        'pill.quietMic',
        'pill.failed.generic',
        'pill.failed.microphone',
        'pill.failed.recording',
        'pill.failed.transcription',
        'pill.failed.paste',
        'pill.failed.pasteTimedOut',
        'pill.failed.englishNotReady',
        'pill.failed.noRussianModel',
        'pill.failed.noUzbekModel',
      ]),
    );
    const failures: DictationError[] = [
      dictationError.armingFailed('REASON'),
      dictationError.captureFailed('REASON'),
      dictationError.noEngineReady('unified', 'en'),
      dictationError.noEngineReady('unified', 'ru'),
      dictationError.noEngineReady('uzbek', 'uz'),
      dictationError.transcriptionFailed('REASON'),
      dictationError.insertionRefused('REASON'),
      dictationError.insertionTimedOut(),
    ];
    for (const language of APP_LANGUAGES) {
      setAppLanguage(language);
      const headlines = failures.map(dictationErrorHeadline);
      expect(new Set(headlines).size).toBe(failures.length);
      for (const [index, headline] of headlines.entries()) {
        expect(headline).not.toContain('REASON');
        expect(headline).not.toBe(failures[index]?.message);
      }
    }
    setAppLanguage('en');
  });

  it('are a glance, not a report: at most six words and 40 characters in every language', () => {
    for (const language of APP_LANGUAGES) {
      for (const key of KEYS) {
        const text = said(language, key);
        expect(text.split(/\s+/u).filter((word) => word !== '—').length, `${key} [${language}]: ${text}`).toBeLessThanOrEqual(6);
        expect(text.length, `${key} [${language}]: ${text}`).toBeLessThanOrEqual(40);
      }
    }
  });

  it('every one, in every language, fits the computed capsule: ≤ 360 wide, ≤ 2 lines, no word cut', () => {
    for (const language of APP_LANGUAGES) {
      for (const key of KEYS) {
        const text = said(language, key);
        const layout = fitPillMessage(text, measure);
        const label = `${key} [${language}]: ${text}`;
        expect(layout.width, label).toBeLessThanOrEqual(PILL_MAX_MESSAGE_WIDTH);
        expect(layout.width, label).toBeGreaterThanOrEqual(PILL_WIDTH);
        expect(layout.lines, label).toBeLessThanOrEqual(2);
        expect(layout.height, label).toBeLessThanOrEqual(2 * PILL_MESSAGE.lineHeight + 2 * PILL_MESSAGE.paddingY);
        expect(widestWord(text, measure), label).toBeLessThanOrEqual(layout.textWidth);
        expect(layout.textWidth + PILL_MESSAGE_CHROME, label).toBeLessThanOrEqual(layout.width);
        // The words really do go in that many lines at that width.
        expect(lineCount(text, layout.textWidth, measure), label).toBe(layout.lines);
      }
    }
  });

  it('a short message keeps the pill its own 160 × 36', () => {
    expect(fitPillMessage('Copied', measure)).toMatchObject({ width: PILL_WIDTH, height: PILL_HEIGHT, lines: 1 });
  });

  it('breaks two lines in balance, not one word left alone', () => {
    const text = 'Didn’t finish because the model for this language could not be loaded at all';
    const layout = fitPillMessage(text, measure);
    expect(layout.lines).toBe(2);
    expect(layout.textWidth).toBeLessThan(measure(text) * 0.62);
  });

  it('a narrow monitor narrows the pill, and nothing overflows it', () => {
    expect(pillMaxMessageWidth(1920)).toBe(PILL_MAX_MESSAGE_WIDTH);
    const narrow = pillMaxMessageWidth(280);
    expect(narrow).toBe(232);
    for (const language of APP_LANGUAGES) {
      for (const key of KEYS) {
        const text = said(language, key);
        const layout = fitPillMessage(text, measure, narrow);
        expect(layout.width, `${key} [${language}]`).toBeLessThanOrEqual(narrow);
        expect(layout.lines).toBeLessThanOrEqual(PILL_MESSAGE.maxLines);
        expect(widestWord(text, measure)).toBeLessThanOrEqual(layout.textWidth);
      }
    }
  });
});

// The parameter set, and the two numbers that must not be copied from macOS blindly.
//
// Every assertion here has a line number in docs/windows/03-ENGINE-PARITY.md.

import { describe, expect, it } from 'vitest';
import {
  beamSizeFor,
  padForDecode,
  resolveDecodeCores,
  resolveThreadCount,
  whisperParamsFor,
} from '../../src/engines/index.js';
import {
  DEFAULT_SETTINGS,
  MINIMUM_DECODE_SAMPLES,
  TEMPERATURE_LADDER,
  WHISPER_V192_DEFAULTS,
  type Settings,
} from '../../src/contracts/index.js';

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

describe('greedy.best_of — the bug that shipped on macOS', () => {
  it('is 5 in the BEAM branch', () => {
    const params = whisperParamsFor({
      language: 'ru',
      family: 'unified',
      settings: settings(),
      initialPrompt: null,
      cpuCount: 8,
    });
    expect(params.strategy).toBe('beam');
    expect(params.greedyBestOf).toBe(5);
  });

  it('is 5 in the GREEDY branch too', () => {
    const params = whisperParamsFor({
      language: 'uz',
      family: 'uzbek',
      settings: settings(),
      initialPrompt: null,
      cpuCount: 8,
    });
    expect(params.strategy).toBe('greedy');
    expect(params.greedyBestOf).toBe(5);
  });

  it('never leaves beam_size set in the greedy branch', () => {
    // Passing beam_size 1 with a beam strategy is a different decoder, not a faster one.
    const params = whisperParamsFor({
      language: 'uz',
      family: 'uzbek',
      settings: settings(),
      initialPrompt: null,
      cpuCount: 8,
    });
    expect(params.beamSearchBeamSize).toBeNull();
  });
});

describe('D-W11 — beam size is per model', () => {
  it('gives the Uzbek family beam 1 whatever the setting says', () => {
    for (const whisperBeamSize of [1, 5, 8]) {
      expect(beamSizeFor('uzbek', settings({ whisperBeamSize }))).toBe(1);
    }
  });

  it('gives the unified family the setting, defaulting to 5', () => {
    expect(beamSizeFor('unified', settings())).toBe(5);
    expect(beamSizeFor('unified', settings({ whisperBeamSize: 3 }))).toBe(3);
  });

  it('falls back to 5 rather than 0 when the setting is nonsense', () => {
    expect(beamSizeFor('unified', settings({ whisperBeamSize: 0 }))).toBe(5);
  });

  it('makes the Uzbek engine greedy and the unified one beam', () => {
    const uzbek = whisperParamsFor({
      language: 'uz',
      family: 'uzbek',
      settings: settings(),
      initialPrompt: null,
      cpuCount: 8,
    });
    const unified = whisperParamsFor({
      language: 'ru',
      family: 'unified',
      settings: settings(),
      initialPrompt: null,
      cpuCount: 8,
    });
    expect(uzbek.strategy).toBe('greedy');
    expect(unified.strategy).toBe('beam');
    expect(unified.beamSearchBeamSize).toBe(5);
  });
});

describe('the thread rule', () => {
  it('keeps the macOS formula: max(1, min(8, cpuCount - 2))', () => {
    expect(resolveThreadCount(4, 0)).toBe(2);
    expect(resolveThreadCount(10, 0)).toBe(8);
    expect(resolveThreadCount(64, 0)).toBe(8);
    expect(resolveThreadCount(1, 0)).toBe(1);
    expect(resolveThreadCount(2, 0)).toBe(1);
  });

  it('honours an explicit override', () => {
    expect(resolveThreadCount(16, 3)).toBe(3);
  });

  it('halves the logical count first, because Windows counts SMT and E-cores', () => {
    expect(resolveDecodeCores(2)).toBe(2); // the CI runner: 1 core / 2 logical
    expect(resolveDecodeCores(8)).toBe(4); // 4C/8T laptop
    expect(resolveDecodeCores(12)).toBe(6);
    expect(resolveDecodeCores(24)).toBe(12); // 8P + 16E
    expect(resolveDecodeCores(32)).toBe(16);
  });

  it('never oversubscribes a real machine end to end', () => {
    // The whole point of the divergence: threads must not exceed physical cores.
    const machines: readonly [number, number][] = [
      [2, 1], // 1C/2T runner
      [8, 4], // 4C/8T
      [12, 6],
      [16, 8],
    ];
    for (const [logical, physical] of machines) {
      const threads = resolveThreadCount(resolveDecodeCores(logical), 0);
      expect(threads).toBeGreaterThanOrEqual(1);
      expect(threads).toBeLessThanOrEqual(physical);
    }
  });

  it('is never 0 on the wire', () => {
    for (const cpuCount of [0, 1, 2, 3, 4, 100]) {
      expect(
        whisperParamsFor({
          language: 'uz',
          family: 'uzbek',
          settings: settings(),
          initialPrompt: null,
          cpuCount,
        }).nThreads,
      ).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('the fields that never move', () => {
  const params = whisperParamsFor({
    language: 'uz',
    family: 'uzbek',
    settings: settings(),
    initialPrompt: null,
    cpuCount: 8,
  });

  it('turns off whisper\'s own printing defaults', () => {
    expect(params.printProgress).toBe(false); // whisper default is TRUE
    expect(params.printTimestamps).toBe(false); // whisper default is TRUE
    expect(params.printRealtime).toBe(false);
    expect(params.printSpecial).toBe(false);
    expect(params.noTimestamps).toBe(true); // whisper default is false
  });

  it('never translates and never auto-detects', () => {
    expect(params.translate).toBe(false);
    expect(params.detectLanguage).toBe(false);
  });

  it('pins the language on every call', () => {
    for (const language of ['en', 'ru', 'uz'] as const) {
      expect(
        whisperParamsFor({
          language,
          family: language === 'uz' ? 'uzbek' : 'unified',
          settings: settings(),
          initialPrompt: null,
          cpuCount: 8,
        }).language,
      ).toBe(language);
    }
  });

  it('keeps no_speech_thold at 0.6 with no setting to move it', () => {
    expect(params.noSpeechThold).toBe(0.6);
    expect(params.singleSegment).toBe(false);
    expect(params.suppressBlank).toBe(true);
  });
});

describe('the initial prompt', () => {
  it('is null when there is none', () => {
    expect(
      whisperParamsFor({
        language: 'uz',
        family: 'uzbek',
        settings: settings(),
        initialPrompt: null,
        cpuCount: 8,
      }).initialPrompt,
    ).toBeNull();
  });

  it('normalises an empty string to null — they are different to a decoder', () => {
    expect(
      whisperParamsFor({
        language: 'uz',
        family: 'uzbek',
        settings: settings(),
        initialPrompt: '',
        cpuCount: 8,
      }).initialPrompt,
    ).toBeNull();
  });

  it('passes a real prompt through unchanged, okina and all', () => {
    const prompt = 'Kotiba, Toshkent, sanʼat, oʻzbek.';
    expect(
      whisperParamsFor({
        language: 'uz',
        family: 'uzbek',
        settings: settings(),
        initialPrompt: prompt,
        cpuCount: 8,
      }).initialPrompt,
    ).toBe(prompt);
  });
});

describe('padForDecode', () => {
  it('pads a short buffer to exactly one second', () => {
    const padded = padForDecode(new Float32Array(1000).fill(0.5));
    expect(padded.length).toBe(MINIMUM_DECODE_SAMPLES);
    expect(padded[0]).toBe(0.5);
    expect(padded[999]).toBe(0.5);
    expect(padded[1000]).toBe(0); // zeros, not a repeat of the signal
    expect(padded[MINIMUM_DECODE_SAMPLES - 1]).toBe(0);
  });

  it('pads an empty buffer rather than returning it', () => {
    expect(padForDecode(new Float32Array(0)).length).toBe(MINIMUM_DECODE_SAMPLES);
  });

  it('returns a long buffer untouched, and does not copy it', () => {
    const long = new Float32Array(MINIMUM_DECODE_SAMPLES * 2);
    expect(padForDecode(long)).toBe(long);
  });

  it('is exactly at the boundary — one sample under pads, exactly at does not', () => {
    expect(padForDecode(new Float32Array(MINIMUM_DECODE_SAMPLES - 1)).length).toBe(
      MINIMUM_DECODE_SAMPLES,
    );
    const exact = new Float32Array(MINIMUM_DECODE_SAMPLES);
    expect(padForDecode(exact)).toBe(exact);
  });
});

describe('the defaults the port depends on and does not set', () => {
  it('records the six-rung temperature ladder', () => {
    expect(TEMPERATURE_LADDER).toEqual([0.0, 0.2, 0.4, 0.6, 0.8, 1.0]);
    expect(WHISPER_V192_DEFAULTS.temperature).toBe(0.0);
    expect(WHISPER_V192_DEFAULTS.temperatureInc).toBe(0.2);
  });

  it('records the thresholds that decide when a rung fails', () => {
    expect(WHISPER_V192_DEFAULTS.entropyThold).toBe(2.4);
    expect(WHISPER_V192_DEFAULTS.logprobThold).toBe(-1.0);
  });

  it('records no_context true and audio_ctx 0', () => {
    expect(WHISPER_V192_DEFAULTS.noContext).toBe(true);
    expect(WHISPER_V192_DEFAULTS.audioCtx).toBe(0);
  });
});

// diagnostics.jsonl.
//
// The wire format is PARITY, not a choice: the analysis scripts already written for the
// Mac must read a Windows log unchanged. That means the `{environment, record}` nesting,
// sorted keys at every level, ISO-8601 with no fractional seconds, and optional fields
// OMITTED rather than written as null.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DIAGNOSTICS_DEVICE,
  DIAGNOSTICS_SUMMARY_EMPTY,
  EMPTY_DICTATION_RECORD,
  type DictationRecord,
} from '../../src/contracts/index.js';
import { DROPPABLE, checkRewrite, messagePrompt } from '../../src/core/modes/index.js';
import { checkUzbekPolishGuard, quoteSpoken } from '../../src/core/text/index.js';
import { createFileDiagnosticsSink, isoSeconds } from '../../src/platform/diagnostics.js';

let directory: string;
let file: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kotiba-diag-'));
  file = path.join(directory, 'diagnostics.jsonl');
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function sink(maxBytes?: number) {
  return createFileDiagnosticsSink({
    path: file,
    appVersion: '0.1.0',
    osVersion: '10.0.26100',
    locale: 'uz-UZ',
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
}

function record(overrides: Partial<DictationRecord> = {}): DictationRecord {
  return {
    ...EMPTY_DICTATION_RECORD,
    startedAt: '2026-08-19T12:34:56Z',
    outcome: 'done',
    ...overrides,
  };
}

async function firstLine(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(file, 'utf8');
  const line = raw.split('\n')[0] ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}

describe('the line format', () => {
  it('nests exactly {environment, record}, with the environment on every line', async () => {
    const store = sink();
    await store.open();
    await store.append(record());
    await store.append(record({ outcome: 'failed' }));

    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(['environment', 'record']);
      expect(parsed['environment']).toEqual({
        appVersion: '0.1.0',
        device: DIAGNOSTICS_DEVICE,
        locale: 'uz-UZ',
        osVersion: '10.0.26100',
      });
    }
  });

  it('says windows where macOS says mac', async () => {
    const store = sink();
    await store.open();
    await store.append(record());
    expect(((await firstLine())['environment'] as { device: string }).device).toBe('windows');
  });

  it('terminates every line with 0x0A', async () => {
    const store = sink();
    await store.open();
    await store.append(record());
    expect((await fs.readFile(file, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('sorts keys at every level, so two runs of the same dictation diff cleanly', async () => {
    const store = sink();
    await store.open();
    await store.append(
      record({
        route: { language: 'uz', family: 'uzbek', source: 'acoustic', turkicMass: 0.83 },
        stageMillis: { transcribing: 1200, arming: 4, routing: 34 },
        engineID: 'uzbek_stt_v1',
      }),
    );

    const raw = (await fs.readFile(file, 'utf8')).trim();
    // Re-serialising the parsed object with the same key order must reproduce the bytes.
    const keysOf = (text: string) => [...text.matchAll(/"([a-zA-Z]+)":/g)].map((m) => m[1]);
    expect(raw).toContain('"environment"');
    // Top level: environment before record.
    expect(raw.indexOf('"environment"')).toBeLessThan(raw.indexOf('"record"'));
    // Inside environment: appVersion, device, locale, osVersion.
    const environmentKeys = keysOf(raw.slice(raw.indexOf('"environment"'), raw.indexOf('"record"')));
    expect(environmentKeys).toEqual(['environment', 'appVersion', 'device', 'locale', 'osVersion']);
    // No pretty-printing.
    expect(raw).not.toContain('\n  ');
  });

  // macOS's `ISO8601DateFormatter` at its defaults writes no fractional seconds;
  // `toISOString()` writes milliseconds. A script that parses one and chokes on the
  // other is the whole cost this format exists to avoid.
  it('writes timestamps with no fractional seconds', () => {
    expect(isoSeconds(new Date('2026-08-19T12:34:56.789Z'))).toBe('2026-08-19T12:34:56Z');
    expect(isoSeconds(new Date('2026-08-19T12:34:56Z'))).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
  });

  it('omits an absent optional field rather than writing null', async () => {
    const store = sink();
    await store.open();
    await store.append(record());

    const line = await firstLine();
    const written = line['record'] as Record<string, unknown>;
    for (const key of ['engineID', 'modeKey', 'polishID', 'polished', 'raw', 'result', 'route']) {
      expect(Object.prototype.hasOwnProperty.call(written, key)).toBe(false);
    }
    // The non-optional ones are always there, defaults included.
    expect(written['audioSeconds']).toBe(0);
    expect(written['errors']).toEqual([]);
    expect(written['peakAmplitude']).toBe(0);
    expect(written['stageMillis']).toEqual({});
    expect(written['outcome']).toBe('done');
  });

  // `turkicMass` is `number | null` in memory because a pin has no acoustic mass to
  // report, and macOS encodes it with encodeIfPresent — so nil is OMITTED, never null.
  // This is the one place the in-memory type and the wire format genuinely disagree.
  it('omits turkicMass for a pinned route and writes it for an acoustic one', async () => {
    const store = sink();
    await store.open();
    await store.append(
      record({ route: { language: 'uz', family: 'uzbek', source: 'pin', turkicMass: null } }),
    );
    const pinned = (await firstLine())['record'] as { route: Record<string, unknown> };
    expect(Object.keys(pinned.route).sort()).toEqual(['family', 'language', 'source']);

    await store.clear();
    await store.append(
      record({ route: { language: 'uz', family: 'uzbek', source: 'acoustic', turkicMass: 0.4 } }),
    );
    const acoustic = (await firstLine())['record'] as { route: Record<string, unknown> };
    expect(acoustic.route['turkicMass']).toBe(0.4);
  });
});

describe('reading back', () => {
  it('round-trips every record', async () => {
    const store = sink();
    await store.open();
    const one = record({ engineID: 'turbo', raw: 'hello', result: 'Hello', modeKey: 'super' });
    await store.append(one);
    expect(await store.records()).toEqual([one]);
  });

  it('costs one corrupt line that line and not the file', async () => {
    const store = sink();
    await store.open();
    await store.append(record({ engineID: 'first' }));
    await fs.appendFile(file, '{ half a line\n', 'utf8');
    await store.append(record({ engineID: 'second' }));

    const back = await store.records();
    expect(back.map((row) => row.engineID)).toEqual(['first', 'second']);
  });
});

describe('the input device', () => {
  const phone = { name: 'Aziz’s iPhone Microphone', transport: 'continuity', sampleRate: 48_000, overrodeDefault: false } as const;

  it('is written as an optional nested object, and round-trips', async () => {
    const store = sink();
    await store.open();
    await store.append(record({ inputDevice: phone }));
    const written = (await firstLine())['record'] as { inputDevice: Record<string, unknown> };
    expect(Object.keys(written.inputDevice).sort()).toEqual(['name', 'overrodeDefault', 'sampleRate', 'transport']);
    expect((await store.records())[0]?.inputDevice).toEqual(phone);
  });

  it('a line written before the field existed, or by a newer build, still reads', async () => {
    const store = sink();
    await store.open();
    const old = { environment: { appVersion: '0', device: 'windows', locale: 'en', osVersion: '1' }, record: { audioSeconds: 2, errors: [], outcome: 'done', peakAmplitude: 0.3, stageMillis: {}, startedAt: '2026-09-01T10:00:00Z' } };
    const newer = { ...old, record: { ...old.record, inputDevice: { name: 'X', transport: 'usb', futureField: 1 }, alsoNew: true } };
    await fs.appendFile(file, `${JSON.stringify(old)}\n${JSON.stringify(newer)}\n`, 'utf8');
    const back = await store.records();
    expect(back).toHaveLength(2);
    expect(back[0]?.inputDevice).toBeUndefined();
    expect(back[1]?.inputDevice?.name).toBe('X');
    // …and the Statistics reader, which takes the same records, only reads what it needs.
    expect(back.every((row) => typeof row.audioSeconds === 'number')).toBe(true);
  });

  it('the summary says what kind of input it was, never which one', async () => {
    const store = sink();
    await store.open();
    await store.append(record({ inputDevice: { ...phone, overrodeDefault: true } }));
    const summary = await store.summary();
    expect(summary).toContain('input continuity, 48000 Hz, overrode system default');
    expect(summary).not.toContain('Aziz');
    expect(summary).not.toContain('iPhone');
  });
});

describe('trimming', () => {
  // Keep the NEWEST half. The newest records explain the problem the user is reporting
  // right now, and an absent file is indistinguishable from diagnostics being off.
  it('keeps the newest half once the file passes maxBytes', async () => {
    const store = sink(4000);
    await store.open();
    for (let i = 0; i < 200; i += 1) {
      await store.append(record({ engineID: `engine-${String(i).padStart(3, '0')}` }));
    }

    const back = await store.records();
    const ids = back.map((row) => row.engineID);
    expect(ids).toContain('engine-199');
    expect(ids).not.toContain('engine-000');
    expect(back.length).toBeLessThan(200);
  });

  it('never deletes the file itself', async () => {
    const store = sink(200);
    await store.open();
    for (let i = 0; i < 20; i += 1) await store.append(record());
    await expect(fs.stat(file)).resolves.toBeDefined();
    expect((await store.records()).length).toBeGreaterThan(0);
  });
});

describe('the summary', () => {
  it('reports an empty store rather than throwing at the worst moment', async () => {
    const store = sink();
    await store.open();
    expect(await store.summary()).toBe(DIAGNOSTICS_SUMMARY_EMPTY);
  });

  it('contains the outcome, the engine id, the stage names and the errors', async () => {
    const store = sink();
    await store.open();
    await store.append(
      record({
        engineID: 'uzbek_stt_v1',
        modeKey: 'super',
        outcome: 'heardNothing',
        errors: ['the recording was silent'],
        stageMillis: { arming: 4, transcribing: 1234 },
      }),
    );

    const summary = await store.summary();
    expect(summary).toContain('heardNothing');
    expect(summary).toContain('uzbek_stt_v1');
    expect(summary).toContain('arming');
    expect(summary).toContain('transcribing');
    expect(summary).toContain('the recording was silent');
  });

  // The whole point is a report someone can paste into a chat without pasting
  // everything they have ever dictated — including, on a bad day, a password.
  it('contains no transcript text', async () => {
    const store = sink();
    await store.open();
    await store.append(
      record({
        raw: 'correct horse battery staple',
        result: 'Correct horse battery staple',
        polished: 'Correct Horse Battery Staple',
      }),
    );

    const summary = await store.summary();
    expect(summary).not.toContain('horse');
    expect(summary).not.toContain('battery');
    expect(summary).not.toContain('staple');
  });

  // Core review 2026-09-30, item 6. The notes are part of the summary, and they quote the
  // speaker: which words a guard refused, what the Uzbek engine answered. Before, a Message
  // sentence whose rewrite lost two words printed those two words into the text a user
  // pastes into a bug report.
  it('redacts notes that quote the speaker, and keeps them in the record', async () => {
    const store = sink();
    await store.open();
    const dropped = checkRewrite(
      'Keep only telegram.',
      'Yes, keep only the dentist telegram today.',
      'en',
      messagePrompt('en'),
      DROPPABLE.en,
    );
    const invented = checkUzbekPolishGuard('ertaga keçşurun boraman', 'ertaga boraman');
    await store.append(
      record({
        errors: [
          `message: ${dropped ?? ''}; kept as spoken`,
          invented?.reason ?? '',
          `the Uzbek engine's second answer was not usable ${quoteSpoken('salom dunyo » kelajak')} — the first stands.`,
        ],
      }),
    );

    const summary = await store.summary();
    for (const word of ['dentist', 'today', 'keçşurun', 'salom', 'kelajak']) {
      expect(summary, word).not.toContain(word);
    }
    expect(summary).toContain('did not say');
    expect(summary).toContain('\u00AB2 words\u00BB');
    expect((await store.records())[0]?.errors.join(' ')).toContain('dentist');
  });

  it('honours its limit', async () => {
    const store = sink();
    await store.open();
    for (let i = 0; i < 60; i += 1) {
      await store.append(record({ engineID: `e${String(i).padStart(2, '0')}` }));
    }
    const summary = await store.summary(5);
    expect(summary).toContain('e59');
    expect(summary).not.toContain('e00');
    expect(summary).toContain('60 dictations recorded');
  });

  it('exports to a filename with no colon in it', async () => {
    const store = sink();
    await store.open();
    await store.append(record());

    const written = await store.exportSummary(directory);
    const name = path.basename(written);
    // `:` in a Windows filename opens an NTFS alternate data stream instead: the write
    // appears to succeed and produces a file the user cannot find.
    expect(name).not.toContain(':');
    expect(name).toMatch(/^kotiba-diagnostics-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.txt$/);
    expect(await fs.readFile(written, 'utf8')).toContain('dictations recorded');
  });
});

describe('clear', () => {
  it('empties the log but leaves the file, because a missing file reads as "off"', async () => {
    const store = sink();
    await store.open();
    await store.append(record());
    await store.clear();

    expect(await fs.readFile(file, 'utf8')).toBe('');
    expect(await store.records()).toEqual([]);
    expect(await store.summary()).toBe(DIAGNOSTICS_SUMMARY_EMPTY);
  });
});

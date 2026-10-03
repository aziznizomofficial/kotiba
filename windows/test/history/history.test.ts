// History over JSONL (D-W5). Storage diverges from macOS; behaviour must not.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { finalText, keepsEverything, type HistoryEntry } from '../../src/contracts/index.js';
import { createFileHistoryStore, type FileHistoryStore } from '../../src/platform/history.js';

let directory: string;
let file: string;
let store: FileHistoryStore;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kotiba-history-'));
  file = path.join(directory, 'history.jsonl');
  store = createFileHistoryStore({ path: file });
  await store.open();
});

afterEach(async () => {
  await store.close();
  await fs.rm(directory, { recursive: true, force: true });
});

let sequence = 0;

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  sequence += 1;
  return {
    id: `id-${String(sequence).padStart(4, '0')}`,
    startedAt: '2026-08-19T12:00:00Z',
    language: 'uz',
    engineID: 'uzbek_stt_v1',
    raw: 'salom dunyo',
    result: 'Salom dunyo',
    polished: null,
    audioSeconds: 1.5,
    audioPath: null,
    ...overrides,
  };
}

async function lines(): Promise<string[]> {
  const raw = await fs.readFile(file, 'utf8');
  return raw.split('\n').filter((line) => line !== '');
}

describe('insert and list', () => {
  it('counts dictations per language — the language decision’s one-time seed (P4)', async () => {
    await store.insert(entry({ id: 'a', language: 'uz' }));
    await store.insert(entry({ id: 'b', language: 'uz' }));
    await store.insert(entry({ id: 'c', language: 'ar' }));
    await store.insert(entry({ id: 'b', language: 'uz' }));
    expect(await store.countsByLanguage?.()).toEqual({ uz: 2, ar: 1 });
  });

  it('lists newest first', async () => {
    await store.insert(entry({ id: 'a', startedAt: '2026-08-19T10:00:00Z' }));
    await store.insert(entry({ id: 'b', startedAt: '2026-08-19T12:00:00Z' }));
    await store.insert(entry({ id: 'c', startedAt: '2026-08-19T11:00:00Z' }));

    expect((await store.recent()).map((row) => row.id)).toEqual(['b', 'c', 'a']);
  });

  // A second-resolution clock makes duplicate timestamps ordinary — ten dictations in a
  // minute is a normal morning — and without a tie-break, which record survives a prune
  // depends on insertion order in a file the user cannot see.
  it('breaks a timestamp tie by id, descending', async () => {
    await store.insert(entry({ id: 'aaa', startedAt: '2026-08-19T12:00:00Z' }));
    await store.insert(entry({ id: 'ccc', startedAt: '2026-08-19T12:00:00Z' }));
    await store.insert(entry({ id: 'bbb', startedAt: '2026-08-19T12:00:00Z' }));

    expect((await store.recent()).map((row) => row.id)).toEqual(['ccc', 'bbb', 'aaa']);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 10; i += 1) await store.insert(entry());
    expect((await store.recent(3))).toHaveLength(3);
    expect((await store.recent(0))).toHaveLength(0);
    expect((await store.recent(-5))).toHaveLength(0);
  });

  it('re-inserting the same id updates rather than duplicating', async () => {
    await store.insert(entry({ id: 'x', result: 'first' }));
    await store.insert(entry({ id: 'x', result: 'second' }));

    expect(await store.count()).toBe(1);
    expect((await store.recent())[0]?.result).toBe('second');
    expect(await lines()).toHaveLength(1);
  });

  it('appends rather than rewriting on the ordinary path', async () => {
    await store.insert(entry());
    const first = await fs.readFile(file, 'utf8');
    await store.insert(entry());
    expect((await fs.readFile(file, 'utf8')).startsWith(first)).toBe(true);
  });

  it('survives a reopen with every field intact', async () => {
    const row = entry({ polished: 'Salom, dunyo!', audioSeconds: 2.25, engineID: 'turbo' });
    await store.insert(row);
    await store.close();

    const reopened = createFileHistoryStore({ path: file });
    await reopened.open();
    expect((await reopened.recent())[0]).toEqual(row);
    expect(finalText(row)).toBe('Salom, dunyo!');
    store = reopened;
  });
});

describe('search', () => {
  beforeEach(async () => {
    await store.insert(entry({ id: 's1', raw: 'oʻzbekiston respublikasi', result: 'Oʻzbekiston respublikasi' }));
    await store.insert(entry({ id: 's2', raw: 'the meeting is at five', result: 'The meeting is at five' }));
    await store.insert(entry({ id: 's3', raw: 'nothing here', result: 'Nothing here', polished: 'Bordies' }));
  });

  it('finds a match in raw, result or polished', async () => {
    expect((await store.search('meeting')).map((row) => row.id)).toEqual(['s2']);
    expect((await store.search('Bordies')).map((row) => row.id)).toEqual(['s3']);
  });

  it('is case-insensitive', async () => {
    expect((await store.search('MEETING'))).toHaveLength(1);
  });

  it('returns nothing for an empty or whitespace-only term', async () => {
    expect(await store.search('')).toEqual([]);
    expect(await store.search('   ')).toEqual([]);
  });

  // remove_diacritics 0 is mandatory: the Uzbek okina U+02BB is a LETTER, not a
  // diacritic. Folding it merges oʻ with o and gʻ with g, so two different words stop
  // being different.
  it('does not fold the okina — oʻzbekiston is not ozbekiston', async () => {
    expect(await store.search('oʻzbekiston')).toHaveLength(1);
    expect(await store.search('ozbekiston')).toHaveLength(0);
  });

  // Uzbek is agglutinative: the suffixes ARE the grammar. English stemming invents
  // matches that mean the opposite of what the user typed.
  it('does not stem — "bordie" must not become "bordies"', async () => {
    expect(await store.search('bordies')).toHaveLength(1);
    // The port searches substrings where macOS matches whole tokens, so a PREFIX does
    // hit here and would not under FTS5. What must never happen is the porter-stemmer
    // behaviour in the other direction: a search for a longer, differently-suffixed
    // word finding the shorter one.
    expect(await store.search('bordied')).toHaveLength(0);
    expect(await store.search('bording')).toHaveLength(0);
  });

  // macOS needs `escapeForFTS5` because user input reaches a query parser. Here there
  // is nothing to escape, and this test is what says so.
  it('treats punctuation as text, not query syntax', async () => {
    await store.insert(entry({ id: 'p1', result: 'well-known "quoted" thing OR else' }));
    expect((await store.search('well-known')).map((row) => row.id)).toEqual(['p1']);
    expect((await store.search('"quoted"')).map((row) => row.id)).toEqual(['p1']);
    expect((await store.search('OR else')).map((row) => row.id)).toEqual(['p1']);
    await expect(store.search('*')).resolves.toEqual([]);
  });

  it('returns matches newest first and honours the limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await store.insert(entry({ id: `m${i}`, result: 'repeated', startedAt: `2026-08-19T13:0${i}:00Z` }));
    }
    const found = await store.search('repeated', 3);
    expect(found.map((row) => row.id)).toEqual(['m4', 'm3', 'm2']);
  });
});

describe('delete', () => {
  it('actually removes the line, and does not tombstone it', async () => {
    await store.insert(entry({ id: 'keep', result: 'kept text' }));
    await store.insert(entry({ id: 'gone', result: 'secret text' }));

    await store.delete('gone');

    expect(await store.count()).toBe(1);
    // A user who deletes a dictation expects it GONE. A tombstone leaves the text on
    // disk, where the next support bundle picks it up.
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).not.toContain('secret text');
    expect(raw).toContain('kept text');
    expect(await lines()).toHaveLength(1);
  });

  it('is a no-op for an id that is not there', async () => {
    await store.insert(entry({ id: 'only' }));
    await store.delete('nope');
    expect(await store.count()).toBe(1);
  });

  it('removes a deleted record from search too', async () => {
    await store.insert(entry({ id: 'x', result: 'findable' }));
    expect(await store.search('findable')).toHaveLength(1);
    await store.delete('x');
    expect(await store.search('findable')).toHaveLength(0);
  });
});

describe('prune', () => {
  beforeEach(async () => {
    for (let i = 0; i < 10; i += 1) {
      await store.insert(entry({ id: `p${i}`, startedAt: `2026-08-19T1${i}:00:00Z` }));
    }
  });

  // 0 is the SHIPPED DEFAULT and it means keep everything. Returning early here is the
  // difference between "no retention policy" and "delete the entire history", and
  // historyLimit has no UI to warn anyone.
  it('keeps everything for 0 and for a negative limit', async () => {
    expect(keepsEverything(0)).toBe(true);
    expect(keepsEverything(-1)).toBe(true);
    expect(await store.prune(0)).toBe(0);
    expect(await store.prune(-1)).toBe(0);
    expect(await store.count()).toBe(10);
  });

  it('keeps the newest N and reports how many went', async () => {
    expect(await store.prune(4)).toBe(6);
    expect((await store.recent()).map((row) => row.id)).toEqual(['p9', 'p8', 'p7', 'p6']);
  });

  it('does nothing when there are fewer records than the limit', async () => {
    expect(await store.prune(50)).toBe(0);
    expect(await store.count()).toBe(10);
  });

  it('removes pruned records from the file and from search', async () => {
    await store.prune(2);
    expect(await lines()).toHaveLength(2);
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).not.toContain('"p0"');
  });
});

describe('clear all', () => {
  it('empties the index and the file, and leaves the file there', async () => {
    await store.insert(entry());
    await store.clearAll();
    expect(await store.count()).toBe(0);
    expect(await fs.readFile(file, 'utf8')).toBe('');
    expect(await store.recent()).toEqual([]);
  });
});

describe('a damaged file', () => {
  it('costs the damaged line and nothing else', async () => {
    await fs.writeFile(
      file,
      [
        JSON.stringify(entry({ id: 'good1', result: 'first' })),
        '{ half a line',
        JSON.stringify(entry({ id: 'good2', result: 'second' })),
        '',
      ].join('\n'),
      'utf8',
    );

    const reopened = createFileHistoryStore({ path: file });
    await reopened.open();
    expect(await reopened.count()).toBe(2);
    expect(reopened.notes.join(' ')).toContain('1 unreadable');
    store = reopened;
  });

  it('drops a row with no id or no timestamp, since neither can be listed', async () => {
    await fs.writeFile(
      file,
      ['{"result":"orphan"}', JSON.stringify(entry({ id: 'ok' })), ''].join('\n'),
      'utf8',
    );
    const reopened = createFileHistoryStore({ path: file });
    await reopened.open();
    expect((await reopened.recent()).map((row) => row.id)).toEqual(['ok']);
    store = reopened;
  });

  it('repairs a row with a language this build does not know rather than dropping it', async () => {
    // macOS's row decoder reads an unknown language as English. A row that survives
    // with the wrong language still shows the user their words; a row that throws shows
    // them nothing.
    await fs.writeFile(
      file,
      `${JSON.stringify({ ...entry({ id: 'kk' }), language: 'kk' })}\n`,
      'utf8',
    );
    const reopened = createFileHistoryStore({ path: file });
    await reopened.open();
    expect((await reopened.recent())[0]?.language).toBe('en');
    store = reopened;
  });

  it('opens a missing file as an empty history', async () => {
    const fresh = createFileHistoryStore({ path: path.join(directory, 'nested', 'history.jsonl') });
    await fresh.open();
    expect(await fresh.count()).toBe(0);
    await fresh.close();
  });
});

// History: append-only JSONL with an in-memory index.  OWNER: t05
//
// D-W5. macOS keeps `history.sqlite` with an FTS5 index; a native SQLite module means
// `electron-rebuild` inside a build nobody on this project can attach a debugger to.
// The user-visible behaviour — list, search, copy, delete, clear — is identical over
// append-only JSONL at the sizes this app produces (505 records after weeks of real
// use), and diagnostics is already JSONL on macOS.
//
// STORAGE DIVERGES. BEHAVIOUR MUST NOT.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  HISTORY_DEFAULT_LIMIT,
  isLanguage,
  keepsEverything,
  type HistoryEntry,
  type HistoryStore,
} from '../contracts/index.js';
import { stableStringify } from '../core/settings/index.js';

import { writeFileAtomic } from './settings.js';

export { groupByLocalDay, localDayKey } from '../core/settings/index.js';

/**
 * Newest first, ties broken by id descending.
 *
 * The tie-break is not decoration: macOS's `prune` orders by `startedAt DESC, id DESC`
 * because a second-resolution clock makes duplicate timestamps genuinely common — ten
 * dictations in a minute is an ordinary morning — and without it, which record survives
 * a prune depends on insertion order in a file the user cannot see.
 */
function newestFirst(a: HistoryEntry, b: HistoryEntry): number {
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/**
 * Is `needle` in `haystack`?
 *
 * Case-insensitive, and NOTHING ELSE. Two properties of macOS's FTS5 configuration are
 * load-bearing and both are preserved by doing less rather than more:
 *
 *   * NO STEMMING. macOS pins `tokenize="unicode61"`, never `porter`. Measured: with
 *     porter, inserting "bordies" makes a search for "bordie" return a hit. Uzbek is
 *     agglutinative — the suffixes ARE the grammar — so English stemming invents
 *     matches that mean the opposite of what the user typed.
 *   * NO DIACRITIC FOLDING (`remove_diacritics 0`). The Uzbek okina U+02BB is a LETTER,
 *     not a diacritic. Stripping it merges oʻ with o and gʻ with g, so "oʻzbekiston"
 *     and "ozbekiston" stop being different words. `toLowerCase` does not touch it,
 *     which is exactly why no normalisation step appears here.
 *
 * DIVERGENCE, NAMED: this is a SUBSTRING search where macOS matches whole tokens, which
 * the `HistoryStore` contract specifies. It is strictly more permissive — "kitob" finds
 * "kitobim" here and finds nothing under FTS5 — and it errs in the safe direction for
 * an agglutinative language, where the stem is what a user remembers typing. It also
 * removes the escaping problem entirely: user input is TEXT, never query syntax, so
 * someone who types a hyphen or an unbalanced quote gets results rather than a parse
 * error. macOS needs `escapeForFTS5` for that; there is nothing here to escape.
 */
function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

function matches(entry: HistoryEntry, needle: string): boolean {
  return (
    contains(entry.raw, needle) ||
    contains(entry.result, needle) ||
    (entry.polished !== null && contains(entry.polished, needle))
  );
}

/**
 * Decode one line. Returns `null` for anything that is not a usable entry.
 *
 * The required fields must be present and the right type; the optional ones are
 * repaired rather than rejected, matching macOS's row decoder, which reads a missing
 * `id`/`engineID`/`raw`/`result` as `""` and an unknown language as English. A row that
 * survives with a wrong language still shows the user their words; a row that throws
 * shows them nothing.
 */
function decodeEntry(line: string): HistoryEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const row = value as Record<string, unknown>;
  const id = typeof row['id'] === 'string' ? row['id'] : '';
  const startedAt = typeof row['startedAt'] === 'string' ? row['startedAt'] : '';
  if (id === '' || startedAt === '') return null;

  const language = row['language'];
  const polished = row['polished'];
  const audioPath = row['audioPath'];

  return {
    id,
    startedAt,
    language: isLanguage(language) ? language : 'en',
    engineID: typeof row['engineID'] === 'string' ? row['engineID'] : '',
    raw: typeof row['raw'] === 'string' ? row['raw'] : '',
    result: typeof row['result'] === 'string' ? row['result'] : '',
    polished: typeof polished === 'string' ? polished : null,
    audioSeconds: typeof row['audioSeconds'] === 'number' ? row['audioSeconds'] : 0,
    audioPath: typeof audioPath === 'string' ? audioPath : null,
  };
}

function encodeEntry(entry: HistoryEntry): string {
  return stableStringify(entry);
}

export interface FileHistoryStore extends HistoryStore {
  /** Every decision and refusal, in order, for the diagnostics pane. */
  readonly notes: readonly string[];
  /**
   * Clear all. Not on the `HistoryStore` contract because macOS has no such button
   * either — but the brief asks for it and `prune(keeping:)` cannot express it, since
   * `keeping: 0` means the opposite. It empties the file and the index together; a free
   * function that truncated the file would leave the index holding every record it just
   * deleted.
   */
  clearAll(): Promise<void>;
}

export interface FileHistoryStoreOptions {
  /** `%LOCALAPPDATA%\Kotiba\history.jsonl`. */
  readonly path: string;
}

export function createFileHistoryStore(options: FileHistoryStoreOptions): FileHistoryStore {
  const file = options.path;
  /** id → entry. The index IS the store once `open()` has run; the file is the log. */
  const entries = new Map<string, HistoryEntry>();
  const notes: string[] = [];
  let opened = false;

  /**
   * Rewrite the whole file from the index.
   *
   * Used by delete, prune and a re-insert. DELETION MUST ACTUALLY REMOVE THE LINE — a
   * tombstone would leave the text on disk, and a user who deletes a dictation expects
   * it gone, not flagged. At 505 records the rewrite is a few hundred kilobytes; the
   * append path is what carries the per-dictation cost, and it stays an append.
   */
  async function rewrite(): Promise<void> {
    const lines = [...entries.values()].sort(newestFirst).map(encodeEntry);
    await writeFileAtomic(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
  }

  async function append(entry: HistoryEntry): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${encodeEntry(entry)}\n`, 'utf8');
  }

  return {
    get notes(): readonly string[] {
      return notes;
    },

    async open(): Promise<void> {
      if (opened) return;
      await fs.mkdir(path.dirname(file), { recursive: true });

      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
        raw = '';
      }

      let corrupt = 0;
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        const entry = decodeEntry(line);
        if (entry === null) {
          // One corrupt line costs that line, never the file. A crash mid-append leaves
          // a partial last line, and losing every earlier dictation to it would be a
          // far worse bug than the one that caused it.
          corrupt += 1;
          continue;
        }
        // Last write wins, which is how a re-inserted id collapses to one entry even in
        // a file an older build appended to twice.
        entries.set(entry.id, entry);
      }
      if (corrupt > 0) notes.push(`skipped ${corrupt} unreadable history line(s)`);

      opened = true;
    },

    async insert(entry: HistoryEntry): Promise<void> {
      const replacing = entries.has(entry.id);
      entries.set(entry.id, entry);
      // Re-inserting an id UPDATES rather than duplicating (macOS `INSERT OR REPLACE`),
      // and that needs the old line gone — so this one case rewrites instead of
      // appending. It is the rare path: ids are UUIDs.
      if (replacing) await rewrite();
      else await append(entry);
    },

    async delete(id: string): Promise<void> {
      if (!entries.delete(id)) return;
      await rewrite();
    },

    async prune(keeping: number): Promise<number> {
      // 0 and every negative value keep EVERYTHING, and 0 is the shipped default.
      // Returning early here is the difference between "no retention policy" and
      // "delete the entire history", and `historyLimit` has no UI to warn anyone.
      if (keepsEverything(keeping)) return 0;
      if (entries.size <= keeping) return 0;

      const ordered = [...entries.values()].sort(newestFirst);
      const doomed = ordered.slice(keeping);
      for (const entry of doomed) entries.delete(entry.id);
      await rewrite();
      return doomed.length;
    },

    async count(): Promise<number> {
      return entries.size;
    },

    async recent(limit: number = HISTORY_DEFAULT_LIMIT): Promise<readonly HistoryEntry[]> {
      return [...entries.values()].sort(newestFirst).slice(0, Math.max(0, limit));
    },

    async search(
      text: string,
      limit: number = HISTORY_DEFAULT_LIMIT,
    ): Promise<readonly HistoryEntry[]> {
      const needle = text.trim().toLowerCase();
      if (needle === '') return [];
      return [...entries.values()]
        .filter((entry) => matches(entry, needle))
        .sort(newestFirst)
        .slice(0, Math.max(0, limit));
    },

    async clearAll(): Promise<void> {
      entries.clear();
      await writeFileAtomic(file, '');
    },

    async close(): Promise<void> {
      entries.clear();
      opened = false;
    },
  };
}

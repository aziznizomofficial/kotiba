// diagnostics.jsonl — one `{environment, record}` object per line.  OWNER: t05
//
// THE WIRE FORMAT IS PARITY, NOT A CHOICE. macOS already writes JSONL here, and the
// analysis scripts written against the Mac's logs must read a Windows log unchanged.
// That fixes four things exactly:
//
//   * the nesting: `{"environment": {...}, "record": {...}}`, environment repeated on
//     EVERY line rather than written once as a header — a support bundle is often a
//     single grepped line, and a line that cannot say what it came from is worth less;
//   * keys lexicographically SORTED at every level, no pretty-printing;
//   * timestamps ISO-8601 UTC with NO fractional seconds (`2026-08-19T12:34:56Z`);
//   * optional fields OMITTED when absent, never written as `null`.
//
// The last one is the easiest to get wrong from TypeScript, where `JSON.stringify`
// already drops `undefined` but happily writes `null` — and a reader that distinguishes
// absent from null reads the two differently.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  DIAGNOSTICS_DEVICE,
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_SUMMARY_EMPTY,
  DIAGNOSTICS_SUMMARY_LIMIT,
  type DiagnosticsEnvironment,
  type DiagnosticsSink,
  type DictationRecord,
} from '../contracts/index.js';
import { redactedDeviceDescription } from '../core/input-device/index.js';
import { stableStringify } from '../core/settings/index.js';
import { redactSpoken } from '../core/text/index.js';

import { writeFileAtomic } from './settings.js';

/**
 * ISO-8601 UTC, seconds precision.
 *
 * `toISOString()` emits milliseconds; macOS's `ISO8601DateFormatter` at its defaults
 * does not. Trimming them is what makes the two files the same format rather than
 * nearly the same format — and a script that parses one and chokes on the other is
 * exactly the cost this whole file exists to avoid.
 */
export function isoSeconds(at: Date = new Date()): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** Drop keys whose value is `undefined`, recursively. Never converts them to `null`. */
function withoutAbsent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAbsent);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (inner === undefined) continue;
      out[key] = withoutAbsent(inner);
    }
    return out;
  }
  return value;
}

/**
 * `turkicMass` is `number | null` on `RouteDecision` because a pin has no acoustic mass
 * to report — but macOS encodes it with `encodeIfPresent`, so a nil is OMITTED and the
 * key never appears as `null`. This is the one place the in-memory type and the wire
 * format genuinely disagree.
 */
function encodeRoute(route: DictationRecord['route']): unknown {
  if (route === undefined) return undefined;
  const { turkicMass, ...rest } = route;
  return turkicMass === null ? rest : { ...rest, turkicMass };
}

/** One line, without its newline. */
export function encodeDiagnosticsLine(
  environment: DiagnosticsEnvironment,
  record: DictationRecord,
): string {
  const line = {
    environment,
    record: { ...record, route: encodeRoute(record.route) },
  };
  return stableStringify(withoutAbsent(line));
}

function decodeLine(line: string): DictationRecord | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) return null;
    const record = (value as { record?: unknown }).record;
    if (typeof record !== 'object' || record === null) return null;
    return record as DictationRecord;
  } catch {
    return null;
  }
}

export interface FileDiagnosticsSinkOptions {
  /** `%LOCALAPPDATA%\Kotiba\diagnostics.jsonl`. */
  readonly path: string;
  readonly appVersion: string;
  readonly osVersion?: string;
  readonly locale?: string;
  readonly maxBytes?: number;
}

export function createFileDiagnosticsSink(options: FileDiagnosticsSinkOptions): DiagnosticsSink {
  const file = options.path;
  const maxBytes = options.maxBytes ?? DIAGNOSTICS_MAX_BYTES;

  const environment: DiagnosticsEnvironment = {
    appVersion: options.appVersion,
    /** macOS writes the literal "mac". This port writes "windows". */
    device: DIAGNOSTICS_DEVICE,
    locale: options.locale ?? 'en-US',
    osVersion: options.osVersion ?? '0.0.0',
  };

  async function readAll(): Promise<string> {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      return '';
    }
  }

  /**
   * Once the file passes `maxBytes`, KEEP THE NEWEST HALF and discard the oldest.
   *
   * Never truncate from the end, and never delete the file: the newest records are the
   * ones that explain the problem the user is reporting right now, and an absent file
   * is indistinguishable from diagnostics being switched off.
   */
  async function trimIfNeeded(): Promise<void> {
    let size: number;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      return;
    }
    if (size <= maxBytes) return;

    const lines = (await readAll()).split('\n').filter((line) => line !== '');
    const keep = lines.slice(-Math.max(1, Math.floor(lines.length / 2)));
    await writeFileAtomic(file, keep.length === 0 ? '' : `${keep.join('\n')}\n`);
  }

  return {
    async open(): Promise<void> {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Create it empty if it is not there, so the diagnostics pane can say "0
      // dictations recorded" rather than reporting a missing file as a fault.
      try {
        const handle = await fs.open(file, 'a');
        await handle.close();
      } catch {
        // Deliberately quiet: an unwritable diagnostics file must not stop dictation.
      }
    },

    async append(record: DictationRecord): Promise<void> {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${encodeDiagnosticsLine(environment, record)}\n`, 'utf8');
      await trimIfNeeded();
    },

    async records(): Promise<readonly DictationRecord[]> {
      const out: DictationRecord[] = [];
      for (const line of (await readAll()).split('\n')) {
        if (line.trim() === '') continue;
        const record = decodeLine(line);
        // ONE CORRUPT LINE COSTS THAT LINE, NOT THE FILE.
        if (record !== null) out.push(record);
      }
      return out;
    },

    /**
     * A report a user can paste into a chat.
     *
     * CONTAINS NO TRANSCRIPT TEXT BY CONSTRUCTION: `raw`, `result` and `polished` are
     * never read here, so there is no formatting decision that could leak them — and the
     * notes, which may quote the speaker, are printed through `redactSpoken`. The
     * whole point is a report someone can send without sending everything they have
     * ever dictated — including, on a bad day, a password.
     */
    async summary(limit: number = DIAGNOSTICS_SUMMARY_LIMIT): Promise<string> {
      const all = await this.records();
      if (all.length === 0) return DIAGNOSTICS_SUMMARY_EMPTY;

      const shown = all.slice(-Math.max(0, limit));
      const lines: string[] = [
        `${all.length} dictations recorded`,
        `${environment.device} ${environment.osVersion} · Kotiba ${environment.appVersion} · ${environment.locale}`,
        '',
      ];

      for (const record of shown) {
        const stages = Object.entries(record.stageMillis)
          .map(([name, ms]) => `${name} ${Math.round(ms)}ms`)
          .join(' ');
        const route =
          record.route === undefined
            ? '—'
            : `${record.route.language}/${record.route.source}` +
              (record.route.turkicMass === null
                ? ''
                : ` mass ${record.route.turkicMass.toFixed(3)}`);

        lines.push(
          [
            record.startedAt,
            record.outcome,
            record.engineID ?? '—',
            record.modeKey ?? '—',
            route,
            `${record.audioSeconds.toFixed(2)}s`,
            `peak ${record.peakAmplitude.toFixed(4)}`,
            // What kind of microphone, never which one: its name can be the owner's
            // ("Aziz’s iPhone Microphone") and this text is pasted into bug reports.
            record.inputDevice === undefined ? '' : `input ${redactedDeviceDescription(record.inputDevice)}`,
            stages,
          ]
            .filter((part) => part !== '')
            .join(' · '),
        );
        // Redacted, because a record's notes may quote the speaker — which words a guard
        // refused, what a second engine answered — and this is the text a user pastes into a
        // bug report. The JSON lines keep them; this never does (`redactSpoken`).
        for (const error of record.errors) lines.push(`    ${redactSpoken(error)}`);
      }

      return `${lines.join('\n')}\n`;
    },

    async exportSummary(directory: string): Promise<string> {
      await fs.mkdir(directory, { recursive: true });
      // `:` is not a legal character in a Windows filename — it opens an NTFS alternate
      // data stream instead, so the write appears to succeed and produces a file the
      // user cannot find. macOS replaces it for cosmetic reasons; here it is mandatory.
      const stamp = isoSeconds().replaceAll(':', '-');
      const target = path.join(directory, `kotiba-diagnostics-${stamp}.txt`);
      await writeFileAtomic(target, await this.summary());
      return target;
    },

    async clear(): Promise<void> {
      // Empty, but still THERE. A missing file reads as "diagnostics are off".
      await writeFileAtomic(file, '');
    },

    async close(): Promise<void> {
      // Every write is awaited to completion, so there is nothing buffered to flush.
    },
  };
}

// What the app knows about Arabic that the engine cannot (C4; `src/engines/arabic.ts`): whether
// it may fetch, where the speed check's verdict is kept, and where its standard clip is.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Settings } from '../contracts/index.js';
import type { ArabicSpeedCheck, ArabicSpeedCheckStore } from '../engines/index.js';

/** Beside the models: the verdict describes this PC, and a reinstall keeps it. */
export const ARABIC_SPEED_CHECK_FILE = 'arabic-speed-check.json';

/**
 * Cohere (and, after a slow verdict, FastConformer) may fetch themselves when onboarding is over
 * and Arabic is ON — turning Arabic on is the yes (D-W25; the Languages page shows the size before
 * the switch). Turning Arabic off stops new fetches.
 */
export function arabicMayDownload(settings: Settings): boolean {
  return settings.onboardingCompleted && settings.enabledLanguages.includes('ar');
}

/** The GPU switch, as transcribe.cpp takes it. */
export function arabicBackend(settings: Settings): 'auto' | 'cpu' {
  return settings.whisperUseGPU ? 'auto' : 'cpu';
}

function isSpeedCheck(value: unknown): value is ArabicSpeedCheck {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['milliseconds'] === 'number' &&
    typeof v['thresholdMs'] === 'number' &&
    typeof v['slow'] === 'boolean' &&
    typeof v['device'] === 'string' &&
    (v['backend'] === 'auto' || v['backend'] === 'cpu') &&
    typeof v['clipSeconds'] === 'number' &&
    typeof v['measuredAt'] === 'string'
  );
}

/**
 * The verdict as one small JSON file, written atomically (temp + rename). An unreadable or
 * foreign file reads as "never checked", which re-runs the check — the safe direction.
 */
export function speedCheckFileStore(path: string): ArabicSpeedCheckStore {
  return {
    async read() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        return isSpeedCheck(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async write(check) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(check, null, 2));
      await rename(temporary, path);
    },
  };
}

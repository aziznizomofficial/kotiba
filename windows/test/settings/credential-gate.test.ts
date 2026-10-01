// THE CREDENTIAL GATE. This is a security property, not a nicety.
//
// When the frontmost application is a password manager, `resolveMode` forces the
// prompt-less `transcription` mode, which has no polisher, so nothing leaves the
// machine. Without it, a password dictated into a vault goes to whatever polish
// endpoint the user configured. The macOS comment records that this defect shipped
// once already.
//
// ── THE DELIBERATE DIVERGENCE ─────────────────────────────────────────────────────
//
// macOS matches bundle ids by exact-match-or-dot-boundary against a table whose
// password prefix is `com.agilebits.onepassword`. The real bundle identifier of
// 1Password 7 is `com.agilebits.onepassword7`, and a trailing `7` is not a dot
// boundary — so 1Password 8 is protected and 1Password 7 is not. t02's golden fixture
// pins that behaviour as it is, correctly, because that is what a parity fixture is for.
//
// WINDOWS DOES NOT REPRODUCE IT. The table is keyed on executable name and names every
// versioned variant explicitly, and the tests below fail if any of them stops matching.
// A version-numbered miss in a security gate is a bug wherever it runs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CREDENTIAL_MODE_KEY, type Settings } from '../../src/contracts/index.js';
import {
  SENSITIVE_APPS,
  WINDOWS_DEFAULT_SETTINGS,
  appKnowledge,
  builtInModes,
  formatForApp,
  isSensitiveApp,
  resolveMode,
} from '../../src/core/settings/index.js';

const modes = builtInModes();

function decide(options: {
  app: string | null;
  settings?: Partial<Settings>;
  picked?: string | null;
}) {
  return resolveMode({
    modes,
    settings: { ...WINDOWS_DEFAULT_SETTINGS, ...options.settings },
    userPickedModeKey: options.picked ?? null,
    foregroundApp: options.app,
  });
}

describe('the sensitive-application table', () => {
  // The list the brief names, one assertion per family, so a regression says WHICH
  // vault stopped being protected rather than "a test failed".
  const mustBeSensitive: readonly (readonly [string, string])[] = [
    ['1Password (both versions ship 1Password.exe)', '1password'],
    ['1Password 7, by version-suffixed name', '1password7'],
    ['1Password 8, by version-suffixed name', '1password8'],
    ['1Password 7 helper', 'agile1pagent'],
    ['1Password 7 by AUMID-style id', 'agilebits.onepassword7'],
    ['Bitwarden', 'bitwarden'],
    ['Bitwarden desktop', 'bitwarden-desktop'],
    ['KeePass 1', 'keepass'],
    ['KeePass 2', 'keepass2'],
    ['KeePassX', 'keepassx'],
    ['KeePassXC', 'keepassxc'],
    ['Dashlane', 'dashlane'],
    ['LastPass', 'lastpass'],
    ['Windows credential prompt', 'credentialuibroker'],
    ['Credential Manager wizard', 'credwiz'],
    ['Keeper', 'keeper'],
    ['NordPass', 'nordpass'],
    ['RoboForm', 'roboform'],
    ['Enpass', 'enpass'],
    ['Proton Pass', 'protonpass'],
  ];

  for (const [label, app] of mustBeSensitive) {
    it(`treats ${label} as a credential field`, () => {
      expect(formatForApp(app)).toBe('password');
      expect(isSensitiveApp(app)).toBe(true);
    });
  }

  // THE DIVERGENCE, ASSERTED. On macOS `com.agilebits.onepassword7` comes back
  // unknown/not-sensitive and 1Password 8 is protected. Here both versions match, and
  // this test is what fails if a future edit reintroduces the version-suffix hole.
  it('protects BOTH 1Password 7 and 1Password 8, and so does macOS now', () => {
    for (const variant of ['1password', '1password7', '1password8', 'agilebits.onepassword7']) {
      expect(isSensitiveApp(variant)).toBe(true);
    }

    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../fixtures/golden/settings.json', import.meta.url)),
        'utf8',
      ),
    ) as { applications: readonly { bundleID: string | null; isSensitive: boolean }[] };

    // This assertion originally pinned the macOS gap (isSensitive: false for 1Password 7) so
    // that a regenerated fixture would announce the Mac being fixed. It did, on 2026-08-19:
    // the Mac table now lists com.agilebits.onepassword7 explicitly. Both platforms agree,
    // and this now guards against either one regressing.
    const macOS7 = fixture.applications.find((row) => row.bundleID === 'com.agilebits.onepassword7');
    expect(macOS7?.isSensitive).toBe(true);
  });

  it('matches on exact equality, so no unrelated app is dragged in by a prefix', () => {
    // `hasPrefix` over flat executable names is actively wrong on Windows: `note` would
    // match `notepad`, and a prefix rule on this table would make `keepass` match some
    // unrelated `keepassistant.exe`.
    expect(isSensitiveApp('keepassistant')).toBe(false);
    expect(isSensitiveApp('1passwordish')).toBe(false);
    expect(formatForApp('notepad')).toBe('plainText');
    expect(formatForApp('note')).toBe('unknown');
  });

  it('is case- and whitespace-insensitive, because a process path is not normalised', () => {
    expect(isSensitiveApp('  1Password  ')).toBe(true);
    expect(isSensitiveApp('KeePassXC')).toBe(true);
  });

  it('returns unknown, and not sensitive, for an app that is not in the table', () => {
    expect(formatForApp('some-random-app')).toBe('unknown');
    expect(isSensitiveApp('some-random-app')).toBe(false);
    expect(isSensitiveApp(null)).toBe(false);
  });

  // A browser's BUILT-IN password manager runs in the ordinary browser process, so
  // marking it sensitive would mean killing polish for the whole web. macOS has the
  // same gap for the same reason and maps browsers to plainText. This test states the
  // gap rather than hiding it.
  it('leaves browsers as plain text — their built-in vaults are not identifiable here', () => {
    for (const browser of ['chrome', 'msedge', 'firefox', 'brave', 'arc']) {
      expect(formatForApp(browser)).toBe('plainText');
      expect(isSensitiveApp(browser)).toBe(false);
    }
  });

  it('lists every sensitive app in the knowledge table exactly once', () => {
    const rows = appKnowledge();
    const apps = rows.map((row) => row.app);
    expect(new Set(apps).size).toBe(apps.length);

    const passwordRows = rows.filter((row) => row.format === 'password').map((row) => row.app);
    expect([...passwordRows].sort()).toEqual([...SENSITIVE_APPS].sort());
  });
});

describe('resolveMode', () => {
  it('forces the prompt-less mode for a credential field', () => {
    const decision = decide({ app: '1password' });
    expect(decision.source).toBe('credentialField');
    expect(decision.mode.key).toBe(CREDENTIAL_MODE_KEY);
    expect(decision.mode.prompt).toBeNull();
  });

  // TIER ONE IS ABSOLUTE. Nothing below it can override the gate — not a tray pick, not
  // the persisted default, not an activationApps match.
  it('cannot be overridden by a mode the user picked from the tray', () => {
    const decision = decide({ app: 'bitwarden', picked: 'message' });
    expect(decision.source).toBe('credentialField');
    expect(decision.mode.prompt).toBeNull();
  });

  it('cannot be overridden by the persisted default or by app-following', () => {
    const decision = decide({
      app: 'keepassxc',
      settings: { defaultModeKey: 'note', modeFollowsApp: true },
    });
    expect(decision.source).toBe('credentialField');
    expect(decision.mode.prompt).toBeNull();
  });

  it('uses the tray pick when there is no credential field', () => {
    const decision = decide({ app: 'code', picked: 'note' });
    expect(decision.source).toBe('userPicked');
    expect(decision.mode.key).toBe('note');
  });

  it('uses the persisted default when modeFollowsApp is off — which it ships as', () => {
    expect(WINDOWS_DEFAULT_SETTINGS.modeFollowsApp).toBe(false);
    const decision = decide({ app: 'telegram' });
    expect(decision.source).toBe('settingsDefault');
    expect(decision.mode.key).toBe('super');
  });

  // The activationApps lists are INERT out of the box. A port that wires app-following
  // on by default changes which mode runs for most dictations on every install.
  it('follows the app only once the toggle is on', () => {
    const off = decide({ app: 'telegram' });
    expect(off.mode.key).toBe('super');

    const on = decide({ app: 'telegram', settings: { modeFollowsApp: true } });
    expect(on.source).toBe('appFollow');
    expect(on.mode.key).toBe('message');

    const note = decide({ app: 'obsidian', settings: { modeFollowsApp: true } });
    expect(note.mode.key).toBe('note');
  });

  it('falls back to the persisted default when app-following matches nothing', () => {
    const decision = decide({ app: 'some-random-app', settings: { modeFollowsApp: true } });
    expect(decision.source).toBe('settingsDefault');
    expect(decision.mode.key).toBe('super');
  });

  it('falls back to Super when the stored default names a mode that does not exist', () => {
    const decision = decide({ app: 'code', settings: { defaultModeKey: 'ghost' } });
    expect(decision.mode.key).toBe('super');
  });

  it('ignores a tray pick that names a mode that does not exist', () => {
    const decision = decide({ app: 'code', picked: 'ghost' });
    expect(decision.source).toBe('settingsDefault');
    expect(decision.mode.key).toBe('super');
  });
});

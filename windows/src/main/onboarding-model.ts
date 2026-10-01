// First run, as data. PURE.
//
// macOS 1.0 has a first-run walkthrough inside its app window (Sources/KotibaUI/
// Onboarding.swift) and Windows has the same steps, with one difference D-W8 buys:
// ONE permission step where the Mac has three — `SendInput` and a low-level keyboard hook
// need no grant, so only the microphone is asked about. D-W23's Download models checklist is gone
// (D-W25): leaving "Your languages" starts what they need — the ~1.95 GB core, plus Turkish's or
// Arabic's files if switched on, the total said on that page — and the last pages show one
// "Getting Kotiba ready" bar. The page is `src/renderer/onboarding.ts`; the order and the rules
// are here, where a test holds them.

/**
 * The steps, in reading order. The Mac's, with "permissions" narrowed to the microphone — and,
 * FIRST, the interface language: every later step is read in it, so it is asked before any of
 * them. It starts on the system's language when that is one of the four, so for most people it
 * is one press of Continue.
 */
export const ONBOARDING_STEP_IDS = ['language', 'welcome', 'microphone', 'hotkey', 'languages', 'alwaysOn', 'done'] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/**
 * Always on starts ON in the walkthrough and is marked recommended — the brief's words —
 * while the SETTING's default stays off. It is written only when the user finishes or
 * skips, so a user who closes the window mid-setup has not signed up for a watchdog.
 */
export const ONBOARDING_ALWAYS_ON_PRESET = true;

/**
 * Whether to show it at all.
 *
 * `--background` is the login launch (see `parseLaunchOptions`): a window nobody asked
 * for, at sign-in, is exactly the behaviour that decision exists to prevent. So a first
 * run that happens at login shows nothing, and onboarding waits for the first time the
 * user opens Kotiba themselves.
 */
export function shouldShowOnboarding(options: {
  readonly onboardingCompleted: boolean;
  readonly background: boolean;
}): boolean {
  return !options.onboardingCompleted && !options.background;
}

// The page's interface language, kept in step with the setting. The main process keeps its
// own (tray, blockers, pill); a page is a separate module instance and follows the same
// setting through the store.

import { resolveAppLanguage, setAppLanguage } from '../core/i18n/index.js';

import { store } from './store.js';

/**
 * Resolve `appLanguage` (`''` follows the system, which Chromium reports as
 * `navigator.languages`) and switch to it. Returns whether the language changed — the caller
 * re-renders what it has already worded.
 */
export function syncLanguage(): boolean {
  const language = resolveAppLanguage(store.settings.appLanguage, navigator.languages);
  document.documentElement.lang = language;
  return setAppLanguage(language);
}

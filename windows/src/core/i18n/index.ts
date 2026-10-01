// The app's UI language — English, Русский, Oʻzbekcha (Lotin), Ўзбекча (Кирилл). PURE.
//
// This is the INTERFACE language only. What the user dictates in (en/ru/uz, the router, the
// pins) is a different axis and nothing here touches it.
//
// One flat catalog per language (`./catalogs/*.ts`), each a single JSON-shaped object literal of
// `key → string`. They are TypeScript rather than `.json` files for one reason: the pages load
// their modules over `file://` with no bundler and a `default-src 'none'` policy, and a JSON
// module import is a fetch that policy refuses. `en` DEFINES the key set; the other three are
// typed against it, so a missing or extra key is a compile error, and `test/i18n` holds the
// rest (non-empty, same `{placeholders}`, orthography).
//
// The current language is module state, set by whoever knows the setting: the main process for
// the tray, blockers and pill messages; each page for itself. Strings are looked up at RENDER
// time, so a switch is a re-render, never a restart.

import { en } from './catalogs/en.js';
import { ru } from './catalogs/ru.js';
import { uzCyrl } from './catalogs/uz-cyrl.js';
import { uzLatn } from './catalogs/uz-latn.js';
import type { Catalog, MessageKey } from './catalogs/en.js';

export type { Catalog, MessageKey };

export const APP_LANGUAGES = ['uz-Latn', 'uz-Cyrl', 'en', 'ru'] as const;
export type AppLanguage = (typeof APP_LANGUAGES)[number];

export const CATALOGS: Readonly<Record<AppLanguage, Catalog>> = {
  en,
  ru,
  'uz-Latn': uzLatn,
  'uz-Cyrl': uzCyrl,
};

/** What the picker shows for each — always in that language, never translated. */
export interface LanguageChoice {
  readonly id: AppLanguage;
  readonly flag: 'gb' | 'ru' | 'uz';
  /** The native name: "Oʻzbekcha (Lotin)". */
  readonly name: string;
  /** One line under it, in the same language: "Interfeys oʻzbek tilida (lotin)". */
  readonly subline: string;
  /** Two letters for the smallest places: "EN", "RU", "UZ", "ЎЗ". */
  readonly short: string;
}

export const LANGUAGE_CHOICES: readonly LanguageChoice[] = [
  { id: 'uz-Latn', flag: 'uz', name: 'Oʻzbekcha (Lotin)', subline: 'Interfeys oʻzbek tilida (lotin)', short: 'UZ' },
  { id: 'uz-Cyrl', flag: 'uz', name: 'Ўзбекча (Кирилл)', subline: 'Интерфейс ўзбек тилида (кирилл)', short: 'ЎЗ' },
  { id: 'en', flag: 'gb', name: 'English', subline: 'Interface in English', short: 'EN' },
  { id: 'ru', flag: 'ru', name: 'Русский', subline: 'Интерфейс на русском', short: 'RU' },
];

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && (APP_LANGUAGES as readonly string[]).includes(value);
}

/**
 * The language a setting means. `''` (the default) follows the system: the first preferred
 * system language that is one of ours — `ru*` → Русский, `uz-Cyrl*` → Cyrillic, any other
 * `uz*` → Latin (the official script) — else English. An unknown stored value is treated as
 * `''`, so a newer build's language never leaves an older one blank.
 */
export function resolveAppLanguage(setting: string, systemLanguages: readonly string[]): AppLanguage {
  if (isAppLanguage(setting)) return setting;
  for (const raw of systemLanguages) {
    const tag = raw.replace(/_/gu, '-').toLowerCase();
    if (tag === 'ru' || tag.startsWith('ru-')) return 'ru';
    if (tag === 'uz' || tag.startsWith('uz-')) return tag.includes('cyrl') ? 'uz-Cyrl' : 'uz-Latn';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}

let current: AppLanguage = 'en';
const listeners = new Set<(language: AppLanguage) => void>();

export function appLanguage(): AppLanguage {
  return current;
}

/** Switch. Returns whether anything changed; listeners hear only a real change. */
export function setAppLanguage(language: AppLanguage): boolean {
  if (language === current) return false;
  current = language;
  for (const listener of [...listeners]) listener(language);
  return true;
}

export function onAppLanguageChange(listener: (language: AppLanguage) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type MessageParams = Readonly<Record<string, string | number>>;

function fill(template: string, params: MessageParams | undefined): string {
  if (params === undefined) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/gu, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** The string for `key` in the current language, `{name}` placeholders filled. */
export function t(key: MessageKey, params?: MessageParams): string {
  return fill(CATALOGS[current][key] ?? en[key] ?? key, params);
}

/** The same, in a given language — for tests and for the picker's own previews. */
export function tIn(language: AppLanguage, key: MessageKey, params?: MessageParams): string {
  return fill(CATALOGS[language][key] ?? en[key] ?? key, params);
}

export type PluralCategory = 'one' | 'few' | 'many' | 'other';

/**
 * CLDR cardinal categories for integers, written out rather than asked of `Intl`: Electron's
 * ICU has them, a test runner's may not, and four rules do not justify the dependency.
 * Uzbek counts with the singular noun ("3 ta diktovka"), so it only ever needs `one`/`other`.
 */
export function pluralCategory(language: AppLanguage, count: number): PluralCategory {
  const n = Math.abs(Math.trunc(count));
  if (language === 'ru') {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'one';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
    return 'many';
  }
  return n === 1 ? 'one' : 'other';
}

/** Keys that exist as `<base>.one`, `.few`, `.many` and `.other` in every catalog. */
export type PluralBase = MessageKey extends infer K
  ? K extends `${infer Base}.one`
    ? Base
    : never
  : never;

/** `{count}` and any other params filled into the right plural form. */
export function tn(base: PluralBase, count: number, params?: MessageParams): string {
  const key = `${base}.${pluralCategory(current, count)}` as MessageKey;
  return t(key, { count, ...params });
}

// ---------------------------------------------------------------------------------
// Numbers and dates, in the chosen language
// ---------------------------------------------------------------------------------

/** Russian and Uzbek write a decimal comma. */
export function formatDecimal(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return current === 'en' ? text : text.replace('.', ',');
}

/**
 * Month names, spelt out here. Chromium's ICU has no Uzbek month names at all — asked for
 * `uz`, it prints «M09» — and even where a runtime has them the Russian genitive ("7 августа")
 * is a separate form. Twelve words per language is cheaper than finding out per machine.
 */
const MONTHS_SHORT: Readonly<Record<AppLanguage, readonly string[]>> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ru: ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  'uz-Latn': ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'],
  'uz-Cyrl': ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
};

/** Long forms as a date uses them: Russian in the genitive. */
const MONTHS_LONG: Readonly<Record<AppLanguage, readonly string[]>> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  'uz-Latn': ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'],
  'uz-Cyrl': ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
};

export function monthShort(month: number, language: AppLanguage = current): string {
  return MONTHS_SHORT[language][month] ?? '';
}

export function monthLong(month: number, language: AppLanguage = current): string {
  return MONTHS_LONG[language][month] ?? '';
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/** A chart's day label: "29 Sep", "29 сен", "29-sen", "29-сен". */
export function formatDayMonth(date: Date): string {
  const day = String(date.getDate());
  const month = monthShort(date.getMonth());
  return current === 'en' || current === 'ru' ? `${day} ${month}` : `${day}-${month}`;
}

/** A chart's month label: "Sep 26", "сен 26", "sen 26", "сен 26" — Russian in the nominative. */
export function formatMonthYear(date: Date): string {
  const month = current === 'ru' && date.getMonth() === 4 ? 'май' : monthShort(date.getMonth());
  return `${month} ${String(date.getFullYear() % 100).padStart(2, '0')}`;
}

/** A history row: "29 Sep at 15:17", "29 сен в 15:17", "29-sen, 15:17". */
export function formatShortDateTime(date: Date): string {
  const time = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  return t('date.shortDateTime', { date: formatDayMonth(date), time });
}

/** "7 August 2026", "7 августа 2026 г.", "2026-yil 7-avgust", "2026 йил 7 август". */
export function formatLongDate(date: Date): string {
  return t('date.long', {
    day: String(date.getDate()),
    month: monthLong(date.getMonth()),
    year: String(date.getFullYear()),
  });
}

/** For `<html lang>`: what a screen reader and the spell checker should assume. */
export function htmlLang(language: AppLanguage = current): string {
  return language;
}

/** Built-in modes carry English names in their data; their display names live here. */
export function builtInModeName(key: string): string | null {
  switch (key) {
    case 'super':
      return t('mode.super');
    case 'message':
      return t('mode.message');
    case 'note':
      return t('mode.note');
    case 'transcription':
      return t('mode.raw');
    default:
      return null;
  }
}

/** The dictation languages, named in the UI language: "Russian", "Русский", "Rus tili". */
export function speechLanguageName(code: string): string {
  switch (code) {
    case 'en':
      return t('speech.en');
    case 'ru':
      return t('speech.ru');
    case 'uz':
      return t('speech.uz');
    case 'tr':
      return t('speech.tr');
    case 'ar':
      return t('speech.ar');
    default:
      return t('speech.unknown');
  }
}

/**
 * The dictation languages as a PICKER lists them. English keeps the Mac's native names
 * (English, Русский, Oʻzbekcha) — the window has always shown them so — and the other three
 * name them in the interface language, short: "Английский", "Ruscha", "Ўзбекча".
 */
export function speechPickerName(code: string): string {
  switch (code) {
    case 'en':
      return t('speechPicker.en');
    case 'ru':
      return t('speechPicker.ru');
    case 'uz':
      return t('speechPicker.uz');
    case 'tr':
      return t('speechPicker.tr');
    case 'ar':
      return t('speechPicker.ar');
    default:
      return t('speech.unknown');
  }
}

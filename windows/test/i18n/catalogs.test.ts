// The interface language: four catalogs that must say the same things, each correctly in its
// own language, and a switch that reaches every surface built from them.

import { afterEach, describe, expect, it } from 'vitest';

import {
  APP_LANGUAGES,
  CATALOGS,
  LANGUAGE_CHOICES,
  formatDayMonth,
  formatLongDate,
  pluralCategory,
  resolveAppLanguage,
  setAppLanguage,
  t,
  tn,
} from '../../src/core/i18n/index.js';
import type { AppLanguage, MessageKey } from '../../src/core/i18n/index.js';
import { en } from '../../src/core/i18n/catalogs/en.js';
import { DEFAULT_SETTINGS } from '../../src/contracts/index.js';
import { validateSettingsField } from '../../src/core/settings/schema.js';
import { hotkeyName, inlineName, keycapLabels, bindingFor } from '../../src/core/hotkey/index.js';
import { formatMillis } from '../../src/core/stats/index.js';
import { LIFECYCLE_COPY } from '../../src/main/lifecycle.js';
import { liveStatus } from '../../src/main/live-status.js';
import { buildTrayMenu } from '../../src/main/menu-model.js';
import type { MenuInputs } from '../../src/main/menu-model.js';
import { pillState } from '../../src/main/pill-model.js';
import { appSections } from '../../src/main/settings-model.js';

const KEYS = Object.keys(en) as MessageKey[];

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((match) => match[1] ?? '').sort();
}

/**
 * Latin words a Cyrillic string may carry: product, model and key names, and the two sample
 * words the Uzbek polish warning quotes. Anything else in Latin letters is a missed translation.
 */
const LATIN_NAMES = new Set([
  'Kotiba', 'Kotib', 'KotibAI', 'Windows', 'Parakeet', 'Ultra', 'whisper', 'Whisper', 'large-v3-turbo',
  'small.en', 'whisper.cpp', 'ggml', 'Qwen3-1.7B', 'Telegram', 'Slack', 'Notion', 'Obsidian', 'Markdown',
  'API', 'WER', 'Ctrl', 'Shift', 'Alt', 'AltGr', 'Escape', 'F13', 'p90', 'MIT', 'Aziz', 'Nizom', 'STT',
  'uzbek_stt_v1', 'Ctrl+C', 'C', 'medium', 'kechqurun', 'keçşurun', 'cotta', 'bin', 'Start',
  // The pill style the owner named after it ("Siri: лепестки").
  'Siri',
  // The old Kotib's own tray item, quoted as it reads there: that app was English only.
  'Turn', 'Off', 'Always', 'On', 'Quit',
  // C4: Arabic's two engines, by their product names.
  'Cohere', 'FastConformer',
]);

function strayLatin(text: string): string[] {
  const words = text.replace(/\{[A-Za-z0-9_]+\}/gu, ' ').match(/[A-Za-zçş][A-Za-z0-9çş.+_-]*/gu) ?? [];
  return words.map((word) => word.replace(/[.-]+$/u, '')).filter((word) => !LATIN_NAMES.has(word));
}

afterEach(() => {
  setAppLanguage('en');
});

describe('the four catalogs', () => {
  it('are the four the picker offers, in its order', () => {
    expect(LANGUAGE_CHOICES.map((choice) => choice.id)).toEqual([...APP_LANGUAGES]);
    expect(LANGUAGE_CHOICES.map((choice) => choice.name)).toEqual([
      'Oʻzbekcha (Lotin)',
      'Ўзбекча (Кирилл)',
      'English',
      'Русский',
    ]);
  });

  for (const language of APP_LANGUAGES) {
    it(`${language}: every key, none extra, none empty, the same {placeholders}`, () => {
      const catalog = CATALOGS[language] as Readonly<Record<string, string>>;
      expect(Object.keys(catalog).sort()).toEqual([...KEYS].sort());
      for (const key of KEYS) {
        const text = catalog[key];
        expect(typeof text === 'string' && text.trim().length > 0, `${language} ${key} is empty`).toBe(true);
        expect(placeholders(text ?? ''), `${language} ${key}`).toEqual(placeholders(en[key]));
      }
    });
  }

  it('every plural has all four forms', () => {
    for (const key of KEYS.filter((each) => each.endsWith('.one'))) {
      const base = key.slice(0, -'.one'.length);
      for (const form of ['few', 'many', 'other']) expect(KEYS, `${base}.${form}`).toContain(`${base}.${form}`);
    }
  });

  it('never translates the product name', () => {
    for (const language of APP_LANGUAGES) {
      const catalog = CATALOGS[language] as Readonly<Record<string, string>>;
      for (const key of KEYS.filter((each) => en[each].includes('Kotiba'))) {
        expect(catalog[key], `${language} ${key}`).toContain('Kotiba');
      }
      for (const text of Object.values(catalog)) {
        expect(text).not.toMatch(/Котиба|Kotibа/u);
      }
    }
  });
});

describe('Uzbek orthography', () => {
  const latin = Object.entries(CATALOGS['uz-Latn']);
  const cyrillic = Object.entries(CATALOGS['uz-Cyrl']);

  it('Latin: oʻ and gʻ with the okina (U+02BB), the tutuq with U+02BC — never an ASCII or curly apostrophe', () => {
    for (const [key, text] of latin) {
      expect(text, key).not.toMatch(/['`’‘]/u);
      // An okina only ever follows o or g.
      for (const match of text.matchAll(/ʻ/gu)) {
        expect(text[(match.index ?? 0) - 1], `${key}: ${text}`).toMatch(/[oOgG]/u);
      }
    }
    expect(CATALOGS['uz-Latn']['s.good_morning']).toBe('Xayrli tong');
    expect(CATALOGS['uz-Latn']['mode.raw']).toBe('Soʻzma-soʻz');
    expect(CATALOGS['uz-Latn']['s.heads_up']).toBe('E\u02BCtibor bering');
  });

  it('Cyrillic: Uzbek letters, no okina, and Latin only for names', () => {
    for (const [key, text] of cyrillic) {
      expect(text, key).not.toMatch(/[ʻʼ'’]/u);
      expect(strayLatin(text), `${key}: ${text}`).toEqual([]);
    }
    const all = cyrillic.map(([, text]) => text).join(' ');
    for (const letter of ['ў', 'қ', 'ғ', 'ҳ']) expect(all).toContain(letter);
  });

  it('Cyrillic is proper Uzbek Cyrillic, not a letter-for-letter transliteration', () => {
    const c = CATALOGS['uz-Cyrl'];
    expect(c['s.app_language']).toBe('Интерфейс тили'); // loanword kept Russian: е, й
    expect(c['common.ready']).toBe('Тайёр'); // yy + o → йё
    expect(c['lang.modelsOnThisPc']).toBe('Шу компьютердаги моделлар'); // ь kept in компьютер
    expect(c['s.heads_up']).toBe('Эътибор беринг'); // word-initial э, tutuq → ъ
    expect(c['life.alwaysOnTitle']).toBe('Доим ёниқ');
    expect(c['s.good_evening']).toBe('Хайрли кеч');
  });

  it('Russian has no stray English', () => {
    for (const [key, text] of Object.entries(CATALOGS.ru)) {
      expect(strayLatin(text), `${key}: ${text}`).toEqual([]);
    }
  });
});

describe('choosing the language', () => {
  it('follows the system when the setting is empty, Latin for Uzbek unless it asks for Cyrillic', () => {
    expect(resolveAppLanguage('', ['ru-RU', 'en-US'])).toBe('ru');
    expect(resolveAppLanguage('', ['uz-UZ'])).toBe('uz-Latn');
    expect(resolveAppLanguage('', ['uz-Latn-UZ'])).toBe('uz-Latn');
    expect(resolveAppLanguage('', ['uz-Cyrl-UZ'])).toBe('uz-Cyrl');
    expect(resolveAppLanguage('', ['de-DE', 'ru'])).toBe('ru');
    expect(resolveAppLanguage('', ['de-DE', 'fr'])).toBe('en');
    expect(resolveAppLanguage('', [])).toBe('en');
  });

  it('a chosen language wins, and a value this build does not know follows the system', () => {
    expect(resolveAppLanguage('uz-Cyrl', ['ru-RU'])).toBe('uz-Cyrl');
    expect(resolveAppLanguage('tg', ['ru-RU'])).toBe('ru');
  });

  it('is a setting that ships as "follow the system" and accepts any string', () => {
    expect(DEFAULT_SETTINGS.appLanguage).toBe('');
    expect(validateSettingsField('appLanguage', 'uz-Cyrl').ok).toBe(true);
    expect(validateSettingsField('appLanguage', 42).ok).toBe(false);
  });
});

describe('numbers and dates', () => {
  it('uses Russian plural forms', () => {
    expect([1, 2, 5, 11, 21, 22, 25, 111].map((n) => pluralCategory('ru', n))).toEqual([
      'one', 'few', 'many', 'many', 'one', 'few', 'many', 'many',
    ]);
    setAppLanguage('ru');
    expect(tn('chart.dictations', 1)).toBe('1 диктовка');
    expect(tn('chart.dictations', 3)).toBe('3 диктовки');
    expect(tn('chart.dictations', 7)).toBe('7 диктовок');
    setAppLanguage('uz-Latn');
    expect(tn('chart.dictations', 7)).toBe('7 ta diktovka');
  });

  it('spells Uzbek months itself — ICU would print «M09»', () => {
    const date = new Date(2026, 8, 29, 15, 17);
    const expected: Readonly<Record<AppLanguage, string>> = {
      en: '29 September 2026',
      ru: '29 сентября 2026 г.',
      'uz-Latn': '2026-yil 29-sentabr',
      'uz-Cyrl': '2026-йил 29-сентябрь',
    };
    for (const language of APP_LANGUAGES) {
      setAppLanguage(language);
      expect(formatLongDate(date)).toBe(expected[language]);
      expect(formatDayMonth(date)).not.toMatch(/M\d/u);
    }
  });

  it('writes units and decimals in the language', () => {
    setAppLanguage('ru');
    expect(formatMillis(1_450)).toBe('1,4 с');
    setAppLanguage('uz-Cyrl');
    expect(formatMillis(180)).toBe('180 мс');
    setAppLanguage('en');
    expect(formatMillis(1_450)).toBe('1.4 s');
  });
});

describe('a switch reaches every surface', () => {
  const menuInputs: MenuInputs = {
    status: { kind: 'idle' },
    lastTranscript: null,
    blockers: [],
    modeFollowsApp: false,
    userPickedMode: null,
    activeModeKey: 'super',
    selectableModes: [],
    pinnedLanguage: null,
    pinnableLanguages: ['en', 'ru', 'uz'],
    languageOrder: ['uz', 'en', 'ru'],
    alwaysOn: false,
  };
  const label = (id: string): string => {
    const item = buildTrayMenu(menuInputs).find((each) => each.kind === 'item' && each.id === id);
    return item !== undefined && item.kind === 'item' ? item.label : '';
  };

  it('the tray menu', () => {
    expect(label('open')).toBe('Open Kotiba');
    setAppLanguage('ru');
    expect(label('open')).toBe('Открыть Kotiba');
    expect(label('language-uz')).toBe('узбекский');
    setAppLanguage('uz-Cyrl');
    expect(label('open')).toBe('Kotiba ойнасини очиш');
    expect(label('quit')).toBe('Kotiba дастуридан чиқиш');
  });

  it('the window’s sections, the copy tables, the status line and the pill', () => {
    setAppLanguage('uz-Latn');
    expect(appSections().map((section) => section.title)).toEqual([
      'Bosh sahifa', 'Tarix', 'Statistika', 'Rejimlar', 'Tillar', 'Tezkor tugma', 'Sozlamalar',
    ]);
    expect(LIFECYCLE_COPY.alwaysOnTitle).toBe('Doim yoniq');
    expect(liveStatus({ kind: 'idle' }, [], 'oʻng Ctrl').title).toBe('Tayyor');
    const pill = pillState({ kind: 'heardNothing' }, null);
    expect(pill.kind === 'attention' ? pill.message : '').toBe(CATALOGS['uz-Latn']['pill.heardNothing']);
    setAppLanguage('en');
    expect(appSections()[0]?.title).toBe('Home');
  });

  it('the hotkey’s name — but never the label written to the settings file', () => {
    setAppLanguage('ru');
    expect(hotkeyName(163)).toBe('Правый Ctrl');
    expect(inlineName(163)).toBe('правый Ctrl');
    expect(keycapLabels(163)).toEqual(['правый', 'Ctrl']);
    expect(bindingFor(163)).toEqual({ vk: 163, label: 'Right Ctrl' });
  });

  it('t() falls back to English, never to a bare key', () => {
    setAppLanguage('uz-Cyrl');
    expect(t('menu.open')).not.toBe('menu.open');
  });
});

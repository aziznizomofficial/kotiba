// The error taxonomy, and the sentence each case shows the user.
//
// Ported from `SessionFailure` + `DictationController.describe(_:)`
// (Sources/KotibaCore/DictationSession.swift:32, Sources/KotibaUI/DictationController.swift:1188)
// and `EngineFailure` (Sources/KotibaEngines/AppleSpeechEngine.swift:203).
//
// The contract the macOS tests pin, and the one that matters here: for EVERY case the
// message is non-empty, longer than 12 characters, names its subject, and contains no
// `Optional(` and no `Error Domain`. "an error occurred" cost days on the predecessor.
//
// The message is a FIELD, not something a caller formats. Nine modules construct these;
// nine hand-written copies of a sentence is how the copies drift.

// The one import from outside contracts: the sentences are shown to the user, so they are in
// the interface language. `core/i18n` is pure and imports nothing back from here.
import { speechLanguageName, t } from '../core/i18n/index.js';

import type { EngineFamily, Language } from './language.js';

/**
 * Why a dictation ended badly. One case per way the pipeline can fail, and each carries
 * everything needed to say so.
 *
 * `noEngineReady` carries BOTH the family and the language deliberately. `unified`
 * covers English and Russian, so a failure carrying only the family made the UI guess,
 * and it guessed English every time — a missing Russian model was reported as "The
 * English engine is not ready yet.", which points the user at the one thing that works.
 */
export type DictationError =
  | { readonly kind: 'armingFailed'; readonly why: string; readonly message: string }
  | { readonly kind: 'captureFailed'; readonly why: string; readonly message: string }
  | {
      readonly kind: 'noEngineReady';
      readonly family: EngineFamily;
      readonly language: Language;
      readonly message: string;
      /**
       * D-W25: set when the engine is not here because its download is still running — whole
       * percent. The message then says so ("still downloading, 42 %") instead of "not ready".
       */
      readonly percent?: number;
    }
  | { readonly kind: 'transcriptionFailed'; readonly why: string; readonly message: string }
  | { readonly kind: 'insertionRefused'; readonly why: string; readonly message: string }
  | { readonly kind: 'insertionTimedOut'; readonly message: string };

export type DictationErrorKind = DictationError['kind'];

/**
 * The engine-not-ready sentence, keyed on the LANGUAGE and never on the family.
 * Keying off the family alone is the shipped bug described above.
 */
const NO_ENGINE_READY: Readonly<Record<Language, string>> = {
  get en(): string {
    return t('err.noEngine.en');
  },
  get ru(): string {
    return t('err.noEngine.ru');
  },
  get uz(): string {
    return t('err.noEngine.uz');
  },
  get tr(): string {
    return t('err.noEngine.tr');
  },
  get ar(): string {
    return t('err.noEngine.ar');
  },
};

/** Constructors. Use these; do not hand-write the message. */
export const dictationError = {
  armingFailed(why: string): DictationError {
    return { kind: 'armingFailed', why, message: t('err.armingFailed', { why }) };
  },
  captureFailed(why: string): DictationError {
    return { kind: 'captureFailed', why, message: t('err.captureFailed', { why }) };
  },
  noEngineReady(family: EngineFamily, language: Language): DictationError {
    return { kind: 'noEngineReady', family, language, message: NO_ENGINE_READY[language] };
  },
  /** No engine yet because its download is under way (D-W25): calm, with how far it has got. */
  gettingReady(family: EngineFamily, language: Language, percent: number): DictationError {
    return {
      kind: 'noEngineReady',
      family,
      language,
      percent,
      message: t('err.gettingReady', { language: speechLanguageName(language), percent: String(percent) }),
    };
  },
  transcriptionFailed(why: string): DictationError {
    return { kind: 'transcriptionFailed', why, message: t('err.transcriptionFailed', { why }) };
  },
  insertionRefused(why: string): DictationError {
    return { kind: 'insertionRefused', why, message: t('err.insertionRefused', { why }) };
  },
  insertionTimedOut(): DictationError {
    return { kind: 'insertionTimedOut', message: t('err.insertionTimedOut') };
  },
} as const;

/**
 * The same failure in the few words the pill has room for — what went wrong, never why. The
 * why is in `message`, which Home shows. The Mac's `DictationController.pillHeadline`.
 */
export function dictationErrorHeadline(error: DictationError): string {
  switch (error.kind) {
    case 'armingFailed':
      return t('pill.failed.microphone');
    case 'captureFailed':
      return t('pill.failed.recording');
    case 'noEngineReady':
      if (error.percent !== undefined) return t('pill.gettingReady', { percent: String(error.percent) });
      return error.language === 'en'
        ? t('pill.failed.englishNotReady')
        : error.language === 'ru'
          ? t('pill.failed.noRussianModel')
          : t('pill.failed.noUzbekModel');
    case 'transcriptionFailed':
      return t('pill.failed.transcription');
    case 'insertionRefused':
      return t('pill.failed.paste');
    case 'insertionTimedOut':
      return t('pill.failed.pasteTimedOut');
  }
}

/**
 * Why an engine could not run. Thrown by `SttEngine.prepare` and `SttEngine.transcribe`.
 *
 * `modelMissing` and `modelCorrupt` are SEPARATE cases, and that separation is D-W10:
 * `--check` must distinguish "models not installed" from "model file corrupt" with a
 * flag set by the component that knows, never by matching on an error message. That
 * exact bug shipped in `ai-balance/windows`, where `no GONKA_API_KEY / GONKA_BASE_URL
 * stored` failed the regex `no [A-Z_]+ stored` and a healthy app exited non-zero.
 *
 * macOS `.localeUnsupported` and `.assetsUnavailable` are NOT ported: the first has no
 * thrower anywhere in the Swift tree, and the second belongs to `AppleSpeechEngine`,
 * which does not exist on Windows (D-W2). `hostUnavailable` is new, because D-W7 makes
 * the engine a separate process that can die.
 */
export type EngineError =
  | { readonly kind: 'notReady'; readonly why: string; readonly reason: string }
  | {
      readonly kind: 'languageUnsupported';
      readonly language: Language;
      readonly engineId: string;
      readonly reason: string;
    }
  | { readonly kind: 'noEngineInstalled'; readonly language: Language; readonly reason: string }
  | { readonly kind: 'modelMissing'; readonly path: string; readonly reason: string }
  | {
      readonly kind: 'modelCorrupt';
      readonly path: string;
      readonly why: string;
      readonly reason: string;
    }
  | { readonly kind: 'hostUnavailable'; readonly why: string; readonly reason: string }
  | { readonly kind: 'transcriptionFailed'; readonly why: string; readonly reason: string };

export type EngineErrorKind = EngineError['kind'];

export const engineError = {
  notReady(why: string): EngineError {
    return { kind: 'notReady', why, reason: `the engine is not ready: ${why}` };
  },
  languageUnsupported(language: Language, engineId: string): EngineError {
    return {
      kind: 'languageUnsupported',
      language,
      engineId,
      reason: `${engineId} does not support ${language} — the router misrouted`,
    };
  },
  noEngineInstalled(language: Language): EngineError {
    return {
      kind: 'noEngineInstalled',
      language,
      reason: `no ${language} model is installed — download it in Settings › Languages`,
    };
  },
  modelMissing(path: string): EngineError {
    return { kind: 'modelMissing', path, reason: `no model at ${path}` };
  },
  modelCorrupt(path: string, why: string): EngineError {
    return { kind: 'modelCorrupt', path, why, reason: `the model at ${path} cannot be used: ${why}` };
  },
  hostUnavailable(why: string): EngineError {
    return { kind: 'hostUnavailable', why, reason: `the speech engine stopped responding: ${why}` };
  },
  transcriptionFailed(why: string): EngineError {
    return { kind: 'transcriptionFailed', why, reason: `transcription failed: ${why}` };
  },
} as const;

/**
 * An `EngineError` as a thrown value. `throw`ing a plain object loses the stack and
 * confuses every `catch`, so engines throw this and callers read `.failure`.
 */
export class EngineFailure extends Error {
  readonly failure: EngineError;

  constructor(failure: EngineError) {
    super(failure.reason);
    this.name = 'EngineFailure';
    this.failure = failure;
  }
}

/** Narrowing helper for a `catch (e: unknown)`. */
export function asEngineError(error: unknown): EngineError | null {
  return error instanceof EngineFailure ? error.failure : null;
}

/**
 * Why the microphone would not open. Reported through state by `warmUp`, which cannot
 * throw, and rethrown with its type intact by `start` — a permission denial must stay a
 * permission denial, or it reaches the user as `engineFailedToStart("permissionDenied")`.
 */
export type MicrophoneError =
  | { readonly kind: 'permissionDenied'; readonly reason: string }
  | { readonly kind: 'noInputAvailable'; readonly reason: string }
  | { readonly kind: 'engineFailedToStart'; readonly why: string; readonly reason: string }
  | { readonly kind: 'conversionFailed'; readonly why: string; readonly reason: string };

export const microphoneError = {
  permissionDenied(): MicrophoneError {
    return {
      kind: 'permissionDenied',
      reason: 'Windows has not given Kotiba the microphone — Settings › Privacy & security › Microphone',
    };
  },
  noInputAvailable(): MicrophoneError {
    return { kind: 'noInputAvailable', reason: 'there is no usable input device' };
  },
  engineFailedToStart(why: string): MicrophoneError {
    return { kind: 'engineFailedToStart', why, reason: `the audio graph would not start: ${why}` };
  },
  conversionFailed(why: string): MicrophoneError {
    return { kind: 'conversionFailed', why, reason: `the audio could not be converted: ${why}` };
  },
} as const;

/** Thrown form of a `MicrophoneError`, for the same reason as `EngineFailure`. */
export class MicrophoneFailure extends Error {
  readonly failure: MicrophoneError;

  constructor(failure: MicrophoneError) {
    super(failure.reason);
    this.name = 'MicrophoneFailure';
    this.failure = failure;
  }
}

export function asMicrophoneError(error: unknown): MicrophoneError | null {
  return error instanceof MicrophoneFailure ? error.failure : null;
}

/**
 * A refusal to write text into the foreground application. Never a throw: the caller
 * always has to record the reason and carry on.
 */
export type InsertionOutcome =
  | { readonly kind: 'inserted' }
  | { readonly kind: 'refused'; readonly reason: string };

/** The refusal sentences, verbatim from `PasteboardSink` and `TextReplacement`. */
export const INSERTION_REFUSALS = {
  empty: 'nothing to insert',
  nothingToReplace: 'nothing to replace',
  clipboardRefused: 'the clipboard refused the text',
  clipboardStolen: 'another app overwrote the clipboard mid-insertion',
  /** macOS blames Input Monitoring here. Windows needs no such grant (D-W8). */
  couldNotSendKeys: 'could not send the paste keystroke',
  moved: 'the text moved or was edited after Kotiba typed it',
  notEditable: 'this app does not expose its text field to Kotiba',
} as const;

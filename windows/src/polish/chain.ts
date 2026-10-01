// What `SessionPorts.createPolishChain` builds in the app: the Mac's
// `DictationController.makePolisher` for a machine with no cloud endpoint.
//
// A built-in mode (Super, Message, Note) gets a `ModePolisher` — its deterministic half
// ALWAYS, and Qwen3-1.7B for the half that needs a model when the GGUF is installed and
// `preferOnDeviceModel` is on. Raw gets nothing: it is exactly what was said. The cloud
// endpoint the Mac can fall back to is not ported (Windows 1.0 has no polish key UI in
// use), so a missing model is never "broken": the chain is always configured, and the
// model's absence only means the rules run alone — which the Modes pane says.

import type { Language, Mode } from '../contracts/index.js';
import type { PolishPrompt } from '../core/modes/index.js';
import { modeBehaviour } from '../core/modes/index.js';
import type { CreatePolishChain, PolishChain } from '../session/ports.js';
import { NO_POLISH } from '../session/ports.js';

import { ModePolisher, type PromptedPolisher } from './incremental.js';

export interface OnDevicePolishChainOptions {
  /** The model, when its GGUF is installed. Asked per dictation, so a download that lands is picked up. */
  readonly model: () => PromptedPolisher | null;
  /**
   * Arabic's own modes model (Gemma 4 E2B, C4 §14.5), when Arabic is on and its GGUF is
   * installed. It claims Arabic only and is asked first; every other language goes to `model`.
   */
  readonly arabicModel?: () => PromptedPolisher | null;
}

/**
 * Several models behind one, picked by language — the Mac's `CompositePolisher`, first that
 * claims the language wins. `prepare` warms only the one that will answer, so Arabic's 3.1 GB
 * model is not loaded for an English dictation.
 */
export class LanguageRoutedPolisher implements PromptedPolisher {
  readonly id: string;
  readonly supportedLanguages: ReadonlySet<Language>;
  private readonly members: readonly PromptedPolisher[];

  constructor(members: readonly PromptedPolisher[]) {
    this.members = members;
    this.id = members.map((member) => member.id).join('+');
    this.supportedLanguages = new Set(members.flatMap((member) => [...member.supportedLanguages]));
  }

  private memberFor(language: Language): PromptedPolisher | null {
    return this.members.find((member) => member.supportedLanguages.has(language)) ?? null;
  }

  generate(text: string, language: Language, prompt: PolishPrompt, maxOutputTokens: number, signal: AbortSignal): Promise<string> {
    const member = this.memberFor(language);
    if (member === null) return Promise.reject(new Error(`no modes model claims ${language}`));
    return member.generate(text, language, prompt, maxOutputTokens, signal);
  }

  async prepare(prompts: readonly PolishPrompt[], language?: Language): Promise<void> {
    const member = language === undefined ? this.members[0] : this.memberFor(language);
    await member?.prepare?.(prompts, language);
  }
}

export function createOnDevicePolishChain(options: OnDevicePolishChainOptions): CreatePolishChain {
  return ({ mode, settings }: { readonly mode: Mode; readonly settings: { readonly preferOnDeviceModel: boolean } }): PolishChain => {
    const behaviour = modeBehaviour(mode);
    if (behaviour === null || behaviour === 'raw') return NO_POLISH;
    const members = settings.preferOnDeviceModel
      ? [options.arabicModel?.() ?? null, options.model()].filter((member): member is PromptedPolisher => member !== null)
      : [];
    const engine = members.length === 0 ? null : members.length === 1 ? members[0]! : new LanguageRoutedPolisher(members);
    return { polisher: new ModePolisher({ behaviour, engine }), notConfigured: false, reason: null };
  };
}

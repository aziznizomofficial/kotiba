// Which model serves which language, and their whole lifetime: build from settings,
// rebuild when the inputs change, preload on a press when the setting asks, and — a
// deliberate Windows ADDITION — drop a model that has not been used in a while.
//
// Ported from `CompositeEngine` (Sources/KotibaEngines/CompositeEngine.swift:21) and the
// engine ownership scattered through `DictationController`.
//
// ---------------------------------------------------------------------------------
// READINESS MUST NOT LIE
// ---------------------------------------------------------------------------------
//
// The macOS composite computed `isReady()` as an OR over its members. Apple's engine is
// prepared at startup and never unloads, so it returned TRUE FOREVER whatever state the
// Russian model was in — the session's own cold-start retry never fired, and Russian
// stayed broken one level below the fix that was supposed to have fixed it.
//
// Two rules follow, and both are implemented here:
//
//   1. A wrapper's `isReady()` is an AND, not an OR. It may not claim readiness it does
//      not have. This costs nothing, because `false` is a TRIGGER and not a gate: the
//      caller calls `prepare()` and re-asks.
//   2. `transcribe` owns loading its own cold members. A member that is merely cold gets
//      LOADED, not skipped. Before that, every Russian dictation failed on stock
//      defaults because nothing on that path ever called `prepare()`.
//
// And `readiness()` does not ask the engines at all. It re-asks the real question — is
// there a usable model file for this role — of the model store, which is the component
// that knows.

import {
  EngineFailure,
  TURKISH_HEAD_MARGIN,
  engineError,
  engineFamilyFor,
  type AcousticClassifier,
  type AudioBuffer,
  type CreateEngineManager,
  type EngineFamily,
  type EngineManager,
  type EngineReadiness,
  type Language,
  type ModelId,
  type ModelRole,
  type ModelStatus,
  type ModelStore,
  type Settings,
  type StreamingSttEngine,
  type SttEngine,
  type TranscriptionStream,
  type TranscriptResult,
} from '../contracts/index.js';
import { vocabularyHint } from '../core/text/index.js';
import { detectionWanted, enabledSubset } from '../core/settings/models.js';
import { subsetFallback, subsetFamilies } from '../core/routing/language-subset.js';
import { settingPathFor } from './model-store.js';
import type { CreateSttEngineForRole, SegmentDecodingEngine } from './stt-engine.js';
import { whisperParamsFor } from './params.js';

/**
 * IDLE UNLOAD IS A WINDOWS ADDITION, NOT PARITY.
 *
 * The wiring audit found `WhisperEngine.unload()` has NO CALLER: the macOS app never
 * unloads a model once loaded. It is worth having here anyway — 1.1 GB of resident
 * weights on a low-RAM laptop is a different situation from an M4 Pro — but it is a new
 * behaviour and it DEFAULTS OFF, because the cost of getting it wrong is a slow
 * dictation for a user who never asked for the memory back.
 */
export interface IdleUnloadPolicy {
  readonly enabled: boolean;
  /** Milliseconds since the last decode on that engine. */
  readonly afterMs: number;
  /** How often to look. Defaults to a quarter of `afterMs`, floored at 30 s. */
  readonly sweepEveryMs?: number;
}

export const DEFAULT_IDLE_UNLOAD: IdleUnloadPolicy = {
  enabled: false,
  afterMs: 10 * 60 * 1_000,
};

export interface EngineManagerDeps {
  readonly settings: Settings;
  readonly models: ModelStore;
  /**
   * Widened from `CreateSttEngine` so the manager can state each engine's languages
   * (FINDING 7 — see `Member.languages`). BACKWARD COMPATIBLE: the extra field is
   * optional, so a plain `CreateSttEngine` is still assignable here and a factory that
   * ignores it still compiles. What it must not do is contradict it.
   */
  readonly createEngine: CreateSttEngineForRole;
  /** `null`/absent means no detector: `detector()` returns null and routing falls back. */
  readonly createClassifier?: (options: {
    readonly modelPath: string;
  }) => AcousticClassifier & { dispose: () => Promise<void> };
  /** Logical processors. See `resolveDecodeCores` for why this is not fed raw. */
  readonly cpuCount?: number;
  readonly idleUnload?: IdleUnloadPolicy;
  readonly onNote?: (note: string) => void;
  /** Injected in tests so an idle timeout does not need a real ten minutes. */
  readonly now?: () => number;
  /**
   * The unified family's LEAD: Parakeet Ultra on ONNX Runtime (`parakeet.ts`), first for
   * English and Russian, with the whisper members behind it for a machine where it cannot
   * load — the Mac's `.unified` slot, member for member. D-W25: the installer no longer
   * carries turbo, so before Parakeet's download lands there is usually NO member behind it
   * (turbo is there only when Turkish or Arabic brought it), and a press says "still
   * downloading, NN %" (`SessionDeps.gettingReady`). Owned by the composition root, so a rebuild keeps it: it is
   * not built from a model path, and re-creating it would drop a 700 MB load.
   */
  readonly unifiedLead?: UnifiedLead;
  /**
   * The Arabic family's lead (C4): Cohere or FastConformer (`arabic.ts`), with whisper turbo
   * and its Arabic prompt behind it for the window before the download lands. Owned by the
   * composition root like Parakeet. After every build it is handed that whisper member
   * (`attachFallback`) — the decode-loop guard's re-decoder, and the host its Silero runs in.
   */
  readonly arabicLead?: UnifiedLead & {
    readonly engine: StreamingSttEngine & { attachFallback?(engine: SttEngine | null): void };
  };
}

/** A streaming engine that heads a family, and the question "is it installed". */
export interface UnifiedLead {
  readonly engine: StreamingSttEngine;
  /** `ready` once its weights are on disk and verified. */
  status(): Promise<ModelStatus>;
}

/**
 * The catalogue entry behind each role, for the readiness fallback below. `uzbek` maps
 * to `uzbek_stt_v1` and not to `navoi-medium`: both files are 539,212,484 bytes with
 * DIFFERENT sha256s, and uzbek-stt-v1 is the one that ships (21.68% WER against 25.19%).
 */
const CATALOGUE_ID_FOR_ROLE: Readonly<Record<ModelRole, ModelId | null>> = {
  uzbek: 'uzbek_stt_v1',
  russian: 'large_v3_turbo',
  detector: 'base_detector',
  fastEnglish: 'small_en',
};

/** Which model role serves a language, given the Fast English setting. */
export function roleFor(language: Language, settings: Settings): ModelRole {
  if (language === 'uz') return 'uzbek';
  // C4: Turkish IS whisper large-v3-turbo — the file downloaded with Turkish or Arabic (D-W25).
  // Arabic's whisper member is that file too, behind its own lead.
  if (language === 'tr' || language === 'ar') return 'russian';
  // D-W2: English's whisper member is `large-v3-turbo` — the same model as Russian — when it
  // is on this PC (D-W25: only with Turkish or Arabic); Parakeet heads the family. Fast
  // English swaps in `small.en` when the user asks and the file is there; not the default.
  if (language === 'en' && settings.fastEnglish) return 'fastEnglish';
  return 'russian';
}

/** Every role a family can call on, best first. */
function rolesForFamily(family: EngineFamily, settings: Settings): readonly ModelRole[] {
  if (family === 'uzbek') return ['uzbek'];
  if (family === 'turkish' || family === 'arabic') return ['russian'];
  // Order is a preference, not a fallback in the dangerous sense: it never substitutes a
  // different LANGUAGE, only a different engine for the language that was asked for.
  return settings.fastEnglish ? ['fastEnglish', 'russian'] : ['russian'];
}

/**
 * The user's terms for one language, tidied the way `Vocabulary.tidy` does it
 * (TextPipeline.swift:99-105): trimmed, empties dropped, de-duplicated case-insensitively
 * with the FIRST spelling kept.
 *
 * `vocabularyHint` documents that it expects tidied terms, and nothing on the Windows
 * settings path tidies them — the schema is a bare `record(string, array(string))`. Raw,
 * a list like `['', ' Kotiba ', 'kotiba']` becomes the hint `", Kotiba , kotiba."`, which is
 * a model of badly-typed prose handed to the decoder as an example of what to produce.
 */
function tidyTerms(terms: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const tidied: string[] = [];
  for (const term of terms) {
    const trimmed = term.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tidied.push(trimmed);
  }
  return tidied;
}

/**
 * Which languages a member will accept: its role's, except in the two families whose whisper
 * member is the turbo file serving ONE language each — the file is shared, the job is not.
 */
function languagesForMember(family: EngineFamily, role: ModelRole): readonly Language[] {
  if (family === 'turkish') return ['tr'];
  if (family === 'arabic') return ['ar'];
  return languagesForRole(role);
}

/** Which languages a role's engine will accept. */
function languagesForRole(role: ModelRole): readonly Language[] {
  switch (role) {
    case 'uzbek':
      return ['uz'];
    case 'fastEnglish':
      return ['en'];
    case 'russian':
      return ['en', 'ru'];
    case 'detector':
      return [];
  }
}

interface Member {
  /** `lead` is the unified family's streaming head (`EngineManagerDeps.unifiedLead`). */
  readonly role: ModelRole | 'lead';
  readonly modelPath: string;
  /**
   * `languagesForRole(role)`, and the ONE authority on what this member may decode.
   *
   * FINDING 7. This used to be read back off `engine.supportedLanguages`, which the
   * composition roots computed from the model's FILENAME — `includes('uzbek') ||
   * includes('navoi') ? ['uz'] : ['en','ru']`. Two ways that is wrong, both silent:
   *
   *   * Fast English on makes `small.en` the FIRST member of the unified family. Its
   *     engine id is `whisper-ggml-small.en-q5_1`, which contains neither string, so it
   *     claimed `['en','ru']` and won the scan for Russian audio — decoded by a model
   *     that has no Russian in it, and the transcript comes back confident.
   *   * A user pointing `uzbekModelPath` at any valid ggml not named `*uzbek*`/`*navoi*`
   *     gave the uzbek family a single member claiming `['en','ru']`, so every Uzbek
   *     dictation threw `noEngineInstalled('uz')` against a model that was right there.
   *
   * The role is what the model store resolved the file FOR, so it is the fact, and it is
   * known here. It is also handed to the factory so the engine's own guard agrees.
   */
  readonly languages: readonly Language[];
  readonly engine: SttEngine;
  lastUsedAt: number;
}

/**
 * The family slot: an ordered member list, first capable-and-loadable wins, and every
 * choice recorded in `engineId` so a substitution is never silent.
 */
function createFamilyEngine(
  family: EngineFamily,
  members: readonly Member[],
  note: (note: string) => void,
  now: () => number,
): SttEngine {
  // From the ROLES, not from what each engine says about itself. See `Member.languages`.
  const supported = new Set<Language>();
  for (const member of members) {
    for (const language of member.languages) supported.add(language);
  }

  // The first member that can stream, if any. A family with none is plain batch — it does
  // not claim `openStream`, so the session opens nothing for it (`isStreamingEngine`).
  const streaming = members.find((member) => typeof (member.engine as Partial<StreamingSttEngine>).openStream === 'function');
  const family_: SttEngine & StreamingSttEngine = {
    engineId: `${family}(${members.map((member) => member.engine.engineId).join(', ')})`,
    supportedLanguages: supported,

    /**
     * AND over the members that would be USED, not OR. See the header. A wrapper may not
     * claim readiness it does not have, and an empty member list is not ready either.
     *
     * "Would be used": walking in order, a member whose every language an earlier RESIDENT
     * member already covers is never reached by `transcribe`, so its being cold says
     * nothing about this dictation. That is what lets a resident Parakeet make the unified
     * family ready without loading the 800 MB whisper model behind it — which a plain AND
     * would demand on every press, and a plain OR would lie about.
     */
    isReady: async () => {
      if (members.length === 0) return false;
      const covered = new Set<Language>();
      for (const member of members) {
        if (member.languages.every((language) => covered.has(language))) continue;
        if (!(await member.engine.isReady())) return false;
        for (const language of member.languages) covered.add(language);
      }
      return true;
    },

    /**
     * Prepares every member. One failing does not stop the others: an app with no
     * Russian model must still dictate English.
     *
     * CONCURRENTLY. Each member owns its own host process, so the loads do not contend
     * for a lock — they contend for disk, and a sequential loop simply adds the members'
     * read times together. On the eager-preload path with Fast English on that is
     * `small.en` (~180 MB) THEN `large-v3-turbo` (~800 MB) one after the other, and the
     * user is holding a hotkey through the sum of them.
     */
    prepare: async () => {
      // A LEAD goes first, alone. When it loads, the members behind it that cover nothing
      // it does not are left cold — they are its fallback, and loading them anyway puts a
      // second 800 MB model in memory for nothing. When it cannot (still downloading, say),
      // every other member prepares, exactly as before.
      let rest: readonly Member[] = members;
      const lead = members[0];
      if (lead !== undefined && lead.role === 'lead') {
        try {
          await lead.engine.prepare();
          rest = members
            .slice(1)
            .filter((member) => !member.languages.every((language) => lead.languages.includes(language)));
          if (rest.length === 0) return;
        } catch (error) {
          note(`${family}: ${lead.engine.engineId} not ready — ${error instanceof Error ? error.message : String(error)}`);
          rest = members.slice(1);
          if (rest.length === 0) throw error;
        }
      }
      const settled = await Promise.allSettled(
        rest.map((member) => member.engine.prepare()),
      );
      const failures: string[] = [];
      settled.forEach((outcome, index) => {
        if (outcome.status !== 'rejected') return;
        const reason: unknown = outcome.reason;
        failures.push(
          `${rest[index]?.engine.engineId ?? 'unknown'}: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      });
      // Only a TOTAL failure is a failure. Anything less and the app still works for
      // something, which is better than refusing to start.
      if (rest.length > 0 && failures.length === rest.length) {
        throw new EngineFailure(engineError.notReady(failures.join('; ')));
      }
    },

    transcribe: async (audio: AudioBuffer, language: Language, signal?: AbortSignal): Promise<TranscriptResult> => {
      const notReady: string[] = [];
      for (const member of members) {
        // The member's ROLE decides, not the engine's self-report. See `Member.languages`.
        if (!member.languages.includes(language)) continue;

        // A member that is merely COLD gets loaded, not skipped. This is the fix that
        // made Russian work; before it, `isReady() === false` sent a perfectly good
        // model straight into `notReady`.
        if (!(await member.engine.isReady())) {
          try {
            await member.engine.prepare();
          } catch (error) {
            notReady.push(
              `${member.engine.engineId} (${error instanceof Error ? error.message : String(error)})`,
            );
            continue;
          }
          if (!(await member.engine.isReady())) {
            notReady.push(member.engine.engineId);
            continue;
          }
        }
        member.lastUsedAt = now();
        return member.engine.transcribe(audio, language, signal);
      }

      if (notReady.length > 0) {
        throw new EngineFailure(
          engineError.notReady(
            `${notReady.join(', ')} can do ${language} but ${notReady.length === 1 ? 'is' : 'are'} not loaded`,
          ),
        );
      }
      // "No member claims this language" is a SETUP fact, not a design one. Reporting it
      // as `languageUnsupported` told the user the router had misrouted when all they had
      // done was never choose a model.
      note(`${family}: no member claims ${language}`);
      throw new EngineFailure(engineError.noEngineInstalled(language));
    },

    /**
     * Stream through the first member that can, for the languages it claims; otherwise, or
     * when that fails, the family's ordinary member-by-member `transcribe` runs on the
     * finalised recording — so a stream never narrows what the slot could have done in
     * batch. The Mac's `CompositeEngine.openStream`.
     */
    openStream: (): TranscriptionStream => {
      const inner = streaming === undefined ? null : (streaming.engine as StreamingSttEngine).openStream();
      return {
        append: (samples) => inner?.append(samples),
        cancel: () => inner?.cancel(),
        onCommit: (listener) => inner?.onCommit?.(listener) ?? (() => undefined),
        finish: async (audio, language) => {
          if (streaming !== undefined && inner !== null && streaming.languages.includes(language)) {
            try {
              const result = await inner.finish(audio, language);
              streaming.lastUsedAt = now();
              return result;
            } catch (error) {
              // Not ready (still downloading, say) or a decode that failed: the slot's other
              // members get their turn on the same audio, exactly as in batch.
              note(`${family}: stream through ${streaming.engine.engineId} failed — ${error instanceof Error ? error.message : String(error)}`);
            }
          } else {
            inner?.cancel();
          }
          return family_.transcribe(audio, language);
        },
      };
    },

    dispose: async () => {
      // The lead belongs to the composition root and outlives a rebuild.
      for (const member of members) if (member.role !== 'lead') await member.engine.dispose();
    },
  };
  if (streaming === undefined) {
    const { openStream: _unused, ...batch } = family_;
    return batch;
  }
  return family_;
}

/** The manager, plus the idle sweep, which is not part of the shared contract. */
export type ManagedEngines = EngineManager & { sweepIdleNow(): Promise<number> };

export function createEngineManagerWith(deps: EngineManagerDeps): ManagedEngines {
  const note = deps.onNote ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const idlePolicy = deps.idleUnload ?? DEFAULT_IDLE_UNLOAD;

  let settings = deps.settings;
  /** Members per family, and the family engine wrapping them. */
  let families = new Map<EngineFamily, { members: Member[]; engine: SttEngine }>();
  let classifier: (AcousticClassifier & { dispose: () => Promise<void> }) | null = null;
  let classifierPath: string | null = null;
  /** What the current build was built from, so `reconfigure` knows if anything moved. */
  let builtFrom = '';
  /** The build chain. Never null: builds are serialised, not deduplicated. */
  let building: Promise<void> = Promise.resolve();
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  /** Everything a rebuild would have to notice. */
  function fingerprint(current: Settings, paths: ReadonlyMap<ModelRole, string | null>): string {
    return JSON.stringify({
      paths: [...paths.entries()].sort(),
      useGpu: current.whisperUseGPU,
      beam: current.whisperBeamSize,
      fastEnglish: current.fastEnglish,
      autoDetect: detectionWanted(current),
    });
  }

  /**
   * The `initial_prompt` for one language, from the LIVE settings.
   *
   * This was hard-coded `null`, so the vocabulary pane wrote terms that reached nothing
   * while its own help text promised they would bias the decoder. What it costs is
   * measured on the 344-clip Uzbek set (02-BEHAVIOUR §4, TextPipeline.swift:112-145):
   * the exemplar sentence alone moves punctuation emission from 68.3% to 88.4%, and a
   * punctuated term list plus the exemplar to 91.0%. Punctuation is not cosmetic here —
   * the capitaliser finds sentence starts by looking for `.`, `!` and `?`, so
   * punctuation the model never emitted is also every capital after the first one.
   *
   * Per LANGUAGE and not per engine, because D-W2 puts English and Russian on the same
   * `large-v3-turbo`: the hint is decoder context, and a Russian exemplar in front of
   * English audio biases the decoder toward Russian.
   *
   * Uzbek gets the exemplar even with no terms configured, and English gets nothing at
   * all without them. Both of those live in `vocabularyHint`, which is where the numbers
   * that justify them are recorded; this function only supplies the terms.
   */
  function promptFor(language: Language): string | null {
    return vocabularyHint(tidyTerms(settings.vocabulary[language] ?? []), language);
  }

  async function resolvePaths(current: Settings): Promise<Map<ModelRole, string | null>> {
    const roles: ModelRole[] = ['uzbek', 'russian', 'detector', 'fastEnglish'];
    const paths = new Map<ModelRole, string | null>();
    for (const role of roles) paths.set(role, await deps.models.resolve(role, current));
    return paths;
  }

  async function build(): Promise<void> {
    // SNAPSHOT, once, at the top. `settings` is a live binding that `reconfigure` writes,
    // and this function has several suspension points; reading it again further down
    // means the paths, the roles, the params and the fingerprint can each describe a
    // different generation of settings. `builtFrom` would then record a fingerprint that
    // matches nothing that was actually built, and the next rebuild would be decided by
    // comparing against it.
    // Builds are queued now rather than deduplicated, so one can still be waiting when
    // `dispose()` runs. Building engines into a disposed manager would leave host
    // processes nobody owns and nobody will ever shut down.
    if (disposed) return;
    const current = settings;
    const paths = await resolvePaths(current);
    const next = fingerprint(current, paths);
    if (next === builtFrom && families.size > 0) return;

    const previous = families;
    const rebuilt = new Map<EngineFamily, { members: Member[]; engine: SttEngine }>();

    for (const family of ['uzbek', 'unified', 'turkish', 'arabic'] as const) {
      const members: Member[] = [];
      // Kept across rebuilds: a lead is the composition root's, not built from a path.
      const lead = family === 'unified' ? deps.unifiedLead : family === 'arabic' ? deps.arabicLead : undefined;
      if (lead !== undefined) {
        const kept = previous.get(family)?.members.find((member) => member.role === 'lead');
        const languages: readonly Language[] = family === 'arabic' ? ['ar'] : ['en', 'ru'];
        members.push(kept ?? { role: 'lead', modelPath: '', languages, engine: lead.engine, lastUsedAt: now() });
      }
      for (const role of rolesForFamily(family, current)) {
        const modelPath = paths.get(role) ?? null;
        if (modelPath === null) continue;

        const languages = languagesForMember(family, role);
        const primary = languages[0] ?? 'en';
        // Params are per FAMILY — that is where D-W11's beam width lives. The language
        // is per call, and the engine overrides it on the way to the host; so is the
        // vocabulary hint, for the same reason and by the same route.
        const params = whisperParamsFor({
          language: primary,
          family,
          settings: current,
          // The primary language's hint, so a params dump in the diagnostics pane is not
          // a lie. `initialPromptFor` below is what actually reaches whisper.
          initialPrompt: promptFor(primary),
          cpuCount: deps.cpuCount ?? 4,
        });

        const engine = deps.createEngine({
          // The Turkish and Arabic members are the unified slot's turbo FILE with a different job;
          // the suffix keeps three engines on one file apart in the diagnostics and the report.
          engineId:
            `whisper-${modelPath.replace(/^.*[\\/]/, '').replace(/\.bin$/, '')}` +
            (family === 'turkish' ? '-tr' : family === 'arabic' ? '-ar' : ''),
          modelPath,
          params,
          // FINDING 7. The role is the fact; the filename is a guess that was wrong in
          // both directions. See `Member.languages`.
          supportedLanguages: languages,
          // Read at DECODE time, not captured here: `settings` is the live binding, so
          // adding a word to the vocabulary reaches the next dictation without rebuilding
          // an engine — and rebuilding means re-reading 539 MB off disk, which is not a
          // price anyone should pay for typing a name into a settings pane.
          initialPromptFor: promptFor,
        });
        members.push({ role, modelPath, languages, engine, lastUsedAt: now() });
      }
      rebuilt.set(family, {
        members,
        engine: createFamilyEngine(family, members, note, now),
      });
      if (family === 'arabic') {
        deps.arabicLead?.engine.attachFallback?.(members.find((member) => member.role !== 'lead')?.engine ?? null);
      }
      note(
        `${family}: ${members.length === 0 ? 'no model' : members.map((member) => member.role).join(' > ')}`,
      );
    }

    // The detector is separate: a different model with an independent lifecycle, and it
    // is never asked to transcribe.
    const detectorPath = paths.get('detector') ?? null;
    if (
      !detectionWanted(current) ||
      detectorPath === null ||
      deps.createClassifier === undefined
    ) {
      if (classifier !== null) await classifier.dispose();
      classifier = null;
      classifierPath = null;
    } else if (detectorPath !== classifierPath) {
      if (classifier !== null) await classifier.dispose();
      classifier = deps.createClassifier({ modelPath: detectorPath });
      classifierPath = detectorPath;
    }

    families = rebuilt;
    builtFrom = next;

    // Tear the old engines down AFTER the new ones are in place, so a reconfigure never
    // leaves the manager with no engine at all. Never the lead: it carried over.
    for (const [, slot] of previous) {
      for (const member of slot.members) if (member.role !== 'lead') await member.engine.dispose();
    }
  }

  /**
   * One build at a time, in the order they were asked for — and a caller always waits
   * for a build that STARTED AFTER its own call.
   *
   * It used to join the one in flight instead, which is wrong for exactly one caller and
   * that caller is `reconfigure`. The sequence:
   *
   *     prepare()          → build A starts, suspends on `resolve()`
   *     reconfigure(B)     → settings = B, sees a build in flight, joins it
   *     build A finishes   → engines built from A
   *     reconfigure(B) resolves
   *
   * and the caller now holds a manager built from the settings it just replaced, with
   * `await reconfigure(...)` as its evidence that it does not. Chaining costs a second
   * `build()` that finds its own fingerprint unchanged and returns — four `stat`s — and
   * removes the whole race.
   */
  function ensureBuilt(): Promise<void> {
    // Assigned before the first suspension point, so two callers cannot read the same
    // predecessor — the same reason the host client keeps its own chain.
    const mine = building.then(build, build);
    building = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  }

  /**
   * Frees the weights of anything nobody has used in a while. Returns how many it freed,
   * which is what makes it testable without waiting a real ten minutes.
   *
   * It calls `unload()`, NOT `dispose()`. Disposing shuts the member's host down for
   * good, so a model unloaded to reclaim memory could never come back — the press after
   * the timeout would fail rather than being slow, which is the opposite of the trade
   * this feature exists to make. `unload` frees the 539 MB and leaves a process that can
   * reload. An engine with no `unload` is left alone rather than disposed, for the same
   * reason.
   */
  async function sweepIdle(): Promise<number> {
    if (!idlePolicy.enabled || disposed) return 0;
    const cutoff = now() - idlePolicy.afterMs;
    let freed = 0;
    for (const [family, slot] of families) {
      for (const member of slot.members) {
        // The lead keeps its own idle clock (`ParakeetEngine.idleUnloadMs`).
        if (member.role === 'lead') continue;
        if (member.lastUsedAt > cutoff) continue;
        if (!(await member.engine.isReady())) continue;
        const unloadable = member.engine as Partial<{ unload: () => Promise<void> }>;
        if (typeof unloadable.unload !== 'function') continue;
        await unloadable.unload();
        freed += 1;
        note(
          `${family}/${member.role}: unloaded after ${Math.round(idlePolicy.afterMs / 1000)}s idle`,
        );
      }
    }
    return freed;
  }

  /**
   * Give back what only languages that are off were holding (the Mac's
   * `releaseLanguagesTurnedOff`): every member of a family none of whose languages is on is
   * unloaded now, not at the idle sweep. `unload`, not `dispose` — turning the language back on
   * reloads it. Nothing is deleted from disk.
   */
  async function releaseFamiliesTurnedOff(): Promise<void> {
    const on = subsetFamilies(enabledSubset(settings));
    for (const [family, slot] of families) {
      if (on.has(family)) continue;
      for (const member of slot.members) {
        if (!(await member.engine.isReady())) continue;
        const unloadable = member.engine as Partial<{ unload: () => Promise<void> }>;
        if (typeof unloadable.unload !== 'function') continue;
        await unloadable.unload();
        note(`${family}/${member.role}: unloaded — its languages are off`);
      }
    }
  }

  if (idlePolicy.enabled) {
    idleTimer = setInterval(
      () => {
        void sweepIdle();
      },
      idlePolicy.sweepEveryMs ?? Math.max(30_000, Math.floor(idlePolicy.afterMs / 4)),
    );
    idleTimer.unref?.();
  }

  return {
    /**
     * The family slot, or `null` — and `null` has TWO causes that must not read alike.
     *
     * `families` is filled by `build()`, which is only ever reached through `prepare()`
     * or `reconfigure()`. A caller that asks before either has run gets an empty map and
     * a `null` that looks exactly like "you have no model for this language" — which is
     * what shipped: `--check` constructed the manager and called `engineFor` on the next
     * line, so every fixture failed with `noEngineInstalled` on a machine whose three
     * models the same report had just listed as `ready`.
     *
     * The construction is deliberately not made eager — `resolve()` is async and a
     * synchronous getter cannot wait for it — so the fix is that this case is now LOUD.
     */
    engineFor(family: EngineFamily): SttEngine | null {
      const slot = families.get(family);
      if (slot === undefined) {
        note(
          `${family}: asked for an engine before the engines were built — ` +
            `prepare() or reconfigure() has to run first`,
        );
        return null;
      }
      return slot.engine;
    },

    /**
     * The acoustic detector, or `null` — and `null` here is the quietest failure in the
     * whole app: routing degrades to the fallback language and reports itself as a
     * ROUTING RESULT (`source: 'fallback'`, `turkicMass: null`), not as a missing
     * component. That is every Uzbek dictation silently going to the unified engine,
     * which is the failure this app exists to prevent, so each cause says which it is.
     */
    detector(): AcousticClassifier | null {
      if (classifier === null) {
        if (deps.createClassifier === undefined) {
          note('detector: no classifier factory was wired in — routing cannot be acoustic');
        } else if (!detectionWanted(settings)) {
          note('detector: one language (or English and Russian alone) is on — nothing to detect');
        } else if (families.size === 0) {
          note('detector: asked for before the engines were built');
        } else {
          note('detector: no usable detector model was resolved');
        }
      }
      return classifier;
    },

    languageHead(): AcousticClassifier | null {
      // Either family's turbo: the Turkish engine, or Arabic's whisper member (same file).
      const hasHead = (each: { readonly engine: unknown }): boolean =>
        typeof (each.engine as Partial<{ detectLanguage: unknown }>).detectLanguage === 'function';
      const member = families.get('turkish')?.members.find(hasHead) ?? families.get('arabic')?.members.find(hasHead);
      if (member === undefined) return null;
      const engine = member.engine as SttEngine & Pick<SegmentDecodingEngine, 'detectLanguage'>;
      return {
        posterior: async (audio) => {
          try {
            member.lastUsedAt = now();
            // The fitted window the Mac's head reads (`TurkishCheck.headMargin`, C4 §13).
            return await engine.detectLanguage(audio.samples, { headMargin: TURKISH_HEAD_MARGIN });
          } catch (error: unknown) {
            note(`language head: no answer — ${error instanceof Error ? error.message : String(error)}`);
            return {};
          }
        },
      };
    },

    /**
     * Run the idle sweep now. On the timer in production; called directly by the test,
     * which would otherwise need a real ten minutes to assert anything.
     */
    sweepIdleNow(): Promise<number> {
      return sweepIdle();
    },

    async prepare(options): Promise<void> {
      await ensureBuilt();
      // Eagerly: the families of the languages that are on, and only those — a language that is
      // off is never preloaded (Turkish's engine is also TurkishCheck's language head).
      const on = enabledSubset(settings);
      const wanted: EngineFamily[] = options.eagerly
        ? [...subsetFamilies(on)]
        : [engineFamilyFor(subsetFallback(on, options.language ?? settings.defaultLanguage))];

      // Concurrently, for the same reason the family slot prepares its members that way:
      // the two families are two independent sets of host processes, and `eagerly` is the
      // path where BOTH whisper models are read off disk. Serially that is the sum of two
      // model reads before the app calls itself ready.
      await Promise.all(
        wanted.map(async (family) => {
          const slot = families.get(family);
          if (slot === undefined || slot.members.length === 0) return;
          try {
            await slot.engine.prepare();
          } catch (error) {
            // A preload failure is not fatal. It becomes a slow first dictation, or a
            // named blocker — never a refused press.
            note(
              `${family}: preload failed — ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }),
      );
    },

    async reconfigure(next: Settings): Promise<void> {
      settings = next;
      await ensureBuilt();
      await releaseFamiliesTurnedOff();
    },

    /**
     * The real question, asked of the component that knows.
     *
     * NOT an OR over engines, and not `isReady()` on anything: a model file that is
     * present and valid is what makes a language available, and a cold engine is a slow
     * first dictation rather than an unavailable language.
     */
    async readiness(): Promise<EngineReadiness> {
      const paths = await resolvePaths(settings);
      const statusOf = async (role: ModelRole): Promise<ModelStatus> => {
        const path = paths.get(role) ?? null;
        if (path !== null) return (await deps.models.inspect(path)).status;

        // `resolve` returns null for "nothing USABLE found", which collapses two states
        // that must stay apart: no file at all, and a file that is there and broken.
        // Reporting the second as `notInstalled` tells the user to obtain a model they
        // already have — the exact shape of the bug D-W10 exists to prevent, and it was
        // in this function until a test asked.
        //
        // So ask again, of the two components that can still tell them apart: the user's
        // own configured path first, because its corruption is the most actionable, then
        // the catalogue, which looks in both the models directory and beside the
        // executable.
        const configured = settingPathFor(role, settings);
        if (configured.length > 0) {
          const inspection = await deps.models.inspect(configured);
          if (inspection.status === 'corrupt') return 'corrupt';
        }
        const id = CATALOGUE_ID_FOR_ROLE[role];
        return id === null ? 'notInstalled' : deps.models.status(id);
      };

      const uzbek = await statusOf('uzbek');
      const whisperUnified = await statusOf('russian');
      // The lead serves English and Russian by itself once it is on disk. Until then whisper
      // turbo — if Turkish or Arabic brought it (D-W25) — is what the slot has, and its status
      // is the slot's; without it, `notInstalled` until Parakeet lands.
      const leadStatus = deps.unifiedLead === undefined ? 'notInstalled' : await deps.unifiedLead.status().catch(() => 'notInstalled' as const);
      const russian: ModelStatus = leadStatus === 'ready' ? 'ready' : whisperUnified;
      const fastEnglish = await statusOf('fastEnglish');
      const detector = detectionWanted(settings) ? await statusOf('detector') : 'notInstalled';

      const availableLanguages = new Set<Language>();
      if (uzbek === 'ready') availableLanguages.add('uz');
      if (russian === 'ready') {
        availableLanguages.add('ru');
        availableLanguages.add('en');
      }
      // Fast English can serve English on its own — but it CANNOT serve Russian, so it
      // never makes `unified` ready by itself.
      if (settings.fastEnglish && fastEnglish === 'ready') availableLanguages.add('en');

      // C4: the optional languages count only once the user turned them on. Turkish is the
      // turbo file; Arabic is its own engine once downloaded, and that same turbo file (with
      // the Arabic prompt) until then — so Arabic dictates from the moment it is switched on.
      const turkish = whisperUnified;
      const arabicLead =
        deps.arabicLead === undefined ? 'notInstalled' : await deps.arabicLead.status().catch(() => 'notInstalled' as const);
      const arabic: ModelStatus = arabicLead === 'ready' ? 'ready' : whisperUnified;
      const enabled = new Set<Language>(settings.enabledLanguages);
      if (enabled.has('tr') && turkish === 'ready') availableLanguages.add('tr');
      if (enabled.has('ar') && arabic === 'ready') availableLanguages.add('ar');
      // A core language that is off is not available either: not pinnable, not in the tray.
      for (const language of [...availableLanguages]) if (!enabled.has(language)) availableLanguages.delete(language);

      return {
        uzbek,
        // The unified slot's status is the large model's: it is the member that covers
        // both of the slot's languages. Reporting `ready` because a Fast English model
        // loaded would be the OR bug again, one name further down.
        unified: russian,
        detector,
        turkish,
        arabic,
        availableLanguages,
      };
    },

    async dispose(): Promise<void> {
      disposed = true;
      if (idleTimer !== null) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      for (const [, slot] of families) {
        for (const member of slot.members) await member.engine.dispose();
      }
      if (deps.unifiedLead !== undefined && families.get('unified') === undefined) {
        await deps.unifiedLead.engine.dispose();
      }
      if (deps.arabicLead !== undefined && families.get('arabic') === undefined) {
        await deps.arabicLead.engine.dispose();
      }
      families = new Map();
      if (classifier !== null) await classifier.dispose();
      classifier = null;
    },
  };
}

/** The contract factory. Extras default to off; the composition root supplies them. */
export const createEngineManager: CreateEngineManager = (deps) => createEngineManagerWith(deps);

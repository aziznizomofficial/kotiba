// The built-in modes' deterministic half and their on-device prompts. PURE.
//
// Ported from Sources/KotibaCore/{DictationCleanup,PunctuationProjection,NoteLayout,
// IncrementalPolish (SentenceSplitter, SentenceGuard),OnDeviceModes}.swift and pinned by
// `fixtures/golden/modes.json`. The orchestration that runs a model over these — one
// sentence at a time, in order, with a deadline — is `src/polish`.

export { cleanUp, fixSpacing, isQuestion, splitTokens, joinTokens, type CleanupOptions, type Token } from './cleanup.js';
export { project, MINIMUM_ALIGNMENT, type ProjectionResult } from './projection.js';
export {
  acceptsHeading,
  capitaliseFirst,
  cleanHeading,
  looksLikeTask,
  noteLine,
  renderNote,
  strippingOrdinal,
  taskText,
  type NoteKind,
  type NoteLine,
} from './note-layout.js';
export {
  checkFullPolishGuard,
  checkRewrite,
  droppedWords,
  guardReason,
  isConnective,
  novelWords,
  renderPrompt,
  sharesStem,
  splitSentences,
  tokenBudget,
  wordCount,
  wordsOf,
  type FullPolishGuard,
  type PolishPrompt,
  type PromptExample,
  type Split,
} from './sentences.js';
export {
  DROPPABLE,
  MESSAGE_BY_PROJECTION,
  OPENERS,
  SUPER_MODEL_LANGUAGES,
  SUPER_TAIL_CAP_MS,
  trimOpeners,
  headingPrompt,
  messagePrompt,
  modeBehaviour,
  noteClassifierPrompt,
  promptName,
  superPrompt,
  type ModeBehaviour,
} from './on-device.js';
export { durationText, formatWhole } from './swift.js';

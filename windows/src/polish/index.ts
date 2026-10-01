// src/polish — the built-in modes' model half. May use Node. May NOT import `electron`.
//
// `IncrementalPolish` / `ModePolisher` run the per-sentence machinery of C3 over the pure
// rules in `src/core/modes`; `LlamaPolisher` is Qwen3-1.7B through node-llama-cpp; and
// `createOnDevicePolishChain` is what `SessionPorts.createPolishChain` is in the app.

export {
  IncrementalPolish,
  ModePolisher,
  TAIL_DEADLINE_MS,
  joinSentences,
  type IncrementalPolishOptions,
  type PolishClock,
  type PolishOutcome,
  type PromptedPolisher,
} from './incremental.js';

export {
  LlamaPolisher,
  chatML,
  turn,
  resolveLlamaThreads,
  CONTEXT_TOKENS,
  DRAFT_TOKENS,
  type LlamaPolisherOptions,
  type LlamaRun,
} from './llama.js';

export { createOnDevicePolishChain, type OnDevicePolishChainOptions } from './chain.js';

export { RemoteLlamaPolisher, type ModesModel, type RemoteLlamaOptions } from './remote-llama.js';
export type { LlamaHostConfig, LlamaHostReply, LlamaHostRequest } from './llama-host.js';

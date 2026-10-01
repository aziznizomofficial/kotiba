// Transcribing while the key is held — the Windows twin of `StreamingTranscriptionEngine`
// and `TranscriptionStream` (Sources/KotibaCore/Contracts.swift).
//
// WHY IT EXISTS. A batch engine's cost grows with the recording, and the recording is
// exactly what the user is waiting on at key-release. This owner's p90 dictation is 42 s
// and one in six runs past 30 s; Parakeet reads audio in ~15 s windows, so a batch decode of
// a long hold costs a window per 15 s AFTER the key comes up. Decoding finished stretches
// during the hold leaves at most one for the release (C1 §5: 31–178 ms key-release → text
// for any length from 30 s to 190 s on the Mac).
//
// Opening a stream is a SPECULATION, not a routing decision: the language is not known
// until key-up, and a dictation that turns out to be Uzbek simply never finishes its
// stream. That is also the seam for whatever streams next — the session feeds a take's
// chunks to any engine that implements this, and knows nothing about which one it is.

import type { AudioBuffer } from './audio.js';
import type { SttEngine, Unsubscribe } from './interfaces.js';
import type { Language } from './language.js';
import type { TranscriptResult } from './transcript.js';

export interface TranscriptionStream {
  /** The next samples of the recording, 16 kHz mono, in order and without gaps. */
  append(samples: Float32Array): void;

  /**
   * Key-up. `audio` is the finalised recording and is AUTHORITATIVE: the stream reuses
   * what it already decoded only where that is still a prefix of `audio`, and decodes the
   * rest. A stream that fell behind, lost samples or was never fed returns exactly what a
   * batch `transcribe(audio, language)` would — it is an optimisation, never a different
   * answer about WHICH audio was transcribed.
   */
  finish(audio: AudioBuffer, language: Language): Promise<TranscriptResult>;

  /** Discard everything. The dictation went to another engine, or was cancelled. */
  cancel(): void;

  /**
   * Text the stream has committed during the hold and will not revise, raw, in order.
   * What incremental polish runs on while the user is still speaking. Optional: a stream
   * that commits nothing early simply never calls it.
   */
  onCommit?(listener: (text: string) => void): Unsubscribe;
}

/** An engine that can start work while the user is still speaking. */
export interface StreamingSttEngine extends SttEngine {
  /**
   * Start a stream. Cheap; must not block on loading — a cold engine returns a stream that
   * buffers until it is ready, or one that does nothing until `finish`.
   */
  openStream(): TranscriptionStream;
}

export function isStreamingEngine(engine: SttEngine | null | undefined): engine is StreamingSttEngine {
  return engine !== null && engine !== undefined && typeof (engine as Partial<StreamingSttEngine>).openStream === 'function';
}

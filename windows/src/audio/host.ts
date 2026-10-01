// The channel between this module and the hidden renderer that owns the microphone.
//
// D-W6 puts capture in an offscreen `BrowserWindow`: `getUserMedia` into an
// `AudioWorklet`, with `new AudioContext({ sampleRate: 16000 })` so the browser's own
// resampler produces the 16 kHz mono float32 whisper wants. That window is created by
// `src/main` (only `src/main` and `src/renderer` may import Electron), so this module
// never sees Electron — it is handed something that satisfies `AudioHost` and drives it.
//
// The interface is deliberately tiny and deliberately message-shaped: everything crossing
// it is plain data, so `test/audio/capture.test.ts` drives the whole state machine
// against a fake host with no browser, no microphone and no Electron.

import type { MicrophoneError } from '../contracts/index.js';

/** What the capture module asks the renderer to do. */
export type AudioHostCommand =
  /**
   * Prepare WITHOUT capturing: check permission, confirm a usable input device exists,
   * and build the 16 kHz `AudioContext`. Deliberately does not call `getUserMedia`, so
   * warming up does not light the Windows microphone indicator.
   */
  | { readonly kind: 'warmUp' }
  /**
   * Open the stream and start streaming chunks tagged `segment`. This is when the indicator
   * lights. Sent while already capturing, it SEALS the previous segment at that sample and
   * carries on under the new tag — nothing restarts, nothing is lost at the seam, nothing
   * is shared. That is how a press during the previous dictation's processing gets a take
   * of its own (the Mac's "a new take seals the previous one at that sample").
   */
  | { readonly kind: 'start'; readonly segment: number }
  /**
   * End `segment`: flush its last partial chunk and answer `stopped` with how many samples
   * it streamed in total. When `segment` is still the one being captured, capturing stops;
   * when a newer segment has already sealed it, nothing stops. The stream stays OPEN
   * either way — the renderer holds it until `release`, so a second press does not pay
   * device-open latency.
   */
  | { readonly kind: 'stop'; readonly segment: number }
  /** Close the stream and put the microphone indicator out. */
  | { readonly kind: 'release' }
  /** Tear down the context entirely. */
  | { readonly kind: 'dispose' };

/**
 * The microphone the stream opened, as the page can see it: the track's own label and rate.
 * A browser exposes no transport type, so the capture module classifies by label
 * (`classifyTransport`). Names are for the diagnostics record, never for a summary.
 */
export interface AudioHostDevice {
  readonly label: string;
  /** The device's own rate (`track.getSettings().sampleRate`), when the browser says. */
  readonly sampleRate: number | null;
}

/** What the renderer answers. `error` is the answer to any command that failed. */
export type AudioHostReply =
  /** `device` accompanies the answer to `start`: which microphone that take is listening to. */
  | { readonly kind: 'ok'; readonly device?: AudioHostDevice }
  | {
      readonly kind: 'warmedUp';
      /** The rate the `AudioContext` actually runs at. Must be 16000; anything else is a bug. */
      readonly sampleRate: number;
      /** For diagnostics only. Never matched against — device ids rotate. */
      readonly deviceLabel: string | null;
    }
  | {
      readonly kind: 'stopped';
      readonly segment: number;
      /**
       * Every sample the renderer streamed for this segment, counted at the source. The
       * capture module compares it with what arrived: a difference is audio lost in
       * transit, and it is COUNTED rather than silently missing. `-1` when the renderer no
       * longer remembers the segment.
       */
      readonly totalSamples: number;
      /** Samples the renderer itself lost. Normally 0; a non-zero value is real. */
      readonly droppedSamples: number;
    }
  | { readonly kind: 'error'; readonly error: MicrophoneError };

/**
 * What the renderer says without being asked.
 *
 * `deviceChanged` is the whole point of this event channel. On macOS, 12 of 159
 * activations captured nothing because the audio graph went stale, and the fix was an
 * explicit `AVAudioEngineConfigurationChange` observer — NOT comparing formats, which is
 * what had been tried and what kept reporting a healthy graph. The browser's analogue is
 * `navigator.mediaDevices.ondevicechange` plus the track's own `ended`/`mute` events, and
 * this module treats any of them the same way: mark the graph stale, drop `isWarm`, and
 * rebuild on the next press.
 */
export type AudioHostEvent =
  /** One audio block's peak, already smoothed by the renderer's meter. */
  | { readonly kind: 'level'; readonly peak: number }
  /**
   * The live 16 kHz stream: one chunk of `segment`, in order. Chunks are ~100 ms (1600
   * samples) while speaking; the last one of a segment is whatever was left when it was
   * stopped or sealed. They arrive over the same pipe as the `stopped` reply and strictly
   * before it, which is what lets `stop()` know it has everything.
   */
  | { readonly kind: 'chunk'; readonly segment: number; readonly samples: Float32Array }
  | { readonly kind: 'deviceChanged'; readonly why: string }
  | { readonly kind: 'streamEnded'; readonly why: string };

export type Unsubscribe = () => void;

export interface AudioHost {
  send(command: AudioHostCommand): Promise<AudioHostReply>;
  onEvent(listener: (event: AudioHostEvent) => void): Unsubscribe;
}

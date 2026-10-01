// The code that runs INSIDE the hidden capture window, as source strings.
//
// D-W6: `getUserMedia` into an `AudioWorklet`, with `new AudioContext({ sampleRate:
// 16000 })` so the browser's own high-quality resampler produces the 16 kHz mono float32
// whisper wants. NOT a hand-written resampler: the macOS one had a bug that threw away
// Uzbek sibilants (commit 97272d7), and nobody on this project can listen to the output
// to catch a repeat.
//
// It lives here, in `src/audio`, rather than in `src/renderer`, because it is this
// module's other half and the two have to change together. `src/main` (t10) owns the
// hidden `BrowserWindow` and injects these — the audio module never imports Electron.
//
// Both strings are plain data. This file has no imports and no side effects.

/**
 * The `AudioWorkletProcessor`, to be turned into a blob URL and passed to
 * `audioWorklet.addModule()`.
 *
 * `process()` runs on the audio thread under the same rules as a Core Audio render
 * callback: no allocation you can avoid, no locks, no logging. It copies its 128-frame
 * quantum into a fresh `Float32Array` and posts it — the copy is unavoidable because the
 * input buffer is recycled under it, and it is one small allocation per 8 ms, which is
 * what the Web Audio API is built for.
 *
 * The peak goes with the block rather than being computed on the main side, so the meter
 * never has to read the capture buffer. That separation is why the macOS `LevelMeter` is
 * a lone atomic beside a single-consumer ring: drawing a level must not consume a sample
 * the transcription needs.
 */
export const CAPTURE_WORKLET_SOURCE = String.raw`
class KotibaCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capturing = false;
    this.port.onmessage = (event) => {
      if (event.data === 'start') this.capturing = true;
      else if (event.data && typeof event.data.stop === 'number') {
        this.capturing = false;
        // Posted AFTER every block sent while capturing, on the same port, so the page
        // knows the last one has arrived. Without it the audio in flight at key-up —
        // up to a few blocks — was dropped on the floor. It carries the stop's number, so
        // a late answer to a stop that timed out cannot end the NEXT stop's wait early.
        this.port.postMessage({ stopped: event.data.stop });
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    let peak = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const magnitude = channel[i] < 0 ? -channel[i] : channel[i];
      if (magnitude > peak) peak = magnitude;
    }

    if (this.capturing) {
      const block = new Float32Array(channel.length);
      block.set(channel);
      this.port.postMessage({ block, peak }, [block.buffer]);
    } else {
      this.port.postMessage({ peak });
    }
    return true;
  }
}

registerProcessor('kotiba-capture', KotibaCaptureProcessor);
`;

/**
 * The page script for the hidden window.
 *
 * It expects two globals from the injector, and nothing else:
 *
 *   `window.__kotibaSend(event)`      — deliver an `AudioHostEvent` to the main process.
 *   `window.__kotibaWorkletSource`    — `CAPTURE_WORKLET_SOURCE`.
 *
 * and it installs one:
 *
 *   `window.__kotibaAudio(command)`   — returns a promise of an `AudioHostReply`.
 *
 * Deliberate choices, each of which is a defect somewhere else if reversed:
 *
 * - `warmUp` does NOT call `getUserMedia`. It checks the permission and confirms a usable
 *   input exists. Warm-up runs on every foreground; if it opened the stream, the Windows
 *   microphone indicator would be lit whenever the app was in front, which reads as
 *   spyware and is not what macOS does either (`warmUp()` there prepares a graph that
 *   captures nothing).
 *
 * - Every warm-up RE-CHECKS the device and rebuilds a context that is not running at
 *   16 kHz. The macOS bug this replaces built its graph once forever and kept reporting
 *   success afterwards; 12 of 159 activations captured nothing.
 *
 * - `ondevicechange`, `track.onended` and `track.onmute` all report `deviceChanged`. The
 *   macOS fix was an explicit configuration-change observer rather than comparing
 *   formats, because comparing formats is what had been tried and it kept saying the
 *   graph was healthy.
 *
 * - The constraints turn OFF echo cancellation, noise suppression and automatic gain
 *   control. This is the browser's analogue of the iOS `.measurement` mode the macOS app
 *   sets, and it matters more here: Windows APO processing is aggressive, it is tuned for
 *   conference calls rather than for a recogniser, and gain control in particular
 *   rewrites the peak the clipping and silence measurements are taken from.
 */
export const CAPTURE_RENDERER_SOURCE = String.raw`
(() => {
  const TARGET_RATE = 16000;
  // One chunk is 100 ms of 16 kHz audio. Small enough to be a live stream a
  // transcriber can follow, large enough that ten per second is all the IPC it costs.
  const CHUNK = 1600;
  // How long 'stop' waits for the worklet's acknowledgement before it gives up waiting
  // for blocks in flight. A few render quanta; the answer normally comes in one.
  const DRAIN_MS = 150;

  const state = {
    context: null,
    worklet: null,
    stream: null,
    source: null,
    // The microphone the open stream is listening to: the track's label and its own rate.
    device: null,
    capturing: false,
    // The segment every arriving block belongs to. Switched by a 'start' while capturing:
    // that is the seam between two takes, at a block boundary, with nothing lost.
    segment: 0,
    chunk: new Float32Array(CHUNK),
    filled: 0,
    // Samples streamed per segment, counted HERE, at the source. Bounded: only the last
    // few segments can still be asked about.
    totals: new Map(),
    dropped: 0,
    drainWaiters: new Map(),
    stopCount: 0,
  };

  const send = (event) => {
    try { window.__kotibaSend(event); } catch { /* the window is going away */ }
  };

  const fail = (kind, why) => {
    if (kind === 'permissionDenied') {
      return { kind: 'error', error: { kind: 'permissionDenied',
        reason: 'Windows has not given Kotiba the microphone — Settings › Privacy & security › Microphone' } };
    }
    if (kind === 'noInputAvailable') {
      return { kind: 'error', error: { kind: 'noInputAvailable', reason: 'there is no usable input device' } };
    }
    if (kind === 'conversionFailed') {
      return { kind: 'error', error: { kind: 'conversionFailed', why,
        reason: 'the audio could not be converted: ' + why } };
    }
    return { kind: 'error', error: { kind: 'engineFailedToStart', why,
      reason: 'the audio graph would not start: ' + why } };
  };

  const countFor = (segment, n) => {
    state.totals.set(segment, (state.totals.get(segment) || 0) + n);
    while (state.totals.size > 16) state.totals.delete(state.totals.keys().next().value);
  };

  // Send whatever the partial chunk holds, under the segment it was captured for.
  const flush = () => {
    if (state.filled === 0) return;
    const samples = state.chunk.slice(0, state.filled);
    state.filled = 0;
    countFor(state.segment, samples.length);
    send({ kind: 'chunk', segment: state.segment, samples });
  };

  const accept = (block) => {
    let offset = 0;
    while (offset < block.length) {
      const take = Math.min(CHUNK - state.filled, block.length - offset);
      state.chunk.set(block.subarray(offset, offset + take), state.filled);
      state.filled += take;
      offset += take;
      if (state.filled === CHUNK) flush();
    }
  };

  let watching = false;
  const watchDevices = () => {
    if (watching || !navigator.mediaDevices) return;
    watching = true;
    navigator.mediaDevices.addEventListener('devicechange', () => {
      send({ kind: 'deviceChanged', why: 'the list of audio devices changed' });
    });
  };

  const teardownStream = () => {
    if (state.source) { try { state.source.disconnect(); } catch { /* already gone */ } }
    state.source = null;
    state.device = null;
    if (state.stream) {
      for (const track of state.stream.getTracks()) { try { track.stop(); } catch { /* already gone */ } }
    }
    state.stream = null;
  };

  const teardown = () => {
    teardownStream();
    if (state.worklet) { try { state.worklet.disconnect(); } catch { /* already gone */ } }
    state.worklet = null;
    if (state.context) { try { state.context.close(); } catch { /* already gone */ } }
    state.context = null;
  };

  const buildContext = async () => {
    // Rebuild rather than reuse whenever the context is not a running 16 kHz context.
    // A suspended or closed context is exactly the stale graph this design exists to
    // notice, and reusing one is how the macOS bug survived a fix at the layer above.
    if (state.context && state.context.state !== 'closed' && state.context.sampleRate === TARGET_RATE) {
      if (state.context.state === 'suspended') await state.context.resume();
      return state.context;
    }
    teardown();
    const context = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
    if (context.sampleRate !== TARGET_RATE) {
      try { await context.close(); } catch { /* nothing to close */ }
      throw new Error('the browser would not give a ' + TARGET_RATE + ' Hz context, it gave ' + context.sampleRate);
    }
    const url = URL.createObjectURL(new Blob([window.__kotibaWorkletSource], { type: 'text/javascript' }));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }

    const worklet = new AudioWorkletNode(context, 'kotiba-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    worklet.port.onmessage = (event) => {
      const { block, peak, stopped } = event.data;
      if (typeof stopped === 'number') {
        const wake = state.drainWaiters.get(stopped);
        state.drainWaiters.delete(stopped);
        if (wake) wake();
        return;
      }
      if (typeof peak === 'number') send({ kind: 'level', peak });
      // NO CAPACITY. The recording is not kept here any more: every block is chunked and
      // streamed to main as it arrives, and main keeps the take — up to its 30-minute
      // ceiling, which it reports rather than silently enforcing. The old page held the
      // whole recording in a 2^23-sample array, which is 524 s: the Mac's 174.76 s
      // truncation with a bigger number.
      if (!block || !state.capturing) return;
      accept(block);
    };
    state.context = context;
    state.worklet = worklet;
    return context;
  };

  const openStream = async (context) => {
    if (state.stream && state.stream.getAudioTracks().some((t) => t.readyState === 'live')) return;
    teardownStream();
    // channelCount 1 asks the browser to downmix; it also resamples to the context rate.
    // Both happen in the browser's own high-quality path, which is the entire point of
    // D-W6 — a hand-written resampler is what destroyed Uzbek sibilants on macOS.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('the stream arrived with no audio track');
    track.addEventListener('ended', () => {
      send({ kind: 'streamEnded', why: 'the input device went away mid-stream' });
    });
    track.addEventListener('mute', () => {
      send({ kind: 'streamEnded', why: 'the input device stopped delivering audio' });
    });
    state.stream = stream;
    // Which microphone this is, written down now for every take that starts on the stream. The
    // rate is the device's own, before the context resampled to 16 kHz.
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
    state.device = {
      label: track.label || '',
      sampleRate: typeof settings.sampleRate === 'number' ? settings.sampleRate : null,
    };
    state.source = context.createMediaStreamSource(stream);
    state.source.connect(state.worklet);
  };

  // Wait for the worklet to say every block it sent while capturing has arrived.
  const drain = () => new Promise((resolve) => {
    state.stopCount += 1;
    const id = state.stopCount;
    let done = false;
    const finish = () => { if (!done) { done = true; state.drainWaiters.delete(id); resolve(); } };
    state.drainWaiters.set(id, finish);
    state.worklet.port.postMessage({ stop: id });
    setTimeout(finish, DRAIN_MS);
  });

  // ONE COMMAND AT A TIME. 'stop' awaits the worklet's drain, and a 'start' for the next
  // take arriving inside that wait would otherwise see capturing still true, seal the
  // wrong segment, and then have its own audio flushed under it when the stop resumed.
  let pending = Promise.resolve();
  window.__kotibaAudio = (command) => {
    const run = pending.then(() => handle(command));
    pending = run.catch(() => undefined);
    return run;
  };

  const handle = async (command) => {
    try {
      switch (command.kind) {
        case 'warmUp': {
          watchDevices();
          if (navigator.permissions) {
            try {
              const status = await navigator.permissions.query({ name: 'microphone' });
              if (status.state === 'denied') return fail('permissionDenied');
            } catch { /* Chromium always knows this one, but never depend on it */ }
          }
          const devices = await navigator.mediaDevices.enumerateDevices();
          const inputs = devices.filter((d) => d.kind === 'audioinput');
          if (inputs.length === 0) return fail('noInputAvailable');
          const context = await buildContext();
          return {
            kind: 'warmedUp',
            sampleRate: context.sampleRate,
            deviceLabel: inputs[0].label || null,
          };
        }
        case 'start': {
          if (state.capturing) {
            // A new take while the last one is still open: seal the old segment at this
            // block boundary and carry on under the new tag. The engine keeps running.
            flush();
            state.segment = command.segment;
            state.totals.set(command.segment, 0);
            return { kind: 'ok', device: state.device || undefined };
          }
          const context = await buildContext();
          await openStream(context);
          if (context.state === 'suspended') await context.resume();
          state.segment = command.segment;
          state.totals.set(command.segment, 0);
          state.filled = 0;
          state.dropped = 0;
          state.capturing = true;
          state.worklet.port.postMessage('start');
          return { kind: 'ok', device: state.device || undefined };
        }
        case 'stop': {
          if (state.capturing && state.segment === command.segment) {
            if (state.worklet) await drain();
            state.capturing = false;
            flush();
          }
          const total = state.totals.has(command.segment) ? state.totals.get(command.segment) : -1;
          const dropped = state.segment === command.segment ? state.dropped : 0;
          return { kind: 'stopped', segment: command.segment, totalSamples: total, droppedSamples: dropped };
        }
        case 'release': {
          state.capturing = false;
          teardownStream();
          return { kind: 'ok' };
        }
        case 'dispose': {
          state.capturing = false;
          teardown();
          return { kind: 'ok' };
        }
        default:
          return fail('engineFailedToStart', 'unknown command ' + command.kind);
      }
    } catch (error) {
      const why = error && error.message ? error.message : String(error);
      if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
        return fail('permissionDenied');
      }
      if (error && (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')) {
        return fail('noInputAvailable');
      }
      if (why.indexOf('Hz context') !== -1) return fail('conversionFailed', why);
      return fail('engineFailedToStart', why);
    }
  };
})();
`;

/** The page `src/main` loads into the hidden window. Nothing but a host for the script. */
export const CAPTURE_PAGE_HTML =
  '<!doctype html><meta charset="utf-8"><title>Kotiba capture</title>';

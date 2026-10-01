// WAV decoding and encoding.
//
// Ported from Sources/KotibaAudio/WAVFileSource.swift:34. Hand-rolled rather than handed
// to a library or to the platform, for the same reason the Swift one is: it has to work
// on a runner with no audio hardware, and `--check` (D-W10) is the only automated proof
// this app's pipeline runs at all.
//
// The parser WALKS the chunk list from offset 12 — `offset = body + size + (size % 2)`,
// word-aligned — rather than assuming `fmt ` at 12 and `data` at 36. Real files carry
// LIST and fact chunks, and a fixed-offset parser reads those as audio.
//
// Uses Node (`fs`) for the file paths only; every parsing function takes bytes.

import { readFile } from 'node:fs/promises';
import { SAMPLE_RATE, type AudioBuffer } from '../contracts/index.js';

/** Why a WAV would not decode. All four cases are pinned by the macOS tests. */
export class WavError extends Error {
  readonly kind: 'notRIFF' | 'notWAVE' | 'truncated' | 'missingChunk' | 'unsupportedFormat';

  constructor(kind: WavError['kind'], message: string) {
    super(message);
    this.name = 'WavError';
    this.kind = kind;
  }
}

/** A decoded file: mono samples at the FILE's own rate. */
export interface DecodedWav {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  /** How many channels the file had, before they were averaged to mono. */
  readonly channels: number;
}

function tag(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.length) throw new WavError('truncated', `truncated at byte ${offset}`);
  return String.fromCharCode(
    bytes[offset] as number,
    bytes[offset + 1] as number,
    bytes[offset + 2] as number,
    bytes[offset + 3] as number,
  );
}

/**
 * Decode a WAV into mono float samples at the file's own rate.
 *
 * Accepts format code 1 (PCM) at 16 bits and format code 3 (IEEE float) at 32 bits —
 * exactly the surface Sources/KotibaAudio/WAVFileSource.swift:84-109 accepts, because that
 * is the surface the fixtures use and every extra decoder is another thing that can be
 * subtly wrong with no way to hear it.
 *
 * 16-bit scales by 32768.0, matching the Swift. The encoder below multiplies by 32767 in
 * the other direction, so a round trip agrees to within one quantisation step and not
 * exactly — the macOS test asserts the same tolerance.
 */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  if (bytes.length < 12) throw new WavError('truncated', 'shorter than a RIFF header');
  if (tag(bytes, 0) !== 'RIFF') throw new WavError('notRIFF', 'not a RIFF file');
  if (tag(bytes, 8) !== 'WAVE') throw new WavError('notWAVE', 'not a WAVE file');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let formatCode = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataEnd = -1;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunk = tag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunk === 'fmt ') {
      if (body + 16 > bytes.length) throw new WavError('truncated', 'truncated fmt chunk');
      formatCode = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (chunk === 'data') {
      dataStart = body;
      dataEnd = Math.min(bytes.length, body + size);
    }
    offset = body + size + (size % 2);
  }

  if (channels <= 0 || sampleRate <= 0) throw new WavError('missingChunk', 'no usable fmt chunk');
  if (dataStart < 0) throw new WavError('missingChunk', 'no data chunk');

  const bytesPerSample = formatCode === 1 && bits === 16 ? 2 : formatCode === 3 && bits === 32 ? 4 : 0;
  if (bytesPerSample === 0) {
    throw new WavError(
      'unsupportedFormat',
      `format code ${formatCode} at ${bits} bits is not supported — expected PCM 16 or float 32`,
    );
  }

  const totalSamples = Math.floor((dataEnd - dataStart) / bytesPerSample);
  const frames = Math.floor(totalSamples / channels);
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const at = dataStart + (frame * channels + channel) * bytesPerSample;
      sum += bytesPerSample === 2 ? view.getInt16(at, true) / 32768 : view.getFloat32(at, true);
    }
    samples[frame] = sum / channels;
  }

  return { samples, sampleRate, channels };
}

/**
 * Encode mono float samples as 16-bit PCM.
 *
 * Only used to write fixtures and to hand the native STT host something a human can play
 * when a transcript looks wrong. Clamps before quantising, because the resampler can hand
 * us a sample above 1.0 and a wrapped Int16 is a click that reads as a consonant.
 */
export function encodeWav(samples: Float32Array, sampleRate: number = SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] as number));
    view.setInt16(44 + index * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

/**
 * Read a 16 kHz mono WAV into an `AudioBuffer`. Throws on anything else.
 *
 * DELIBERATELY REFUSES OTHER RATES. There is no resampler in this process — D-W6 puts
 * the only one in the renderer, where the browser's own high-quality implementation does
 * it. A convenience resampler here would be a second, worse one, on the path `--check`
 * uses to prove the pipeline, and the macOS `resampledTo16k()` it would be copied from is
 * a nearest-sample stub explicitly documented as not a quality resampler. So a fixture
 * that is not already 16 kHz is a broken fixture, and it says so.
 */
export async function readWavFile(path: string): Promise<AudioBuffer> {
  const decoded = decodeWav(await readFile(path));
  if (decoded.sampleRate !== SAMPLE_RATE) {
    throw new WavError(
      'unsupportedFormat',
      `${path} is ${decoded.sampleRate} Hz — fixtures must be ${SAMPLE_RATE} Hz mono, because ` +
        'nothing outside the capture renderer is allowed to resample',
    );
  }
  return { samples: decoded.samples, droppedSamples: 0 };
}

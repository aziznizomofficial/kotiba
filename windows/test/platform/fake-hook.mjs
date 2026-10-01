// A stand-in for kotiba-hook.exe that speaks its protocol exactly.
//
// The real helper is a WH_KEYBOARD_LL hook and compiles only on Windows, so on every
// other machine this is what the consumer is tested against — a real child process,
// over a real pipe, with real chunk boundaries. That last part is the point: an
// in-process fake hands the parser whole lines, and the bug this catches is a line
// split across two `data` events.
//
// Configuration is by environment, because the real helper takes no arguments either:
//
//   KOTIBA_FAKE_HOOK_LINES   `;`-separated lines to write, e.g. "DOWN 163;UP 163".
//                           A line of `@<ms>` sleeps. A line of `@split` writes the
//                           NEXT line one byte at a time, so the consumer's buffering
//                           is exercised.
//   KOTIBA_FAKE_HOOK_EXIT    exit with this code once the lines are written, instead of
//                           waiting for stdin to close.
//   KOTIBA_FAKE_HOOK_STDERR  one line to write on stderr first.
//   KOTIBA_FAKE_HOOK_STATE   what `POLL <vk>` answers: `STATE <vk> <this>` (default 1, held).
//                           `none` answers nothing, as a pre-1.0 helper would.
//   KOTIBA_FAKE_HOOK_LOG     a file every stdin command line is appended to.

const lines = (process.env.KOTIBA_FAKE_HOOK_LINES ?? '').split(';').filter((line) => line.length > 0);
const exitCode = process.env.KOTIBA_FAKE_HOOK_EXIT;

if (process.env.KOTIBA_FAKE_HOOK_STDERR !== undefined) {
  process.stderr.write(`${process.env.KOTIBA_FAKE_HOOK_STDERR}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  let splitNext = false;
  for (const line of lines) {
    if (line.startsWith('@')) {
      if (line === '@split') {
        splitNext = true;
        continue;
      }
      await sleep(Number.parseInt(line.slice(1), 10) || 0);
      continue;
    }
    const payload = `${line}\n`;
    if (splitNext) {
      splitNext = false;
      for (const byte of payload) {
        process.stdout.write(byte);
        await sleep(1);
      }
    } else {
      process.stdout.write(payload);
    }
  }

  if (exitCode !== undefined) {
    // Let the pipe drain before the process goes, or the consumer never sees the lines
    // that preceded the death — which would make every crash test pass for the wrong
    // reason.
    await sleep(20);
    process.exit(Number.parseInt(exitCode, 10) || 0);
  }
}

// The real helper stops when its stdin closes, and until then reads one command per line:
// `SWALLOW <vk>` and `POLL <vk>`.
import { appendFileSync } from 'node:fs';
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (let nl = pending.indexOf('\n'); nl >= 0; nl = pending.indexOf('\n')) {
    const line = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    if (process.env.KOTIBA_FAKE_HOOK_LOG) appendFileSync(process.env.KOTIBA_FAKE_HOOK_LOG, `${line}\n`);
    const poll = /^POLL (\d+)$/.exec(line);
    const state = process.env.KOTIBA_FAKE_HOOK_STATE ?? '1';
    if (poll && state !== 'none') process.stdout.write(`STATE ${poll[1]} ${state}\n`);
  }
});
process.stdin.on('end', () => process.exit(0));

run();

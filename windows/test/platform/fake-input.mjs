// A stand-in for kotiba-input.exe that speaks its protocol exactly.
//
// The real helper is SendInput, the Win32 clipboard and UI Automation, so it compiles
// only on Windows. This is a real child process over a real pipe implementing the same
// request/response shape, including the parts that are easy to get wrong on the client
// side: responses strictly in order, an echoed `id`, and refusals that arrive as values
// from a process that is still alive.
//
// Configuration is by environment:
//
//   KOTIBA_FAKE_INPUT_MODE      `ok` (default), `refuse:<code>`, `silent`, `crash`
//   KOTIBA_FAKE_INPUT_APP       what `foreground` answers, e.g. "telegram". `-` refuses.
//   KOTIBA_FAKE_INPUT_PID       the pid `foreground` reports. Default 4242.
//   KOTIBA_FAKE_INPUT_PREVIOUS  what `replace` believes is before the caret. A mismatch
//                              refuses with `moved`, like the real verification does.
//   KOTIBA_FAKE_INPUT_DROPPED   `droppedFormats` to report on a clipboard insert.
//   KOTIBA_FAKE_INPUT_DELAY_MS  wait this long before answering.
//   KOTIBA_FAKE_INPUT_PATH      the path to claim on a successful insert.

const mode = process.env.KOTIBA_FAKE_INPUT_MODE ?? 'ok';
const app = process.env.KOTIBA_FAKE_INPUT_APP ?? 'telegram';
const pid = Number.parseInt(process.env.KOTIBA_FAKE_INPUT_PID ?? '4242', 10);
const previous = process.env.KOTIBA_FAKE_INPUT_PREVIOUS;
const dropped = process.env.KOTIBA_FAKE_INPUT_DROPPED;
const delayMs = Number.parseInt(process.env.KOTIBA_FAKE_INPUT_DELAY_MS ?? '0', 10);
const insertPath = process.env.KOTIBA_FAKE_INPUT_PATH ?? 'unicode';

process.stderr.write('kotiba-input 1.0.0: ready\n');

const emit = (object) => process.stdout.write(`${JSON.stringify(object)}\n`);

function answer(request) {
  const id = request.id;

  if (mode === 'crash') process.exit(9);
  if (mode === 'silent') return;
  if (mode.startsWith('refuse:')) {
    emit({ id, ok: false, code: mode.slice('refuse:'.length), detail: 'the fake was told to' });
    return;
  }

  switch (request.op) {
    case 'hello':
      emit({ id, ok: true, helper: 'kotiba-input', version: '1.0.0' });
      return;

    case 'foreground':
      if (app === '-') {
        emit({ id, ok: false, code: 'foregroundUnknown', detail: 'cannot open process 8123' });
        return;
      }
      emit({
        id,
        ok: true,
        appId: app.toLowerCase(),
        displayName: app.charAt(0).toUpperCase() + app.slice(1),
        pid,
      });
      return;

    case 'insert': {
      const text = typeof request.text === 'string' ? request.text : '';
      if (text.length === 0) {
        emit({ id, ok: false, code: 'empty' });
        return;
      }
      const response = { id, ok: true, path: insertPath, units: text.length };
      if (insertPath === 'clipboard') {
        response.clipboardSaved = true;
        response.restoreDelayMs = request.restoreDelayMs ?? 250;
        if (dropped !== undefined) response.droppedFormats = dropped;
      }
      emit(response);
      return;
    }

    case 'replace': {
      if (typeof request.previous !== 'string' || request.previous.length === 0) {
        emit({ id, ok: false, code: 'nothingToReplace' });
        return;
      }
      // The real helper reads the characters before the caret back and refuses when they
      // are not exactly what it inserted. Same shape here, so the client is tested
      // against the refusal it will actually meet.
      if (previous !== undefined && previous !== request.previous) {
        emit({ id, ok: false, code: 'moved' });
        return;
      }
      emit({ id, ok: true, path: 'automation', units: String(request.text ?? '').length });
      return;
    }

    default:
      emit({ id, ok: false, code: 'badRequest', detail: `unknown op '${request.op}'` });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        emit({ ok: false, code: 'badRequest', detail: 'not JSON' });
        newline = buffer.indexOf('\n');
        continue;
      }
      if (delayMs > 0) setTimeout(() => answer(request), delayMs);
      else answer(request);
    }
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));

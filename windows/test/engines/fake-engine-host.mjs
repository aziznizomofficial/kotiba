// A stand-in for engine-host.js that speaks the same protocol with no model at all, so the
// supervision around the process — hello, crash, restart, give up, fall back — is tested with
// real processes and real native-style deaths.
//
//   fake-engine-host.mjs <role> <behaviour>
//
// behaviours: ok | crash-on-work (SIGSEGV-style abort on the first real request) |
// never-hello (exit before saying anything) | crash-on-load (parakeet: die while loading)

const [role, behaviour = 'ok'] = process.argv.slice(2);
const send = (message) => process.send(message);
const die = () => process.kill(process.pid, 'SIGKILL');

if (behaviour === 'never-hello') process.exit(3);
send({ kind: 'hello', pid: process.pid });
process.on('disconnect', () => process.exit(0));

process.on('message', (request) => {
  if (request.kind === 'dispose') {
    setTimeout(() => process.exit(0), 5);
    return;
  }
  if (role === 'parakeet') {
    if (request.kind === 'load') {
      if (behaviour === 'crash-on-load') die();
      else send({ kind: 'loaded' });
      return;
    }
    if (request.kind === 'transcribe') {
      if (behaviour === 'crash-on-work') die();
      const ok = request.samples instanceof Float32Array;
      send({ kind: 'text', id: request.id, text: `${ok ? 'f32' : typeof request.samples}:${request.samples.length}:${process.pid}` });
    }
    return;
  }
  // llama
  if (request.kind === 'configure' || request.kind === 'abort') return;
  if (request.kind === 'generate' && behaviour === 'crash-on-work') die();
  if (request.kind === 'generate') {
    send({ kind: 'loaded', loaded: true });
    send({ kind: 'done', id: request.id, text: `${request.text.toUpperCase()}@${process.pid}`, run: null });
    return;
  }
  send({ kind: 'done', id: request.id, text: null, run: null });
});

// The app's `EngineLauncher`: each on-device engine in an Electron utility process (D-W22).
//
// A utility process is a separate OS process that Electron starts, names in Task Manager, and
// kills with the app — so an engine can never outlive Kotiba, and a native crash inside ONNX
// Runtime or llama.cpp ends that process only. Messages are structured clones over Electron's
// own IPC, which is what `forkLauncher` reproduces for plain Node.
//
// Only `src/main` may import electron, so this is the one place the engines' process is made.

import { utilityProcess } from 'electron';

import { engineHostPath, type EngineChannel, type EngineLauncher } from '../engines/engine-process.js';

const SERVICE_NAMES = {
  parakeet: 'Kotiba speech engine',
  llama: 'Kotiba modes engine',
  arabic: 'Kotiba Arabic engine',
  lid: 'Kotiba language detection',
} as const;

export function utilityLauncher(scriptPath: string = engineHostPath()): EngineLauncher {
  return (role) => {
    const child = utilityProcess.fork(scriptPath, [role], {
      serviceName: SERVICE_NAMES[role],
      stdio: 'inherit',
    });
    let exited = false;
    const exitListeners: ((code: number | null) => void)[] = [];
    child.on('exit', (code) => {
      exited = true;
      for (const listener of exitListeners.splice(0)) listener(code);
    });
    const channel: EngineChannel = {
      postMessage(message) {
        if (!exited) child.postMessage(message);
      },
      onMessage(listener) {
        child.on('message', listener);
      },
      onExit(listener) {
        if (exited) listener(null);
        else exitListeners.push(listener);
      },
      kill() {
        if (!exited) child.kill();
      },
      get pid() {
        return child.pid;
      },
    };
    return channel;
  };
}

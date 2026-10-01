// The contract surface. Every other module imports from here and from nowhere else in
// `src/contracts`, so a type can move between files without nine rebases.
//
// Nothing in this directory imports Electron, a Node builtin, or any OS API — it is
// types and plain data, and `windows/scripts/gate.sh` fails the build if that changes.

export * from './not-implemented.js';
export * from './language.js';
export * from './audio.js';
export * from './transcript.js';
export * from './routing.js';
export * from './settings.js';
export * from './modes.js';
export * from './polish.js';
export * from './errors.js';
export * from './state.js';
export * from './history.js';
export * from './diagnostics.js';
export * from './models.js';
export * from './hotkey.js';
export * from './interfaces.js';
export * from './streaming.js';
export * from './bundles.js';

import FluidAudio

// FluidAudio exports a struct named `FluidAudio`, so `FluidAudio.Language` does not name its
// language enum from any file that also imports KotibaCore — the module qualifier resolves to
// the struct. This file imports FluidAudio alone, where the bare name is unambiguous, and gives
// the type a name the engine can use.
typealias FluidLanguage = Language

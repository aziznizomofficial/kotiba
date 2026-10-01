import Foundation
import KotibaCore

// kotiba-golden — the Swift implementation stating its own answers.
//
//     swift run kotiba-golden windows/fixtures/golden
//
// This exists because of D-W1. Kotiba's core is a measured classifier, not business logic: the
// Turkic cluster threshold, the four Uzbek-Cyrillic letters, the 4-distinct-word evidence bar and
// the okina/tutuq rule are all numbers and sets that were arrived at by measurement, and a
// TypeScript reimplementation that is quietly different from any one of them produces bad Uzbek
// while every unit test it also wrote stays green. So the Swift emits, and the TypeScript is
// asserted against the emission rather than trusted.
//
// Determinism is the whole product. Everything in here is either a literal in this repository or
// the return value of a pure function over one. There is no clock, no locale, no environment, no
// network, no `UserDefaults`, no `FileManager.default.currentDirectoryPath`, and no dictionary
// iterated in hash order that reaches the output unsorted. Running it twice must produce
// byte-identical files, and `docs/windows/02b-GOLDEN.md` says how that is checked.

enum Generator {
    /// Stamped into every fixture. Deliberately a version rather than a timestamp: two runs of
    /// the same source must differ in nothing at all, and a date would be the one field that
    /// changed on every regeneration and trained a reader to ignore diffs.
    static let identity = "kotiba-golden v1 — swift run kotiba-golden windows/fixtures/golden"
}

// MARK: - Entry point

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: kotiba-golden <output-directory>\n".utf8))
    exit(2)
}

/// Relative paths resolve against the working directory, which is the one thing about invocation
/// that legitimately varies. The *contents* never depend on it — `Corpus.repoRoot` is derived from
/// `#filePath`, so the inputs are the same wherever the command is run from.
let outputDirectory = URL(fileURLWithPath: arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

func emit(_ name: String, _ value: JSONValue) throws {
    let url = outputDirectory.appendingPathComponent(name)
    try Data(value.serialised().utf8).write(to: url, options: .atomic)
    FileHandle.standardOutput.write(Data("wrote \(name)\n".utf8))
}

try emit("cluster-mass.json", RoutingFixtures.clusterMass())
try emit("script-check.json", RoutingFixtures.scriptCheck())
try emit("route.json", await RoutingFixtures.route())
try emit("transcript-check.json", TranscriptCheckFixtures.all())
try emit("uzbek-delivery.json", TextFixtures.uzbekDelivery())
try emit("arabic-delivery.json", TextFixtures.arabicDelivery())
try emit("capitalise.json", TextFixtures.capitalise())
try emit("modes.json", await ModesFixtures.all())
try emit("settings.json", SettingsFixtures.settings())

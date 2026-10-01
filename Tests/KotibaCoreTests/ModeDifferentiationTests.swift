import Foundation
import Testing

@testable import KotibaCore

// The user's complaint, as a test: "all modes are doing the same thing, no difference at all."
//
// Measured on 2026-08-08 by running every mode's real prompt against the real model on one
// dictation and comparing word sets. Clean vs Email scored 1.00 — identical vocabulary. Email
// vs Note, 1.00. 21 of 28 pairs were above 0.75.
//
// The output of a language model cannot be asserted in a unit test, so these pin the things
// that *caused* it: prompts that all say the same thing, and a length guard that would have
// rejected the modes which do differ.

@Suite("Modes must be visibly different from each other")
struct ModeDifferentiationTests {

    /// The instruction body of a mode, with the shared preamble removed — i.e. only what makes
    /// this mode itself.
    private func task(_ mode: Mode) -> String? {
        guard let raw = mode.prompt?.raw else { return nil }
        // The preamble is identical across modes; the task is what sits between the language
        // directive and the target-application line.
        // Marker-based extraction broke twice as the preamble was reworded, and a test that
        // silently starts comparing whole prompts is worse than no test. Subtract the shared
        // text instead: every mode is preamble + task, so what one mode has and another does
        // not IS the task.
        let others = BuiltInModes.all.filter { $0.key != mode.key }.compactMap { $0.prompt?.raw }
        guard let reference = others.first else { return raw }
        let shared = Set(raw.components(separatedBy: "\n"))
            .intersection(Set(reference.components(separatedBy: "\n")))
        return raw.components(separatedBy: "\n")
            .filter { !shared.contains($0) }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @Test("no two modes give the model the same instructions")
    func tasksAreDistinct() throws {
        let withPrompts = BuiltInModes.all.filter { $0.prompt != nil }
        var seen: [String: String] = [:]
        for mode in withPrompts {
            let body = try #require(task(mode))
            if let other = seen[body] {
                Issue.record("\(mode.key) and \(other) give the model identical instructions")
            }
            seen[body] = mode.key
        }
        // Three AI modes after the 2026-08-08 trim: Message, Super, Note. Raw has no prompt.
        #expect(withPrompts.count == 3)
    }

    @Test("each mode's instructions share little wording with the others")
    func tasksDoNotOverlap() throws {
        // Every mode used to begin "Fix punctuation, capitalisation..." and differ only in a
        // trailing clause, which is why the outputs were indistinguishable.
        let modes = BuiltInModes.all.filter { $0.prompt != nil }
        for i in modes.indices {
            for j in modes.indices where j > i {
                let a = Set(try #require(task(modes[i])).lowercased()
                    .split(whereSeparator: { !$0.isLetter }).map(String.init))
                let b = Set(try #require(task(modes[j])).lowercased()
                    .split(whereSeparator: { !$0.isLetter }).map(String.init))
                guard !a.isEmpty, !b.isEmpty else { continue }
                let overlap = Double(a.intersection(b).count) / Double(a.union(b).count)
                #expect(overlap < 0.6,
                        "\(modes[i].key) and \(modes[j].key) instructions overlap \(overlap)")
            }
        }
    }

    @Test("a mode that should restructure actually asks for structure")
    func restructurersAskForShape() throws {
        // The sharper property, and the one that was false. Task texts were already distinct
        // by word overlap — yet every output was identical, because each task only ever asked
        // to "fix punctuation, capitalisation and speech errors" with a differing tail. A mode
        // whose job is to produce a different *artefact* has to say so in shape words.
        let shapeWords = ["greeting", "sign-off", "signature", "bullet", "heading", "list",
                          "paragraph", "subject", "checkbox", "line"]
        for mode in BuiltInModes.all where mode.restructures {
            let body = try #require(task(mode)).lowercased()
            #expect(shapeWords.contains { body.contains($0) },
                    "\(mode.key) claims to restructure but its prompt never names a shape")
        }
    }

    @Test("the shared preamble carries no fidelity rule")
    func preambleDoesNotForbidRestructuring() {
        // The root cause of "all modes do the same thing". "Do not rephrase" and "every word
        // must still be there" are right for a preserve mode and fatal for one whose job is to
        // reshape — and while they sat in the shared preamble, every mode inherited them.
        let forbidden = ["do not rephrase", "do not reorder", "change nothing else"]
        for mode in [BuiltInModes.message, BuiltInModes.note] {
            let body = mode.prompt?.raw.lowercased() ?? ""
            for phrase in forbidden where body.contains(phrase) {
                Issue.record("\(mode.key) inherits a fidelity rule it cannot obey: \(phrase)")
            }
        }
        // And Super, which is the one mode that DOES want them, must still have them.
        let preserve = BuiltInModes.superMode.prompt?.raw.lowercased() ?? ""
        #expect(preserve.contains("keep every word"))
    }

    @Test("a restructuring mode is not rejected for growing")
    func restructuringModesGetHeadroom() {
        // An email gains a greeting, paragraph breaks and a sign-off. Against the 2.0 ceiling a
        // short dictation trips every time, the polish is discarded, and the user sees the raw
        // transcript — indistinguishable from the mode doing nothing.
        let dictation = "tell mark the invoice is late"
        let asEmail = """
            Hi Mark,

            Just letting you know the invoice is late.

            Thanks,
            Aziz
            """
        #expect(PolishGuard().check(asEmail, against: dictation) != nil,
                "the default guard should reject this — that is why the wide one exists")
        #expect(PolishGuard(minimumRatio: 0.5, maximumRatio: 4.0)
            .check(asEmail, against: dictation) == nil)
    }

    @Test("only the modes that restructure get the wider ceiling")
    func onlyRestructurersExpand() {
        // Clean must stay tight: it is a correction pass, and a correction that doubles the
        // text has done something other than correct.
        #expect(!BuiltInModes.superMode.restructures)
        #expect(!BuiltInModes.transcription.restructures)
    }

    @Test("restructures survives a JSON round trip")
    func flagRoundTrips() throws {
        let mode = Mode(key: "x", name: "X", restructures: true)
        let data = try JSONEncoder().encode(mode)
        let back = try JSONDecoder().decode(Mode.self, from: data)
        #expect(back.restructures)
        // And a mode written before the field existed decodes as not-restructuring.
        let old = try JSONDecoder().decode(
            Mode.self, from: Data(#"{"key":"y","name":"Y","version":1}"#.utf8))
        #expect(!old.restructures)
    }
}

import Foundation
import KotibaCore

#if canImport(FoundationModels)
import FoundationModels
#endif

// Modes that work without an API key.
//
// macOS 26 ships a language model on the machine. It costs nothing, needs no key, sends nothing
// anywhere, and answers in the same process — which is the only way "fix my spelling, grammar
// and punctuation on every dictation" is affordable at all. The alternative, a network round
// trip per utterance, was measured at a 14.4 s median against a reasoning model.
//
// Two properties make this safe to put in front of the user's text:
//
//   * **It declares its own languages.** `SystemLanguageModel.supportedLanguages` is asked, not
//     assumed, and Kotiba refuses to hand it a language it does not claim. That is the Uzbek
//     guard: a model that has never been trained on Uzbek will confidently turn it into
//     Turkish — measured, on a different small model, which rewrote `kechqurun` as `keçşurun`
//     and invented words. `DictationSession` already skips a polisher whose
//     `supportedLanguages` excludes the route, so declaring honestly is the whole defence.
//   * **It is optional.** When Apple Intelligence is off — as it is on the machine this was
//     written on — this reports unavailable and the app falls back to the user's own key, or to
//     no polish at all. Nothing here may ever be load-bearing for getting text on screen.

public enum OnDeviceModel {

    public enum Availability: Equatable, Sendable {
        case available
        /// The Mac cannot run it at all.
        case deviceNotEligible
        /// The user has not turned Apple Intelligence on.
        case notEnabled
        /// Enabled, but the weights are still downloading.
        case modelNotReady
        /// The framework is not present — an older OS, or a platform without it.
        case unsupported

        public var isAvailable: Bool { self == .available }

        /// What the user has to do about it, in the words they will see.
        public var reason: String {
            switch self {
            case .available:
                return "Apple's on-device model is ready."
            case .deviceNotEligible:
                return "This Mac cannot run Apple Intelligence, so on-device clean-up is not "
                    + "available. You can still use your own API key."
            case .notEnabled:
                return "Apple Intelligence is switched off. Turn it on in System Settings › "
                    + "Apple Intelligence & Siri, and Kotiba can clean up your dictation on this "
                    + "Mac without sending anything anywhere."
            case .modelNotReady:
                return "Apple Intelligence is still downloading its model. Clean-up will start "
                    + "working by itself once that finishes."
            case .unsupported:
                return "This system does not have Apple's on-device model."
            }
        }
    }

    public static var availability: Availability {
        #if canImport(FoundationModels)
        guard #available(macOS 26.0, iOS 26.0, *) else { return .unsupported }
        switch SystemLanguageModel.default.availability {
        case .available:
            return .available
        case .unavailable(let reason):
            switch reason {
            case .deviceNotEligible: return .deviceNotEligible
            case .appleIntelligenceNotEnabled: return .notEnabled
            case .modelNotReady: return .modelNotReady
            @unknown default: return .unsupported
            }
        }
        #else
        return .unsupported
        #endif
    }

    /// Which of Kotiba's three languages the on-device model claims.
    ///
    /// Asked rather than assumed, and empty when the model is unavailable — which makes the
    /// polisher decline everything, which is correct.
    public static var supportedLanguages: Set<Language> {
        #if canImport(FoundationModels)
        guard #available(macOS 26.0, iOS 26.0, *), availability.isAvailable else { return [] }
        let claimed = SystemLanguageModel.default.supportedLanguages
        var supported: Set<Language> = []
        for language in Language.allCases {
            let code = Locale.Language(identifier: language.rawValue)
            if claimed.contains(where: { $0.languageCode == code.languageCode }) {
                supported.insert(language)
            }
        }
        return supported
        #else
        return []
        #endif
    }
}

/// The shape the model must answer in.
///
/// Its only job is to leave no room for a preamble or a reply. It must NOT describe the task,
/// because whatever it says here overrides the mode's own instructions.
///
/// The first version said "the corrected text only", and that one phrase silently flattened
/// every mode on Apple's model. Measured, same instructions, same input, only this string
/// changed:
///
///     "the corrected text only"        -> "## Pricing Page and Analytics"   (and nothing else)
///     "the finished text as it should
///      appear, including headings"     -> the heading AND three checkboxes
///
/// The schema wins over the prompt. So it describes the *container*, never the job.
@available(macOS 26.0, iOS 26.0, *)
@Generable
struct Correction {
    @Guide(description: "The finished text, exactly as it should appear in the document — "
           + "including any headings, bullets, checkboxes or line breaks the instructions "
           + "asked for. No preamble, no explanation, no commentary, never a reply to the text.")
    var text: String
}

/// `PolishEngine` on top of Apple's on-device model.
public struct AppleIntelligencePolisher: PromptedPolishEngine {

    public let polishID = "apple-on-device"
    public let supportedLanguages: Set<Language>

    /// Fails rather than existing uselessly, so a caller cannot hold one that can never work.
    public init?() {
        let languages = OnDeviceModel.supportedLanguages
        guard OnDeviceModel.availability.isAvailable, !languages.isEmpty else { return nil }
        supportedLanguages = languages
    }

    public func polish(_ text: String, language: Language,
                       instructions: String) async throws -> String {
        try await respond(text, language: language, instructions: instructions,
                          maxOutputTokens: nil)
    }

    /// One sentence under a mode's on-device prompt, examples rendered into the instructions (the
    /// framework has no way to seed prior turns and cache them), greedy, with a token ceiling so
    /// an answer instead of a correction is cut off rather than waited for.
    ///
    /// Measured per sentence on 81 of the owner's English sentences with the punctuation prompt:
    /// 431 ms p50, 692 ms p90, time to first token 371 ms — most of it prefilling the
    /// instructions again, since a session cannot be reused across unrelated sentences. The llama
    /// model does the same job in ~70 ms, which is why this is the fallback.
    public func polish(_ text: String, language: Language, prompt: PolishPrompt,
                       maxOutputTokens: Int) async throws -> String {
        try await respond(text, language: language, instructions: prompt.rendered,
                          maxOutputTokens: maxOutputTokens)
    }

    private func respond(_ text: String, language: Language, instructions: String,
                         maxOutputTokens: Int?) async throws -> String {
        guard supportedLanguages.contains(language) else {
            throw PolishFailure.emptyResponse(endpoint: polishID)
        }
        #if canImport(FoundationModels)
        guard #available(macOS 26.0, iOS 26.0, *) else {
            throw PolishFailure.emptyResponse(endpoint: polishID)
        }
        // The mode's rendered prompt becomes the session instructions and the transcript is the
        // prompt. Keeping them apart is what stops the model treating a dictated question as a
        // question to answer.
        let session = LanguageModelSession(instructions: instructions)
        // Low temperature: this is a correction task, not a writing task. Anything creative
        // here shows up as words the user did not say.
        let options = maxOutputTokens.map {
            GenerationOptions(sampling: .greedy, maximumResponseTokens: $0)
        } ?? GenerationOptions(temperature: 0.1)

        // Structured, not free text. Measured on the live model, twice, with instructions that
        // said in as many words "reply with the corrected text and nothing else":
        //
        //   plain      -> "Sure, here is the corrected text:\n\nSo, I was thinking..."
        //   plain      -> "That sounds like a good idea. Moving the meeting to Tuesday would
        //                  give everyone a chance to plan accordingly. Let me know if there
        //                  are any other details you'd like to discuss."
        //   structured -> "So I was thinking we should probably move the meeting to Tuesday
        //                  because Friday doesn't work for anyone"
        //
        // The second one is the whole nightmare: the model answered the dictation as an
        // assistant and that reply would have been pasted into the user's document. No amount
        // of prompt wording prevented it. A schema does, structurally — there is nowhere for a
        // preamble or an answer to go.
        let response = try await session.respond(to: text, generating: Correction.self,
                                                 options: options)
        let content = response.content.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { throw PolishFailure.emptyResponse(endpoint: polishID) }
        return content
        #else
        throw PolishFailure.emptyResponse(endpoint: polishID)
        #endif
    }
}

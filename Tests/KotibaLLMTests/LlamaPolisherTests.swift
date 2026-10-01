import Foundation
import Testing
import KotibaCore
@testable import KotibaLLM

// Bands 1–2 cover the parts that need no weights. The generation test is band 3: it runs only
// when KOTIBA_POLISH_MODEL points at a GGUF (`make test-models` does not set it; the probe's
// `modes` command is the measured path).

struct LlamaPolisherTests {

    @Test func lookupProposesWhatFollowedTheLastMatchingTokens() {
        let source: [Int32] = [10, 11, 12, 13, 14, 15]
        #expect(LlamaEngine.lookup([99, 11, 12], in: source, maxDraft: 3) == [13, 14, 15])
        #expect(LlamaEngine.lookup([12], in: source, maxDraft: 2) == [13, 14])
    }

    @Test func lookupProposesNothingWithoutAMatchOrAtTheEnd() {
        #expect(LlamaEngine.lookup([42], in: [1, 2, 3], maxDraft: 4).isEmpty)
        #expect(LlamaEngine.lookup([3], in: [1, 2, 3], maxDraft: 4).isEmpty)
        #expect(LlamaEngine.lookup([1], in: [], maxDraft: 4).isEmpty)
    }

    @Test func promptIsChatMLWithExamplesAsTurnsAndThinkingOff() {
        let prompt = PolishPrompt(system: "S", examples: [.init("in", "out")])
        let head = LlamaEngine.chatML(prompt)
        #expect(head == "<|im_start|>system\nS<|im_end|>\n<|im_start|>user\nin<|im_end|>\n"
                + "<|im_start|>assistant\nout<|im_end|>\n")
        #expect(LlamaEngine.turn("x").hasSuffix("<|im_start|>assistant\n<think>\n\n</think>\n\n"))
    }

    @Test func gemma4IsReadFromTheArchitectureAndWrittenInItsOwnTurns() {
        // C4 §14.5: Arabic's modes model is Gemma 4; every other GGUF here is ChatML.
        #expect(LlamaEngine.chatFormat(architecture: "gemma4") == .gemma4)
        #expect(LlamaEngine.chatFormat(architecture: "qwen3") == .chatML)
        #expect(LlamaEngine.chatFormat(architecture: "") == .chatML)
        let prompt = PolishPrompt(system: "S", examples: [.init("in", "out")])
        #expect(LlamaEngine.gemma4(prompt) == "<bos><|turn>system\nS<turn|>\n"
                + "<|turn>user\nin<turn|>\n<|turn>model\nout<turn|>\n")
    }

    @Test func aMissingModelFailsTheSentenceRatherThanTheProcess() async {
        let polisher = LlamaPolisher(modelPath: "/nonexistent/model.gguf")
        await #expect(throws: LlamaFailure.modelMissing("/nonexistent/model.gguf")) {
            _ = try await polisher.polish("hello there", language: .english,
                                          instructions: "tidy")
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["KOTIBA_POLISH_MODEL"] != nil))
    func realModelPunctuatesWithoutChangingWords() async throws {
        let path = try #require(ProcessInfo.processInfo.environment["KOTIBA_POLISH_MODEL"])
        let polisher = LlamaPolisher(modelPath: path)
        let input = "ertaga vaqtingiz qanday soat beshda ko'rishsak nima deysiz"
        let raw = try await polisher.polish(input, language: .uzbek,
                                            prompt: OnDeviceModes.superPrompt(.uzbek),
                                            maxOutputTokens: 64)
        let projected = PunctuationProjection.project(raw, onto: input)
        #expect(projected.aligned >= PunctuationProjection.minimumAlignment)
        #expect(SentenceGuard.novelWords(in: projected.text, given: input).isEmpty)
    }

    // The pipeline cancels a primed sentence the final transcript no longer contains, often in
    // the middle of its generation. That used to leave the sequence's cache ahead of what the
    // engine believed it held, and every later sentence failed with `llama_decode returned -1`.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["KOTIBA_POLISH_MODEL"] != nil))
    func aCancelledGenerationDoesNotPoisonTheNext() async throws {
        let path = try #require(ProcessInfo.processInfo.environment["KOTIBA_POLISH_MODEL"])
        let polisher = LlamaPolisher(modelPath: path)
        let prompt = OnDeviceModes.superPrompt(.uzbek)
        let input = "ertaga vaqtingiz qanday soat beshda ko'rishsak nima deysiz"
        for _ in 0..<5 {
            let doomed = Task {
                try await polisher.polish(input + " va keyin nima qilamiz", language: .uzbek,
                                          prompt: prompt, maxOutputTokens: 64)
            }
            try await Task.sleep(for: .milliseconds(15))
            doomed.cancel()
            _ = try? await doomed.value
        }
        let raw = try await polisher.polish(input, language: .uzbek, prompt: prompt,
                                            maxOutputTokens: 64)
        #expect(!raw.isEmpty)
        await polisher.unload()
    }
}

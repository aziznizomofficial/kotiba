import Accelerate
import Foundation
import KotibaCore
internal import llama

// The on-device polisher for every Mac and — through the same GGUF file and node-llama-cpp — for
// Windows. Apple's model covers English only on this machine (`supportedLanguages` lists 23
// locales, Russian and Uzbek not among them), and only on Macs with Apple Intelligence switched
// on; this covers all three languages everywhere.
//
// Chosen by measurement over the owner's own sentences (docs/research/C3-on-device-modes.md):
// Qwen3-1.7B, Q4_K_M, 1.28 GB, Apache-2.0. Smaller models (Gemma 3 1B, Qwen3.5-0.8B, LFM2.5-1.2B)
// copied their own examples into the output or answered the dictation; larger ones (Qwen3-4B,
// Qwen3.5-4B) paraphrased more — which the modes do not want — at two to four times the latency.
//
// Two things make it fast enough to sit after key-release:
//
//   * **The prompt is prefilled once.** Each distinct prompt (a mode's system text and examples)
//     lives in its own KV-cache sequence, so a sentence costs only its own tokens of prefill —
//     ~40 tokens, not ~400.
//   * **The input is the draft.** A clean-up pass mostly copies its input, so the input's own
//     tokens are proposed as the next several tokens and verified in one batch (prompt-lookup
//     speculative decoding). Greedy verification makes the output identical to plain decoding;
//     only the number of forward passes changes. Measured in llama-server on this machine with
//     the same model: sentence p50 229 → 122 ms (English), 378 → 204 ms (Uzbek).

public struct LlamaPolisher: PromptedPolishEngine {

    public let polishID: String
    public let supportedLanguages: Set<Language>
    private let engine: LlamaEngine

    /// `modelPath` must point at a GGUF file; nothing is loaded until the first `prepare` or
    /// `polish`, and the weights are released again after `idleUnload` without use.
    public init(modelPath: String, id: String = "qwen3-1.7b",
                languages: Set<Language> = Set(Language.allCases),
                idleUnload: Duration = .seconds(180)) {
        polishID = id
        supportedLanguages = languages
        engine = LlamaEngine(path: modelPath, idleUnload: idleUnload)
    }

    public func polish(_ text: String, language: Language,
                       instructions: String) async throws -> String {
        try await engine.generate(PolishPrompt(system: instructions), input: text,
                                  maxTokens: SentenceSplitter.tokenBudget(for: text) * 2)
    }

    public func polish(_ text: String, language: Language, prompt: PolishPrompt,
                       maxOutputTokens: Int) async throws -> String {
        try await engine.generate(prompt, input: text, maxTokens: maxOutputTokens)
    }

    public func prepare(_ prompts: [PolishPrompt]) async {
        for prompt in prompts { try? await engine.prefill(prompt) }
    }

    /// Free the weights now. The engine reloads on next use.
    public func unload() async { await engine.unload() }

    /// Timings of the last generation, for the probe.
    public func lastRun() async -> LlamaEngine.Run? { await engine.last }
}

public enum LlamaFailure: Error, Sendable, Equatable, CustomStringConvertible {
    case modelMissing(String)
    case loadFailed(String)
    case tooLong(tokens: Int, context: Int)
    case decodeFailed(Int32)

    public var description: String {
        switch self {
        case .modelMissing(let p): return "no polish model at \(p)"
        case .loadFailed(let p): return "llama.cpp could not load \(p)"
        case .tooLong(let t, let c): return "sentence needs \(t) tokens, context holds \(c)"
        case .decodeFailed(let code): return "llama_decode returned \(code)"
        }
    }
}

/// One model, one context, several cached prompts. An actor because llama.cpp contexts are not
/// thread-safe and generations must not interleave.
public actor LlamaEngine {

    public struct Run: Sendable {
        public var promptTokens: Int
        public var prefilled: Int
        public var generated: Int
        public var forwardPasses: Int
        public var prefillMs: Double
        public var generateMs: Double
    }

    private let path: String
    private let idleUnload: Duration
    /// How many input tokens to propose per forward pass. Measured on 30 real Uzbek dictations,
    /// Super mode, tail p50/p90: 0 → 200/483 ms, 8 → 119/242, 16 → 106/189, 32 → 113/226. A
    /// verification pass costs ~33 ms whatever its width against ~8 ms for one token, so the
    /// draft must be long enough to be accepted four tokens at a time; past 16 it rarely is.
    /// `KOTIBA_LLAMA_DRAFT` overrides it so the
    /// probe can measure the difference; 0 is plain greedy decoding.
    private let draftTokens = Int(ProcessInfo.processInfo.environment["KOTIBA_LLAMA_DRAFT"] ?? "")
        ?? 16
    private var model: OpaquePointer?
    private var context: OpaquePointer?
    private var vocab: OpaquePointer?
    /// The chat markup the loaded model was trained on, read from its GGUF (`chatFormat`).
    private var format: ChatFormat = .chatML

    /// Qwen's ChatML (Qwen3's own template with thinking switched off), or Gemma 4's turns —
    /// for the Arabic modes model (C4 §14.5). Chosen by the GGUF's `general.architecture`.
    enum ChatFormat: Sendable, Equatable {
        case chatML
        case gemma4
    }
    private var slots: [PolishPrompt: Slot] = [:]
    private var unloadTask: Task<Void, Never>?
    private var nextUse = 0
    public private(set) var last: Run?

    /// Context shared by every cached prompt. q8_0 KV halves it: 4096 tokens of Qwen3-1.7B cost
    /// ~235 MB instead of ~470 MB.
    static let contextTokens: UInt32 = 4096
    static let maxSequences = 4
    static let batchTokens: Int32 = 512

    private struct Slot {
        var sequence: Int32
        var tokens: [llama_token]
        var lastUse: Int
    }

    init(path: String, idleUnload: Duration) {
        self.path = path
        self.idleUnload = idleUnload
        let live = Self.live
        Task { [weak self] in if let self { await live.add(self) } }
    }

    // MARK: Lifecycle

    /// Once per process. llama.cpp logs every tensor it loads to stderr — hundreds of lines per
    /// load, into the app's unified log — so the log callback is replaced with one that drops it.
    private static let backend: Void = {
        llama_log_set({ _, _, _ in }, nil)
        llama_backend_init()
    }()

    /// Every engine this process created, so they can be released before exit. ggml's Metal
    /// device asserts at process teardown if a model or context is still alive — measured: the
    /// probe aborted in `ggml_metal_device_free` from `exit()` after a clean run.
    private static let live = LiveEngines()

    /// Free every loaded model and context. Call before the process exits.
    public static func releaseAll() async {
        for engine in await live.all() { await engine.unload() }
    }

    private func load() throws {
        if context != nil { return }
        guard FileManager.default.fileExists(atPath: path) else {
            throw LlamaFailure.modelMissing(path)
        }
        _ = Self.backend
        var modelParams = llama_model_default_params()
        modelParams.n_gpu_layers = 99
        guard let loaded = llama_model_load_from_file(path, modelParams) else {
            throw LlamaFailure.loadFailed(path)
        }
        var params = llama_context_default_params()
        params.n_ctx = Self.contextTokens
        params.n_batch = UInt32(Self.batchTokens)
        params.n_ubatch = UInt32(Self.batchTokens)
        params.n_seq_max = UInt32(Self.maxSequences)
        params.kv_unified = true
        params.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_AUTO
        params.type_k = GGML_TYPE_Q8_0
        params.type_v = GGML_TYPE_Q8_0
        let threads = Int32(max(1, min(8, ProcessInfo.processInfo.activeProcessorCount - 2)))
        params.n_threads = threads
        params.n_threads_batch = threads
        guard let ctx = llama_init_from_model(loaded, params) else {
            llama_model_free(loaded)
            throw LlamaFailure.loadFailed(path)
        }
        model = loaded
        context = ctx
        vocab = llama_model_get_vocab(loaded)
        format = Self.chatFormat(architecture: Self.metadata(loaded, "general.architecture"))
        slots = [:]
    }

    /// Weights out of memory when nobody has dictated for a while — the idle-RAM lesson from the
    /// whisper contexts (1.5 GB held forever) applies to this model just the same.
    private func scheduleUnload() {
        unloadTask?.cancel()
        let delay = idleUnload
        unloadTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.unload()
        }
    }

    public func unload() {
        if let context { llama_free(context) }
        if let model { llama_model_free(model) }
        context = nil
        model = nil
        vocab = nil
        slots = [:]
    }

    // MARK: Prompt

    static func metadata(_ model: OpaquePointer, _ key: String) -> String {
        var buffer = [CChar](repeating: 0, count: 128)
        let n = llama_model_meta_val_str(model, key, &buffer, buffer.count)
        return n > 0 ? String(cString: buffer) : ""
    }

    static func chatFormat(architecture: String) -> ChatFormat {
        architecture.hasPrefix("gemma4") || architecture.hasPrefix("gemma3n") ? .gemma4 : .chatML
    }

    /// The prompt's system text and examples, in the loaded model's markup.
    func head(_ prompt: PolishPrompt) -> String {
        switch format {
        case .chatML: return Self.chatML(prompt)
        case .gemma4: return Self.gemma4(prompt)
        }
    }

    /// One user turn and the opening of the model's reply.
    func userTurn(_ input: String) -> String {
        switch format {
        case .chatML: return Self.turn(input)
        case .gemma4: return "<|turn>user\n\(input)<turn|>\n<|turn>model\n"
        }
    }

    /// Gemma 4's own markup with thinking off: a system turn, examples as real turns.
    static func gemma4(_ prompt: PolishPrompt) -> String {
        var s = "<bos><|turn>system\n\(prompt.system)<turn|>\n"
        for example in prompt.examples {
            s += "<|turn>user\n\(example.input)<turn|>\n"
            s += "<|turn>model\n\(example.output)<turn|>\n"
        }
        return s
    }

    /// ChatML with an empty thinking block — Qwen3's own template with thinking switched off.
    /// Examples become real user/assistant turns.
    static func chatML(_ prompt: PolishPrompt) -> String {
        var s = "<|im_start|>system\n\(prompt.system)<|im_end|>\n"
        for example in prompt.examples {
            s += "<|im_start|>user\n\(example.input)<|im_end|>\n"
            s += "<|im_start|>assistant\n\(example.output)<|im_end|>\n"
        }
        return s
    }

    static func turn(_ input: String) -> String {
        "<|im_start|>user\n\(input)<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
    }

    private func tokenize(_ text: String) -> [llama_token] {
        guard let vocab else { return [] }
        let utf8 = Array(text.utf8CString)
        let byteCount = Int32(utf8.count - 1)
        var tokens = [llama_token](repeating: 0, count: Int(byteCount) + 8)
        var n = utf8.withUnsafeBufferPointer { buf in
            llama_tokenize(vocab, buf.baseAddress, byteCount, &tokens, Int32(tokens.count),
                           false, true)
        }
        if n < 0 {
            tokens = [llama_token](repeating: 0, count: Int(-n))
            n = utf8.withUnsafeBufferPointer { buf in
                llama_tokenize(vocab, buf.baseAddress, byteCount, &tokens, Int32(tokens.count),
                               false, true)
            }
        }
        return Array(tokens.prefix(Int(max(0, n))))
    }

    private func piece(_ token: llama_token) -> [UInt8] {
        guard let vocab else { return [] }
        var buf = [CChar](repeating: 0, count: 64)
        let n = llama_token_to_piece(vocab, token, &buf, Int32(buf.count), 0, false)
        guard n > 0 else { return [] }
        return buf.prefix(Int(n)).map { UInt8(bitPattern: $0) }
    }

    // MARK: Slots

    /// The sequence holding this prompt, evicting the least recently used when all are taken.
    private func slot(for prompt: PolishPrompt) -> Slot {
        nextUse += 1
        if var existing = slots[prompt] {
            existing.lastUse = nextUse
            slots[prompt] = existing
            return existing
        }
        let used = Set(slots.values.map(\.sequence))
        var sequence = (0..<Int32(Self.maxSequences)).first { !used.contains($0) }
        if sequence == nil, let victim = slots.min(by: { $0.value.lastUse < $1.value.lastUse }) {
            sequence = victim.value.sequence
            slots[victim.key] = nil
            if let context { _ = llama_memory_seq_rm(llama_get_memory(context), victim.value.sequence, -1, -1) }
        }
        let fresh = Slot(sequence: sequence ?? 0, tokens: [], lastUse: nextUse)
        slots[prompt] = fresh
        return fresh
    }

    /// Bring `slot`'s KV up to `tokens`, reusing the common prefix. Returns tokens prefilled.
    /// Leaves the logits of the last token available at batch index `lastIndex`.
    private func sync(_ slot: inout Slot, to tokens: [llama_token],
                      needLogits: Bool) throws -> (prefilled: Int, passes: Int) {
        guard let context else { return (0, 0) }
        var common = zip(slot.tokens, tokens).prefix(while: { $0 == $1 }).count
        // The last token must be decoded again to have its logits.
        if needLogits, common == tokens.count { common = max(0, common - 1) }
        // Unconditionally, not only when `slot.tokens` runs past `common`. A generation that was
        // cancelled — the pipeline cancels a primed sentence the final transcript no longer
        // contains — or whose decode failed throws before `generate` stores its slot, so the
        // sequence's cache holds the turn and the tokens it had generated while `slot.tokens`
        // still reads as the bare prompt. Trusting `slot.tokens` then decoded new tokens at
        // positions the cache already held, and `llama_decode` answered -1 for every sentence
        // from then on (measured: every Uzbek Super sentence of a 40-dictation e2e run).
        _ = llama_memory_seq_rm(llama_get_memory(context), slot.sequence, Int32(common), -1)
        slot.tokens = Array(tokens.prefix(common))
        var passes = 0
        var start = common
        while start < tokens.count {
            let end = min(tokens.count, start + Int(Self.batchTokens))
            let isLast = end == tokens.count
            try decode(Array(tokens[start..<end]), from: start, sequence: slot.sequence,
                       logits: isLast && needLogits ? .last : .none)
            slot.tokens += tokens[start..<end]
            passes += 1
            start = end
        }
        return (tokens.count - common, passes)
    }

    private enum Logits { case none, last, all }

    private func decode(_ tokens: [llama_token], from position: Int, sequence: Int32,
                        logits: Logits) throws {
        guard let context else { return }
        var batch = llama_batch_init(Int32(tokens.count), 0, 1)
        defer { llama_batch_free(batch) }
        for (i, token) in tokens.enumerated() {
            batch.token[i] = token
            batch.pos[i] = llama_pos(position + i)
            batch.n_seq_id[i] = 1
            batch.seq_id[i]![0] = sequence
            switch logits {
            case .none: batch.logits[i] = 0
            case .last: batch.logits[i] = i == tokens.count - 1 ? 1 : 0
            case .all: batch.logits[i] = 1
            }
        }
        batch.n_tokens = Int32(tokens.count)
        let status = llama_decode(context, batch)
        guard status == 0 else { throw LlamaFailure.decodeFailed(status) }
    }

    /// Greedy: the output of a clean-up pass should be the most likely text, not a sample.
    /// vDSP because this runs over 151,936 logits for every drafted position.
    private func argmax(at index: Int32) -> llama_token {
        guard let context, let vocab, let logits = llama_get_logits_ith(context, index) else {
            return 0
        }
        var value: Float = 0
        var position: vDSP_Length = 0
        vDSP_maxvi(logits, 1, &value, &position, vDSP_Length(llama_vocab_n_tokens(vocab)))
        return llama_token(position)
    }

    // MARK: Generation

    func prefill(_ prompt: PolishPrompt) throws {
        try load()
        var slot = slot(for: prompt)
        _ = try sync(&slot, to: tokenize(head(prompt)), needLogits: false)
        slots[prompt] = slot
        scheduleUnload()
    }

    func generate(_ prompt: PolishPrompt, input: String, maxTokens: Int) throws -> String {
        try load()
        defer { scheduleUnload() }
        let clock = ContinuousClock()
        let started = clock.now

        let head = tokenize(head(prompt))
        let userTokens = tokenize(userTurn(input))
        let tokens = head + userTokens
        guard tokens.count + maxTokens < Int(Self.contextTokens) - 8 else {
            throw LlamaFailure.tooLong(tokens: tokens.count + maxTokens,
                                      context: Int(Self.contextTokens))
        }
        var slot = slot(for: prompt)
        let (prefilled, prefillPasses) = try sync(&slot, to: tokens, needLogits: true)
        let prefillDone = clock.now

        // The draft source: the input's own tokens, as the model would write them.
        let source = tokenize(input)
        var output: [llama_token] = []
        var pending = argmax(at: -1)
        var position = slot.tokens.count
        var passes = 0
        guard let vocab else { throw LlamaFailure.loadFailed(path) }

        while output.count < maxTokens {
            try Task.checkCancellation()
            if llama_vocab_is_eog(vocab, pending) { break }
            output.append(pending)
            let draft = Array(Self.lookup(output, in: source, maxDraft: draftTokens)
                .prefix(max(0, maxTokens - output.count)))
            try decode([pending] + draft, from: position, sequence: slot.sequence,
                       logits: .all)
            passes += 1
            slot.tokens.append(pending)
            var accepted = 0
            var next = argmax(at: 0)
            for (i, token) in draft.enumerated() {
                guard next == token, !llama_vocab_is_eog(vocab, token) else { break }
                output.append(token)
                slot.tokens.append(token)
                accepted += 1
                next = argmax(at: Int32(i + 1))
                if output.count >= maxTokens { break }
            }
            position += 1 + accepted
            if accepted < draft.count, let context {
                _ = llama_memory_seq_rm(llama_get_memory(context), slot.sequence,
                                        Int32(position), -1)
            }
            pending = next
        }
        slots[prompt] = slot

        var bytes: [UInt8] = []
        for token in output { bytes += piece(token) }
        let text = String(decoding: bytes, as: UTF8.self)
            .replacingOccurrences(of: "<|im_end|>", with: "")
            .replacingOccurrences(of: "<turn|>", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        let done = clock.now
        last = Run(promptTokens: tokens.count, prefilled: prefilled, generated: output.count,
                   forwardPasses: passes + prefillPasses,
                   prefillMs: Self.ms(prefillDone - started), generateMs: Self.ms(done - prefillDone))
        return text
    }

    /// Prompt-lookup drafting: find the longest recent n-gram of the output (3, then 2, then 1
    /// tokens) inside the input and propose what followed it there.
    static func lookup(_ output: [llama_token], in source: [llama_token],
                       maxDraft: Int) -> [llama_token] {
        guard !source.isEmpty else { return [] }
        for n in stride(from: min(3, output.count), through: 1, by: -1) {
            let tail = Array(output.suffix(n))
            var i = source.count - n
            while i >= 0 {
                if Array(source[i..<(i + n)]) == tail, i + n < source.count {
                    return Array(source[(i + n)..<min(source.count, i + n + maxDraft)])
                }
                i -= 1
            }
        }
        return []
    }

    public static func ms(_ d: Duration) -> Double {
        Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15
    }
}

private actor LiveEngines {
    private var engines: [WeakEngine] = []
    private struct WeakEngine { weak var engine: LlamaEngine? }
    func add(_ engine: LlamaEngine) {
        engines.removeAll { $0.engine == nil }
        engines.append(WeakEngine(engine: engine))
    }
    func all() -> [LlamaEngine] { engines.compactMap(\.engine) }
}

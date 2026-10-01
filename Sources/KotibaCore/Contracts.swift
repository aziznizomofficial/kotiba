import Foundation

// The seams between pure logic and the platform. Everything in this file is a protocol or a
// value type; nothing here knows what AVAudioEngine, Core ML or NSPasteboard are. That is the
// whole point — the state machine in DictationSession.swift can then be exercised end to end
// in Band-1 tests with no signing, no models and no microphone.
//
// Tasks C-01 … C-05 of docs/20-BUILD-PLAN.md.

// MARK: - Language and engines

/// The languages Kotiba hears. Three it exists for — Uzbek is the reason it exists at all — and
/// two the user may add (D-11).
///
/// Turkish and Arabic are **optional dictation languages**: off until the user turns them on in
/// Languages (or onboarding offers them to a Mac whose system language is one of them), and never
/// app-interface languages — that list is `AppLanguage`, and stays en / ru / uz-Latn / uz-Cyrl.
/// Everything that iterates `allCases` therefore sees five; everything that routes must ask which
/// of the optional two are on (`TieredRouter.optional`), because a language that is not on must
/// cost the three core ones nothing — not a detection, not a stream, not a misroute.
public enum Language: String, Sendable, Codable, CaseIterable, Equatable {
    case english = "en"
    case russian = "ru"
    case uzbek = "uz"
    /// whisper large-v3-turbo, the file the Russian fallback already uses (C4 §7.1).
    case turkish = "tr"
    /// Cohere Transcribe Arabic through transcribe.cpp, turbo behind it (C4 §7.2).
    case arabic = "ar"

    /// What a prompt calls the language. `{{language}}` used to render the code, so a model was
    /// told "The text is in uz" and left to work out what uz was — and "Latin script" is not
    /// decoration: a model that knows Uzbek has two alphabets will otherwise pick one.
    public var promptName: String {
        switch self {
        case .english: return "English"
        case .russian: return "Russian"
        case .uzbek: return "Uzbek (Latin script)"
        case .turkish: return "Turkish"
        case .arabic: return "Arabic (Arabic script)"
        }
    }

    /// The languages that are always on. The optional ones are the rest of `allCases`.
    public static let core: Set<Language> = [.english, .russian, .uzbek]

    /// Off until the user turns it on; see the type's comment.
    public var isOptional: Bool { !Self.core.contains(self) }

    /// Written right to left. Only the app's own transcript surfaces care (C4 §9.5): the text
    /// itself is inserted in logical order and never carries a bidi control mark.
    public var isRightToLeft: Bool { self == .arabic }

    /// Upper- and lowercasing that know Turkish's two i's: `i` ↔ `İ` and `ı` ↔ `I`.
    ///
    /// Swift's plain `uppercased()` is locale-free, so `istanbul` capitalised to `Istanbul` —
    /// wrong in Turkish, where the capital of `i` is `İ` — and `lowercased()` turned `İ` into `i`
    /// plus a combining dot, a two-scalar string no word list matches. Every other language takes
    /// the locale-free path it always had (Arabic has no case; `lowercased()` leaves it alone).
    public func uppercased(_ text: String) -> String {
        self == .turkish ? text.uppercased(with: Self.turkishLocale) : text.uppercased()
    }

    public func lowercased(_ text: String) -> String {
        self == .turkish ? text.lowercased(with: Self.turkishLocale) : text.lowercased()
    }

    private static let turkishLocale = Locale(identifier: "tr")
}

/// Which engine family a language belongs to.
///
/// English and Russian share one family, deliberately. Parakeet TDT v3 carries a unified 8192-token
/// vocabulary and decides English against Russian *inside the decoder, at zero cost* — measured
/// on a commercial dictation app's own history, where 60 of 60 records were pinned to "en" and one of them
/// emitted correct Cyrillic in 98 ms. So the router's job is one bit, not a 3-way choice.
public enum EngineFamily: String, Sendable, Codable, CaseIterable, Equatable {
    /// Parakeet Ultra (the TDT 0.6B v3 family) on the ANE. English and Russian, 41–62 ms warm
    /// for up to 10 s of audio on the M4 Pro — docs/research/C1-en-ru-engine-selection.md.
    case unified
    /// whisper.cpp + Metal with an Uzbek fine-tune. ~438 ms for 10.7 s on M4 Pro.
    case uzbek
    /// whisper large-v3-turbo on Turkish — the same file as the Russian fallback, its own
    /// streaming session (C4 §8). Optional (D-11).
    case turkish
    /// Cohere Transcribe Arabic through transcribe.cpp, with turbo and a punctuated Arabic prompt
    /// behind it while the 1.77 GB model is not on disk and when a segment ends in a decode loop
    /// (C4 §3.2). Optional (D-11).
    case arabic

    public init(for language: Language) {
        switch language {
        case .english, .russian: self = .unified
        case .uzbek: self = .uzbek
        case .turkish: self = .turkish
        case .arabic: self = .arabic
        }
    }
}

// MARK: - Audio

/// A finalised mono 16 kHz Float32 buffer. Engines take this; nothing takes a file path.
public struct AudioBuffer: Sendable, Equatable {
    public static let sampleRate = 16_000

    public let samples: [Float]

    /// How many samples the capture threw away because nothing drained them in time.
    ///
    /// This exists because there was previously nowhere to put it. `MicrophoneSource` counted the
    /// loss correctly and then wrote it to `lastWarmUpError` — a field only the microphone-*permission*
    /// UI reads — so a truncated recording arrived here looking complete, went to `.done`, and the
    /// count was cleared by the next `start()`. Worse, when it did surface it was rendered as the
    /// permission blocker, so lost audio read as "grant microphone access".
    ///
    /// Non-zero means the recording is short: the user said more than this buffer contains.
    public let droppedSamples: Int

    /// Which input device produced this recording, when the source knows (`MicrophoneSource`
    /// does; a WAV file does not). It travels with the audio because the session is the only
    /// place the record is written, and a capture's device can change between two takes.
    public let device: InputDeviceInfo?

    public init(samples: [Float], droppedSamples: Int = 0, device: InputDeviceInfo? = nil) {
        self.samples = samples
        self.droppedSamples = droppedSamples
        self.device = device
    }

    /// The same recording, labelled with the device it came from.
    public func withDevice(_ device: InputDeviceInfo?) -> AudioBuffer {
        AudioBuffer(samples: samples, droppedSamples: droppedSamples, device: device)
    }

    /// Seconds of speech lost to overflow, at the buffer's own sample rate.
    public var droppedSeconds: Double { Double(droppedSamples) / Double(Self.sampleRate) }

    public var duration: Double { Double(samples.count) / Double(Self.sampleRate) }

    /// Peak absolute amplitude. The near-silence guard keys off this, and it is the reason
    /// roughly a third of the previous build's dictations returned an empty string instead of
    /// saying it heard nothing: empty results had a median peak of 0.0018 against 0.1326 for
    /// successful ones.
    public var peakAmplitude: Float {
        samples.reduce(Float(0)) { Swift.max($0, Swift.abs($1)) }
    }
}

/// A source of microphone audio. `WAVFileSource` conforms to this in tests so no test ever
/// touches the real microphone — that needs a TCC grant which does not exist on a runner and
/// pops a dialog locally.
public protocol AudioSource: Sendable {
    /// Begin capturing. Must be safe to call when already armed.
    func start() async throws

    /// Stop capturing and return everything captured since `start()`.
    func stop() async throws -> AudioBuffer

    /// Prepare the engine graph without capturing, so the first press is not the cold one.
    /// Called on every foreground, never once from init.
    func warmUp() async
}

/// A source that hands over its audio while it is still capturing, without disturbing the
/// capture: `stop()` still returns the whole recording.
///
/// Separate from `AudioSource` because a test's WAV source has nothing to stream and nothing
/// should make it pretend otherwise. `MicrophoneTake` conforms — one per dictation, so two
/// overlapping dictations never share a stream.
public protocol LiveAudioSource: AudioSource {
    /// Every 16 kHz mono chunk of this recording, in order and without gaps, delivered while it
    /// is captured; finished when the recording ends. Buffered, so a late consumer misses
    /// nothing. Iterated once.
    var chunks: AsyncStream<[Float]> { get }
}

// MARK: - Transcription

public struct Transcript: Sendable, Equatable {
    /// Exactly what the engine emitted, before any normalisation. Persisted as `rawResult`.
    public let raw: String
    public let language: Language
    public let engineID: String

    public init(raw: String, language: Language, engineID: String) {
        self.raw = raw
        self.language = language
        self.engineID = engineID
    }
}

public protocol TranscriptionEngine: Sendable {
    /// Stable, human-readable, and recorded in diagnostics. When something is slow, the first
    /// question is always which engine actually ran — the previous build could not answer it,
    /// and silently served every iOS dictation from Whisper for weeks.
    var engineID: String { get }

    var supportedLanguages: Set<Language> { get }

    /// Whether this engine can transcribe *right now*, with nothing loaded first.
    ///
    /// This is deliberately narrow, and the narrowness is the point: it answers "is the model
    /// resident", not "will this engine work". A lazily-loaded engine is legitimately false here
    /// before its first use, so **false is not a failure** — a caller that treats it as one
    /// refuses engines that would have worked. That mistake is what stopped Uzbek and Russian
    /// dictation working on every default install.
    ///
    /// A caller finding false must call `prepare()` and re-ask. Only a `prepare()` that *throws*
    /// means the engine is unusable, and its error is the diagnosis.
    func isReady() async -> Bool

    /// Load and compile. Idempotent, and retried on every foreground rather than once at init.
    ///
    /// Throwing is the only way an engine says it cannot work, so throw something that names the
    /// cause — a missing file, a bad checksum and a denied permission must stay distinguishable
    /// once they reach the user.
    func prepare() async throws

    func transcribe(_ audio: AudioBuffer, language: Language) async throws -> Transcript
}

/// An engine that can start work while the user is still speaking.
///
/// Why it exists: a batch engine's cost grows with the recording, and the recording is exactly
/// what the user is waiting on at key-release. Parakeet decodes a 15 s window in ~100 ms on the
/// Neural Engine, so a 10 s dictation is fine in batch — but this owner's p90 dictation is 42 s
/// and one in six runs past 30 s, where batch costs several windows *after* the key comes up.
/// Decoding finished stretches during the hold leaves at most one window for the release.
///
/// Opening a stream is a *speculation*, not a routing decision: the language is not known until
/// key-up, and a stream whose dictation routes elsewhere (Uzbek) is simply cancelled.
public protocol StreamingTranscriptionEngine: TranscriptionEngine {
    /// Start a stream. Cheap; must not block on loading — a cold engine may return a stream that
    /// buffers until it is ready, or one that does nothing until `finish`.
    func openStream() async -> any TranscriptionStream
}

public protocol TranscriptionStream: Sendable {
    /// The next samples of the recording, 16 kHz mono Float32, in order and without gaps.
    func append(_ samples: [Float]) async

    /// Key-up. `audio` is the finalised recording and is authoritative: the stream reuses what
    /// it already decoded only where that is still a prefix of `audio`, and decodes the rest.
    /// A stream that fell behind, lost samples or was never fed returns exactly what a batch
    /// `transcribe(audio, language:)` would — it is an optimisation, never a different answer
    /// about *which* audio was transcribed.
    func finish(_ audio: AudioBuffer, language: Language) async throws -> Transcript

    /// Discard everything. The dictation went to another engine, or was cancelled.
    func cancel() async

    /// What the stream has decoded so far, while the key is still held — or nil for a stream
    /// that decodes nothing before `finish`. Polled by the session, which feeds the settled part
    /// of it to the mode's sentence-by-sentence polish so that key-up is left with the tail only.
    func progress() async -> StreamProgress?

    /// Whether routing currently expects this stream's language. A stream may stop its
    /// *speculative* work while it is unlikely — the Uzbek stream's pause decodes are GPU time an
    /// English dictation should not pay for — but must still be able to `finish` correctly if the
    /// route comes back to it. Default: ignored.
    func setLikely(_ likely: Bool) async

    /// How `finish` settled the tail, in one word, for the diagnostics record (`report.tail`):
    /// `speculation` (a decode made at the pause before key-up was adopted — release cost a
    /// join), `prefix` (a pause decode plus the rest), `decoded` (the tail was decoded after
    /// key-up), `none` (nothing left), `fallback`, or `batch` (the stream could not vouch for the
    /// recording, which was decoded whole). Nil when the stream does not say.
    func settlement() async -> String?

    /// Where the last speech the stream's speech detector heard ends, in samples from the start
    /// of the recording — or nil when it does not track speech. Asked at key-up, after every
    /// sample has been appended: a language detection that heard at least this much heard every
    /// word, so it is as good as a detection over the whole recording.
    func lastSpeechEnd() async -> Int?
}

/// A stream's text while the key is held.
public struct StreamProgress: Sendable, Equatable {
    /// Decoded for good — never revised by anything that happens later in the hold.
    public var committed: String
    /// The latest provisional decode of everything after `committed` (made at a pause), or "".
    /// It may change when the speaker carries on; `LiveTranscript` decides which part of it has
    /// settled.
    public var provisional: String
    /// The language the text is written in, when the stream can tell.
    public var language: Language?
    /// Where, in samples from the start of the recording, the last speech `provisional` covers
    /// ends — so a language detection that has heard at least this much has heard every word
    /// the provisional decode holds. 0 when unknown.
    public var speechEnd: Int

    public init(committed: String, provisional: String, language: Language?,
                speechEnd: Int = 0) {
        self.committed = committed
        self.provisional = provisional
        self.language = language
        self.speechEnd = speechEnd
    }

    /// Committed and provisional, joined the way the stream's own `finish` joins them.
    public var text: String {
        [committed, provisional].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }.joined(separator: " ")
    }
}

extension TranscriptionStream {
    public func progress() async -> StreamProgress? { nil }
    public func setLikely(_ likely: Bool) async {}
    public func settlement() async -> String? { nil }
    public func lastSpeechEnd() async -> Int? { nil }
}

// MARK: - Routing

public enum RouteSource: String, Sendable, Codable, Equatable {
    /// The mode pinned a language. Costs nothing and beats everything.
    case pin
    /// ECAPA over the full utterance at key-release, masked to two classes.
    case acoustic
    /// The engine's own output script disagreed with the route; this is the verifier.
    case scriptCheck
    /// The engine's output was in the right script but the wrong language's words — the Uzbek
    /// engine answering in English. See `LexicalCheck`.
    case lexicalCheck
    /// Parakeet's transcript read as neither English nor Russian and the Uzbek engine's did not
    /// read as English: Uzbek the acoustic pass missed. See `TranscriptCheck`.
    case transcriptCheck
    /// Nothing was available; the default language was used.
    case fallback
    /// Turkish, on the second opinion of whisper turbo's own language head, over a recording the
    /// acoustic pass had heard as Turkic and as likely Turkish (D-11). See `TurkishCheck`.
    case turkishCheck
    /// Arabic, on the same head's word, over a recording the acoustic pass half-heard as Arabic
    /// (C4 §14). See `ArabicCheck`.
    case arabicCheck
    /// The user dictates in only one language — or only English and Russian, which one engine
    /// settles between itself — so there was nothing to detect (`LanguageSubset.soleRoute`).
    /// Free like a pin, but not a pin: a recovery may still move it within the languages that
    /// are on.
    case only
}

public struct RouteDecision: Sendable, Codable, Equatable {
    public let language: Language
    public let family: EngineFamily
    public let source: RouteSource
    /// Summed probability across Uzbek and the languages it is misheard as. A clean Uzbek clip
    /// scores `tr 0.63 / az 0.17 / uz 0.00`, so any rule waiting for `uz` to win never fires.
    public let turkicMass: Double?
    /// The detector's `tr` and `ar` probabilities as shares of its whole posterior — recorded
    /// only when an optional language is on, since only then does routing read them (D-11).
    public let turkishShare: Double?
    public let arabicShare: Double?
    /// A second language the decision has not ruled out, for the session to settle with more
    /// evidence: `.turkish` on an Uzbek route that sounded Turkish (`TurkishCheck`), `.arabic` on
    /// any route that half-sounded Arabic (`ArabicCheck`). Nil almost always.
    public let candidate: Language?
    /// turbo's `tr` share, when `TurkishCheck` was asked. For the record.
    public let turkishVerified: Double?
    /// turbo's `ar` share, when `ArabicCheck` was asked. For the record.
    public let arabicVerified: Double?

    public init(language: Language, source: RouteSource, turkicMass: Double? = nil,
                turkishShare: Double? = nil, arabicShare: Double? = nil,
                candidate: Language? = nil, turkishVerified: Double? = nil,
                arabicVerified: Double? = nil) {
        self.language = language
        self.family = EngineFamily(for: language)
        self.source = source
        self.turkicMass = turkicMass
        self.turkishShare = turkishShare
        self.arabicShare = arabicShare
        self.candidate = candidate
        self.turkishVerified = turkishVerified
        self.arabicVerified = arabicVerified
    }

    /// The same decision routed to `language` by `source`, keeping what the detector heard.
    public func rerouted(to language: Language, by source: RouteSource,
                         turkishVerified: Double? = nil,
                         arabicVerified: Double? = nil) -> RouteDecision {
        RouteDecision(language: language, source: source, turkicMass: turkicMass,
                      turkishShare: turkishShare, arabicShare: arabicShare, candidate: nil,
                      turkishVerified: turkishVerified ?? self.turkishVerified,
                      arabicVerified: arabicVerified ?? self.arabicVerified)
    }
}

public protocol LanguageRouter: Sendable {
    /// `pin` short-circuits everything when present.
    func route(_ audio: AudioBuffer, pin: Language?) async -> RouteDecision
}

// MARK: - Insertion

/// What actually happened, observed rather than assumed. The HUD dismisses on this, never on a
/// fixed delay: a commercial dictation app's paste confirmation was still breaking per-app at v2.17.0.
public enum InsertionOutcome: Sendable, Equatable {
    case inserted
    case refused(reason: String)
    case timedOut
}

public protocol TextSink: Sendable {
    func insert(_ text: String) async throws -> InsertionOutcome

    /// Replace text this session previously inserted, for the polish pass. Implementations that
    /// cannot verify the old text is still present must return `.refused` rather than guess —
    /// a mis-replace corrupts whatever the user typed in between.
    func replace(_ previous: String, with text: String) async throws -> InsertionOutcome
}

// MARK: - Polish

/// The system prompt a polish pass runs under — one per language, because the route is not
/// known when the prompt is built.
///
/// The prompt used to be a single string rendered at key-up for `mode.language ??
/// defaultLanguage`, before the acoustic pass had run. No built-in mode pins a language, so it
/// always said "The text is in en. Keep it in en. Never translate." — and a Russian or Uzbek
/// dictation then reached the model under an instruction to translate it, from the one line
/// whose whole purpose was to stop the model drifting between languages.
///
/// A string literal still works, for callers and tests with nothing language-specific to say.
public enum PolishInstructions: Sendable, Equatable, ExpressibleByStringLiteral {
    case fixed(String)
    case perLanguage([Language: String])

    public init(stringLiteral value: String) { self = .fixed(value) }

    /// The instructions for the language the session actually routed to, or nil if this set
    /// has nothing for it — in which case the session does not polish.
    public func resolved(for language: Language) -> String? {
        switch self {
        case .fixed(let text): return text
        case .perLanguage(let byLanguage): return byLanguage[language]
        }
    }
}

/// Optional post-processing. Never on the critical path: measured at 4–18× the cost of the
/// transcription it polishes, p50 1620 ms against ASR's 170 ms, and never once under 759 ms.
public protocol PolishEngine: Sendable {
    var polishID: String { get }
    var supportedLanguages: Set<Language> { get }

    /// Must honour cancellation. The caller enforces the deadline; an implementation that
    /// ignores `Task.isCancelled` will be abandoned rather than waited for.
    func polish(_ text: String, language: Language, instructions: String) async throws -> String

    /// Anything the last `polish` call needs on the record beyond the text it returned, and it is
    /// drained — reading it clears it.
    ///
    /// `polish` returns a bare `String`, which leaves no way to say *who* produced it. That is
    /// fine for a single polisher and wrong for a composite: when the on-device member fails and
    /// the network member quietly succeeds, the user's text goes over the wire despite them asking
    /// for on-device, and `polishID` records the whole member list rather than the one that ran.
    /// Nothing anywhere could tell them. This is that missing channel.
    ///
    /// Default: nothing to add.
    func drainNotes() async -> [String]
}

extension PolishEngine {
    public func drainNotes() async -> [String] { [] }
}

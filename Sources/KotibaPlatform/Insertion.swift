import Foundation
import KotibaCore

// The platform seam, stated once, so no caller above this line needs an `#if os(...)`.
//
// Apps/ and KotibaUI are meant to be shared. The moment a controller writes `#if os(macOS)`
// around a sink, the same conditional has to be repeated everywhere else that touches it, and
// the iOS target breaks the next time someone forgets — which is exactly how it broke.
//
// So both platforms answer the same two questions. macOS answers them properly. iOS answers
// them honestly: insertion there is the keyboard extension over the App Group (tasks I-05 and
// I-06), which is not built, and `Focus` cannot work at all because iOS 26.4 nulled
// `hostApplicationBundleId`.

public enum Insertion {

    /// The sink for this platform.
    public static func sink() -> any TextSink {
        #if os(macOS)
        return PasteboardSink()
        #else
        return UnavailableSink()
        #endif
    }
}

/// Refuses, and says why. Never silently drops the text.
///
/// A sink that accepted and discarded would produce the exact defect this project exists to
/// fix: a dictation that reports success and delivers nothing.
public struct UnavailableSink: TextSink {

    public init() {}

    public func insert(_ text: String) async throws -> InsertionOutcome {
        .refused(reason: "text insertion is not implemented on this platform yet — on iOS it "
                 + "needs the keyboard extension, which is not built")
    }

    public func replace(_ previous: String, with text: String) async throws -> InsertionOutcome {
        .refused(reason: "text replacement is not implemented on this platform")
    }
}

#if !os(macOS)

/// The same shape as the macOS one, answering nothing.
///
/// iOS has no equivalent of reading the frontmost app's focused element — a keyboard extension
/// cannot see the host application at all, and iOS 26.4 nulled `hostApplicationBundleId`. So
/// the context is honestly empty rather than guessed at.
public struct ScreenContext: Sendable, Equatable {
    public var userName: String?
    public var appName: String?
    public var appFormat: String
    public var fieldDescription: String?
    public var names: [String]

    public init(userName: String? = nil, appName: String? = nil, appFormat: String = "plain text",
                fieldDescription: String? = nil, names: [String] = []) {
        self.userName = userName
        self.appName = appName
        self.appFormat = appFormat
        self.fieldDescription = fieldDescription
        self.names = names
    }

    public static func capture(nameLimit: Int = 24) -> ScreenContext { ScreenContext() }
}

/// The same shape as the macOS one, answering nil.
///
/// Not an oversight: iOS 26.4 nulled `hostApplicationBundleId` for keyboard extensions, so an
/// app there genuinely cannot know which application it is typing into. Mode activation by app
/// is macOS-only for that reason, and the build plan records it under M-05.
public enum Focus {
    public static var frontmostBundleID: String? { nil }
    public static var frontmostName: String? { nil }
    public static var isSelfFrontmost: Bool { true }
}

#endif

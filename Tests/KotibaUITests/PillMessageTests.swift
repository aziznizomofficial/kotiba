import AppKit
import Foundation
import KotibaCore
import SwiftUI
import Testing

@testable import KotibaUI

// The owner saw a long failure sentence spill out of the 160 × 36 pill. What holds it now: every
// message the pill can say is a few words in each of the four languages, and each one fits the
// capsule the layout computes — one line or two, never a word cut in half, never wider than the
// pill may grow. Read straight from the catalog, so a translation that grows fails here rather
// than on someone's screen.

@MainActor
@Suite("Pill messages fit the pill")
struct PillMessageTests {

    /// Every message the pill can carry: the clipboard note, heard-nothing and each failure.
    static var messageKeys: [String] {
        StringCatalog.bundled.table.keys
            .filter { $0 == "pill.copied" || $0 == "pill.heardNothing" || $0 == "pill.quietMic"
                || $0.hasPrefix("pill.failed.") }
            .sorted()
    }

    static func text(_ key: String, _ language: AppLanguage) -> String {
        guard case .text(let text)? = StringCatalog.bundled.table[key]?[language.rawValue] else {
            Issue.record("\(key) has no \(language.rawValue) text")
            return ""
        }
        // The quiet-microphone hint carries a device name. Test it with the widest name the pill
        // will ever print (`QuietMic.pillName`: two words, 14 characters), not with "%@".
        return text.replacingOccurrences(of: "%@", with: worstDeviceName)
    }

    /// Two wide words cut at 14 characters — what `QuietMic.pillName` hands the message at most.
    static let worstDeviceName = QuietMic.pillName("Wwwwwwwwwww Wwwwwwwwwww")

    static var lineHeight: CGFloat {
        let font = PillMessageLayout.font
        return ceil(font.ascender - font.descender + font.leading)
    }

    @Test("the catalog carries a pill message for every way a dictation can end badly")
    func everyOutcomeHasOne() {
        let keys = Set(Self.messageKeys)
        for key in ["pill.copied", "pill.heardNothing", "pill.quietMic", "pill.failed.generic", "pill.failed.microphone",
                    "pill.failed.recording", "pill.failed.transcription", "pill.failed.paste",
                    "pill.failed.pasteTimedOut", "pill.failed.englishNotReady",
                    "pill.failed.noRussianModel", "pill.failed.noUzbekModel"] {
            #expect(keys.contains(key), "\(key)")
        }
        // Each failure the controller can report maps to one of them, never to the long sentence.
        let failures: [SessionFailure] = [
            .armingFailed("REASON"), .captureFailed("REASON"), .noEngineReady(.unified, .english),
            .noEngineReady(.unified, .russian), .noEngineReady(.uzbek, .uzbek),
            .transcriptionFailed("REASON"), .insertionRefused("REASON"), .insertionTimedOut,
        ]
        let headlines = failures.map(DictationController.pillHeadline)
        #expect(Set(headlines).count == failures.count)
        for (failure, headline) in zip(failures, headlines) {
            #expect(headline != DictationController.describe(failure), "\(failure)")
            #expect(!headline.contains("REASON"), "\(failure) leaked its reason into the pill")
        }
    }

    @Test("a glance, not a report: at most six words and 40 characters in every language")
    func short() {
        for language in AppLanguage.allCases {
            for key in Self.messageKeys {
                let text = Self.text(key, language)
                let words = text.split(whereSeparator: \.isWhitespace).filter { $0 != "—" }
                #expect(words.count <= 6, "\(key) [\(language.rawValue)]: \(text)")
                #expect(text.count <= 40, "\(key) [\(language.rawValue)]: \(text)")
            }
        }
    }

    @Test("every message in every language fits the computed capsule: ≤ 360 wide, ≤ 2 lines, no word cut")
    func fits() {
        var longest: (String, CGFloat) = ("", 0)
        for language in AppLanguage.allCases {
            for key in Self.messageKeys {
                let text = Self.text(key, language)
                let layout = PillMessageLayout.fit(text)
                let label = "\(key) [\(language.rawValue)]: \(text)"
                #expect(layout.size.width <= PillView.maxMessageWidth, "\(label) — \(layout)")
                #expect(layout.size.width >= PillView.width, "\(label)")
                #expect(layout.lines <= 2, "\(label) — \(layout.lines) lines")
                #expect(layout.size.height <= 2 * Self.lineHeight + 2 * PillMessageLayout.verticalPadding + 1,
                        "\(label)")
                // No word is wider than the line it has to sit on, so none is broken.
                #expect(PillMessageLayout.widestWord(text) <= layout.textWidth, "\(label)")
                // The capsule holds the words and the icon exactly: chrome + text ≤ width.
                #expect(layout.textWidth + PillMessageLayout.chrome <= layout.size.width + 0.5, "\(label)")
                let natural = PillMessageLayout.measure(text, width: .greatestFiniteMagnitude).width
                if natural > longest.1 { longest = (label, natural) }
            }
        }
        // The longest message wraps and still fits — the case the owner saw.
        let (label, _) = longest
        #expect(!label.isEmpty)
    }

    @Test("SwiftUI draws the words in the lines the measurement promised")
    func swiftUIAgrees() {
        for language in AppLanguage.allCases {
            for key in Self.messageKeys {
                let text = Self.text(key, language)
                let layout = PillMessageLayout.fit(text)
                let host = NSHostingView(rootView:
                    Text(text)
                        .font(Font(PillMessageLayout.font))
                        .multilineTextAlignment(.center)
                        .lineLimit(PillMessageLayout.maxLines)
                        .frame(width: layout.textWidth)
                        .fixedSize(horizontal: false, vertical: true))
                let drawn = host.fittingSize.height
                let lines = Int((drawn / Self.lineHeight).rounded())
                #expect(lines == layout.lines,
                        "\(key) [\(language.rawValue)]: SwiftUI drew \(lines) lines (\(drawn) pt), measured \(layout.lines)")
                // And the whole capsule view is exactly the computed size.
                let pill = NSHostingView(rootView: PillView(state: .attention(text), level: 0))
                let size = pill.fittingSize
                #expect(abs(size.width - layout.size.width) <= 0.5 && abs(size.height - layout.size.height) <= 0.5,
                        "\(key) [\(language.rawValue)]: view \(size), layout \(layout.size)")
            }
        }
    }

    @Test("two lines break in balance, not one word left alone")
    func balanced() {
        // Long enough to need two lines at 360; balanced means the lines are close in width.
        let text = "Didn’t finish because the model for this language could not be loaded at all"
        let layout = PillMessageLayout.fit(text)
        #expect(layout.lines == 2)
        let full = PillMessageLayout.measure(text, width: .greatestFiniteMagnitude).width
        // Balanced: the wrap width is barely more than half the text's one-line width.
        #expect(layout.textWidth < full * 0.62, "\(layout.textWidth) vs \(full)")
    }

    @Test("a narrow screen narrows the pill, and a long message still never overflows it")
    func narrowScreen() {
        #expect(HUDPanel.maxMessageWidth(visibleWidth: 1512) == PillView.maxMessageWidth)
        let narrow = HUDPanel.maxMessageWidth(visibleWidth: 280)
        #expect(narrow == 232)
        for language in AppLanguage.allCases {
            for key in Self.messageKeys {
                let text = Self.text(key, language)
                let layout = PillMessageLayout.fit(text, maxWidth: narrow)
                #expect(layout.size.width <= narrow, "\(key) [\(language.rawValue)]")
                #expect(layout.lines <= PillMessageLayout.maxLines)
                #expect(PillMessageLayout.widestWord(text) <= layout.textWidth)
            }
        }
    }

    @Test("a short message stays the pill's own 160 × 36, on one line")
    func shortStaysSmall() {
        let layout = PillMessageLayout.fit("Copied")
        #expect(layout.size == CGSize(width: PillView.width, height: PillView.height))
        #expect(layout.lines == 1)
    }
}

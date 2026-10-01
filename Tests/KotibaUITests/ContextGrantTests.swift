import Foundation
import KotibaPlatform
import Testing

@testable import KotibaCore
@testable import KotibaUI

// `{{selection}}` came back empty for a mode that asked for the selection and nothing else.
//
// `ScreenContext.capture()` is one call answering two separate questions — what application am I
// in, and what is selected in it — and the gate on it was `contextFromActiveApplication` alone. A
// mode with `contextFromSelection` on and `contextFromActiveApplication` off therefore captured
// nothing at all, and `screen?.selection ?? ""` rendered an empty string with no error: exactly
// the silent-empty-variable failure that filling `ScreenContext.selection` in was written to end.
//
// The two are independent grants. Either one is a reason to look at the screen; neither is a
// reason to hand over the other one's contents.

@Suite("What a mode is allowed to see")
@MainActor
struct ContextGrantTests {

    private func mode(selection: Bool, application: Bool) -> Mode {
        Mode(key: "test", name: "Test",
             contextFromSelection: selection,
             contextFromActiveApplication: application)
    }

    private static let onScreen = ScreenContext(
        userName: "Aziz Nizomov",
        appName: "Mail",
        fieldDescription: "To:",
        names: ["Nizomov"],
        selection: "the sentence being rewritten")

    private func rendered(_ mode: Mode, screen: ScreenContext?) -> PromptContext {
        DictationController.promptContext(
            mode: mode, screen: screen, bundleID: nil, language: .uzbek,
            vocabulary: [], clipboard: "", now: Date(timeIntervalSince1970: 0))
    }

    // The finding, as a test.
    @Test("a mode that asks only for the selection gets the selection")
    func selectionDoesNotNeedTheApplication() {
        let mode = mode(selection: true, application: false)

        #expect(DictationController.readsScreen(mode),
                "the screen has to be read at all, or there is nothing to take the selection from")
        #expect(rendered(mode, screen: Self.onScreen).selection == "the sentence being rewritten")
    }

    // The privacy half, which the old gate got right by accident and must keep. Reading the screen
    // for the selection must not also hand over the app, the field, the user or the visible names.
    @Test("...and nothing else")
    func selectionDoesNotLeakTheApplication() {
        let context = rendered(mode(selection: true, application: false), screen: Self.onScreen)

        #expect(context.app == "an unknown application")
        #expect(context.field == "an unnamed field")
        #expect(context.user == "the speaker")
        #expect(context.names == "none visible")
    }

    @Test("a mode that asks for the application does not get the selection with it")
    func applicationDoesNotLeakTheSelection() {
        let context = rendered(mode(selection: false, application: true), screen: Self.onScreen)

        #expect(context.selection.isEmpty)
        #expect(context.app == "Mail")
        #expect(context.field == "To:")
        #expect(context.user == "Aziz Nizomov")
    }

    // Reading the screen is the least private thing Kotiba does, so a mode that asks for neither
    // must not pay for it.
    @Test("a mode that asks for neither is never read for")
    func noGrantMeansNoCapture() {
        #expect(!DictationController.readsScreen(mode(selection: false, application: false)))
    }

    @Test("either grant is reason enough to look")
    func eitherGrantCaptures() {
        #expect(DictationController.readsScreen(mode(selection: true, application: false)))
        #expect(DictationController.readsScreen(mode(selection: false, application: true)))
    }

    // Their polish never sees the rendered template, so reading the screen at key-up — on the
    // main actor, before the transcript is finished — bought nothing and cost the paste.
    @Test("a built-in mode never reads the screen, though each ships asking for the application")
    func builtInModesDoNotCapture() {
        for mode in BuiltInModes.all {
            #expect(mode.contextFromActiveApplication, "\(mode.key) no longer asks")
            #expect(!DictationController.readsScreen(mode), "\(mode.key) reads the screen")
        }
    }

    // Accessibility refused, or nothing focused. Every variable degrades to its stated default
    // rather than to a crash or a stale value from a previous dictation.
    @Test("no screen at all is survivable")
    func nilScreenDegrades() {
        let context = rendered(mode(selection: true, application: true), screen: nil)

        #expect(context.selection.isEmpty)
        #expect(context.user == "the speaker")
        #expect(context.app == "an unknown application")
    }
}

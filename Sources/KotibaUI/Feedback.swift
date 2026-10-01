import Foundation

#if os(macOS)
import AppKit
#endif

// The sounds, and why they are off by default.
//
// This app is used in meetings. A dictation tool that chirps twice every time someone speaks is
// a tool people stop using in the room where they most need it. So the toggle exists, it
// defaults to off, and the sounds are the quiet system ones rather than anything
// attention-seeking.
//
// System sounds rather than bundled audio: they respect the user's alert volume, they are
// already familiar, and they add nothing to the app's download.

enum Feedback {

    enum Event {
        case start
        case stop
        case cancel
        case failure

        #if os(macOS)
        var soundName: String {
            switch self {
            case .start: return "Tink"
            case .stop: return "Pop"
            case .cancel: return "Bottle"
            case .failure: return "Funk"
            }
        }
        #endif
    }

    static func play(_ event: Event, enabled: Bool) {
        guard enabled else { return }
        #if os(macOS)
        // Fire and forget. A missing system sound returns nil rather than throwing, and a
        // dictation must never fail because a sound would not play.
        NSSound(named: event.soundName)?.play()
        #endif
    }
}

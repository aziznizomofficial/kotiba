import SwiftUI

import KotibaCore

// Shell only. This target owns the microphone and the models; the keyboard extension is a
// thin insertion client that talks to it over the App Group. The extension cannot open the
// microphone — error 561145187 '!rec' — which is what forces this split.
@main
struct KotibaiOSApp: App {
    var body: some Scene {
        WindowGroup {
            Text("Kotiba — not yet wired up")
        }
    }
}

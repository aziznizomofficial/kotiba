// swift-tools-version: 6.2
import PackageDescription

// Kotiba — a a commercial dictation app-equivalent dictation system for one person on three devices.
//
// The shape of this file is load-bearing, not taste. KotibaCore is pure Swift: it imports
// nothing from AVFoundation, CoreML or SwiftUI and contains no #if os(...). Everything
// platform-shaped enters through a protocol in Contracts/. That is what lets the bulk of
// the test suite run in milliseconds on every push, with no signing, no models and no
// microphone — see docs/20-BUILD-PLAN.md, "Test bands".
//
// Apps/ carries exactly three things: the activation gesture, the presentation shell and
// the delivery mechanism. If a fourth appears there, it is misplaced.

let swift6 = SwiftSetting.swiftLanguageMode(.v6)

let package = Package(
    name: "Kotiba",
    // The app's own words are English first; Localizable.xcstrings in KotibaUI carries Русский,
    // Oʻzbekcha (Lotin) and Ўзбекча (Кирилл) beside it. See KotibaUI/Localization.swift.
    defaultLocalization: "en",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "KotibaCore", targets: ["KotibaCore"]),
        .library(name: "KotibaAudio", targets: ["KotibaAudio"]),
        .library(name: "KotibaModels", targets: ["KotibaModels"]),
        .library(name: "KotibaEngines", targets: ["KotibaEngines"]),
        .library(name: "KotibaPlatform", targets: ["KotibaPlatform"]),
        .library(name: "KotibaLLM", targets: ["KotibaLLM"]),
        .library(name: "KotibaTranscribe", targets: ["KotibaTranscribe"]),
        .library(name: "KotibaUI", targets: ["KotibaUI"]),
        .executable(name: "kotiba-probe", targets: ["kotiba-probe"]),
        .executable(name: "kotiba-golden", targets: ["kotiba-golden"]),
    ],
    dependencies: [
        // Parakeet TDT on the Neural Engine, for English and Russian. See
        // docs/research/C1-en-ru-engine-selection.md for the measurement that chose it.
        //
        // Pinned exactly, not `from:`, for the same reason whisper is pinned by checksum: the
        // decode path (window stitching, TDT duration handling, the v3 top-K language filter)
        // lives in this library, not in the weights, so a minor bump can move WER. Upgrade by
        // re-running Scripts/measure/en-ru and reading the numbers, not by resolving.
        //
        // `traits: []` drops the NeMo text-normalisation xcframework (a prebuilt Rust static
        // library, ~8 MB per slice). It serves TTS and inverse text normalisation, neither of
        // which Kotiba calls; ASR output is identical without it.
        //
        // Apache-2.0. The model weights it loads are CC-BY-4.0 and are downloaded at runtime,
        // not vendored — see ModelCatalogue and NOTICE.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.4",
                 traits: []),
    ],
    targets: [
        // Pure. No Apple media or ML frameworks, no SwiftUI, no #if os.
        // SQLite is the history store. It is a C library, not a platform framework, so it does
        // not compromise KotibaCore's purity — `make lint` still passes.
        .target(name: "KotibaCore", swiftSettings: [swift6],
                linkerSettings: [.linkedLibrary("sqlite3")]),

        // Objective-C because it must be. AVFAudio reports a hardware-format mismatch by
        // raising an NSException, Swift cannot catch one, and an uncaught raise aborts the
        // process — the crash logs behind "the hotkey went dead after six hours".
        // Only @try/@catch can turn that raise into a value, and only ObjC has @try.
        .target(name: "KotibaObjC"),

        .target(name: "KotibaAudio", dependencies: ["KotibaCore", "KotibaObjC"],
                swiftSettings: [swift6]),
        .target(name: "KotibaModels", dependencies: ["KotibaCore"], swiftSettings: [swift6]),
        .target(name: "KotibaPlatform", dependencies: ["KotibaCore"], swiftSettings: [swift6]),

        // whisper.cpp, as the project's own released xcframework rather than a vendored copy.
        //
        // A binary target, pinned by checksum, for three reasons. It keeps 184 MB of compiled
        // Metal out of the repository forever. It is the artefact the upstream project itself
        // tests and ships, so it carries Metal and Core ML support already configured. And the
        // checksum means a silently swapped binary fails the build instead of shipping.
        //
        // Uzbek is why this dependency exists. Apple's SpeechTranscriber refuses the language
        // outright; whisper.cpp with a fine-tuned model is the only measured path to it.
        .binaryTarget(
            name: "whisper",
            url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-v1.9.2-xcframework.zip",
            checksum: "af74fed13ea7f2d5ca2a39d9f58ec177713fafd7cab63aef4e27b79f3ceca80b"
        ),

        // llama.cpp, for the modes. Same reasoning as whisper above — the project's own released
        // xcframework, pinned by checksum — and the same GGUF the Windows port loads through
        // node-llama-cpp. b11249 (2026-09-29). Only `llama_*` symbols are called from Swift: both
        // frameworks carry their own copy of ggml, and a `ggml_*` call from Swift would bind to
        // whichever one the linker saw first.
        .binaryTarget(
            name: "llama",
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b11249/llama-b11249-xcframework.zip",
            checksum: "ff076c7ff880e5342a3e0924dea0f051fdfc3d1e89f5485338cd6fd777dae854"
        ),

        // transcribe.cpp, for Arabic (docs/research/C4-turkish-arabic-engine-selection.md, D-11):
        // Cohere Transcribe Arabic runs on nothing else on both platforms. Same reasoning as the
        // two above — the project's own released xcframework, pinned by checksum (the sha256 C4
        // §7.2 recorded). It is a dynamic framework exporting no ggml symbol, so its ggml cannot
        // meet whisper's or llama's; its module is `CTranscribe`. MIT; the weights it loads are
        // Apache-2.0 and downloaded at runtime (ModelCatalogue.arabicEngine, NOTICE).
        .binaryTarget(
            name: "TranscribeCpp",
            url: "https://github.com/handy-computer/transcribe.cpp/releases/download/v0.2.4/TranscribeCpp.xcframework.zip",
            checksum: "243e96ea569583245c9732de3955111210d986c03a34b81424dacde169f9de6a"
        ),

        // The Arabic engine, alone with transcribe.cpp — for the same reason KotibaLLM is alone
        // with llama.cpp: nothing that imports whisper's headers should also see a second set.
        .target(name: "KotibaTranscribe", dependencies: ["KotibaCore", "TranscribeCpp"],
                swiftSettings: [swift6],
                linkerSettings: [.linkedLibrary("c++"), .linkedLibrary("z"),
                                 .linkedFramework("Accelerate"), .linkedFramework("Metal"),
                                 .linkedFramework("MetalKit")]),

        // The on-device polisher. Separate from KotibaEngines so that nothing importing the
        // transcription engines also has to import a second copy of the ggml headers.
        .target(name: "KotibaLLM", dependencies: ["KotibaCore", "llama"], swiftSettings: [swift6]),

        // The engines. Each conforms to `TranscriptionEngine` and knows nothing about the
        // others; the router picks between them. Depends on KotibaModels because an engine
        // that needs a downloaded model asks the store where it is rather than guessing.
        .target(name: "KotibaEngines",
                dependencies: ["KotibaCore", "KotibaAudio", "KotibaModels", "whisper",
                               "KotibaTranscribe",
                               .product(name: "FluidAudio", package: "FluidAudio")],
                swiftSettings: [swift6]),

        // UI is the one place where MainActor-by-default is right. It also holds the controller
        // that owns every other piece, which is why it depends on all of them: something has to
        // be the single object the app hands to a view, and a seventh target to hold one class
        // would be an abstraction with no second user.
        .target(
            name: "KotibaUI",
            dependencies: ["KotibaCore", "KotibaAudio", "KotibaModels", "KotibaPlatform",
                           "KotibaEngines", "KotibaLLM", "KotibaTranscribe"],
            // The String Catalog: `swift build` copies it verbatim and Xcode compiles it to .lproj
            // tables; `StringCatalog` reads either, so tests and the app agree.
            //
            // The app icon at 256 px, for the brand mark in the sidebar, onboarding and About.
            // A copy rather than `NSApp.applicationIconImage`: that is whatever the system made of
            // the icon (masked, padded, or a generic one in a test or the snapshot harness), and
            // this has to be the same pixels everywhere. `BrandMarkTests` keeps it identical to
            // Apps/macOS/Assets.xcassets/AppIcon.appiconset/icon_256x256.png.
            resources: [.process("Resources/Localizable.xcstrings"),
                        .copy("Resources/BrandMark.png"),
                        // Home's globe (PromoGlobe.swift): Natural Earth 110 m land, public domain,
                        // one bit per 3° sample — 529 bytes.
                        .copy("Resources/GlobeLand.bin")],
            swiftSettings: [swift6, .defaultIsolation(MainActor.self)]
        ),

        // Not shipped. The harness that produces every latency number the docs quote.
        // `e2e` drives the real `DictationController`, hence KotibaUI and KotibaPlatform.
        .executableTarget(name: "kotiba-probe",
                          dependencies: ["KotibaCore", "KotibaAudio", "KotibaEngines",
                                         "KotibaModels", "KotibaLLM", "KotibaPlatform", "KotibaUI",
                                         "KotibaTranscribe"],
                          swiftSettings: [swift6]),

        // Not shipped, and not a test. The generator that makes the Swift implementation state
        // its own answers, so the Windows port can be asserted against them rather than trusted.
        // It depends on KotibaCore and KotibaModels only — deliberately not KotibaUI, whose
        // MainActor isolation and whisper dependency would put a 184 MB binary and a UserDefaults
        // read behind a program whose entire product is determinism. See docs/windows/02b-GOLDEN.md.
        .executableTarget(name: "kotiba-golden",
                          dependencies: ["KotibaCore", "KotibaModels", "KotibaPlatform"],
                          swiftSettings: [swift6]),

        // Fixtures are read from #filePath at runtime, not bundled, so SwiftPM should not
        // treat them as resources.
        .testTarget(name: "KotibaCoreTests", dependencies: ["KotibaCore"],
                    exclude: ["Fixtures"], swiftSettings: [swift6]),
        .testTarget(name: "KotibaAudioTests", dependencies: ["KotibaAudio", "KotibaObjC"],
                    swiftSettings: [swift6]),
        .testTarget(name: "KotibaModelsTests", dependencies: ["KotibaModels"], swiftSettings: [swift6]),
        .testTarget(name: "KotibaEnginesTests", dependencies: ["KotibaEngines"], swiftSettings: [swift6]),
        .testTarget(name: "KotibaLLMTests", dependencies: ["KotibaLLM"], swiftSettings: [swift6]),
        .testTarget(name: "KotibaTranscribeTests", dependencies: ["KotibaTranscribe"],
                    swiftSettings: [swift6]),
        .testTarget(name: "KotibaPlatformTests", dependencies: ["KotibaPlatform"], swiftSettings: [swift6]),
        .testTarget(name: "KotibaUITests", dependencies: ["KotibaUI"],
                    swiftSettings: [swift6, .defaultIsolation(MainActor.self)]),
    ]
)

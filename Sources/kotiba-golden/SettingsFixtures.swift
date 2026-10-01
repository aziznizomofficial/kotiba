import Foundation
import KotibaCore
import KotibaModels
import KotibaPlatform

// settings.json — the shipped defaults and the full mode table.
//
// The mode table is *invoked*: `BuiltInModes` lives in KotibaCore, so every field below is what
// the app itself constructs, prompts included, character for character.
//
// The defaults are a harder problem and the solution is worth explaining, because the obvious two
// answers are both wrong.
//
//   * **Import KotibaUI and read `AppSettings()`.** `AppSettings` is in KotibaUI, which is
//     MainActor-isolated, depends on SwiftUI and pulls in the 184 MB whisper binary target — and
//     `init` calls `load()`, which reads `UserDefaults.standard`. A generator whose entire product
//     is byte-identical output cannot have the machine it runs on in its input.
//   * **Type the 28 values in by hand.** Then the fixture is a second copy of the defaults that
//     drifts silently the first time someone changes one, which is the exact failure mode golden
//     fixtures exist to remove.
//
// So: **parse `Sources/KotibaUI/Settings.swift` at generation time.** The file is committed, so
// this is as deterministic as a literal, and it is derived from the declaration rather than from
// someone's memory of it. `expectedFields` below is a closed list — a field renamed, added or
// removed makes this program exit non-zero and say which, rather than quietly emitting a fixture
// that no longer describes the app.

enum SettingsFixtures {

    // MARK: - The shipped defaults, read out of the declaration

    /// Every `public var` `AppSettings` is expected to declare, with the JSON type its default
    /// should land as. Closed in both directions on purpose: an unexpected field is drift too.
    private static let expectedFields: [(name: String, kind: Kind)] = [
        ("defaultLanguage", .language),
        ("pinnedLanguage", .optionalLanguage),
        ("enabledLanguages", .languages),
        ("turkishDictations", .int),
        ("arabicDictations", .int),
        ("uzbekModelPath", .string),
        ("russianModelPath", .string),
        ("whisperUseGPU", .bool),
        ("whisperBeamSize", .int),
        ("preloadAllLanguages", .bool),
        ("modelIdleUnloadMinutes", .double),
        ("detectorModelPath", .string),
        ("turkicThreshold", .double),
        ("silenceThreshold", .double),
        ("soundFeedback", .bool),
        ("vocabulary", .emptyObject),
        ("replacements", .emptyArray),
        ("autoCapitalise", .bool),
        ("defaultModeKey", .string),
        ("modeFollowsApp", .bool),
        ("polishEnabled", .bool),
        ("polishUzbek", .bool),
        ("preferOnDeviceModel", .bool),
        ("cloudPolish", .bool),
        ("polishBaseURL", .string),
        ("polishModel", .string),
        ("polishFallbackModel", .string),
        ("polishKeyAccount", .string),
        ("polishTimeoutSeconds", .double),
        ("hotkey", .hotkey),
        ("duckingEnabled", .bool),
        ("duckLevel", .double),
        ("preferBuiltInMicWithBluetooth", .bool),
        ("alwaysOn", .bool),
        ("launchAtLogin", .bool),
        ("hasCompletedOnboarding", .bool),
        ("autoDownloadModels", .bool),
        ("appLanguage", .string),
        ("pillStyle", .pillStyle),
        ("statsPeriod", .string),
        ("keepHistory", .bool),
        ("historyLimit", .int),
        ("diagnosticsEnabled", .bool),
    ]

    private enum Kind {
        case bool, int, double, string, language, optionalLanguage, emptyObject, emptyArray
        /// `[Language]`, written as an array literal of cases (`[.english, .russian]`).
        case languages
        /// `HotkeySpec`, written as a static member (`.default`) and resolved through the real
        /// symbol, so the fixture says which key that is rather than repeating its name.
        case hotkey
        /// `PillAnimationStyle`, written as a case (`.sirilobes`). Its raw values are its case
        /// names — the enum declares no others — so the member name is what the file stores.
        /// Closed like the hotkeys: a case this list does not know fails the run.
        case pillStyle
    }

    /// The `PillAnimationStyle` cases a default may name.
    private static let pillStyles: Set<String> = ["sirifilled", "sirilobes", "barsglow"]

    /// The `HotkeySpec` members a default may name. Closed: an unknown member fails the run.
    private static let namedHotkeys: [String: HotkeySpec] = [
        ".default": .default,
        ".rightCommand": .rightCommand,
    ]

    /// Expressions a default may be written as instead of a literal, resolved through the real
    /// symbol so the fixture cannot disagree with the constant it points at. `turkicThreshold` is
    /// the one that matters: it and `ClusterMass.defaultThreshold` used to hold *different*
    /// numbers, and the measured one lived only in the settings file.
    private static let namedConstants: [String: Double] = [
        "ClusterMass.defaultThreshold": ClusterMass.defaultThreshold,
    ]

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("kotiba-golden: settings: \(message)\n".utf8))
        exit(1)
    }

    /// `name -> (declared type, the text after `=`, or nil for a bare optional)`.
    private static func declarations() -> [String: (type: String, value: String?)] {
        let path = "Sources/KotibaUI/Settings.swift"
        guard let text = try? String(contentsOf: Corpus.repoRoot.appendingPathComponent(path),
                                     encoding: .utf8) else {
            fail("cannot read \(path)")
        }
        var found: [String: (type: String, value: String?)] = [:]
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("public var ") else { continue }
            let body = String(trimmed.dropFirst("public var ".count))
            guard let colon = body.firstIndex(of: ":") else { continue }
            let name = String(body[body.startIndex..<colon])
            let rest = String(body[body.index(after: colon)...])
            // A computed property opens a brace on the same line; a stored one never does.
            if rest.contains("{") { continue }
            if let equals = rest.range(of: " = ") {
                found[name] = (String(rest[rest.startIndex..<equals.lowerBound])
                                .trimmingCharacters(in: .whitespaces),
                               String(rest[equals.upperBound...])
                                .trimmingCharacters(in: .whitespaces))
            } else {
                found[name] = (rest.trimmingCharacters(in: .whitespaces), nil)
            }
        }
        return found
    }

    private static func decode(_ name: String, _ kind: Kind, _ raw: String?) -> JSONValue {
        switch kind {
        case .optionalLanguage:
            guard raw == nil else { fail("\(name) was expected to default to nil, got \(raw!)") }
            return .null
        case .language:
            guard let raw, raw.hasPrefix(".") ,
                  let language = Language.allCases.first(where: { "\($0)" == String(raw.dropFirst()) })
            else { fail("\(name): cannot read a Language from \(raw ?? "nil")") }
            return str(language.rawValue)
        case .bool:
            guard raw == "true" || raw == "false" else { fail("\(name): not a Bool: \(raw ?? "nil")") }
            return .bool(raw == "true")
        case .int:
            guard let raw, let value = Int(raw) else { fail("\(name): not an Int: \(raw ?? "nil")") }
            return .int(value)
        case .double:
            guard let raw else { fail("\(name): no default") }
            if let named = namedConstants[raw] { return num(named, decimals: 6) }
            guard let value = Double(raw) else { fail("\(name): not a Double: \(raw)") }
            return num(value, decimals: 6)
        case .string:
            guard let raw, raw.hasPrefix("\""), raw.hasSuffix("\""), raw.count >= 2 else {
                fail("\(name): not a String literal: \(raw ?? "nil")")
            }
            return str(String(raw.dropFirst().dropLast()))
        case .languages:
            guard let raw, raw.hasPrefix("["), raw.hasSuffix("]") else {
                fail("\(name): not a [Language] literal: \(raw ?? "nil")")
            }
            let cases = raw.dropFirst().dropLast().split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
            return arr(cases.map { item in
                guard item.hasPrefix("."),
                      let language = Language.allCases.first(where: { "\($0)" == String(item.dropFirst()) })
                else { fail("\(name): cannot read a Language from \(item)") }
                return str(language.rawValue)
            })
        case .emptyObject:
            guard raw == "[:]" else { fail("\(name): expected [:], got \(raw ?? "nil")") }
            return obj([:])
        case .emptyArray:
            guard raw == "[]" else { fail("\(name): expected [], got \(raw ?? "nil")") }
            return arr([])
        case .hotkey:
            guard let raw, let spec = namedHotkeys[raw] else {
                fail("\(name): not a known HotkeySpec member: \(raw ?? "nil")")
            }
            return obj(["kind": str(spec.kind.rawValue), "keyCode": .int(Int(spec.keyCode))])
        case .pillStyle:
            guard let raw, raw.hasPrefix("."), pillStyles.contains(String(raw.dropFirst())) else {
                fail("\(name): not a known PillAnimationStyle case: \(raw ?? "nil")")
            }
            return str(String(raw.dropFirst()))
        }
    }

    private static func defaults() -> JSONValue {
        let declared = declarations()
        let expectedNames = Set(expectedFields.map(\.name))
        let unexpected = declared.keys.filter { !expectedNames.contains($0) }.sorted(by: scalarOrder)
        if !unexpected.isEmpty {
            fail("AppSettings declares fields this fixture does not know about: "
                 + unexpected.joined(separator: ", ")
                 + " — add them to expectedFields and regenerate")
        }
        var out: [String: JSONValue] = [:]
        for field in expectedFields {
            guard let declaration = declared[field.name] else {
                fail("AppSettings no longer declares `\(field.name)`")
            }
            out[field.name] = decode(field.name, field.kind, declaration.value)
        }
        return obj(out)
    }

    // MARK: - The mode table

    private static func mode(_ mode: Mode) -> JSONValue {
        obj([
            "key": str(mode.key),
            "name": str(mode.name),
            "version": .int(mode.version),
            // The prompt verbatim, newlines and all. It is a shipped constant: the difference
            // between Super's prompt and Message's is the difference between a mode that
            // preserves the speaker's words and one that rewrites them, and a port that
            // paraphrases either has changed what the app does.
            "prompt": mode.prompt.map { str($0.raw) } ?? .null,
            "polishes": .bool(mode.polishes),
            "language": mode.language.map { str($0.rawValue) } ?? .null,
            "voiceModelID": mode.voiceModelID.map(str) ?? .null,
            "polishModelID": mode.polishModelID.map(str) ?? .null,
            "contextFromSelection": .bool(mode.contextFromSelection),
            "contextFromClipboard": .bool(mode.contextFromClipboard),
            "contextFromActiveApplication": .bool(mode.contextFromActiveApplication),
            // Order is the declaration's, not sorted: `ModeRegistry.mode(forBundleID:)` matches by
            // longest prefix on a dot boundary, so which entry wins is a property of the strings
            // rather than of their position — but a port that reorders them has still changed a
            // shipped literal, and a fixture that sorted them could not tell.
            "activationApps": arr(mode.activationApps.map(str)),
            "autocapitalizeInsert": .bool(mode.autocapitalizeInsert),
            "restructures": .bool(mode.restructures),
        ])
    }

    static func settings() -> JSONValue {
        let registry = try? BuiltInModes.registry()
        guard let registry else { fail("BuiltInModes.registry() threw") }

        // The frontmost-app table, which is what `modeFollowsApp` and the credential gate both
        // read. 02-BEHAVIOUR §4 calls the credential case a security property: when the frontmost
        // application is a password manager, the raw prompt-less mode is forced and polish is
        // suppressed entirely, because otherwise a password dictated into 1Password is sent to
        // whatever polish endpoint the user configured. That defect shipped once already.
        let bundleProbes = [
            "com.tinyspeck.slackmacgap", "com.hnc.Discord", "ru.keepcoder.Telegram",
            "org.telegram.desktop", "net.whatsapp.WhatsApp", "com.apple.MobileSMS",
            "md.obsidian", "notion.id", "com.apple.Notes", "com.apple.mail",
            "com.agilebits.onepassword7", "com.1password.1password", "com.apple.Terminal",
            "com.microsoft.VSCode", "com.apple.dt.Xcode", "com.apple.Safari",
            "org.telegram", "org.telegramfoo", "com.apple", "", "com.unknown.app",
        ]
        let applications = bundleProbes.sorted(by: scalarOrder).map { bundleID -> JSONValue in
            let format = AppKnowledge.format(forBundleID: bundleID.isEmpty ? nil : bundleID)
            let claimed = registry.mode(forBundleID: bundleID.isEmpty ? nil : bundleID)
            return obj([
                "bundleID": bundleID.isEmpty ? .null : str(bundleID),
                "format": str(format.rawValue),
                "isSensitive": .bool(AppKnowledge.isSensitive(format)),
                "modeKey": str(claimed.key),
            ])
        }

        return obj([
            "fixture": str("settings"),
            "generator": str(Generator.identity),
            "source": str("KotibaUI/Settings.swift (defaults, parsed from the declaration); "
                          + "KotibaCore/BuiltInModes.swift, KotibaCore/Modes.swift (modes, invoked)"),
            "note": str("""
                The shipped defaults and the four built-in modes. There are FOUR modes, not six, \
                and the default key is `message`, not `super` — docs/SETUP.md says otherwise and \
                is stale. `AppSettings.defaultModeKey` is `super`, which is a different thing: it \
                is what a fresh dictation starts in when no app-specific mode claims the frontmost \
                application, while the registry's own default is what `defaultMode` returns. Both \
                are here because they disagree and a port will assume they do not.
                """),
            "defaultsDerivedBy": str("""
                Parsed from the `public var` declarations in Sources/KotibaUI/Settings.swift at \
                generation time, not invoked: `AppSettings.init` reads UserDefaults, which would \
                put the generating machine's state into the fixture. The field list is closed, so \
                a renamed or added setting fails the generator rather than silently dropping out \
                of the fixture.
                """),
            "defaults": defaults(),
            "modeDefaultKeyInRegistry": str(registry.defaultKey),
            "modeCount": .int(registry.modes.count),
            // Registry order, which is BuiltInModes.all's order — message, super, note,
            // transcription — not alphabetical and not the order they are declared in the file.
            "modes": arr(registry.modes.map(mode)),
            "modeConstants": obj([
                "modeInitDefaults": obj([
                    "version": .int(1),
                    "autocapitalizeInsert": .bool(true),
                    "restructures": .bool(false),
                    "contextFromSelection": .bool(false),
                    "contextFromClipboard": .bool(false),
                    "contextFromActiveApplication": .bool(false),
                ]),
                "polishesIsPromptOnly": .bool(true),
                "bundleIDMatch": str("longest activationApps prefix that ends on a dot boundary "
                                     + "or matches the whole identifier"),
            ]),
            "polishGuard": obj([
                "minimumRatio": num(PolishGuard().minimumRatio, decimals: 6),
                "maximumRatio": num(PolishGuard().maximumRatio, decimals: 6),
                "shortInputHeadroom": .int(PolishGuard().shortInputHeadroom),
                "ratioFloorLength": .int(PolishGuard.ratioFloorLength),
                "restructuringModesAreExempt": .bool(true),
            ]),
            "textFormats": arr(AppTextFormat.allCases.map(\.rawValue)
                .sorted(by: scalarOrder).map(str)),
            "applicationCount": .int(applications.count),
            "applicationsNote": str("""
                Generated by calling AppKnowledge.format and ModeRegistry.mode(forBundleID:), so \
                these rows are what the Mac app does — including where that is wrong. \
                `com.agilebits.onepassword7` — the real bundle identifier of 1Password 7 on \
                macOS — comes back `unknown` and NOT sensitive, because the table's prefix is \
                `com.agilebits.onepassword` and the matcher requires an exact match or a dot \
                boundary, which a trailing `7` is not. `com.1password.1password` matches and is \
                sensitive, so the gate holds for 1Password 8 and misses 7. This fixture pins \
                the behaviour as it is, because that is what a parity fixture is for; it is NOT \
                an endorsement, and the Windows port should not reproduce the miss when it \
                writes its own executable-path table. Raised for t05.
                """),
            "applications": arr(applications),
            "windowsDeltas": obj([
                "note": str("""
                    Where the Windows port deliberately differs, from 02-BEHAVIOUR §5. Listed here \
                    so a port that fails one of these fixtures can tell a bug from a decision. \
                    Everything not named here is parity.
                    """),
                "whisperBeamSize": str("D-W11: macOS ships 5 for every model; Windows ships 1 for "
                                       + "the Uzbek model and 5 for large-v3-turbo. D-08 measured "
                                       + "beam 5 worth 0.03 WER points on uzbek_stt_v1 — 21.65% "
                                       + "against 21.68% — for +21% latency on a 2.8 s clip and "
                                       + "+39% on an 8.8 s clip."),
                "activationApps": str("bundle identifiers are macOS. The Windows analogue is the "
                                      + "executable path or AUMID; the matching RULE — longest "
                                      + "prefix on a dot boundary — is parity, the strings are not."),
                "englishEngine": str("D-W18: Parakeet Ultra serves English and Russian on both "
                                     + "platforms; until it is downloaded Windows falls back to the "
                                     + "bundled large-v3-turbo (the Mac to SpeechTranscriber)."),
                "hotkey": str("D-W4: the key is a Win32 virtual-key code, Right Ctrl (163), not a "
                              + "macOS kVK code. The FIELD is parity; its value cannot be."),
                "hasCompletedOnboarding": str("named `onboardingCompleted` on Windows; same meaning."),
                "autoDownloadModels": str("absent on Windows as a Boolean: D-W23 records WHICH "
                                          + "downloads the user accepted (`acceptedDownloads`, "
                                          + "default empty) and Parakeet fetches itself only once "
                                          + "onboarding is done and it is on that list — the Mac's "
                                          + "true-by-default is gated by hasCompletedOnboarding the "
                                          + "same way, so a fresh install on either never starts a "
                                          + "download before the user has been asked."),
                "preferBuiltInMicWithBluetooth": str("absent on Windows: the HFP switch it avoids "
                                                     + "is a Core Audio behaviour, and Windows "
                                                     + "capture uses the default device (D-W6)."),
                "modelIdleUnloadMinutes": str("absent on Windows as a setting: each engine carries "
                                              + "its own idle unload (Parakeet 15 min, Qwen 3 min); "
                                              + "the whisper host's is off by default "
                                              + "(DEFAULT_IDLE_UNLOAD in engines/manager.ts)."),
            ]),
        ])
    }
}

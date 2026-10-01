import Foundation
import Testing

@testable import KotibaUI

// The interface in four languages. What these hold the catalog to:
//
//   * every key has all four translations, none empty, with the plural forms each language needs;
//   * the placeholders agree — a `%@` dropped from a translation shifts every argument after it,
//     and a `%lld` turned into `%@` crashes `String(format:)`;
//   * Uzbek Latin uses ʻ (U+02BB) in oʻ/gʻ and ʼ (U+02BC) for the tutuq, never a typed apostrophe;
//     Uzbek Cyrillic is Cyrillic, with Latin only in names that are Latin in every language;
//   * every key the code asks for exists, and every key in the catalog is asked for;
//   * the JSON `swift test` reads and the tables Xcode compiles for the app say the same thing.
//
// A test that switches the language does so synchronously and switches back before it returns:
// the suites run concurrently on the main actor, and an `await` in between would let another test
// read Russian where it expects English.

@MainActor
@Suite("Interface localization")
struct LocalizationTests {

    static let languages = AppLanguage.allCases.map(\.rawValue)
    static let repoRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let catalogURL = repoRoot
        .appendingPathComponent("Sources/KotibaUI/Resources/Localizable.xcstrings")

    static func loadCatalog() throws -> StringCatalog {
        try StringCatalog(xcstrings: Data(contentsOf: catalogURL))
    }

    /// The plural categories a language must supply, CLDR integers only.
    static func requiredCategories(_ language: String) -> Set<String> {
        language == "ru" ? ["one", "few", "many", "other"] : ["one", "other"]
    }

    /// Every `%…` conversion in a template, keyed by argument position. `%%` is not an argument.
    static func placeholders(_ template: String) -> [Int: String] {
        let pattern = try! NSRegularExpression(pattern: "%(?:(\\d+)\\$)?(lld|ld|d|@|%)")
        var out: [Int: String] = [:]
        var next = 1
        let range = NSRange(template.startIndex..., in: template)
        for match in pattern.matches(in: template, range: range) {
            let type = String(template[Range(match.range(at: 2), in: template)!])
            if type == "%" { continue }
            let position = Range(match.range(at: 1), in: template).map { Int(template[$0])! } ?? next
            out[position] = type
            next = position + 1
        }
        return out
    }

    @Test("every key has English, Russian, Uzbek Latin and Uzbek Cyrillic, none empty")
    func complete() throws {
        let catalog = try Self.loadCatalog()
        #expect(catalog.table.count > 300, "the catalog is suspiciously small")
        for (key, row) in catalog.table {
            for language in Self.languages {
                switch row[language] {
                case .text(let text)?:
                    #expect(!text.trimmingCharacters(in: .whitespaces).isEmpty,
                            "\(key) is empty in \(language)")
                case .plural(let forms)?:
                    let missing = Self.requiredCategories(language).subtracting(forms.keys)
                    #expect(missing.isEmpty, "\(key) in \(language) lacks \(missing.sorted())")
                    #expect(forms.values.allSatisfy { !$0.isEmpty }, "\(key) has an empty form")
                case nil:
                    Issue.record("\(key) has no \(language) translation")
                }
            }
        }
    }

    @Test("every translation carries the same placeholders as the English")
    func placeholdersMatch() throws {
        let catalog = try Self.loadCatalog()
        for (key, row) in catalog.table {
            guard case .text(let english)? = row["en"] else {
                guard case .plural(let englishForms)? = row["en"] else { continue }
                let expected = Self.placeholders(englishForms["other"] ?? "")
                #expect(expected.values.contains("lld"), "\(key): a plural must print its number")
                for (language, entry) in row {
                    guard case .plural(let forms) = entry else {
                        Issue.record("\(key) is plural in English but not in \(language)")
                        continue
                    }
                    for (category, template) in forms {
                        #expect(Self.placeholders(template) == expected,
                                "\(key) [\(language) \(category)]: \(template)")
                    }
                }
                continue
            }
            let expected = Self.placeholders(english)
            for (language, entry) in row {
                guard case .text(let template) = entry else {
                    Issue.record("\(key) is plain in English but plural in \(language)")
                    continue
                }
                #expect(Self.placeholders(template) == expected,
                        "\(key) [\(language)]: “\(template)” against “\(english)”")
            }
        }
    }

    /// All the text in one language, plural forms included.
    static func texts(_ catalog: StringCatalog, _ language: String) -> [(key: String, text: String)] {
        catalog.table.flatMap { key, row -> [(key: String, text: String)] in
            switch row[language] {
            case .text(let text)?: return [(key, text)]
            case .plural(let forms)?: return forms.values.map { (key, $0) }
            case nil: return []
            }
        }
    }

    @Test("Uzbek Latin writes oʻ and gʻ with U+02BB and the tutuq with U+02BC")
    func uzbekLatinOrthography() throws {
        let catalog = try Self.loadCatalog()
        // An apostrophe of any other kind after o or g, where the okina belongs.
        let wrongOkina = try NSRegularExpression(pattern: "[oOgG]['`‘’ʼ]")
        // The okina anywhere but after o or g.
        let strayOkina = try NSRegularExpression(pattern: "(^|[^oOgG])ʻ")
        for (key, text) in Self.texts(catalog, "uz-Latn") {
            let range = NSRange(text.startIndex..., in: text)
            #expect(wrongOkina.firstMatch(in: text, range: range) == nil, "\(key): \(text)")
            #expect(strayOkina.firstMatch(in: text, range: range) == nil, "\(key): \(text)")
            // A typed ASCII apostrophe never belongs in Uzbek Latin: the okina and the tutuq
            // (maʼlumot, taʼsir) are letters of their own.
            #expect(!text.contains("'"), "\(key) has an ASCII apostrophe: \(text)")
        }
        // The tutuq is actually used, not silently replaced by something else.
        #expect(Self.texts(catalog, "uz-Latn").contains { $0.text.contains("maʼlum") })
    }

    /// Latin words that are Latin in every language: names, codes and keys on the keyboard.
    static let latinInCyrillic: Set<String> = [
        "Kotiba", "Kotib", "KotibAI", "Kotibai", "Rubai", "Mac", "macOS", "Apple", "Intelligence",
        "Siri", "AirPods", "iPhone", "Continuity", "Bluetooth", "Dock", "Neural", "Engine", "whisper", "Whisper", "cpp",
        "ggml", "Parakeet", "Ultra", "Qwen3", "Qwen", "GPU", "API", "Markdown", "Slack",
        "Telegram", "Obsidian", "Esc", "F1", "F2", "F13", "F1–F12", "fn", "C", "Return", "Delete",
        "Forward", "Page", "Up", "Down", "Help", "Clear", "NVIDIA", "parakeet", "tdt", "b", "v3",
        "moondream", "Core", "ML", "FluidInference", "CC", "BY", "OpenAI", "Silero", "VAD", "Team",
        "org", "Alibaba", "GGUF", "llama", "FluidAudio", "Apache", "MIT", "THIRD_PARTY_NOTICES",
        "md", "uz", "kotiba", "settings", "v1", "unreadable", "p90", "kechqurun", "keçşurun",
        "cotta", "Turn", "Off", "Always", "On", "Quit", "Kotib/uzbek_stt_v1", "uzbek_stt_v1",
        "medium", "bin", "q5_0", "ggml-org", "Aziz", "Nizom", "Whisper-medium", "base", "ai", "B", "kotib", "V",
        // D-11: the Turkish engine and Arabic's fallback are whisper turbo.
        "turbo", "transcribe",
    ]

    @Test("Uzbek Cyrillic is Cyrillic, with Latin only in names and keys")
    func uzbekCyrillicScript() throws {
        let catalog = try Self.loadCatalog()
        let latinWord = try NSRegularExpression(pattern: "[A-Za-z][A-Za-z0-9_./ç–şğ-]*")
        let placeholder = try NSRegularExpression(pattern: "%(\\d+\\$)?(lld|ld|d|@)")
        for (key, raw) in Self.texts(catalog, "uz-Cyrl") {
            let text = placeholder.stringByReplacingMatches(
                in: raw, range: NSRange(raw.startIndex..., in: raw), withTemplate: "")
            let range = NSRange(text.startIndex..., in: text)
            for match in latinWord.matches(in: text, range: range) {
                var word = String(text[Range(match.range, in: text)!])
                while let last = word.last, ".-/".contains(last) { word.removeLast() }
                // "Apache-2.0" is Apache; "Qwen3-1.7B" is Qwen3 and B — the numbers are numbers.
                let parts = Set(word.split(whereSeparator: { "./-".contains($0) })
                    .map { String($0.drop(while: \.isNumber)) }
                    .filter { $0.contains(where: \.isLetter) })
                #expect(Self.latinInCyrillic.contains(word) || parts.isSubset(of: Self.latinInCyrillic),
                        "\(key): Latin “\(word)” in Uzbek Cyrillic — \(text)")
            }
            // Russian letters that Uzbek Cyrillic does not use.
            #expect(!text.contains { "щЩ".contains($0) }, "\(key): щ in Uzbek Cyrillic — \(text)")
        }
        // The four letters that make it Uzbek rather than Russian are all in use.
        let all = Self.texts(catalog, "uz-Cyrl").map(\.text).joined()
        for letter in ["ў", "қ", "ғ", "ҳ"] { #expect(all.contains(letter), "no \(letter) anywhere") }
    }

    @Test("the product is Kotiba in every language")
    func productName() throws {
        let catalog = try Self.loadCatalog()
        for language in Self.languages {
            for (key, text) in Self.texts(catalog, language) {
                #expect(!text.contains("Котиба") && !text.contains("Kotibа"),
                        "\(key) [\(language)] transliterates the name: \(text)")
                // Cyrillic never glues a suffix onto the Latin name ("Kotiba’нинг"); it says
                // "Kotiba дастурининг" instead.
                #expect(text.range(of: "Kotiba?[’'ʼ]?[\\p{Script=Cyrillic}]",
                                   options: .regularExpression) == nil,
                        "\(key) [\(language)] glues Cyrillic onto the name: \(text)")
            }
        }
    }

    // MARK: Code and catalog agree

    /// Every literal key passed to `L`, `Lp` or `Lnoun` under Sources/ and Apps/.
    static func keysInCode() throws -> (plain: Set<String>, nouns: Set<String>) {
        let call = try NSRegularExpression(pattern: "\\b(L|Lp|Lnoun)\\(\"([a-zA-Z0-9_.]+)\"")
        var plain = Set<String>(), nouns = Set<String>()
        for directory in ["Sources", "Apps"] {
            let root = repoRoot.appendingPathComponent(directory)
            let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)!
            for case let url as URL in files where url.pathExtension == "swift" {
                let text = try String(contentsOf: url, encoding: .utf8)
                let range = NSRange(text.startIndex..., in: text)
                for match in call.matches(in: text, range: range) {
                    let function = String(text[Range(match.range(at: 1), in: text)!])
                    let key = String(text[Range(match.range(at: 2), in: text)!])
                    if function == "Lnoun" { nouns.insert(key) } else { plain.insert(key) }
                }
            }
        }
        return (plain, nouns)
    }

    @Test("every key the code asks for is in the catalog, and nothing in it is unused")
    func codeAndCatalogAgree() throws {
        let catalog = try Self.loadCatalog()
        let (plain, nouns) = try Self.keysInCode()
        var used = plain
        for base in nouns {
            for category in ["one", "few", "many", "other"] { used.insert("\(base).\(category)") }
        }
        let missing = used.subtracting(catalog.table.keys)
        let unused = Set(catalog.table.keys).subtracting(used)
        #expect(missing.isEmpty, "asked for but not in the catalog: \(missing.sorted())")
        #expect(unused.isEmpty, "in the catalog but never asked for: \(unused.sorted())")
    }

    @Test("the tables Xcode compiles for the app read the same as the JSON")
    func compiledTablesAgree() throws {
        let output = FileManager.default.temporaryDirectory
            .appendingPathComponent("kotiba-xcstrings-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: output) }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["xcstringstool", "compile", Self.catalogURL.path,
                             "--output-directory", output.path]
        process.standardOutput = FileHandle.nullDevice
        let errors = Pipe()
        process.standardError = errors
        do { try process.run() } catch {
            // No Xcode on this machine: nothing to compare against, and nothing would ship.
            return
        }
        process.waitUntilExit()
        let message = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(),
                             as: UTF8.self)
        // A failure here is the app build failing: Xcode runs the same compiler.
        try #require(process.terminationStatus == 0, "xcstringstool refused the catalog: \(message)")
        let bundle = try #require(Bundle(url: output))
        let compiled = StringCatalog(lprojIn: bundle)
        let json = try Self.loadCatalog()
        #expect(compiled.table.count == json.table.count)
        for (key, row) in json.table {
            for language in Self.languages {
                #expect(compiled.table[key]?[language] == row[language],
                        "\(key) [\(language)] differs once compiled")
            }
        }
    }

    // MARK: Behaviour

    @Test("the system language picks the default, Uzbek without a script is Latin")
    func systemDefault() {
        #expect(AppLanguage.systemDefault(preferred: ["en-UZ", "uz-UZ"]) == .english)
        #expect(AppLanguage.systemDefault(preferred: ["uz-UZ"]) == .uzbekLatin)
        #expect(AppLanguage.systemDefault(preferred: ["uz-Latn-UZ"]) == .uzbekLatin)
        #expect(AppLanguage.systemDefault(preferred: ["uz-Cyrl-UZ"]) == .uzbekCyrillic)
        #expect(AppLanguage.systemDefault(preferred: ["uz_Cyrl"]) == .uzbekCyrillic)
        #expect(AppLanguage.systemDefault(preferred: ["ru-RU"]) == .russian)
        #expect(AppLanguage.systemDefault(preferred: ["fr-FR", "de"]) == .english)
        #expect(AppLanguage.systemDefault(preferred: ["fr-FR", "ru"]) == .russian)
        #expect(AppLanguage.resolve("uz-Cyrl", preferred: ["en"]) == .uzbekCyrillic)
        #expect(AppLanguage.resolve("", preferred: ["ru"]) == .russian)
        #expect(AppLanguage.resolve("klingon", preferred: ["ru"]) == .russian)
    }

    @Test("Russian plurals take one, few and many; Uzbek does not inflect")
    func plurals() {
        let rule = { (n: Int) in StringCatalog.pluralCategory(n, language: .russian) }
        #expect([1, 21, 101].map(rule) == ["one", "one", "one"])
        #expect([2, 3, 4, 22, 104].map(rule) == ["few", "few", "few", "few", "few"])
        #expect([0, 5, 11, 12, 14, 25, 111].map(rule) == Array(repeating: "many", count: 7))
        #expect(StringCatalog.pluralCategory(5, language: .uzbekLatin) == "other")
        #expect(StringCatalog.pluralCategory(1, language: .english) == "one")
    }

    /// Run `body` with the interface in `language`, and put English back before returning.
    private func with(_ language: AppLanguage, _ body: () throws -> Void) rethrows {
        let before = Localizer.shared.language
        Localizer.shared.apply(language)
        defer { Localizer.shared.apply(before) }
        try body()
    }

    @Test("switching the language switches the words, with no restart")
    func liveSwitch() {
        #expect(L("section.settings") == "Settings")
        with(.russian) {
            #expect(L("section.settings") == "Настройки")
            #expect(Lp("languages.whisper.minutes", 5) == "5 минут")
            #expect(Lp("languages.whisper.minutes", 2) == "2 минуты")
            #expect(Lnoun("noun.day", 21) == "день")
            #expect(Names.number(1.5, digits: 1) == "1,5")
        }
        with(.uzbekLatin) { #expect(L("section.settings") == "Sozlamalar") }
        with(.uzbekCyrillic) { #expect(L("section.settings") == "Созламалар") }
        #expect(L("section.settings") == "Settings")
        #expect(L("no.such.key") == "no.such.key", "a missing key shows itself")
    }

    @Test("choosing a language persists it and applies it at once")
    func choosingPersists() {
        let store = UserDefaults(suiteName: UUID().uuidString)!
        let controller = DictationController(settings: AppSettings.hermetic(store: store),
                                             devices: .testing)
        #expect(controller.settings.appLanguage == "", "a fresh install follows the system")
        with(.english) {
            controller.setAppLanguage(.uzbekCyrillic)
            #expect(Localizer.shared.language == .uzbekCyrillic)
            #expect(L("section.home") == "Бош саҳифа")
            Localizer.shared.apply(.english)
        }
        #expect(controller.settings.appLanguage == "uz-Cyrl")
        #expect(store.stringArray(forKey: "AppleLanguages") == ["uz-Cyrl"])
        // Survives a relaunch: a second settings object on the same store reads it back.
        #expect(AppSettings.hermetic(store: store).appLanguage == "uz-Cyrl")
    }

    @Test("the language is the first step of onboarding")
    func onboardingStartsWithLanguage() {
        #expect(OnboardingView.Step.allCases.first == .appLanguage)
    }

    @Test("ICU's Uzbek okina is normalised to U+02BB in formatted dates")
    func uzbekDateOkina() {
        with(.uzbekLatin) {
            #expect(LocalFormat.text("o\u{2018}tgan hafta") == "o\u{02BB}tgan hafta")
        }
        #expect(LocalFormat.text("o\u{2018}") == "o\u{2018}", "only in Uzbek Latin")
    }
}

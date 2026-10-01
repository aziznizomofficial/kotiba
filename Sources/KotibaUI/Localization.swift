import Foundation
import Observation
import SwiftUI

// The app's own words, in the language the user picked — English, Русский, Oʻzbekcha (Lotin) or
// Ўзбекча (Кирилл). This is the interface language only. What Kotiba *hears* (`Language`, the
// router, the engines) is a separate axis and nothing here touches it.
//
// Why not plain `Text("…")` and the system's own lookup:
//
//   * **It cannot switch live.** `Bundle.localizedString` answers in the process's preferred
//     language, fixed at launch. The brief asks for a switch that takes effect the moment a card is
//     clicked in onboarding, without a restart. So the language is an `@Observable` value, every
//     lookup reads it, and every view that shows a word re-renders when it changes — the same
//     mechanism the rest of the window already runs on.
//   * **The catalog lives in a package.** `Text(_:)` looks in `Bundle.main`; the strings are in
//     KotibaUI's resource bundle, and threading `bundle: .module` through four hundred call sites
//     is the kind of thing one forgotten site silently undoes.
//   * **`swift build` does not compile String Catalogs.** It copies `Localizable.xcstrings`
//     verbatim, while Xcode (the app) compiles it to `<lang>.lproj/Localizable.strings` and
//     `.stringsdict`. `StringCatalog` reads whichever it finds, so `swift test` and the shipped app
//     answer from the same file — `LocalizationTests` compiles the catalog with `xcstringstool` and
//     asserts the two readings agree key for key.
//
// Keys are semantic (`onboarding.welcome.title`), not English sentences, so rewording English
// does not orphan three translations. Arguments use `%@` / `%lld`, positional (`%1$@`) when a
// translation needs to reorder them; `LocalizationTests` checks every language carries the same
// ones. A count that changes the noun goes through `Lp`, which picks the CLDR plural form —
// Russian has three, Uzbek and English two.

// MARK: - The four languages

/// An interface language. Its raw value is what `AppSettings.appLanguage` stores and the locale
/// identifier the catalog is keyed by. The empty string in settings means "follow the system".
public enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
    // Declaration order is the order every picker shows: Uzbek first, the owner's call.
    case uzbekLatin = "uz-Latn"
    case uzbekCyrillic = "uz-Cyrl"
    case english = "en"
    case russian = "ru"

    public var id: String { rawValue }

    public var locale: Locale { Locale(identifier: rawValue) }

    /// The name in its own language and script — what the picker shows, never translated.
    public var nativeName: String {
        switch self {
        case .english: return "English"
        case .russian: return "Русский"
        case .uzbekLatin: return "Oʻzbekcha (Lotin)"
        case .uzbekCyrillic: return "Ўзбекча (Кирилл)"
        }
    }

    /// One line under the native name, also in that language: it reads correctly to exactly the
    /// person who should click it.
    public var nativeCaption: String {
        switch self {
        case .english: return "Interface in English"
        case .russian: return "Интерфейс на русском"
        case .uzbekLatin: return "Interfeys oʻzbek tilida"
        case .uzbekCyrillic: return "Интерфейс ўзбек тилида"
        }
    }

    /// What a stored `appLanguage` means. Empty or unknown follows the system.
    public static func resolve(_ stored: String,
                               preferred: [String] = Locale.preferredLanguages) -> AppLanguage {
        AppLanguage(rawValue: stored) ?? systemDefault(preferred: preferred)
    }

    /// The first of the user's preferred system languages that is one of the four; English when
    /// none is. Uzbek without a script — or in Latin — is Latin, the official alphabet; Uzbek
    /// written in Cyrillic (`uz-Cyrl`, `uz-Cyrl-UZ`) is Cyrillic.
    public static func systemDefault(preferred: [String]) -> AppLanguage {
        for identifier in preferred {
            let tags = identifier.replacingOccurrences(of: "_", with: "-")
                .split(separator: "-").map { $0.lowercased() }
            switch tags.first {
            case "en": return .english
            case "ru": return .russian
            case "uz": return tags.contains("cyrl") ? .uzbekCyrillic : .uzbekLatin
            default: continue
            }
        }
        return .english
    }
}

// MARK: - The live choice

/// The interface language right now. One per process, like the menu bar; `@Observable`, so a view
/// that looked a word up re-renders when it changes.
///
/// It starts in English and stays there until the app shell applies the stored setting at launch.
/// That is deliberate: tests construct controllers and views without an app shell, and they must
/// read the same words on a Russian or Uzbek machine as on an English one.
@Observable
public final class Localizer {
    public static let shared = Localizer()

    public private(set) var language: AppLanguage = .english

    @ObservationIgnored let catalog: StringCatalog

    init(catalog: StringCatalog = .bundled) {
        self.catalog = catalog
    }

    /// Switch every word on screen. Cheap to call with the current value.
    public func apply(_ language: AppLanguage) {
        guard language != self.language else { return }
        self.language = language
    }

    public var locale: Locale { language.locale }

    func string(_ key: String) -> String {
        catalog.template(key, language: language)
    }

    func string(_ key: String, arguments: [any CVarArg]) -> String {
        let template = catalog.template(key, language: language)
        return arguments.isEmpty ? template
            : String(format: template, locale: language.locale, arguments: arguments)
    }

    func plural(_ key: String, count: Int) -> String {
        let template = catalog.template(key, language: language, count: count)
        return String(format: template, locale: language.locale, Int64(count))
    }
}

/// The word for `key` in the current interface language.
public func L(_ key: String) -> String {
    Localizer.shared.string(key)
}

/// The sentence for `key`, with `%@` / `%lld` filled in. Pass `Int` for `%lld` and `String` for
/// `%@`; the template decides the order.
public func L(_ key: String, _ arguments: any CVarArg...) -> String {
    Localizer.shared.string(key, arguments: arguments)
}

/// A counted phrase — "1 dictation", "5 диктовок" — with the plural form the language needs.
/// The template carries exactly one `%lld`.
public func Lp(_ key: String, _ count: Int) -> String {
    Localizer.shared.plural(key, count: count)
}

/// The noun alone, agreeing with a number shown somewhere else — a stat tile's "days" under a big
/// "5". A String Catalog refuses a plural variation that does not print its number (Xcode fails
/// the build), so these are four ordinary keys, `<base>.one`, `.few`, `.many`, `.other`, every one
/// translated in every language, and the CLDR rule picks between them here.
public func Lnoun(_ base: String, _ count: Int) -> String {
    let category = StringCatalog.pluralCategory(count, language: Localizer.shared.language)
    return L("\(base).\(category)")
}

// MARK: - The catalog

/// `Localizable.xcstrings`, read into memory once: key → language → text (or plural forms).
///
/// Two sources, one shape. `swift build` leaves the catalog as JSON in the resource bundle; Xcode
/// compiles it to `.lproj` tables and the JSON is gone. Both are read here into the same table.
struct StringCatalog: Sendable {

    enum Entry: Sendable, Equatable {
        case text(String)
        /// CLDR category ("one", "few", "many", "other") → template.
        case plural([String: String])
    }

    /// key → language identifier → entry.
    let table: [String: [String: Entry]]

    static let sourceLanguage = AppLanguage.english

    static let bundled: StringCatalog = load(from: .module)

    static func load(from bundle: Bundle) -> StringCatalog {
        if let url = bundle.url(forResource: "Localizable", withExtension: "xcstrings"),
           let data = try? Data(contentsOf: url),
           let catalog = try? StringCatalog(xcstrings: data) {
            return catalog
        }
        return StringCatalog(lprojIn: bundle)
    }

    init(table: [String: [String: Entry]]) {
        self.table = table
    }

    /// The template for `key`, falling back to English, then to the key itself — a missing
    /// translation shows English rather than a blank, and a missing key shows itself, which is
    /// what a test or a screenshot will catch.
    func template(_ key: String, language: AppLanguage, count: Int? = nil) -> String {
        guard let row = table[key] else { return key }
        let entry = row[language.rawValue] ?? row[Self.sourceLanguage.rawValue]
        switch entry {
        case .text(let text): return text
        case .plural(let forms):
            let category = Self.pluralCategory(count ?? 0, language: language)
            return forms[category] ?? forms["other"] ?? forms.values.first ?? key
        case nil: return key
        }
    }

    /// CLDR cardinal plural rules for the four languages, integers only.
    static func pluralCategory(_ n: Int, language: AppLanguage) -> String {
        switch language {
        case .russian:
            let mod10 = n % 10, mod100 = n % 100
            if mod10 == 1 && mod100 != 11 { return "one" }
            if (2...4).contains(mod10) && !(12...14).contains(mod100) { return "few" }
            return "many"
        case .english, .uzbekLatin, .uzbekCyrillic:
            return n == 1 ? "one" : "other"
        }
    }

    // MARK: Reading the JSON (swift build, swift test)

    init(xcstrings data: Data) throws {
        struct File: Decodable {
            let strings: [String: Row]
        }
        struct Row: Decodable {
            let localizations: [String: Localization]?
        }
        struct Localization: Decodable {
            let stringUnit: Unit?
            let variations: Variations?
        }
        struct Unit: Decodable { let value: String }
        struct Variations: Decodable { let plural: [String: Variant]? }
        struct Variant: Decodable { let stringUnit: Unit }

        let file = try JSONDecoder().decode(File.self, from: data)
        var table: [String: [String: Entry]] = [:]
        for (key, row) in file.strings {
            var entries: [String: Entry] = [:]
            for (language, localization) in row.localizations ?? [:] {
                if let unit = localization.stringUnit {
                    entries[language] = .text(unit.value)
                } else if let plural = localization.variations?.plural {
                    entries[language] = .plural(plural.mapValues(\.stringUnit.value))
                }
            }
            table[key] = entries
        }
        self.init(table: table)
    }

    // MARK: Reading the compiled tables (the Xcode-built app)

    /// `xcstringstool` writes `uz-Latn` as `uz.lproj` (Latin is Uzbek's default script) and keeps
    /// `uz-Cyrl.lproj`, so each language names every directory it may have been written to.
    static func lprojNames(_ language: AppLanguage) -> [String] {
        switch language {
        case .uzbekLatin: return ["uz-Latn", "uz"]
        default: return [language.rawValue]
        }
    }

    init(lprojIn bundle: Bundle) {
        var table: [String: [String: Entry]] = [:]
        for language in AppLanguage.allCases {
            guard let directory = Self.lprojNames(language)
                .lazy.compactMap({ bundle.url(forResource: $0, withExtension: "lproj") }).first
            else { continue }
            if let strings = NSDictionary(
                contentsOf: directory.appendingPathComponent("Localizable.strings"))
                as? [String: String] {
                for (key, value) in strings { table[key, default: [:]][language.rawValue] = .text(value) }
            }
            if let plurals = NSDictionary(
                contentsOf: directory.appendingPathComponent("Localizable.stringsdict"))
                as? [String: [String: Any]] {
                for (key, rule) in plurals {
                    // xcstringstool writes one variable per plural: `%#@name@` and a dictionary
                    // `name` of category → template. That is the only shape the catalog uses.
                    guard let format = rule["NSStringLocalizedFormatKey"] as? String,
                          format.hasPrefix("%#@"), format.hasSuffix("@"),
                          let forms = rule[String(format.dropFirst(3).dropLast())] as? [String: Any]
                    else { continue }
                    let categories = ["zero", "one", "two", "few", "many", "other"]
                    var entry: [String: String] = [:]
                    for category in categories {
                        if let template = forms[category] as? String { entry[category] = template }
                    }
                    table[key, default: [:]][language.rawValue] = .plural(entry)
                }
            }
        }
        self.init(table: table)
    }
}

// MARK: - Formatting in the chosen language

enum LocalFormat {
    /// A date in the interface language. ICU's Uzbek Latin data writes the okina as U+2018 (‘) —
    /// "o‘tgan hafta" — where the orthography and every string in the catalog use ʻ (U+02BB).
    static func text(_ formatted: String) -> String {
        Localizer.shared.language == .uzbekLatin
            ? formatted.replacingOccurrences(of: "\u{2018}", with: "\u{02BB}") : formatted
    }

    static func date(_ date: Date, _ style: Date.FormatStyle) -> String {
        text(date.formatted(style.locale(Localizer.shared.locale)))
    }
}

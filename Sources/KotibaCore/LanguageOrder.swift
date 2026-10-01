import Foundation

// The order the dictation-language pickers list their languages in: Home's row, the menu-bar
// Language section, Settings › Languages and the first-run models step. (The interface-language
// picker is a different list with a fixed order and does not come through here.)
//
// Two layers. The DEFAULT order is a rank table by language code — Uzbek, English, Russian, then
// Arabic and Turkish — so a language added to `Language` slots in by editing one array (or by
// nothing at all: a code the table does not know sorts after every ranked one, in declaration
// order). The USAGE order then reorders by successful dictations in the last 30 days, with
// hysteresis so a picker never shuffles over a one-dictation difference. "Automatic" is not a
// language and is always put first by the caller.
//
// Pure: no clock, no file, no UI — the pane, the menu and the tests all call the same function.

public enum LanguageOrder {

    /// Default rank, best first, by `Language.rawValue`. New languages: append their code here
    /// in the position the owner wants; `ar` and `tr` are listed ahead of their enum cases.
    public static let defaultCodes = ["uz", "en", "ru", "ar", "tr"]

    /// A neighbour is only overtaken with at least this many more dictations…
    public static let minimumLead = 3
    /// …and at least this much more than it (1.2 = 20 % more).
    public static let minimumRatio = 1.2

    public static func defaultRank(_ language: Language) -> Int {
        rank(of: language.rawValue, table: defaultCodes, declared: Language.allCases.map(\.rawValue))
    }

    /// The languages in the default order — what a fresh install, and onboarding, show.
    public static var defaultOrder: [Language] {
        Language.allCases.sorted { defaultRank($0) < defaultRank($1) }
    }

    /// The default order, then usage: `counts` are successful dictations per language over the
    /// window; `previous` is the order the user last saw (nil on a fresh launch, which starts
    /// from the default order so the same counts always give the same list).
    public static func ordered(counts: [Language: Int], previous: [Language]? = nil) -> [Language] {
        let codes = order(codes: Language.allCases.map(\.rawValue),
                          counts: Dictionary(counts.map { ($0.key.rawValue, $0.value) },
                                             uniquingKeysWith: +),
                          previous: previous?.map(\.rawValue),
                          table: defaultCodes)
        return codes.compactMap { Language(rawValue: $0) }
    }

    /// Whether `challenger` has a clear enough lead over the neighbour above it to swap places.
    public static func isClearLead(_ challenger: Int, over incumbent: Int) -> Bool {
        challenger >= incumbent + minimumLead && Double(challenger) >= Double(incumbent) * minimumRatio
    }

    // MARK: - The algorithm, over codes so tests can add languages that do not exist yet

    static func rank(of code: String, table: [String], declared: [String]) -> Int {
        if let index = table.firstIndex(of: code) { return index }
        return table.count + (declared.firstIndex(of: code) ?? declared.count)
    }

    static func order(codes: [String], counts: [String: Int], previous: [String]?,
                      table: [String]) -> [String] {
        func rankOf(_ code: String) -> Int { rank(of: code, table: table, declared: codes) }
        let byDefault = codes.sorted { rankOf($0) < rankOf($1) }
        // Start where the user last saw the list (dropping what is gone, appending what is new
        // in default order); with no history, from the default order.
        var list = byDefault
        if let previous {
            let known = previous.filter { codes.contains($0) }
            list = known + byDefault.filter { !known.contains($0) }
        }
        func count(_ code: String) -> Int { counts[code] ?? 0 }
        // `below` moves above `above` when it clearly leads, or — equal counts — when the
        // default order says so. Every swap strictly improves one of the two, so this settles;
        // the pass cap is belt and braces.
        func overtakes(_ below: String, _ above: String) -> Bool {
            if count(below) == count(above) { return rankOf(below) < rankOf(above) }
            return isClearLead(count(below), over: count(above))
        }
        var passes = 0
        var swapped = true
        while swapped, passes < max(1, list.count * list.count) {
            swapped = false
            passes += 1
            var index = 0
            while index + 1 < list.count {
                if overtakes(list[index + 1], list[index]) {
                    list.swapAt(index, index + 1)
                    swapped = true
                }
                index += 1
            }
        }
        return list
    }
}

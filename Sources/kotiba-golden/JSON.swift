import Foundation

// A deterministic JSON writer, hand-rolled rather than JSONEncoder, for two reasons that are
// both load-bearing for what these fixtures are for.
//
// 1. **Every non-ASCII scalar is written as `\uXXXX`.** The fixtures exist to pin the difference
//    between okina U+02BB and tutuq belgisi U+02BC, and a literal `ʻ` in a UTF-8 file is one
//    editor, one `git config core.autocrlf`, one NFC pass away from being something else. An
//    escape survives all of that, and `JSON.parse` in the TypeScript port decodes it natively.
// 2. **Object keys are sorted, always.** `JSONEncoder.OutputFormatting.sortedKeys` would give the
//    same thing, but sorting here keeps the whole format in one file that can be read in a
//    minute, which matters more for a file whose entire job is to be trusted.
//
// There is no reader here. Nothing in this project reads these files back with Swift.

enum JSONValue {
    case string(String)
    case int(Int)
    /// Written with `decimals` digits after the point, trailing zeros kept. See `num`.
    case number(Double, decimals: Int)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])
}

/// A double, rounded for emission.
///
/// Rounding is not cosmetic. `ClusterMass.mass` sums `posterior.values`, and a Swift `Dictionary`
/// iterates in an order derived from a **per-process** hash seed, so the summation order — and
/// therefore the last bit or two of the result — is not stable across runs. Nothing about the
/// decision changes (`isUzbek` is a comparison against 0.05, nowhere near a bit boundary), but the
/// printed digits would, and byte-identical output is the acceptance criterion for this generator.
///
/// 9 decimal places is ~7 orders of magnitude above the ~1e-16 relative wobble that reordering a
/// five-term sum can produce, and it is also the right tolerance for the TypeScript side, whose
/// own summation order will differ again. Each fixture that carries a mass states the tolerance.
func num(_ value: Double, decimals: Int = 9) -> JSONValue { .number(value, decimals: decimals) }

func str(_ value: String) -> JSONValue { .string(value) }
func obj(_ pairs: [String: JSONValue]) -> JSONValue { .object(pairs) }
func arr(_ items: [JSONValue]) -> JSONValue { .array(items) }

extension JSONValue {
    /// Pretty-printed with two-space indent, LF line endings, and a trailing newline.
    func serialised() -> String {
        var out = ""
        write(into: &out, indent: 0)
        out.append("\n")
        return out
    }

    private func write(into out: inout String, indent: Int) {
        let pad = String(repeating: "  ", count: indent)
        let inner = String(repeating: "  ", count: indent + 1)
        switch self {
        case .string(let s):
            out += Self.escape(s)
        case .int(let i):
            out += String(i)
        case .number(let d, let decimals):
            out += Self.format(d, decimals: decimals)
        case .bool(let b):
            out += b ? "true" : "false"
        case .null:
            out += "null"
        case .array(let items):
            guard !items.isEmpty else { out += "[]"; return }
            out += "[\n"
            for (i, item) in items.enumerated() {
                out += inner
                item.write(into: &out, indent: indent + 1)
                out += i == items.count - 1 ? "\n" : ",\n"
            }
            out += pad + "]"
        case .object(let pairs):
            guard !pairs.isEmpty else { out += "{}"; return }
            let keys = pairs.keys.sorted()
            out += "{\n"
            for (i, key) in keys.enumerated() {
                out += inner + Self.escape(key) + ": "
                pairs[key]!.write(into: &out, indent: indent + 1)
                out += i == keys.count - 1 ? "\n" : ",\n"
            }
            out += pad + "}"
        }
    }

    /// Fixed-point, never scientific notation, never locale-aware.
    ///
    /// `String(format:)` against an explicit POSIX locale rather than string interpolation:
    /// interpolation of a `Double` gives shortest-round-trip, which prints `0.05` and
    /// `0.7999999999999999` from the same fixture and makes a diff unreadable. `-0` folds to `0`
    /// so a sum that happens to underflow negative does not change the bytes.
    static func format(_ value: Double, decimals: Int) -> String {
        let text = String(format: "%.\(decimals)f",
                          locale: Locale(identifier: "en_US_POSIX"), value)
        return text.hasPrefix("-") && Double(text) == 0 ? String(text.dropFirst()) : text
    }

    /// Escapes to pure ASCII. Everything above U+007E becomes `\uXXXX`, astral planes included,
    /// as a surrogate pair.
    static func escape(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value >= 0x20 && scalar.value <= 0x7E {
                    out.unicodeScalars.append(scalar)
                } else if scalar.value <= 0xFFFF {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    let v = scalar.value - 0x10000
                    out += String(format: "\\u%04x", 0xD800 + (v >> 10))
                    out += String(format: "\\u%04x", 0xDC00 + (v & 0x3FF))
                }
            }
        }
        return out + "\""
    }
}

/// Sorts strings by their Unicode scalar sequence.
///
/// Not `<` on `String`. Swift's own string comparison is by canonical-equivalence ordering, which
/// is deterministic and locale-independent — so it would satisfy the byte-identical requirement —
/// but it is not what `Array.prototype.sort()` does on the TypeScript side, and a list a port has
/// to reproduce should be ordered by a rule the port can implement in one line. Scalar order is
/// that rule, and for these lists it is UTF-16 code-unit order too, since nothing here is astral.
func scalarOrder(_ a: String, _ b: String) -> Bool {
    var left = a.unicodeScalars.makeIterator()
    var right = b.unicodeScalars.makeIterator()
    while true {
        switch (left.next(), right.next()) {
        case (nil, nil): return false
        case (nil, _): return true
        case (_, nil): return false
        case (let x?, let y?):
            if x.value != y.value { return x.value < y.value }
        }
    }
}

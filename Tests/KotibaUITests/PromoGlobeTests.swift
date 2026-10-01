import AppKit
import Foundation
import SwiftUI
import Testing

@testable import KotibaUI

// Home's first panel, the V19 "Globe" promo (PromoGlobe.swift). What can be asserted without
// eyes: the land data ships and decodes to the web original's dot count, the story is the
// owner's, Super's green marks are the page's, and every moment of the loop draws.

@Suite("Home promo: the globe")
@MainActor
struct PromoGlobeTests {

    @Test("the land dots ship as a resource and decode to the page's 1,207 samples")
    func landDecodes() {
        // 4,228 samples (every 3°, equal-area rows) in 529 bytes; 1,207 of them are land.
        #expect(GlobeScene.land.count == 1207)
        for v in GlobeScene.land.prefix(50) {
            #expect(abs((v * v).sum() - 1) < 1e-9)
        }
    }

    @Test("languages in the owner's order, each over its city, each in one mode")
    func story() {
        #expect(GlobeScene.SEQ.map(\.name) == ["Oʻzbekcha", "English", "Русский", "العربية", "Türkçe"])
        #expect(GlobeScene.SEQ.map(\.mode) == [2, 3, 0, 1, 1]) // Message, Note, Raw, Super, Super
        #expect(GlobeScene.SEQ.allSatisfy { GlobeScene.REG[$0.code] != nil })
        #expect(GlobeScene.SEQ.filter(\.rtl).map(\.code) == ["AR"])
    }

    @Test("Super's green marks what it added: punctuation and the capital of a word said in lower case")
    func superAdded() throws {
        let turkish = try #require(GlobeScene.SEQ.first { $0.code == "TR" })
        let out = Array(turkish.out[0]), flags = GlobeScene.superAdded(turkish)
        let marked = String(out.indices.filter { flags[$0] }.map { out[$0] })
        // "Yarın" was said "yarın"; "İstanbul'a" was already capitalised; the comma and the "?" are new.
        #expect(marked == "Y,?")
        let arabic = try #require(GlobeScene.SEQ.first { $0.code == "AR" })
        #expect(GlobeScene.superAdded(arabic).last == true)
        #expect(GlobeScene.superAdded(arabic).dropLast().allSatisfy { !$0 })
    }

    @Test("the loop is seamless: the spins land back where they began after 20 s")
    func seamless() {
        #expect(GlobeScene.langBase(5) - GlobeScene.langBase(0) == 30) // ≡ 0 mod 5
        #expect(GlobeScene.modeBase(5) - GlobeScene.modeBase(0) == 24) // ≡ 0 mod 4
        for t in stride(from: 0.0, to: 4, by: 0.37) {
            let lang = GlobeScene.spin(t + 20, GlobeScene.langBase, 0, 0.95) - GlobeScene.spin(t, GlobeScene.langBase, 0, 0.95)
            let mode = GlobeScene.spin(t + 20, GlobeScene.modeBase, 1.04, 1.62) - GlobeScene.spin(t, GlobeScene.modeBase, 1.04, 1.62)
            #expect(abs(lang - 30) < 1e-9 && abs(mode - 24) < 1e-9)
        }
    }

    @Test("every stop draws, at the narrowest and widest Home widths, with a non-⌘ hotkey too")
    func drawsEverywhere() {
        for (width, glyph) in [(600.0, "⌘"), (1400.0, "F13"), (742.0, "fn")] {
            for t in stride(from: 0.0, to: 20, by: 0.5) {
                let renderer = ImageRenderer(content: PromoGlobePanel(hotkeyGlyph: glyph, time: t)
                    .frame(width: width, height: PromoGlobePanel.height))
                renderer.scale = 1
                let image = renderer.cgImage
                #expect(image?.width == Int(width))
            }
        }
    }

    @Test("the accessibility label is said in every interface language")
    func labelLocalised() {
        for language in AppLanguage.allCases {
            Localizer.shared.apply(language)
            #expect(L("home.promo.label") != "home.promo.label")
        }
        Localizer.shared.apply(.english)
    }
}

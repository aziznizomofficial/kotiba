import SwiftUI

// About: version, licence, and the credits the open-source release owes. It is a card at the
// bottom of Settings rather than an eighth sidebar section — nobody visits it twice, and a
// section would take a slot from the pages people use every day.
//
// The wording is legal, not marketing, so it lives in one place: THIRD_PARTY_NOTICES.md is the
// full text and this card is its short form. If a model is added to the app, add its line here
// and its row there.

struct AboutCard: View {

    private var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "dev"
        let build = info?["CFBundleVersion"] as? String
        return build.map { "\(short) (\($0))" } ?? short
    }

    var body: some View {
        Card(title: L("about.title"), systemImage: "info.circle.fill") {
            HStack(spacing: Theme.Space.m) {
                BrandMark(size: 40)
                SettingRow(title: "Kotiba \(version)", detail: L("about.licence")) {
                    Link(L("about.source"), destination: URL(string: "https://github.com/aziznizomofficial/kotiba")!)
                        .font(Theme.Typeface.callout)
                        .foregroundStyle(Theme.Palette.accent)
                }
            }
            Hairline()
            Footnote(L("about.uzbekModel"))
            Hairline()
            credit(L("about.credit.parakeet"), L("about.credit.parakeet.detail"),
                   link: "https://huggingface.co/FluidInference/parakeet-ultra-coreml")
            credit(L("about.credit.whisper"), L("about.credit.whisper.detail"),
                   link: "https://huggingface.co/ggerganov/whisper.cpp")
            // Downloaded by the models step since the Uzbek streaming slice, and missing here
            // while THIRD_PARTY_NOTICES.md §1.6 already listed it.
            credit(L("about.credit.silero"), L("about.credit.silero.detail"),
                   link: "https://huggingface.co/ggml-org/whisper-vad")
            credit(L("about.credit.qwen"), L("about.credit.qwen.detail"),
                   link: "https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF")
            Footnote(L("about.alsoBuiltOn"))
        }
    }

    private func credit(_ title: String, _ text: String, link: String) -> some View {
        SettingRow(title: title, detail: text) {
            Link(L("about.model"), destination: URL(string: link)!)
                .font(Theme.Typeface.callout)
                .foregroundStyle(Theme.Palette.accent)
        }
    }
}

import Foundation

// What Kotiba can fetch for you, and — just as importantly — what it cannot.
//
// `ModelStore` has always been able to download, sha256-verify and atomically install a model.
// It had no callers and there was no catalogue: `ModelEntry` was a shape with no instances, so
// even a wired-up store had nothing to ask for. Meanwhile the only acquisition path in the app
// was an `NSOpenPanel`, and the blocker the Uzbek user meets on first launch — "No Uzbek model.
// Choose one in Settings › Languages" — was a dead end with no download behind it.
//
// The hashes and URLs here are the ones in `Scripts/Manifest.json`, which `make bootstrap` uses.
// `ModelCatalogueManifestTests` reads that file and asserts the two agree, because a second copy
// of a value is exactly how `ClusterMass.defaultThreshold` came to disagree with the setting it
// was supposed to be.

public enum ModelCatalogue {

    /// A model the app knows how to obtain by itself.
    ///
    /// The Uzbek engine joins the list the moment its public route is live — see
    /// `uzbekEngineIsPublic`. Until then it is fetched by `make bootstrap` (through `gh`) or
    /// arrives inside the app bundle, and the settings pane says so instead of offering a 404.
    public static let downloadable: [ModelEntry] =
        [russianEngine, languageID, detector, polishModel, arabicEngine, arabicModesModel]
        + (uzbekEngineIsPublic ? [uzbekEngine] : [])

    /// Kotib STT — `Kotib/uzbek_stt_v1`, Whisper-medium fine-tuned on Uzbek, Apache-2.0 — as the
    /// q5_0 ggml the app runs. This is the Uzbek engine permanently (D-08, C2).
    ///
    /// Hugging Face carries only the safetensors, so the ggml exists because this project built
    /// it: `Scripts/convert-uzbek.sh` against revision 0e239511 (whose `model.safetensors` is
    /// sha256 a0175dcd…), then `whisper-quantize q5_0`. The file below is the one measured at
    /// 21.55% WER on the 344-clip harness with the app's decode settings.
    ///
    /// Fetched from `publicModelsBase`, the one place this project's own builds are published.
    /// Reproducible by anyone with `Scripts/convert-uzbek.sh`, byte for byte (verified 2026-09-30).
    public static let uzbekEngine = ModelEntry(
        name: "Kotib STT (uzbek_stt_v1) q5_0",
        url: publicModelsBase.appendingPathComponent("ggml-uzbek-stt-v1-q5_0.bin"),
        sha256: "2891c1ca99f40a5519cd2e863e85b70b6cdc057b46fdbb5edbe6d9cead29c1b2",
        destination: "ggml-uzbek-stt-v1-q5_0.bin",
        expectedBytes: 539_212_484)

    /// Silero VAD, as the ggml whisper.cpp's `whisper_vad_*` API loads. 885 KB, MIT. The
    /// streaming Uzbek session uses it to decide where to cut and what to trim, and falls back to
    /// an energy gate without it (C2 §4). `SileroSpeechDetector.fileName` is this `destination`.
    public static let speechDetector = ModelEntry(
        name: "Silero VAD v6.2.0 ggml",
        url: URL(string: "https://huggingface.co/ggml-org/whisper-vad/resolve/"
                 + "9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin")!,
        sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
        destination: "ggml-silero-v6.2.0.bin",
        expectedBytes: 885_098)

    /// Where this project's *own* model builds are published for anyone to fetch — the models
    /// no upstream hosts as ggml. One constant, mirrored as `public_models_base` in
    /// `Scripts/Manifest.json` and `PUBLIC_MODELS_BASE` in `windows/src/contracts/models.ts`;
    /// `ModelCatalogueManifestTests` asserts they agree.
    ///
    /// Release `models-v2` of `aziznizomofficial/kotiba`, which carries the Uzbek ggml with the
    /// sha256 below (uploaded 2026-10-01 for 1.0.0). A plain GET answers once that repository is
    /// public; while it is still private, `make bootstrap` reaches the same asset through `gh`.
    public static let publicModelsBase = URL(
        string: "https://github.com/aziznizomofficial/kotiba/releases/download/models-v2/")!

    /// True from 1.0.0: `models-v2` exists on `aziznizomofficial/kotiba` with the file above, so
    /// the in-app Download button for Uzbek has something to fetch. (It 404s only for as long as
    /// the repository itself is private — the state just before the public launch.)
    public static let uzbekEngineIsPublic = true

    /// whisper large-v3-turbo, q5_0. Named for the job it had first — Russian, before Parakeet
    /// (Apple's engine does not do Russian at all) — and still Russian's answer while Parakeet is
    /// missing *if* it is on disk. Since 2026-10-02 it ships in no installer and is fetched only
    /// with Turkish (its engine) or Arabic (its language check and loop fallback).
    public static let russianEngine = ModelEntry(
        name: "whisper large-v3-turbo q5_0",
        url: URL(string: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"
                 + "ggml-large-v3-turbo-q5_0.bin")!,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        destination: "ggml-large-v3-turbo-q5_0.bin",
        expectedBytes: 574_041_195)

    /// Cohere Transcribe Arabic 07-2026, Q5_K_M GGUF — the Arabic engine (D-11, C4 §7.2), run by
    /// transcribe.cpp. Optional: fetched only when the user turns Arabic on. 7.0 % WER on FLEURS
    /// Arabic against whisper turbo's 13.8 %, and it punctuates.
    ///
    /// The upstream `CohereLabs/cohere-transcribe-arabic-07-2026` is click-through gated; this is
    /// handy-computer's ungated Apache-2.0 GGUF redistribution, pinned to a revision (NOTICE
    /// carries Cohere's attribution). Windows loads the same file.
    public static let arabicEngine = ModelEntry(
        name: "Cohere Transcribe Arabic 07-2026 Q5_K_M",
        url: URL(string: "https://huggingface.co/handy-computer/"
                 + "cohere-transcribe-arabic-07-2026-gguf/resolve/"
                 + "5e6b33c211458ac69347d297abb6d47a250c328f/"
                 + "cohere-transcribe-arabic-07-2026-Q5_K_M.gguf")!,
        sha256: "55e61c9b047e36f0e084d367f6b0bfecc71a6a0527da6eea4f0c687f3584775f",
        destination: "cohere-transcribe-arabic-07-2026-Q5_K_M.gguf",
        expectedBytes: 1_770_270_112)

    /// Gemma 4 E2B instruct, Q4_K_M GGUF — the modes model for Arabic dictations only (C4 §14.5).
    /// Optional, offered with Arabic: measured with C3's method on held-out Arabic it labels Note
    /// lines right where Qwen3-1.7B made 29 of 101 encyclopaedia facts into tasks (2 of 101),
    /// punctuates dialect better (F1 42.5 against 35.3), and takes out more fillers in Message;
    /// the other languages keep `polishModel`. Apache-2.0 (Google), unsloth's GGUF, pinned.
    public static let arabicModesModel = ModelEntry(
        name: "Gemma 4 E2B Q4_K_M (Arabic modes)",
        url: URL(string: "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/"
                 + "0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf")!,
        sha256: "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8",
        destination: "gemma-4-E2B-it-Q4_K_M.gguf",
        expectedBytes: 3_106_738_272)

    /// The language-ID model (P4, D-14): SpeechBrain's VoxLingua107 ECAPA-TDNN (Apache-2.0),
    /// exported by `Scripts/export-ecapa.py` as one Core ML file — waveform in, 107 languages'
    /// log-posteriors out, Float16 weights. The detector from 1.1 on: it has an Uzbek class where
    /// whisper base has only Turkish to hear Uzbek as, and every dialect of Arabic. Published with
    /// the project's own builds (`publicModelsBase`); the ONNX twin is Windows'.
    public static let languageID = ModelEntry(
        name: "VoxLingua107 ECAPA language ID (Core ML, f16)",
        url: publicModelsBase.appendingPathComponent("ecapa-voxlingua107-lid-f16.mlmodel"),
        sha256: "1f6bcbadd1514375669e1f99a9c520c564de719c98410fb5b2cdf2aa3e346052",
        destination: "ecapa-voxlingua107-lid-f16.mlmodel",
        expectedBytes: 42_940_194)

    /// whisper base, q5_1. Language detection only — 59 MB and 34 ms, and it is never asked to
    /// transcribe anything.
    public static let detector = ModelEntry(
        name: "whisper base q5_1",
        url: URL(string: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"
                 + "ggml-base-q5_1.bin")!,
        sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
        destination: "ggml-base-q5_1.bin",
        expectedBytes: 59_707_625)

    // MARK: Core ML bundles

    // A Core ML model is a directory, so these are `ModelBundle`s rather than `ModelEntry`s: every
    // file pinned to one upstream commit with its own sha256, generated by
    // `Scripts/measure/en-ru/hf_manifest.py` and mirrored in `Scripts/Manifest.json` under
    // "bundles". The engine fetches its bundle itself on first use (`ParakeetEngine.prepare`), so
    // these are not in `downloadable`, which is the settings pane's list of single-file models.

    /// Parakeet Ultra — moondream's post-training of NVIDIA Parakeet-TDT-0.6B-v3, as FluidAudio's
    /// Core ML build. English and Russian (and 23 other European languages) in one model, with
    /// punctuation and capitals from the decoder itself. CC-BY-4.0: the attribution lives in
    /// NOTICE. The engine for both languages — see docs/research/C1-en-ru-engine-selection.md.
    public static let parakeetUltra = ModelBundle.huggingFace(
        name: "Parakeet Ultra (TDT 0.6B, Core ML)",
        repo: "FluidInference/parakeet-ultra-coreml",
        revision: "95eaa59a39d4394f047a4dc5cce480388a60d1b6",
        directory: "parakeet-ultra-coreml",
        files: [
            ("Decoder.mlmodelc/analytics/coremldata.bin",
             "fe92b6cfaa012abd5248c0bc877832f19807015abffc60d87b8ccc8ccb48b3b5", 243),
            ("Decoder.mlmodelc/coremldata.bin",
             "3b06e66768f0df7e21795f50e2b29300e33eeb1a2579dc42c695279c2d308497", 560),
            ("Decoder.mlmodelc/model.mil",
             "956f600207f88396017ca5c96cfa3acd5bfee60835a5b44b762e033a8fb28955", 13_110),
            ("Decoder.mlmodelc/weights/weight.bin",
             "02a0d219f281b9665bc10c8768649403b2eebbbf4b44c627041d948e0de11bb4", 23_604_992),
            ("Encoder.mlmodelc/analytics/coremldata.bin",
             "d87101d824d6723cf95304da33755c3c60e762663b9ef2b0c4bd0aa166a09a0d", 243),
            ("Encoder.mlmodelc/coremldata.bin",
             "397a84a4062f563cbc5f56077c674f09a61d85be5090f61d2f1932afb92ac0fe", 514),
            ("Encoder.mlmodelc/model.mil",
             "f5d601568a4171d99a314c0fe3f6bc67715da2623732a3fb566e050ea83e5848", 1_002_653),
            ("Encoder.mlmodelc/weights/weight.bin",
             "315ba01f33cadbf601d43ac7f5c86208b7aa75fdaa34705c9869d5abe3521c9b", 594_211_328),
            ("JointDecisionv3.mlmodelc/analytics/coremldata.bin",
             "68d38ca646aebafa7a9329e2efda50f5767c49e89fdb5f77f212072bb66f97c4", 243),
            ("JointDecisionv3.mlmodelc/coremldata.bin",
             "5e3af5a4ce686f6c237cadbd9284e10d333bc0e1546633cd0e430e6194044bc4", 592),
            ("JointDecisionv3.mlmodelc/model.mil",
             "791b3c3cf3eb2079c84623fc880f6bba008d1366e5f8b03e9a8ed8bd4d7194a0", 11_777),
            ("JointDecisionv3.mlmodelc/weights/weight.bin",
             "3f310b85b82341c53ec383025ab094a4e462ee1c592e1ad7c6bfe39cff66ca25", 12_642_764),
            ("Preprocessor.mlmodelc/analytics/coremldata.bin",
             "c9beeb989c8d66f8be11df59bc6df277ec76cee404f6865b46243835ef562f6d", 243),
            ("Preprocessor.mlmodelc/coremldata.bin",
             "dbde3f2300842c1fd51ef3ff948a0bcffe65ffd2dca10707f2509f32c1d65b1d", 486),
            ("Preprocessor.mlmodelc/metadata.json",
             "2a98699e22d279dd37fa1d238aeb1c6db1df0d6fad687775324157689d8f3acf", 2_841),
            ("Preprocessor.mlmodelc/model.mil",
             "4b8518a956450fec57f06c2a21bdffc26973f7f1fa6842fb38fe917f896b6b93", 28_181),
            ("Preprocessor.mlmodelc/weights/weight.bin",
             "129b76e3aeafa8afa3ea76d995b964b145fe83700d579f6ff42c4c38fa0968ea", 491_072),
            ("parakeet_vocab.json",
             "7ec60e05f1b24480736ec0eed40900f4626bce1fa9a60fd700ec7e2a59198735", 151_122),
        ])

    /// NVIDIA's own Parakeet-TDT-0.6B-v3, which Ultra was post-trained from. Kept because it is
    /// the baseline every published Parakeet number refers to, and the probe measures against it.
    public static let parakeetV3 = ModelBundle.huggingFace(
        name: "Parakeet TDT 0.6B v3 (Core ML)",
        repo: "FluidInference/parakeet-tdt-0.6b-v3-coreml",
        revision: "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe",
        directory: "parakeet-tdt-0.6b-v3-coreml",
        files: [
            ("Decoder.mlmodelc/analytics/coremldata.bin",
             "4238c4e81ecd0dc94bd7dfbb60f7e2cc824107c1ffe0387b8607b72833dba350", 243),
            ("Decoder.mlmodelc/coremldata.bin",
             "18647af085d87bd8f3121c8a9b4d4564c1ede038dab63d295b4e745cf2d7fb99", 554),
            ("Decoder.mlmodelc/metadata.json",
             "a39e93cd8371b8ded92635c7804fcd0590f0d1dd9415c6d19a0484be073077d9", 3_427),
            ("Decoder.mlmodelc/model.mil",
             "ef2a0a281695398a62fde86ac269c68f73d5b578d7ed3b31f2ba91a2d1ea1f35", 13_110),
            ("Decoder.mlmodelc/weights/weight.bin",
             "48adf0f0d47c406c8253d4f7fef967436a39da14f5a65e66d5a4b407be355d41", 23_604_992),
            ("Encoder.mlmodelc/analytics/coremldata.bin",
             "42e638870d73f26b332918a3496ce36793fbb413a81cbd3d16ba01328637a105", 243),
            ("Encoder.mlmodelc/coremldata.bin",
             "d48034a167a82e88fc3df64f60af963ab3983538271175b8319e7d5720a0fb86", 485),
            ("Encoder.mlmodelc/metadata.json",
             "da24da9cca943fb29d7fa8e376d57fca7cb3aa08ca51b956b0b0e56813f087e9", 2_921),
            ("Encoder.mlmodelc/model.mil",
             "ed7b19156ca29fa7dfd6891deb9fda4b0e8893f68597c985d135736546a43808", 959_769),
            ("Encoder.mlmodelc/weights/weight.bin",
             "e2020f323703477a5b21d7c2d282c403e371afb5962e79877e3033e73ba6f421", 445_187_200),
            ("JointDecisionv3.mlmodelc/analytics/coremldata.bin",
             "26def4bf73dd56d29dee21c8ef97cb8969e62f6120ed1adc91e46828e2737b6c", 243),
            ("JointDecisionv3.mlmodelc/coremldata.bin",
             "f5fc08b741400f0088492c9e839418b1e18522f19cba28d361dd030c5f398342", 521),
            ("JointDecisionv3.mlmodelc/metadata.json",
             "d9307211b9a37e0f0ac260c7660b1571a3de25841035cfdf9b58fd40425f890f", 3_453),
            ("JointDecisionv3.mlmodelc/model.mil",
             "be60732943389a047175111a83f8839f3eb39d4803adafa828a0871b2f39818d", 11_775),
            ("JointDecisionv3.mlmodelc/weights/weight.bin",
             "4e0e63d840032f7f07ddb1d64446051166281e5491bf22da8a945c41f6eedb3e", 12_642_764),
            ("Preprocessor.mlmodelc/analytics/coremldata.bin",
             "c9beeb989c8d66f8be11df59bc6df277ec76cee404f6865b46243835ef562f6d", 243),
            ("Preprocessor.mlmodelc/coremldata.bin",
             "dbde3f2300842c1fd51ef3ff948a0bcffe65ffd2dca10707f2509f32c1d65b1d", 486),
            ("Preprocessor.mlmodelc/metadata.json",
             "2a98699e22d279dd37fa1d238aeb1c6db1df0d6fad687775324157689d8f3acf", 2_841),
            ("Preprocessor.mlmodelc/model.mil",
             "4b8518a956450fec57f06c2a21bdffc26973f7f1fa6842fb38fe917f896b6b93", 28_181),
            ("Preprocessor.mlmodelc/weights/weight.bin",
             "129b76e3aeafa8afa3ea76d995b964b145fe83700d579f6ff42c4c38fa0968ea", 491_072),
            ("parakeet_vocab.json",
             "7ec60e05f1b24480736ec0eed40900f4626bce1fa9a60fd700ec7e2a59198735", 151_122),
        ])

    /// English-only Parakeet v2. Measured against Ultra for English; see C1.
    public static let parakeetV2 = ModelBundle.huggingFace(
        name: "Parakeet TDT 0.6B v2 (Core ML)",
        repo: "FluidInference/parakeet-tdt-0.6b-v2-coreml",
        revision: "ee09c569f73759e6d44c9bd16766f477b2b36d39",
        directory: "parakeet-tdt-0.6b-v2-coreml",
        files: [
            ("Decoder.mlmodelc/analytics/coremldata.bin",
             "46de1a6fe2e49d19a2125bc91acf020df7f2aea84ba821532aade8427a440b05", 243),
            ("Decoder.mlmodelc/coremldata.bin",
             "d200ca07694a347f6d02a3886a062ae839831e094e443222f2e48a14945966a8", 554),
            ("Decoder.mlmodelc/metadata.json",
             "90a279b822496316458febc0ce761ab05954fadd9d66aa97bea077a35fc8f2b2", 3_427),
            ("Decoder.mlmodelc/model.mil",
             "7b95a5a6b672c652000348a67b6d4d92bb8e176b978c6666fe73c28a4d7ec579", 13_106),
            ("Decoder.mlmodelc/weights/weight.bin",
             "27d26890221d82322c1092fd99d7b40578e435d5cf4b83c887c42603caf97aba", 14_429_952),
            ("Encoder.mlmodelc/analytics/coremldata.bin",
             "42e638870d73f26b332918a3496ce36793fbb413a81cbd3d16ba01328637a105", 243),
            ("Encoder.mlmodelc/coremldata.bin",
             "4def7aa848599ad0e17a8b9a982edcdbf33cf92e1f4b798de32e2ca0bc74b030", 485),
            ("Encoder.mlmodelc/metadata.json",
             "58222fbc48c13c49d9715567803cd50cb9c23e4360462e0f8ffcea59a2c73c63", 2_926),
            ("Encoder.mlmodelc/model.mil",
             "ed7b19156ca29fa7dfd6891deb9fda4b0e8893f68597c985d135736546a43808", 959_769),
            ("Encoder.mlmodelc/weights/weight.bin",
             "4adc7ad44f9d05e1bffeb2b06d3bb02861a5c7602dff63a6b494aed3bf8a6c3e", 445_187_200),
            ("JointDecision.mlmodelc/analytics/coremldata.bin",
             "f1183ba213bb94a918c8d2cad19ab045320618f97f6ca662245b3936d7b090f7", 243),
            ("JointDecision.mlmodelc/coremldata.bin",
             "e2c6752f1c8cf2d3f6f26ec93195c9bfa759ad59edf9f806696a138154f96f11", 534),
            ("JointDecision.mlmodelc/metadata.json",
             "ba8d309417b9acd4a175fdb15687de6a941db2f5b06666a60e7cf3cc8e2d3c3c", 2_936),
            ("JointDecision.mlmodelc/model.mil",
             "93bf82042235127cb81ab537dcae47a1c2e7e242ce4ffdaf772981b45eedc4f0", 9_722),
            ("JointDecision.mlmodelc/weights/weight.bin",
             "ca22a65903a05e64137677da608077578a8606090a598abf4875fa6199aaa19d", 3_453_388),
            ("Preprocessor.mlmodelc/analytics/coremldata.bin",
             "03ab3c1327a054c54c07a40325db967ec574f2c91dcc8192bfa44aa561bcf2d8", 243),
            ("Preprocessor.mlmodelc/coremldata.bin",
             "d88ea1fc349459c9e100d6a96688c5b29a1f0d865f544be103001724b986b6d6", 494),
            ("Preprocessor.mlmodelc/metadata.json",
             "fb16c581ff5e1b962e7cb2181ed892cd32f9f84c12b6e80ff3e089f28e35bcbb", 2_974),
            ("Preprocessor.mlmodelc/model.mil",
             "3e06d16fd061294c8a75be68c43a3b1ed1f593d4a9c35249e9cdbccadc59721e", 27_166),
            ("Preprocessor.mlmodelc/weights/weight.bin",
             "a5f7df6c7f47147ae9486fe18cc7792f9a44d093ec3c6a11e91ef2dc363c48dc", 298_880),
            ("parakeet_vocab.json",
             "57019fe3c745772ca83a1b048a4bb951cd51329504ea33d4d83316b96e279a97", 18_762),
        ])

    /// Qwen3-1.7B, Q4_K_M — the on-device model behind Super (Uzbek), Message and Note, on macOS
    /// through llama.cpp and on Windows through node-llama-cpp: the same file on both.
    ///
    /// Pinned to a repository revision, not `main`: the hash is of this exact file, and a
    /// re-quantised upload under the same name would otherwise fail verification for every new
    /// install. Apache-2.0. Chosen by measurement — docs/research/C3-on-device-modes.md.
    public static let polishModel = ModelEntry(
        name: "Qwen3 1.7B Q4_K_M (modes)",
        url: URL(string: "https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/"
                 + "daeb8e2d528a760970442092f6bf1e55c3b659eb/Qwen3-1.7B-Q4_K_M.gguf")!,
        sha256: "d2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5",
        destination: "Qwen3-1.7B-Q4_K_M.gguf",
        expectedBytes: 1_282_439_264)

    /// The Uzbek model, and why it is not in `downloadable` yet.
    ///
    /// There is no public `.bin` of it anywhere: `Kotib/uzbek_stt_v1` ships safetensors only,
    /// and the ggml conversion was produced in this project and lives as an asset on a
    /// **private** GitHub release. A plain `URLSession` GET cannot fetch it — `make bootstrap`
    /// reaches it through `gh` with the maintainer's credentials, which a shipped app does not
    /// have and should not want. `uzbekEngine` is ready for the day the repository is public.
    ///
    /// So the honest position is: Kotiba cannot download this one for you, and says so, rather
    /// than offering a button that fails with a 404. Choosing the file by hand still works, and
    /// `ModelFile.inspect` now checks what you chose is actually a ggml model.
    public static let uzbekEngineIsNotDownloadable = """
        Kotiba cannot fetch the Uzbek model for you: the only build of it lives on a private \
        release, and there is no public copy to download. Choose the file with the button above \
        once you have it.
        """

    /// Which setting a downloaded model belongs in.
    public static func settingKey(for entry: ModelEntry) -> Purpose? {
        switch entry.destination {
        case russianEngine.destination: return .russianModel
        case detector.destination: return .detectorModel
        case languageID.destination: return .languageIDModel
        case uzbekEngine.destination: return .uzbekModel
        case polishModel.destination: return .polishModel
        case arabicEngine.destination: return .arabicModel
        case arabicModesModel.destination: return .arabicModesModel
        default: return nil
        }
    }

    public enum Purpose: Sendable, Equatable {
        case russianModel
        case detectorModel
        /// `AppSettings.languageIDModelPath` (P4).
        case languageIDModel
        case uzbekModel
        /// Not a setting: the app finds it by its destination in the models directory.
        case polishModel
        /// Likewise (`AppSettings.resolvedArabicPath`).
        case arabicModel
        /// Likewise (`DictationController.arabicModesPath`).
        case arabicModesModel
    }
}

extension ModelBundle {
    /// A bundle whose files all come from one Hugging Face repo at one commit, laid out under
    /// `directory` exactly as the repo lays them out.
    public static func huggingFace(name: String, repo: String, revision: String,
                                   directory: String,
                                   files: [(path: String, sha256: String, bytes: Int)])
        -> ModelBundle {
        ModelBundle(
            name: name, directory: directory, revision: revision,
            files: files.map { file in
                ModelEntry(
                    name: "\(name) · \(file.path)",
                    url: URL(string: "https://huggingface.co/\(repo)/resolve/\(revision)/"
                             + file.path)!,
                    sha256: file.sha256,
                    destination: "\(directory)/\(file.path)",
                    expectedBytes: file.bytes)
            })
    }
}

import Foundation
import Testing

@testable import KotibaCore

// The input device in the diagnostics record, and the gate on the "your microphone is very quiet"
// hint. Every device here is invented; nothing opens audio.

private let iPhone = InputDeviceInfo(name: "Test iPhone Microphone", transport: .continuity,
                                     sampleRate: 48_000, overrodeDefault: false)
private let builtIn = InputDeviceInfo(name: "MacBook Pro Microphone", transport: .builtIn,
                                      sampleRate: 48_000, overrodeDefault: true)

private func take(outcome: String = "heardNothing", seconds: Double = 8, peak: Float = 0.008,
                  device: InputDeviceInfo? = iPhone) -> DictationRecord {
    var r = DictationRecord(startedAt: Date(timeIntervalSince1970: 1_785_000_000))
    r.outcome = outcome
    r.audioSeconds = seconds
    r.peakAmplitude = peak
    r.inputDevice = device
    return r
}

@Suite("Input device in the diagnostics record")
struct InputDeviceRecordTests {

    @Test("a record with a device round-trips through the JSONL store")
    func roundTrip() async throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("kotiba-input-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try DiagnosticsStore(
            url: dir.appendingPathComponent("d.jsonl"),
            environment: DiagnosticsEnvironment(appVersion: "1", osVersion: "m", device: "d",
                                                locale: "en"))
        try await store.append(take())
        #expect(try await store.records().first?.inputDevice == iPhone)
    }

    @Test("a line written before the field existed still reads, and so does one with extra fields")
    func backwardAndForwardCompatible() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let old = #"{"startedAt":"2026-09-01T10:00:00Z","audioSeconds":2,"peakAmplitude":0.3,"stageMillis":{},"outcome":"done","errors":[]}"#
        let oldRecord = try decoder.decode(DictationRecord.self, from: Data(old.utf8))
        #expect(oldRecord.inputDevice == nil)

        // A newer build adding a field, and a device with only its name and transport.
        let newer = #"{"startedAt":"2026-09-01T10:00:00Z","audioSeconds":2,"peakAmplitude":0.3,"stageMillis":{},"outcome":"done","errors":[],"inputDevice":{"name":"X","transport":"usb","futureField":1},"alsoNew":true}"#
        let newerRecord = try decoder.decode(DictationRecord.self, from: Data(newer.utf8))
        #expect(newerRecord.inputDevice == InputDeviceInfo(name: "X", transport: .usb))
    }

    @Test("the plain-text summary says what kind of input, never its name")
    func summaryIsRedacted() async throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("kotiba-input-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try DiagnosticsStore(
            url: dir.appendingPathComponent("d.jsonl"),
            environment: DiagnosticsEnvironment(appVersion: "1", osVersion: "m", device: "d",
                                                locale: "en"))
        try await store.append(take(device: InputDeviceInfo(
            name: "Aziz’s iPhone Microphone", transport: .continuity, sampleRate: 48_000,
            overrodeDefault: true)))
        let summary = try await store.summary()
        #expect(summary.contains("input continuity, 48000 Hz, overrode system default"), "\(summary)")
        #expect(!summary.contains("Aziz"))
        #expect(!summary.contains("iPhone Microphone"))
    }

    @Test("transport is refined by name when the hardware did not say Continuity")
    func classifyByName() {
        #expect(InputTransport.classify(.usb, name: "Aziz’s iPhone Microphone") == .continuity)
        #expect(InputTransport.classify(.other, name: "iPad Mic") == .continuity)
        #expect(InputTransport.classify(.builtIn, name: "iPhone") == .builtIn)
        #expect(InputTransport.classify(.usb, name: "Blue Yeti") == .usb)
    }

    @Test("an AudioBuffer carries its device, and equality still means the same audio")
    func bufferDevice() {
        let plain = AudioBuffer(samples: [0.1, 0.2])
        #expect(plain.device == nil)
        #expect(plain.withDevice(iPhone).device == iPhone)
        #expect(plain.withDevice(iPhone).samples == plain.samples)
    }
}

@Suite("Quiet-microphone gate")
struct QuietMicTests {

    @Test("a 1.5 s+ heard-nothing take under peak 0.03 with a known device qualifies")
    func qualifies() {
        #expect(QuietMic.suspect(take()) == iPhone)
        // The measured burst: peaks 0.005–0.016, 8–13 s holds.
        for peak: Float in [0.005, 0.016, 0.0299] {
            #expect(QuietMic.suspect(take(seconds: 13, peak: peak)) != nil, "peak \(peak)")
        }
    }

    @Test("every other take does not", arguments: [
        ("a tap, not a hold", take(seconds: 1.49)),
        ("loud enough to have been speech", take(peak: 0.03)),
        ("dictation that worked", take(outcome: "done")),
        ("a failure", take(outcome: "failed")),
        ("device not known", take(device: nil)),
    ])
    func doesNotQualify(_ why: String, _ record: DictationRecord) {
        #expect(QuietMic.suspect(record) == nil, "\(why)")
    }

    @Test("once per device per hour, and a different device is its own count")
    func rateLimit() {
        var limiter = QuietMicLimiter()
        func admit(_ device: InputDeviceInfo, _ at: Date) -> Bool { limiter.admit(device, now: at) }
        let t0 = Date(timeIntervalSince1970: 1_785_000_000)
        #expect(admit(iPhone, t0))
        #expect(!admit(iPhone, t0 + 60))
        #expect(!admit(iPhone, t0 + 3599))
        #expect(admit(builtIn, t0 + 61), "another device is not the same nag")
        #expect(admit(iPhone, t0 + 3600), "an hour later it may speak again")
        #expect(!admit(iPhone, t0 + 3601))
    }

    @Test("the pill names the device in at most two short words")
    func pillName() {
        #expect(QuietMic.pillName("Test iPhone Microphone") == "Test iPhone")
        #expect(QuietMic.pillName("MacBook Pro Microphone") == "MacBook Pro")
        #expect(QuietMic.pillName("iPhone Microphone") == "iPhone")
        #expect(QuietMic.pillName("Microphone") == "Microphone")
        let long = QuietMic.pillName("Wwwwwwwwwwwwwwwwww Wwwwwwwwwwwwww")
        #expect(long.count <= 14 && long.hasSuffix("…"))
        #expect(QuietMic.pillName("Sony WH-1000XM4 Hands-Free AG Audio").split(separator: " ").count <= 2)
    }

    @Test("the explanation depends on what the device is")
    func kinds() {
        #expect(QuietMic.kind(of: iPhone) == .continuity)
        #expect(QuietMic.kind(of: InputDeviceInfo(name: "Phone link iPhone", transport: .usb)) == .continuity)
        #expect(QuietMic.kind(of: builtIn) == .builtIn)
        #expect(QuietMic.kind(of: InputDeviceInfo(name: "Blue Yeti", transport: .usb)) == .external)
        #expect(QuietMic.kind(of: InputDeviceInfo(name: "AirPods", transport: .bluetooth)) == .external)
    }
}

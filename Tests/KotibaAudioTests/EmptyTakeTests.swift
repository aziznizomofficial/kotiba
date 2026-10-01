import Testing

@testable import KotibaAudio

// When a take that came back empty condemns the graph (`MicrophoneSource.stopTake`). The
// rebuild itself needs a real device, which no test may open; the rule is what can go wrong here.
@Suite("An empty take marks the graph for rebuilding")
struct EmptyTakeTests {

    @Test("a held take that delivered nothing condemns the graph")
    func heldAndEmpty() {
        #expect(MicrophoneSource.deliveredNothing(samples: 0, engineRan: true,
                                                  held: .milliseconds(800)))
    }

    @Test("a tap shorter than the first buffer, a take with audio, or no engine do not")
    func notCondemned() {
        #expect(!MicrophoneSource.deliveredNothing(samples: 0, engineRan: true,
                                                   held: .milliseconds(40)))
        #expect(!MicrophoneSource.deliveredNothing(samples: 1, engineRan: true,
                                                   held: .seconds(3)))
        #expect(!MicrophoneSource.deliveredNothing(samples: 0, engineRan: false,
                                                   held: .seconds(3)))
        #expect(!MicrophoneSource.deliveredNothing(samples: 0, engineRan: true, held: nil))
    }
}

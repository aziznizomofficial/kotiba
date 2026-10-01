import Foundation
import KotibaObjC
import Testing

// The shim exists because AVFAudio reports a hardware-format mismatch by raising an
// NSException — which no Swift `catch` can see, so the process aborts. Observed three times
// as identical SIGABRT crash logs through `-[AVAudioEngine connect:to:format:]` when the
// input device changed between reading its format and connecting to it. The engine calls
// themselves need a real microphone and a TCC grant, so what is provable here is the
// contract the fix rests on: an Objective-C exception comes back as a value.
struct ExceptionGuardTests {

    @Test func objcExceptionComesBackAsAnError() {
        let error = KotibaCatchObjCException {
            NSException(name: .invalidArgumentException,
                        reason: "required condition is false: format.sampleRate == hwFormat.sampleRate",
                        userInfo: nil).raise()
        }
        #expect(error != nil)
        // The reason must survive into the error: it is what the HUD and the blockers list
        // show, and "NSInvalidArgumentException" alone diagnoses nothing.
        #expect(error?.localizedDescription.contains("format.sampleRate") == true)
    }

    @Test func quietBlockReturnsNil() {
        var ran = false
        let error = KotibaCatchObjCException { ran = true }
        #expect(error == nil)
        #expect(ran)
    }
}

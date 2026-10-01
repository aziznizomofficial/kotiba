#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs `block` and returns nil, unless the block raises an Objective-C exception — which
/// comes back as an NSError carrying the exception's name and reason.
///
/// This exists for AVFAudio: `-[AVAudioEngine connect:to:format:]` and its relatives signal a
/// hardware-format mismatch by raising, not by returning an error, and Swift has no way to
/// catch an NSException. Without this wrapper the raise reaches std::terminate and the whole
/// process aborts — measured on this Mac as a SIGABRT every time the input device changed
/// between reading its format and connecting to it.
NSError * _Nullable KotibaCatchObjCException(void (NS_NOESCAPE ^block)(void))
    NS_SWIFT_NAME(KotibaCatchObjCException(_:));

NS_ASSUME_NONNULL_END

#import "include/KotibaExceptionGuard.h"

NSError * _Nullable KotibaCatchObjCException(void (NS_NOESCAPE ^block)(void)) {
    @try {
        block();
        return nil;
    } @catch (NSException *exception) {
        NSString *reason = exception.reason ?: @"no reason given";
        NSString *message = [NSString stringWithFormat:@"%@ — %@", exception.name, reason];
        return [NSError errorWithDomain:@"uz.kotiba.objc-exception"
                                   code:1
                               userInfo:@{NSLocalizedDescriptionKey : message}];
    }
}

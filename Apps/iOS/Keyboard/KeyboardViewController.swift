import UIKit

// Task I-05. This inserts text and does nothing else: it cannot record audio, and although
// the measured memory ceiling is ~177 MB rather than the ~60 MB everyone assumed, hosting a
// model here would still be pointless without a microphone.
final class KeyboardViewController: UIInputViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
    }
}

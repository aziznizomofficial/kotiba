import CryptoKit
import Foundation
import KotibaCore

// Task E-04. Where model weights live, how they get there, and how we know they arrived intact.
//
// Three findings shape this and each one cost something to learn:
//
// 1. **`Library/Application Support`, never `Library/Caches`.** iOS may purge Caches under
//    storage pressure, and a 1.1 GB re-download because the phone wanted some room is not a
//    recoverable user experience. The predecessor was forced into Caches because `mkdir` under
//    Application Support failed on the iPad with NSFileWriteNoPermissionError — the cause is
//    that the iOS installer does not create that directory, so it must be created with
//    `withIntermediateDirectories: true` rather than assumed to exist.
//
// 2. **Weights survive the weekly re-sign.** Measured across six rebuild-and-reinstall cycles
//    on both devices, including an executable rename. So models are emphatically NOT part of
//    the 7-day problem and must not be re-downloaded on a hunch.
//
// 3. **Every refusal is recorded with its errno.** The predecessor swallowed the directory
//    failure by design, and the consequence was that Parakeet never once loaded on iOS while
//    every dictation silently fell back to an engine 30x slower, for weeks, with nothing
//    anywhere saying so.

public struct ModelEntry: Sendable, Codable, Equatable {
    public var name: String
    public var url: URL
    /// Lowercase hex. Empty means "unknown" — permitted, but recorded loudly.
    public var sha256: String
    /// Path relative to the models root.
    public var destination: String
    public var expectedBytes: Int?

    public init(name: String, url: URL, sha256: String, destination: String,
                expectedBytes: Int? = nil) {
        self.name = name
        self.url = url
        self.sha256 = sha256
        self.destination = destination
        self.expectedBytes = expectedBytes
    }
}

/// A model that is a directory of files — a Core ML `.mlmodelc` set — pinned file by file.
///
/// Every file is an ordinary `ModelEntry`, so each is downloaded, sha256-checked and atomically
/// installed by the same code path a single-file whisper model already uses. The entries'
/// `destination`s all live under `directory`, in upstream's own layout, because the loader
/// (FluidAudio's `AsrModels.loadLocal`) reads that layout and nothing else.
public struct ModelBundle: Sendable, Codable, Equatable {
    public var name: String
    /// Relative to the models root; the directory handed to the loader.
    public var directory: String
    /// The upstream commit every file URL is pinned to. Recorded in the verification stamp.
    public var revision: String
    public var files: [ModelEntry]

    public init(name: String, directory: String, revision: String, files: [ModelEntry]) {
        self.name = name
        self.directory = directory
        self.revision = revision
        self.files = files
    }

    public var totalBytes: Int { files.reduce(0) { $0 + ($1.expectedBytes ?? 0) } }

    static let stampName = ".kotiba-verified.json"

    struct Stamp: Codable, Equatable {
        var revision: String
        var files: [String: String]
    }

    var stamp: Stamp {
        Stamp(revision: revision,
              files: Dictionary(uniqueKeysWithValues: files.map { ($0.destination, $0.sha256) }))
    }
}

public enum ModelStoreError: Error, Sendable, Equatable {
    case directoryUnavailable(path: String, errno: String)
    case downloadFailed(name: String, reason: String)
    case checksumMismatch(name: String, expected: String, actual: String)
    case notInstalled(name: String)

    public var reason: String {
        switch self {
        case .directoryUnavailable(let path, let errno):
            return "cannot use \(path): \(errno)"
        case .downloadFailed(let name, let reason):
            return "\(name) failed to download: \(reason)"
        case .checksumMismatch(let name, let expected, let actual):
            return "\(name) arrived corrupt — expected sha256 \(expected.prefix(12))…, "
                + "got \(actual.prefix(12))…"
        case .notInstalled(let name):
            return "\(name) is not installed"
        }
    }
}

/// Bytes of one file on disk so far — including any resumed from an earlier attempt.
public typealias DownloadProgress = @Sendable (_ bytesOnDisk: Int64) -> Void

/// Injected so tests never touch the network.
public protocol ModelDownloader: Sendable {
    /// Returns the bytes.
    func fetch(_ url: URL) async throws -> Data

    /// Writes the bytes to `file` without holding them in memory. The default goes through
    /// `fetch`, which is fine for a test double and wrong for a 1.3 GB model — the real
    /// downloader streams to disk.
    func download(_ url: URL, to file: URL) async throws

    /// The same, continuing a `file` that already holds the first bytes of the body — an earlier
    /// attempt interrupted by a quit, a sleep or a dropped connection — and reporting progress
    /// as it goes. A downloader that cannot resume starts over, which is what the default does.
    func download(_ url: URL, to file: URL, resuming: Bool,
                  progress: DownloadProgress?) async throws
}

extension ModelDownloader {
    public func download(_ url: URL, to file: URL) async throws {
        try await fetch(url).write(to: file)
    }

    public func download(_ url: URL, to file: URL, resuming: Bool,
                         progress: DownloadProgress?) async throws {
        try await download(url, to: file)
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? Int
        progress?(Int64(size ?? 0))
    }
}

public struct URLSessionDownloader: ModelDownloader {
    public init() {}
    public func fetch(_ url: URL) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(from: url)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw ModelStoreError.downloadFailed(name: url.lastPathComponent,
                                                 reason: "HTTP \(http.statusCode)")
        }
        return data
    }

    /// Streamed straight into `file`, resumed with an HTTP range request when `file` already
    /// holds part of the body, with progress per chunk. Hugging Face (and its CDN) and GitHub
    /// release assets both answer ranges with 206; a server that answers 200 instead gets a
    /// clean restart rather than a spliced file — and the sha256 check after it would catch one
    /// anyway.
    public func download(_ url: URL, to file: URL, resuming: Bool,
                         progress: DownloadProgress?) async throws {
        try await ResumableTransfer(url: url, file: file, resuming: resuming,
                                    progress: progress).run()
    }

    /// Streamed to a temporary file by URLSession and moved into place. `fetch` held the whole
    /// body in memory, which for the 1.28 GB polish model is 1.28 GB of RSS in the app that is
    /// supposed to idle at 174 MB.
    public func download(_ url: URL, to file: URL) async throws {
        let (temporary, response) = try await URLSession.shared.download(from: url)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            try? FileManager.default.removeItem(at: temporary)
            throw ModelStoreError.downloadFailed(name: url.lastPathComponent,
                                                 reason: "HTTP \(http.statusCode)")
        }
        try? FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: temporary, to: file)
    }
}

/// Whether a file on disk is plausibly a whisper.cpp ggml model, without loading it.
///
/// The app's only check used to be `FileManager.fileExists`. A half-finished 200 MB download of a
/// 539 MB model, or the wrong `.bin` entirely, passed it: `uzbekReady` went true, the "No Uzbek
/// model" blocker disappeared, and the settings row showed a tick for a file nothing had ever
/// looked inside. The only feedback was whisper.cpp's own guess — "the file may be truncated or
/// not a ggml model" — arriving 7.8 s later, once per launch, forever.
///
/// This is deliberately cheap: four bytes and a stat, so it can sit in front of every readiness
/// question without costing anything. It is a plausibility check, not a verification — that is
/// what `sha256` and `ModelEntry` are for, and they only apply to models this app fetched itself.
public enum ModelFile {

    /// whisper.cpp writes `GGML_FILE_MAGIC` as the first four bytes, little-endian. Verified
    /// against every model this app actually loads: all four begin `6c 6d 67 67`.
    public static let ggmlMagic: UInt32 = 0x6767_6d6c

    /// Below this a file cannot be a usable speech model. The smallest one Kotiba ships with is
    /// the 59 MB detector, so 8 MB is far under any real model and far over any truncation that
    /// would otherwise pass unnoticed.
    public static let minimumBytes = 8 * 1024 * 1024

    public enum Verdict: Sendable, Equatable {
        case usable
        case missing
        case tooSmall(bytes: Int)
        case notGGML

        public var isUsable: Bool { self == .usable }

        /// What to tell the user, in the words they will see.
        public var reason: String? {
            switch self {
            case .usable: return nil
            case .missing: return "the file is not there any more"
            case .tooSmall(let bytes):
                return "the file is only \(bytes / 1_048_576) MB — it looks like a download that "
                    + "did not finish"
            case .notGGML:
                return "the file is not a whisper.cpp ggml model"
            }
        }
    }

    public static func inspect(_ path: String) -> Verdict {
        guard !path.isEmpty, FileManager.default.fileExists(atPath: path) else { return .missing }
        guard let handle = FileHandle(forReadingAtPath: path) else { return .missing }
        defer { try? handle.close() }

        let attributes = try? FileManager.default.attributesOfItem(atPath: path)
        let size = (attributes?[.size] as? Int) ?? 0
        guard size >= minimumBytes else { return .tooSmall(bytes: size) }

        guard let head = try? handle.read(upToCount: 4), head.count == 4 else { return .notGGML }
        let magic = head.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        return UInt32(littleEndian: magic) == ggmlMagic ? .usable : .notGGML
    }
}

public actor ModelStore {

    public let root: URL
    private let downloader: any ModelDownloader
    /// Every directory decision and every refusal, in order. This is what `diagnostics.json`
    /// carries so nobody has to guess which path won.
    public private(set) var notes: [String] = []

    public init(root: URL, downloader: any ModelDownloader = URLSessionDownloader()) {
        self.root = root
        self.downloader = downloader
    }

    /// Creates the models root, recording exactly what happened.
    ///
    /// `withIntermediateDirectories: true` is load-bearing on iOS: the installer does not
    /// create `Library/Application Support`, and creating a child of a directory that does not
    /// exist fails with NSFileWriteNoPermissionError — which reads like a permissions problem
    /// and is not one.
    @discardableResult
    public func prepareRoot() throws -> URL {
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            notes.append("models root ready at \(root.path)")
            return root
        } catch {
            let note = "models root REFUSED at \(root.path): \(error)"
            notes.append(note)
            throw ModelStoreError.directoryUnavailable(path: root.path, errno: "\(error)")
        }
    }

    public func location(of entry: ModelEntry) -> URL {
        root.appendingPathComponent(entry.destination)
    }

    public func isInstalled(_ entry: ModelEntry) -> Bool {
        FileManager.default.fileExists(atPath: location(of: entry).path)
    }

    /// Downloads in flight, by destination, so two callers asking for one file share one
    /// transfer instead of writing the same partial file from two places. (`ModelStore` is an
    /// actor, but actors are re-entrant across a download's `await`.)
    private var inFlight: [String: Task<URL, any Error>] = [:]

    /// Download if absent, verify, and return the local path. Idempotent: an already-correct
    /// file is not re-fetched, because weights survive re-signs and a 1.1 GB re-download on a
    /// hunch is not free.
    ///
    /// Resumable: the body goes to `<destination>.partial`, which outlives the process, so a
    /// download interrupted by a quit or a dropped connection continues where it stopped the next
    /// time anything asks for the file. Only a complete body whose sha256 matches is moved into
    /// place; one that does not match is deleted, partial and all.
    @discardableResult
    public func ensure(_ entry: ModelEntry, progress: DownloadProgress? = nil) async throws -> URL {
        if let running = inFlight[entry.destination] { return try await running.value }
        let task = Task { try await self.fetchAndVerify(entry, progress: progress) }
        inFlight[entry.destination] = task
        defer { inFlight[entry.destination] = nil }
        // A caller that is cancelled (the download step's Pause) stops the transfer; what has
        // arrived stays in the partial file for next time.
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func fetchAndVerify(_ entry: ModelEntry, progress: DownloadProgress?) async throws -> URL {
        try prepareRoot()
        let destination = location(of: entry)

        if FileManager.default.fileExists(atPath: destination.path) {
            if entry.sha256.isEmpty {
                notes.append("\(entry.name) present, no checksum to verify against")
                return destination
            }
            let actual = try Self.sha256(of: destination)
            if actual == entry.sha256.lowercased() {
                notes.append("\(entry.name) present and verified")
                progress?(Int64(entry.expectedBytes ?? 0))
                return destination
            }
            notes.append("\(entry.name) present but sha256 \(actual.prefix(12))… != "
                         + "\(entry.sha256.prefix(12))…, refetching")
            try? FileManager.default.removeItem(at: destination)
        }

        // Into a sibling partial file first, hashed from disk, then moved into place: a
        // half-written file that passes an existence check is worse than no file.
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        let partial = Self.partialLocation(of: destination)
        let resuming = FileManager.default.fileExists(atPath: partial.path)
        if resuming {
            let had = (try? FileManager.default.attributesOfItem(atPath: partial.path))?[.size]
                as? Int ?? 0
            notes.append("\(entry.name) resuming at \(had) bytes")
        }
        do {
            try await downloader.download(entry.url, to: partial, resuming: resuming,
                                          progress: progress)
        } catch let failure as ModelStoreError {
            // The partial file is kept: it is the resume point.
            notes.append("\(entry.name) download failed: \(failure.reason)")
            throw failure
        } catch is CancellationError {
            // Pause, not failure. Wrapped into `.downloadFailed` like any other error, it never
            // matched the download step's `catch is CancellationError`, and a paused row read
            // "failed — CancellationError()".
            notes.append("\(entry.name) paused")
            throw CancellationError()
        } catch {
            let failure = ModelStoreError.downloadFailed(name: entry.name, reason: "\(error)")
            notes.append(failure.reason)
            throw failure
        }

        let actual = try Self.sha256(of: partial)
        if !entry.sha256.isEmpty {
            guard actual == entry.sha256.lowercased() else {
                try? FileManager.default.removeItem(at: partial)
                notes.append("\(entry.name) arrived corrupt, discarded")
                throw ModelStoreError.checksumMismatch(name: entry.name,
                                                       expected: entry.sha256, actual: actual)
            }
        } else {
            notes.append("\(entry.name) has no expected sha256; it is \(actual)")
        }

        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: partial, to: destination)
        try excludeFromBackup(destination)
        let bytes = (try? destination.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        notes.append("\(entry.name) installed (\(bytes) bytes)")
        return destination
    }

    /// Where an interrupted download of `destination` waits to be resumed.
    static func partialLocation(of destination: URL) -> URL {
        destination.appendingPathExtension("partial")
    }

    // MARK: Bundles

    /// Where a bundle's files land: one directory, laid out exactly as upstream lays it out.
    public func location(of bundle: ModelBundle) -> URL {
        root.appendingPathComponent(bundle.directory, isDirectory: true)
    }

    /// Whether every file of `bundle` is on disk at its expected size. Cheap — a stat per file,
    /// no hashing — so it can answer "is this downloaded" for the settings pane.
    public func isInstalled(_ bundle: ModelBundle) -> Bool {
        bundle.files.allSatisfy { Self.hasExpectedSize(location(of: $0), $0.expectedBytes) }
    }

    /// Download whatever is missing, verify every file, and return the bundle's directory.
    ///
    /// A Core ML model is a directory of files, not one file, so it is fetched as its files —
    /// each through `ensure(_:)`, each pinned to one upstream commit and checked against its own
    /// sha256. There is no archive to unpack and nothing is trusted that was not hashed.
    ///
    /// Hashing 632 MB costs about a second on an M4 Pro, and `prepare()` runs this on every load
    /// — which, with idle-unload, is several times a day. So a fully verified bundle is stamped,
    /// and a later call that finds the stamp *and* every file at its recorded size returns
    /// without reading a byte. The stamp names the upstream revision, so a catalogue that moves
    /// to a new commit re-verifies (and re-fetches what changed) instead of trusting old files.
    @discardableResult
    public func ensure(_ bundle: ModelBundle, progress: DownloadProgress? = nil) async throws -> URL {
        try prepareRoot()
        let directory = location(of: bundle)
        let stamp = directory.appendingPathComponent(ModelBundle.stampName)

        if let data = try? Data(contentsOf: stamp),
           let recorded = try? JSONDecoder().decode(ModelBundle.Stamp.self, from: data),
           recorded == bundle.stamp, isInstalled(bundle) {
            notes.append("\(bundle.name) present, verified at \(bundle.revision.prefix(12))")
            return directory
        }

        // Anything short of a matching stamp re-verifies every file. A stale stamp is removed
        // first, so an interrupted run can never leave one that vouches for a half-done bundle.
        try? FileManager.default.removeItem(at: stamp)
        // Progress over the whole bundle: the files already done, plus the one in flight.
        let done = BundleProgress()
        for file in bundle.files {
            let before = done.total
            var fileProgress: DownloadProgress?
            if let progress {
                fileProgress = { @Sendable (bytes: Int64) in progress(before + bytes) }
            }
            try await ensure(file, progress: fileProgress)
            done.add(Int64(file.expectedBytes ?? 0))
            progress?(done.total)
        }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(bundle.stamp).write(to: stamp, options: .atomic)
        notes.append("\(bundle.name) verified: \(bundle.files.count) files, "
                     + "\(bundle.totalBytes / 1_000_000) MB")
        return directory
    }

    /// Bytes of a bundle's finished files, as a reference the progress closures can read.
    private final class BundleProgress: @unchecked Sendable {
        private let lock = NSLock()
        private var bytes: Int64 = 0
        var total: Int64 { lock.withLock { bytes } }
        func add(_ n: Int64) { lock.withLock { bytes += n } }
    }

    /// Delete a bundle's directory, stamp and all.
    public func remove(_ bundle: ModelBundle) throws {
        let directory = location(of: bundle)
        guard FileManager.default.fileExists(atPath: directory.path) else {
            throw ModelStoreError.notInstalled(name: bundle.name)
        }
        try FileManager.default.removeItem(at: directory)
        notes.append("\(bundle.name) removed")
    }

    private static func hasExpectedSize(_ url: URL, _ expected: Int?) -> Bool {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size]
                as? Int else { return false }
        return expected.map { $0 == size } ?? true
    }

    /// Multi-gigabyte weights must not be uploaded to iCloud on every backup — they are
    /// re-downloadable. Note this is applied to *models* only; the enrollment audio is not
    /// re-downloadable and is deliberately left backed up.
    private func excludeFromBackup(_ url: URL) throws {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = url
        try? mutable.setResourceValues(values)
    }

    public func remove(_ entry: ModelEntry) throws {
        let destination = location(of: entry)
        guard FileManager.default.fileExists(atPath: destination.path) else {
            throw ModelStoreError.notInstalled(name: entry.name)
        }
        try FileManager.default.removeItem(at: destination)
        notes.append("\(entry.name) removed")
    }

    public func installedBytes() -> Int {
        guard let walker = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total = 0
        for case let url as URL in walker {
            // The `as? Int` this used to carry was redundant, not wrong — `?? 0` already handled
            // the nil — but it warned on every build, and a warning nobody can act on is how a
            // real one gets missed.
            total += (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        }
        return total
    }

    // MARK: Hashing

    static func sha256(of data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Streams the file so a 1.1 GB model is not read into memory to be hashed.
    static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

// `"\(error)"` is this codebase's interchange format at the module boundaries — 23 sites convert
// that way — and for an `Error` enum without `CustomStringConvertible` it reflects the case name
// instead of the diagnosis. A denied microphone reached the user as
// `engineFailedToStart("permissionDenied")`, which appears verbatim in real diagnostics. Each of
// these types already writes the actionable sentence in `reason`; this is what makes the
// interchange format use it, with no call-site changes.

extension ModelStoreError: CustomStringConvertible {
    public var description: String { reason }
}

// MARK: - The transfer

/// One HTTP GET streamed into a file, continued from the file's current length with a range
/// request. A delegate-based data task rather than `URLSession.download(from:)` because only the
/// data task hands over the body as it arrives — which is what both resuming (the bytes land in
/// *our* file, which survives the process) and progress (a count per chunk) need.
final class ResumableTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let url: URL
    private let file: URL
    private let resuming: Bool
    private let progress: DownloadProgress?
    private let lock = NSLock()
    private var handle: FileHandle?
    private var written: Int64 = 0
    private var failure: (any Error)?
    private var continuation: CheckedContinuation<Void, any Error>?

    init(url: URL, file: URL, resuming: Bool, progress: DownloadProgress?) {
        self.url = url
        self.file = file
        self.resuming = resuming
        self.progress = progress
    }

    func run() async throws {
        let existing = resuming
            ? Int64((try? FileManager.default.attributesOfItem(atPath: file.path))?[.size]
                    as? Int ?? 0)
            : 0
        if !resuming { try? FileManager.default.removeItem(at: file) }
        if !FileManager.default.fileExists(atPath: file.path) {
            FileManager.default.createFile(atPath: file.path, contents: nil)
        }
        var request = URLRequest(url: url)
        if existing > 0 { request.setValue("bytes=\(existing)-", forHTTPHeaderField: "Range") }
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let task = session.dataTask(with: request)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.withLock { self.continuation = continuation }
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 200
        do {
            let handle = try FileHandle(forWritingTo: file)
            switch status {
            case 206:
                // The server is continuing where the file stops.
                written = try handle.seekToEnd().asInt64
            case 200..<300:
                // A whole body: whatever was on disk is not a prefix of it any more.
                try handle.truncate(atOffset: 0)
                written = 0
            case 416:
                // The file already holds the whole body; the checksum decides.
                written = try handle.seekToEnd().asInt64
                lock.withLock { self.handle = handle }
                completionHandler(.cancel)
                finish(nil)
                return
            default:
                try? handle.close()
                completionHandler(.cancel)
                finish(ModelStoreError.downloadFailed(name: url.lastPathComponent,
                                                      reason: "HTTP \(status)"))
                return
            }
            lock.withLock { self.handle = handle }
            progress?(written)
            completionHandler(.allow)
        } catch {
            completionHandler(.cancel)
            finish(error)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let total: Int64? = lock.withLock {
            guard let handle, failure == nil else { return nil }
            do {
                try handle.write(contentsOf: data)
                written += Int64(data.count)
                return written
            } catch {
                failure = error
                dataTask.cancel()
                return nil
            }
        }
        if let total { progress?(total) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didCompleteWithError error: (any Error)?) {
        finish(error)
    }

    private func finish(_ error: (any Error)?) {
        let (continuation, failure): (CheckedContinuation<Void, any Error>?, (any Error)?) =
            lock.withLock {
                try? handle?.close()
                handle = nil
                defer { self.continuation = nil }
                return (self.continuation, self.failure ?? error)
            }
        guard let continuation else { return }
        if let failure {
            // Our own cancel (the caller's task was cancelled) reads as a cancellation, not as
            // a network failure worth a note.
            let cancelled = (failure as? URLError)?.code == .cancelled
            continuation.resume(throwing: cancelled ? CancellationError() : failure)
        } else {
            continuation.resume()
        }
    }
}

private extension UInt64 {
    var asInt64: Int64 { Int64(clamping: self) }
}

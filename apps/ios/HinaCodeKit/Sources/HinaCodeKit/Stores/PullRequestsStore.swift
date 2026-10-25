import Observation

/// Pull request links per thread, and what GitHub says about each linked pull request, read through the desktop.
///
/// `github.*` and `pullRequestGuides.*` run on the server the caller names, so pass the server of the thread the pull
/// request belongs to.
@MainActor
@Observable
public final class PullRequestsStore {
    /// What a thread row needs to color its pull request number.
    public struct Summary: Equatable, Sendable {
        public let status: PullRequestStatus
        public let checks: ChecksStatus?
        public let review: ReviewStatus?

        public init(status: PullRequestStatus, checks: ChecksStatus?, review: ReviewStatus?) {
            self.status = status
            self.checks = checks
            self.review = review
        }
    }

    public enum CodeView: Sendable {
        case files, guide
    }

    /// Every `github.*` read runs `gh` on the desktop, so a pull request is read at most this often.
    public static let summaryMaxAge: Duration = .seconds(60)
    public static let detailMaxAge: Duration = .seconds(30)

    /// Links per thread, oldest first, so the newest is last. A thread is absent until its links have loaded.
    public private(set) var linksByThread: [String: [PullRequestLink]] = [:]
    public private(set) var summaries: [String: RemoteValue<Summary>] = [:]
    public private(set) var pullRequests: [String: RemoteValue<PullRequest>] = [:]
    public private(set) var details: [String: RemoteValue<PullRequestDetail>] = [:]
    /// Guide state per pull request, kept current by `pullRequest.guide` pushes once read.
    public private(set) var guides: [String: RemoteValue<PullRequestGuideState>] = [:]
    /// Whether the Code tab lists files or the guide, kept while the app runs.
    public var codeView: CodeView = .files
    /// Changed files per pull request head, see `files(url:head:)`.
    private var filesByHead: [String: RemoteValue<[PullRequestFile]>] = [:]

    @ObservationIgnored private let caller: any Caller
    @ObservationIgnored private let timers: any Timers
    @ObservationIgnored private var lastLoad = 0
    @ObservationIgnored private var currentLoad: Int?
    @ObservationIgnored private var threadsPushedDuringLoad: Set<String> = []
    /// Bumped by every list a thread receives, so a slower read cannot replace a newer push.
    @ObservationIgnored private var versions: [String: Int] = [:]
    @ObservationIgnored private var lastRead = 0
    @ObservationIgnored private var pullRequestReads: [String: Read] = [:]
    @ObservationIgnored private var detailReads: [String: Read] = [:]
    @ObservationIgnored private var fileReads: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var guideReads: [String: Task<Void, Never>] = [:]

    public init(caller: any Caller, timers: any Timers) {
        self.caller = caller
        self.timers = timers
    }

    /// Reads every thread's links again on each handshake, since pushes were missed while offline. A failure keeps
    /// the links already shown; the PRs tab loads and reports its own thread.
    public func load() async {
        lastLoad += 1
        let load = lastLoad
        currentLoad = load
        threadsPushedDuringLoad = []
        defer { if currentLoad == load { currentLoad = nil } }

        guard let links = try? await caller.call(RPC.pullRequestsAll), currentLoad == load else { return }
        var grouped = Dictionary(grouping: links, by: \.threadId)
        for threadId in threadsPushedDuringLoad {
            if let pushed = linksByThread[threadId] { grouped[threadId] = pushed }
        }
        linksByThread = grouped
        summaries.merge(snapshotSummaries(links)) { _, snapshot in snapshot }
    }

    /// Reads one thread's links. Throws, so the PRs tab can show why.
    public func loadThread(_ threadId: String) async throws {
        let version = versions[threadId]
        let links = try await caller.call(RPC.pullRequestsList, PullRequestsListRequest(threadId: threadId))
        if versions[threadId] == version { replace(threadId: threadId, links: links) }
    }

    /// A `thread.pullRequests` push: the thread's whole list.
    public func replace(threadId: String, links: [PullRequestLink]) {
        versions[threadId, default: 0] += 1
        if currentLoad != nil { threadsPushedDuringLoad.insert(threadId) }
        linksByThread[threadId] = links
        summaries.merge(snapshotSummaries(links)) { _, snapshot in snapshot }
    }

    /// Keeps a guide current through the `pullRequest.guide` push, and ignores any other push.
    public func receive(_ push: PushEvent) {
        guard case .pullRequestGuide(let update) = push else { return }
        guides[update.url] = .ready(update.state, at: timers.now)
    }

    /// Reads the state of a pull request for a badge, unless a watch snapshot or a recent read already has it.
    public func ensureSummary(_ url: String, server: String?) {
        let watched = linksByThread.values.contains { links in
            links.contains { $0.url == url && $0.watch?.snapshot != nil }
        }
        if watched || isFresh(summaries[url], maxAge: Self.summaryMaxAge) { return }
        readPullRequest(url, server: server, force: false)
    }

    /// Reads a pull request unless a read is in flight or the last one is under a minute old. `force` starts a new
    /// read that supersedes the one in flight.
    public func loadPullRequest(_ url: String, server: String?, force: Bool = false) async {
        await readPullRequest(url, server: server, force: force)?.value
    }

    /// Like `loadPullRequest`, for the detail screen, which may be 30 seconds old.
    public func loadDetail(_ url: String, server: String?, force: Bool = false) async {
        await read(into: \.details, reads: \.detailReads, url: url, maxAge: Self.detailMaxAge, force: force) {
            Summary(status: $0.status, checks: $0.checks, review: $0.review)
        } read: { [caller] in
            try await caller.call(RPC.githubPullRequestDetail, .init(url: url), server: server)
        }?.value
    }

    /// The changed files at a pull request's head. A push changes the head, so it reads anew.
    public func files(url: String, head: String) -> RemoteValue<[PullRequestFile]>? {
        filesByHead[Self.filesKey(url, head)]
    }

    /// Reads the changed files at `head` once, unless forced. A failure keeps files already shown.
    public func loadFiles(_ url: String, head: String, server: String?, force: Bool = false) async {
        let key = Self.filesKey(url, head)
        await readCode(into: \.filesByHead, reads: \.fileReads, key: key, force: force) { [caller] in
            try await caller.call(RPC.githubPullRequestFiles, .init(url: url), server: server)
        }
    }

    /// Reads the guide once, unless forced; `receive` keeps it current after that. A failure keeps a guide already
    /// shown.
    public func loadGuide(_ url: String, server: String?, force: Bool = false) async {
        await readCode(into: \.guides, reads: \.guideReads, key: url, force: force) { [caller] in
            try await caller.call(RPC.pullRequestGuidesGet, .init(url: url), server: server)
        }
    }

    /// The pull request number in a GitHub pull request URL, so a link can show `#123` before GitHub answers.
    public nonisolated static func pullRequestNumber(_ url: String) -> String? {
        (url.firstMatch(of: /\/pull\/(\d+)/.asciiOnlyDigits())?.1).map(String.init)
    }

    private static func filesKey(_ url: String, _ head: String) -> String {
        "\(url)@\(head)"
    }

    private func isFresh<Value>(_ entry: RemoteValue<Value>?, maxAge: Duration) -> Bool {
        entry?.isFresh(now: timers.now, maxAge: maxAge) ?? false
    }

    /// A watched link's last snapshot is a summary the desktop already read, so it costs no `gh` call.
    private func snapshotSummaries(_ links: [PullRequestLink]) -> [String: RemoteValue<Summary>] {
        var summaries: [String: RemoteValue<Summary>] = [:]
        for link in links {
            guard let snapshot = link.watch?.snapshot else { continue }
            let summary = Summary(status: snapshot.status, checks: snapshot.checks, review: snapshot.review)
            summaries[link.url] = .ready(summary, at: timers.now)
        }
        return summaries
    }

    private func writeSummary(_ url: String, _ summary: RemoteValue<Summary>) {
        // A failed read does not hide a summary that a snapshot or an earlier read gave.
        if summary.value == nil, summaries[url]?.value != nil { return }
        summaries[url] = summary
    }

    @discardableResult
    private func readPullRequest(_ url: String, server: String?, force: Bool) -> Task<Void, Never>? {
        read(into: \.pullRequests, reads: \.pullRequestReads, url: url, maxAge: Self.summaryMaxAge, force: force) {
            Summary(status: $0.status, checks: $0.checks, review: $0.review)
        } read: { [caller] in
            try await caller.call(RPC.githubPullRequest, .init(url: url), server: server)
        }
    }

    /// Reads `url` into `slot` and its summary, and returns the read. Unless forced, it returns the read in flight
    /// instead, or nil while `slot` is fresh. The previous value stays while it reads; a forced read supersedes the
    /// one in flight.
    private func read<Value: Sendable>(
        into slot: ReferenceWritableKeyPath<PullRequestsStore, [String: RemoteValue<Value>]>,
        reads: ReferenceWritableKeyPath<PullRequestsStore, [String: Read]>,
        url: String,
        maxAge: Duration,
        force: Bool,
        summary: @escaping (Value) -> Summary,
        read: @escaping @MainActor () async throws -> Value
    ) -> Task<Void, Never>? {
        if !force {
            if let pending = self[keyPath: reads][url] { return pending.task }
            if isFresh(self[keyPath: slot][url], maxAge: maxAge) { return nil }
        }
        if self[keyPath: slot][url] == nil { self[keyPath: slot][url] = .loading }
        if summaries[url] == nil { writeSummary(url, .loading) }
        lastRead += 1
        let id = lastRead
        let task = Task {
            let result: RemoteValue<Value>
            do {
                let value = try await read()
                result = .ready(value, at: timers.now)
            } catch {
                result = .failure(error, at: timers.now)
            }
            guard self[keyPath: reads][url]?.id == id else { return }
            self[keyPath: reads][url] = nil
            self[keyPath: slot][url] = result
            writeSummary(url, result.map(summary))
        }
        self[keyPath: reads][url] = Read(id: id, task: task)
        return task
    }

    /// Reads one entry of `filesByHead` or `guides` once at a time. A failure keeps a value already shown.
    private func readCode<Value: Sendable>(
        into slot: ReferenceWritableKeyPath<PullRequestsStore, [String: RemoteValue<Value>]>,
        reads: ReferenceWritableKeyPath<PullRequestsStore, [String: Task<Void, Never>]>,
        key: String,
        force: Bool,
        read: @escaping @MainActor () async throws -> Value
    ) async {
        if let pending = self[keyPath: reads][key] { return await pending.value }
        let current = self[keyPath: slot][key]
        if !force, case .ready = current { return }
        if current == nil { self[keyPath: slot][key] = .loading }
        let task = Task {
            do {
                let value = try await read()
                self[keyPath: slot][key] = .ready(value, at: timers.now)
            } catch {
                if self[keyPath: slot][key]?.value == nil { self[keyPath: slot][key] = .failure(error, at: timers.now) }
            }
            self[keyPath: reads][key] = nil
        }
        self[keyPath: reads][key] = task
        await task.value
    }

    private struct Read {
        let id: Int
        let task: Task<Void, Never>
    }
}

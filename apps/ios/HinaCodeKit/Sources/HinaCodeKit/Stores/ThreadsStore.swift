import Observation

/// Projects, worktrees and threads, read on every handshake and kept current by pushes.
@MainActor
@Observable
public final class ThreadsStore {
    public enum Status: Equatable, Sendable {
        case loading
        case ready
        /// The last load failed. What an earlier load read stays on screen.
        case error(String)
    }

    /// The branch a thread works on. A removed worktree's branch is still named, marked removed, since the thread
    /// now works in the project root.
    public struct Branch: Equatable, Sendable {
        public let name: String
        public let removed: Bool

        public init(name: String, removed: Bool) {
            self.name = name
            self.removed = removed
        }
    }

    public private(set) var projects: [Project] = []
    public private(set) var worktrees: [String: Worktree] = [:]
    /// The branch checked out in each project's root, by project id, once read.
    public private(set) var branches: [String: String] = [:]
    public private(set) var threads: [String: AgentThread] = [:]
    public private(set) var status: Status = .loading

    @ObservationIgnored private let caller: any Caller
    @ObservationIgnored private var lastLoad = 0
    /// The load in flight, if any. Pushes are recorded while it reads, to merge over its answer.
    @ObservationIgnored private var currentLoad: Int?
    @ObservationIgnored private var threadsPushedDuringLoad: [String: PushedThread] = [:]
    @ObservationIgnored private var worktreesPushedDuringLoad: [String: Worktree] = [:]

    public init(caller: any Caller) {
        self.caller = caller
    }

    /// Reads projects, worktrees and threads again, since pushes were missed while offline. A thread pushed while the
    /// read was in flight keeps whichever copy is newer. A load answered after a newer one started is ignored.
    public func load() async {
        lastLoad += 1
        let load = lastLoad
        currentLoad = load
        threadsPushedDuringLoad = [:]
        worktreesPushedDuringLoad = [:]
        defer { if currentLoad == load { currentLoad = nil } }

        let projectsRead = Task.immediate { try await self.caller.call(RPC.projectsList) }
        let worktreesRead = Task.immediate { try await self.caller.call(RPC.worktreesList) }
        let threadsRead = Task.immediate { try await self.caller.call(RPC.threadsList) }
        do {
            let (projects, worktrees, threads) = try await (projectsRead.value, worktreesRead.value, threadsRead.value)
            guard currentLoad == load else { return }
            var byId = Dictionary(threads.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
            for (id, pushed) in threadsPushedDuringLoad {
                switch pushed {
                case .removed:
                    byId[id] = nil
                case .updated(let thread):
                    if let listed = byId[id], listed.updatedAt > thread.updatedAt { continue }
                    byId[id] = thread
                }
            }
            self.projects = projects
            self.worktrees = Dictionary(worktrees.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
                .merging(worktreesPushedDuringLoad) { _, pushed in pushed }
            self.threads = byId
            status = .ready
            for project in projects { readBranch(project.id) }
        } catch {
            if currentLoad == load { status = .error(error.localizedDescription) }
        }
    }

    /// A `thread.updated` push.
    public func upsert(_ thread: AgentThread) {
        let previous = threads[thread.id]
        if currentLoad != nil { threadsPushedDuringLoad[thread.id] = .updated(thread) }
        threads[thread.id] = thread
        // A turn in the project root may have switched its branch.
        if let previous, Self.isBusy(previous.status), !Self.isBusy(thread.status), thread.worktreeId == nil {
            readBranch(thread.projectId)
        }
        // The desktop pushes no project changes, so a thread from an unknown project means one was added there.
        if currentLoad == nil, status == .ready, !projects.contains(where: { $0.id == thread.projectId }) {
            Task.immediate { await self.load() }
        }
    }

    /// A `thread.removed` push.
    public func remove(id: String) {
        if currentLoad != nil { threadsPushedDuringLoad[id] = .removed }
        threads[id] = nil
    }

    /// A `worktree.updated` push.
    public func upsertWorktree(_ worktree: Worktree) {
        if currentLoad != nil { worktreesPushedDuringLoad[worktree.id] = worktree }
        worktrees[worktree.id] = worktree
    }

    /// The desktop pushes no project changes, so a project this phone added is put in place here.
    public func addProject(_ project: Project) {
        projects.removeAll { $0.id == project.id }
        projects.append(project)
    }

    /// The folder `thread` works in, or nil until its worktree has loaded. See `threadRoot(_:projects:worktrees:)`.
    public func root(of thread: AgentThread) -> String? {
        Self.threadRoot(thread, projects: projects, worktrees: worktrees)
    }

    /// The branch `thread` works on, or nil before it is read. See `threadBranch(worktree:rootBranch:)`.
    public func branch(of thread: AgentThread) -> Branch? {
        Self.threadBranch(worktree: thread.worktreeId.flatMap { worktrees[$0] }, rootBranch: branches[thread.projectId])
    }

    private func readBranch(_ projectId: String) {
        Task.immediate {
            // A folder that is not a git repository has no branch to show.
            guard let branch = try? await caller.call(RPC.projectsCurrentBranch, .init(id: projectId)) else { return }
            branches[projectId] = branch
        }
    }

    private static func isBusy(_ status: ThreadStatus) -> Bool {
        status == .running || status == .awaitingApproval
    }

    private enum PushedThread {
        case updated(AgentThread)
        case removed
    }
}

nonisolated extension ThreadsStore {
    /// A project's threads in the order the developer arranged them in the desktop sidebar.
    public static func sortThreads(_ threads: some Sequence<AgentThread>) -> [AgentThread] {
        threads.sorted { $0.sortIndex < $1.sortIndex }
    }

    /// Pinned threads, in the order they were pinned.
    public static func pinnedThreads(_ threads: some Sequence<AgentThread>) -> [AgentThread] {
        threads
            .filter { $0.pinnedAt != nil && $0.status != .archived }
            .sorted { ($0.pinnedAt ?? "") < ($1.pinnedAt ?? "") }
    }

    /// Every active thread that is not pinned, newest activity first, as on the desktop. A thread that starts waiting
    /// for the developer is updated then, so it rises to the top on its own.
    public static func inboxThreads(_ threads: some Sequence<AgentThread>) -> [AgentThread] {
        threads.filter { $0.pinnedAt == nil && $0.status != .archived }.sorted(by: newestFirst)
    }

    public static func archivedThreads(_ threads: some Sequence<AgentThread>) -> [AgentThread] {
        threads.filter { $0.status == .archived }.sorted(by: newestFirst)
    }

    /// Threads whose title or project name contains every word of `query`, ignoring case. Archived threads last.
    public static func matchThreads(_ threads: some Sequence<AgentThread>, projects: [Project], query: String)
        -> [AgentThread]
    {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        if words.isEmpty { return [] }
        let projectNames = Dictionary(projects.map { ($0.id, $0.name.lowercased()) }, uniquingKeysWith: { $1 })
        return
            threads
            .filter { thread in
                let haystack = "\(thread.title.lowercased()) \(projectNames[thread.projectId] ?? "")"
                return words.allSatisfy { haystack.contains($0) }
            }
            .sorted { a, b in
                let aArchived = a.status == .archived
                let bArchived = b.status == .archived
                return aArchived == bArchived ? newestFirst(a, b) : bArchived
            }
    }

    /// The folder a thread works in: its worktree while that exists, else the project root. `fs.*` and `fs.preview`
    /// accept only these roots. Nil until the thread's worktree has loaded.
    public static func threadRoot(_ thread: AgentThread, projects: [Project], worktrees: [String: Worktree])
        -> String?
    {
        let project = projects.first { $0.id == thread.projectId }
        guard let worktreeId = thread.worktreeId else { return project?.rootPath }
        guard let worktree = worktrees[worktreeId] else { return nil }
        return worktree.status == .removed ? project?.rootPath : worktree.path
    }

    /// The branch a thread works on: its worktree's, or the one checked out in the project root.
    public static func threadBranch(worktree: Worktree?, rootBranch: String?) -> Branch? {
        let name = worktree?.branch ?? rootBranch ?? ""
        return name.isEmpty ? nil : Branch(name: name, removed: worktree?.status == .removed)
    }

    private static func newestFirst(_ a: AgentThread, _ b: AgentThread) -> Bool {
        a.updatedAt > b.updatedAt
    }
}

import HinaCodeKit
import Testing

private let early = "2026-10-16T00:00:00.000Z"
private let late = "2026-10-16T00:01:00.000Z"

private func thread(
    _ id: String, _ updatedAt: String = early, _ title: String? = nil, projectId: String = "p",
    worktreeId: String? = nil, status: ThreadStatus = .idle, pinnedAt: String? = nil
) -> AgentThread {
    AgentThread(
        id: id, projectId: projectId, worktreeId: worktreeId, title: title ?? id, provider: .claude, model: "opus",
        fastMode: false, userSkills: false, accessMode: .supervised, status: status, sortIndex: 0, pinnedAt: pinnedAt,
        queue: [], createdBy: "user", createdAt: early, updatedAt: updatedAt)
}

private func project(_ id: String, name: String? = nil, rootPath: String = "/repo") -> Project {
    Project(
        id: id, name: name ?? id, rootPath: rootPath, createdAt: early, updatedAt: early, linearReview: false,
        kind: .folder)
}

private func worktree(_ id: String, path: String = "/repo-w", branch: String = "kk/fix", status: WorktreeStatus)
    -> Worktree
{
    Worktree(
        id: id, projectId: "p", path: path, branch: branch, baseRef: "main", status: status, setupLog: "",
        createdAt: early)
}

private func ids(_ threads: [AgentThread]) -> [String] {
    threads.map(\.id)
}

@MainActor
@Suite("ThreadsStore")
struct ThreadsStoreTests {
    let caller = FakeCaller()
    let store: ThreadsStore

    init() {
        store = ThreadsStore(caller: caller)
    }

    private var titles: [String: String] { store.threads.mapValues(\.title) }

    @discardableResult
    private func load() -> Task<Void, Never> {
        let store = store
        return Task.immediate { await store.load() }
    }

    private func answer(_ threads: [AgentThread]) {
        caller.requests("projects.list")[0].resolve([Project]())
        caller.requests("worktrees.list")[0].resolve([Worktree]())
        caller.requests("threads.list")[0].resolve(threads)
        caller.calls.removeAll()
    }

    @Test("keeps a thread pushed during the load when it is newer than the listed copy")
    func newerPushWins() async {
        let loading = load()
        store.upsert(thread("a", late, "pushed"))
        answer([thread("a", early, "listed"), thread("b", early)])
        await loading.value
        #expect(titles == ["a": "pushed", "b": "b"])
        #expect(store.status == .ready)
    }

    @Test("keeps the listed copy when it is newer than the push")
    func newerListWins() async {
        let loading = load()
        store.upsert(thread("a", early, "pushed"))
        answer([thread("a", late, "listed")])
        await loading.value
        #expect(titles == ["a": "listed"])
    }

    @Test("keeps a thread created during the load that the list predates")
    func createdDuringLoad() async {
        let loading = load()
        store.upsert(thread("new", late))
        answer([thread("a", early)])
        await loading.value
        #expect(titles == ["a": "a", "new": "new"])
    }

    @Test("does not bring back a thread removed during the load")
    func removedDuringLoad() async {
        let loading = load()
        store.remove(id: "gone")
        answer([thread("a", early), thread("gone", early)])
        await loading.value
        #expect(titles == ["a": "a"])
    }

    @Test("forgets pushes once the load settles")
    func forgetsPushes() async {
        let first = load()
        store.remove(id: "a")
        answer([])
        await first.value

        let second = load()
        answer([thread("a", early)])
        await second.value
        #expect(titles == ["a": "a"])
    }

    @Test("ignores a load answered after a newer one started")
    func ignoresOlderLoad() async {
        load()
        let older = caller.calls
        caller.calls.removeAll()
        let newer = load()
        answer([thread("a", late, "newer")])
        await newer.value

        older.first { $0.method == "projects.list" }?.resolve([Project]())
        older.first { $0.method == "worktrees.list" }?.resolve([Worktree]())
        older.first { $0.method == "threads.list" }?.resolve([thread("a", early, "older")])
        await caller.flush()
        #expect(titles == ["a": "newer"])
    }

    @Test("keeps the threads on screen when a reload fails")
    func reloadFailure() async {
        let first = load()
        answer([thread("a", early)])
        await first.value

        let failing = load()
        caller.requests("projects.list")[0].resolve([Project]())
        caller.requests("worktrees.list")[0].resolve([Worktree]())
        caller.requests("threads.list")[0].reject(RpcError("Timeout", "Timeout"))
        await failing.value
        #expect(titles == ["a": "a"])
        #expect(store.status == .error("Timeout"))
    }

    @Test("reads everything again when a thread arrives from a project the phone does not know")
    func unknownProjectReloads() async {
        let first = load()
        answer([thread("a", early)])
        await first.value

        store.upsert(thread("b", late, projectId: "added-on-desktop"))
        #expect(caller.calls.map(\.method) == ["projects.list", "worktrees.list", "threads.list"])
    }

    @Test("keeps a worktree pushed while the worktrees are read")
    func worktreePushedDuringLoad() async {
        let loading = load()
        store.upsertWorktree(worktree("w", status: .ready))
        answer([thread("a", early)])
        await loading.value
        #expect(store.worktrees["w"]?.path == "/repo-w")
    }

    @Test("reads a project root's branch again when one of its threads finishes a turn")
    func rereadsBranchAfterTurn() async {
        let first = load()
        caller.requests("projects.list")[0].resolve([project("p")])
        caller.requests("worktrees.list")[0].resolve([Worktree]())
        caller.requests("threads.list")[0].resolve([thread("a", early, status: .running)])
        await first.value
        caller.requests("projects.currentBranch")[0].resolve("main")
        caller.calls.removeAll()
        await caller.flush()

        store.upsert(thread("a", late, status: .idle))
        caller.requests("projects.currentBranch")[0].resolve("kk/switched")
        await caller.flush()
        #expect(store.branches["p"] == "kk/switched")
    }
}

@Suite("ThreadsStore lists")
struct ThreadsStoreListTests {
    private func at(_ minute: Int) -> String {
        "2026-10-16T00:\(minute < 10 ? "0" : "")\(minute):00.000Z"
    }

    @Test("lists the inbox by latest activity, without pinned or archived threads")
    func inbox() {
        let threads = [
            thread("old", at(1)),
            thread("new", at(5)),
            thread("waiting", at(0), status: .awaitingApproval),
            thread("pinned", at(9), pinnedAt: at(2)),
            thread("archived", at(9), status: .archived),
        ]
        #expect(ids(ThreadsStore.inboxThreads(threads)) == ["new", "old", "waiting"])
        #expect(ids(ThreadsStore.pinnedThreads(threads)) == ["pinned"])
        #expect(ids(ThreadsStore.archivedThreads(threads)) == ["archived"])
    }

    @Test("keeps pins in the order they were pinned")
    func pinOrder() {
        let threads = [thread("second", pinnedAt: at(3)), thread("first", pinnedAt: at(1))]
        #expect(ids(ThreadsStore.pinnedThreads(threads)) == ["first", "second"])
    }

    @Test("matches every word against the title and the project name, archived threads last")
    func match() {
        let projects = [project("p", name: "Hinacode"), project("q", name: "site")]
        let threads = [
            thread("a", at(1), "Fix login test"),
            thread("b", at(2), "Login page copy", projectId: "q"),
            thread("c", at(9), "Old login work", status: .archived),
        ]
        #expect(ids(ThreadsStore.matchThreads(threads, projects: projects, query: "LOGIN")) == ["b", "a", "c"])
        #expect(ids(ThreadsStore.matchThreads(threads, projects: projects, query: "login hina")) == ["a", "c"])
        #expect(ThreadsStore.matchThreads(threads, projects: projects, query: "  ").isEmpty)
    }
}

@Suite("threadRoot")
struct ThreadsStoreRootTests {
    let projects = [project("p")]

    private func inProject(_ worktreeId: String?) -> AgentThread {
        thread("t", worktreeId: worktreeId)
    }

    private func worktrees(_ status: WorktreeStatus) -> [String: Worktree] {
        ["w": worktree("w", status: status)]
    }

    @Test("is the project root without a worktree")
    func projectRoot() {
        #expect(ThreadsStore.threadRoot(inProject(nil), projects: projects, worktrees: [:]) == "/repo")
    }

    @Test("is the worktree while it exists, and the project root once it is removed")
    func worktreeRoot() {
        #expect(ThreadsStore.threadRoot(inProject("w"), projects: projects, worktrees: worktrees(.ready)) == "/repo-w")
        #expect(ThreadsStore.threadRoot(inProject("w"), projects: projects, worktrees: worktrees(.removed)) == "/repo")
    }

    @Test("is unknown until the worktree has loaded")
    func unknownRoot() {
        #expect(ThreadsStore.threadRoot(inProject("w"), projects: projects, worktrees: [:]) == nil)
    }
}

@Suite("threadBranch")
struct ThreadsStoreBranchTests {
    @Test("names the worktree's branch, marked once the worktree is removed")
    func worktreeBranch() {
        #expect(
            ThreadsStore.threadBranch(worktree: worktree("w", status: .ready), rootBranch: "main")
                == ThreadsStore.Branch(name: "kk/fix", removed: false))
        #expect(
            ThreadsStore.threadBranch(worktree: worktree("w", status: .removed), rootBranch: "main")
                == ThreadsStore.Branch(name: "kk/fix", removed: true))
    }

    @Test("names the project root's branch for a thread without a worktree")
    func rootBranch() {
        #expect(
            ThreadsStore.threadBranch(worktree: nil, rootBranch: "main")
                == ThreadsStore.Branch(name: "main", removed: false))
    }

    @Test("names nothing before the branch is read, or for a folder without git")
    func noBranch() {
        #expect(ThreadsStore.threadBranch(worktree: nil, rootBranch: nil) == nil)
        #expect(ThreadsStore.threadBranch(worktree: nil, rootBranch: "") == nil)
    }
}

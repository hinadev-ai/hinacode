import HinaCodeKit
import Testing

private let urlA = "https://github.com/acme/app/pull/1"
private let urlB = "https://github.com/acme/app/pull/2"

private func link(_ id: String, _ threadId: String, _ url: String, watched: Bool = false) -> PullRequestLink {
    let snapshot = PullRequestWatchSnapshot(
        status: .open, checks: .failing, review: nil, mergeable: .mergeable, head: "abc", failingChecks: [])
    return PullRequestLink(
        id: id, threadId: threadId, url: url, createdAt: "2026-10-16T00:00:00.000Z",
        watch: watched ? PullRequestWatch(generation: "g", events: [], snapshot: snapshot, wakes: 0, failures: 0) : nil)
}

private func pullRequest(_ url: String, checks: ChecksStatus = .passing) -> PullRequest {
    PullRequest(
        url: url, number: 1, title: "Fix", status: .open, checks: checks, review: .approved, author: "kk",
        headRefName: "kk/fix", baseRefName: "main", additions: 1, deletions: 1)
}

private func detail(_ url: String, status: PullRequestStatus = .open) -> PullRequestDetail {
    PullRequestDetail(
        url: url, number: 1, title: "Fix", status: status, checks: .passing, review: .approved, author: "kk",
        headRefName: "kk/fix", baseRefName: "main", additions: 1, deletions: 1, body: "", baseRef: "main",
        headRef: "kk/fix", head: "abc", mergeable: .mergeable, checkRuns: [])
}

@MainActor
@Suite("PullRequestsStore")
struct PullRequestsStoreTests {
    let caller = FakeCaller()
    let timers = ManualTimers()
    let store: PullRequestsStore

    init() {
        store = PullRequestsStore(caller: caller, timers: timers)
    }

    private func setTime(_ time: Duration) {
        timers.advance(by: time - timers.now)
    }

    private func answer(_ method: String, _ value: any Sendable) async {
        await caller.flush()
        for pending in caller.requests(method) { pending.resolve(value) }
        caller.calls.removeAll()
        await caller.flush()
    }

    @Test("groups every thread's links, oldest first")
    func groupsLinks() async {
        let store = store
        let loading = Task.immediate { await store.load() }
        await answer("pullRequests.all", [link("1", "t1", urlA), link("2", "t2", urlB), link("3", "t1", urlB)])
        await loading.value
        #expect(store.linksByThread["t1"]?.map(\.id) == ["1", "3"])
        #expect(store.linksByThread["t2"]?.map(\.id) == ["2"])
    }

    @Test("replaces a thread's links with a push, and keeps a push that lands during a load")
    func replaceDuringLoad() async {
        let store = store
        let loading = Task.immediate { await store.load() }
        store.replace(threadId: "t1", links: [link("9", "t1", urlB)])
        await answer("pullRequests.all", [link("1", "t1", urlA), link("2", "t2", urlB)])
        await loading.value
        #expect(store.linksByThread["t1"]?.map(\.id) == ["9"])

        store.replace(threadId: "t2", links: [])
        #expect(store.linksByThread["t2"] == [])
    }

    @Test("keeps a push that lands while one thread's links are read")
    func replaceDuringThreadRead() async throws {
        let store = store
        let loading = Task.immediate { try await store.loadThread("t1") }
        store.replace(threadId: "t1", links: [link("a", "t1", urlA), link("b", "t1", urlB)])
        await answer("pullRequests.list", [link("a", "t1", urlA)])
        try await loading.value
        #expect(store.linksByThread["t1"]?.map(\.url) == [urlA, urlB])
    }

    @Test("takes a watched link's summary from its snapshot without asking GitHub")
    func watchedSummary() async {
        store.replace(threadId: "t1", links: [link("1", "t1", urlA, watched: true)])
        setTime(PullRequestsStore.summaryMaxAge * 2)
        store.ensureSummary(urlA, server: nil)
        await caller.flush()
        #expect(caller.calls.isEmpty)
        #expect(store.summaries[urlA]?.value == PullRequestsStore.Summary(status: .open, checks: .failing, review: nil))
    }

    @Test("shares one read between concurrent requests for the same pull request")
    func sharesOneRead() async {
        let store = store
        store.ensureSummary(urlA, server: "s1")
        store.ensureSummary(urlA, server: "s1")
        let card = Task.immediate { await store.loadPullRequest(urlA, server: "s1") }
        await caller.flush()
        #expect(caller.requests("github.pullRequest").map(\.server) == ["s1"])
        #expect(store.summaries[urlA] == .loading)

        await answer("github.pullRequest", pullRequest(urlA))
        await card.value
        #expect(
            store.summaries[urlA]?.value
                == PullRequestsStore.Summary(status: .open, checks: .passing, review: .approved))
    }

    @Test("reads a pull request again only after a minute, and keeps the last value while it does")
    func readsAgainAfterAMinute() async {
        store.ensureSummary(urlA, server: nil)
        await answer("github.pullRequest", pullRequest(urlA))

        setTime(PullRequestsStore.summaryMaxAge - .milliseconds(1))
        store.ensureSummary(urlA, server: nil)
        await caller.flush()
        #expect(caller.calls.isEmpty)

        setTime(PullRequestsStore.summaryMaxAge)
        store.ensureSummary(urlA, server: nil)
        await caller.flush()
        #expect(caller.requests("github.pullRequest").count == 1)
        #expect(store.summaries[urlA]?.value != nil)

        await answer("github.pullRequest", pullRequest(urlA, checks: .failing))
        #expect(store.summaries[urlA]?.value?.checks == .failing)
    }

    @Test("reports a failed read and retries it after the same interval")
    func retriesFailedRead() async {
        let store = store
        let loading = Task.immediate { await store.loadDetail(urlA, server: nil) }
        await caller.flush()
        caller.requests("github.pullRequestDetail")[0].reject(RpcError("CommandFailed", "gh is not signed in"))
        caller.calls.removeAll()
        await loading.value
        #expect(store.details[urlA] == .error(message: "gh is not signed in", tag: "CommandFailed", at: .zero))
        #expect(store.summaries[urlA] == .error(message: "gh is not signed in", tag: "CommandFailed", at: .zero))

        await store.loadDetail(urlA, server: nil)
        #expect(caller.calls.isEmpty)
        setTime(PullRequestsStore.detailMaxAge)
        let retry = Task.immediate { await store.loadDetail(urlA, server: nil) }
        await caller.flush()
        #expect(caller.requests("github.pullRequestDetail").count == 1)
        await answer("github.pullRequestDetail", detail(urlA))
        await retry.value
        #expect(store.details[urlA]?.value != nil)
    }

    @Test("reads a detail again when forced, and ignores the read it superseded")
    func forcedReadSupersedes() async {
        let store = store
        let first = Task.immediate { await store.loadDetail(urlA, server: nil) }
        await caller.flush()
        let older = caller.requests("github.pullRequestDetail")[0]
        caller.calls.removeAll()
        let forced = Task.immediate { await store.loadDetail(urlA, server: nil, force: true) }
        await answer("github.pullRequestDetail", detail(urlA, status: .merged))
        await forced.value
        older.resolve(detail(urlA, status: .open))
        await first.value
        await caller.flush()
        #expect(store.details[urlA]?.value?.status == .merged)
    }
}

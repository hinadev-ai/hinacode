import HinaCodeKit
import Testing

private func pr(_ number: Int) -> String { "https://github.com/acme/app/pull/\(number)" }

private func link(_ threadId: String, _ number: Int, _ createdAt: String, snapshot: PullRequestWatchSnapshot? = nil)
    -> PullRequestLink
{
    PullRequestLink(
        id: "\(threadId)-\(number)", threadId: threadId, url: pr(number), createdAt: createdAt,
        watch: snapshot.map { PullRequestWatch(generation: "g", events: [], snapshot: $0, wakes: 0, failures: 0) })
}

private func thread(_ id: String, _ status: ThreadStatus = .idle) -> AgentThread {
    AgentThread(
        id: id, projectId: "p", title: id, provider: .claude, model: "m", fastMode: false, userSkills: false,
        accessMode: .supervised, status: status, sortIndex: 0, queue: [], createdBy: "user",
        createdAt: "2026-10-01", updatedAt: "2026-10-01")
}

private func ready(
    _ number: Int, status: PullRequestStatus = .open, checks: ChecksStatus? = nil, review: ReviewStatus? = nil
) -> PullRequest {
    PullRequest(
        url: pr(number), number: Double(number), title: "PR \(number)", status: status, checks: checks,
        review: review, author: "octocat", headRefName: "head", baseRefName: "main", additions: 0, deletions: 0)
}

private func issue(_ id: String, _ type: String, _ priority: Double, _ updatedAt: String) -> LinearIssue {
    LinearIssue(
        id: id, identifier: id, title: id, url: "", state: .init(name: type, type: type), priority: priority,
        updatedAt: updatedAt)
}

struct OverviewTests {
    @Test func `groups active threads' pull requests by what they need, once each under the newest link`() {
        let conflicting = PullRequestWatchSnapshot(status: .open, mergeable: .conflicting, head: "h", failingChecks: [])
        let overview = Overview(
            links: [
                link("t1", 1, "2026-10-20"),
                link("t2", 1, "2026-10-22"),
                link("t1", 2, "2026-10-21", snapshot: conflicting),
                link("t1", 3, "2026-10-19"),
                link("t1", 4, "2026-10-18"),
                link("t1", 5, "2026-10-17"),
                link("archived", 6, "2026-10-23"),
                link("t1", 7, "2026-10-16"),
            ],
            threads: ["t1": thread("t1"), "t2": thread("t2"), "archived": thread("archived", .archived)],
            pullRequests: [
                pr(1): ready(1, checks: .failing, review: .changesRequested),
                pr(3): ready(3, checks: .passing),
                pr(4): ready(4, status: .merged, checks: .failing),
                pr(5): ready(5, status: .closed),
            ])

        #expect(overview.attention.map(\.url) == [pr(1), pr(2)])
        #expect(overview.attention.map(\.threadId) == ["t2", "t1"])
        #expect(overview.attention.map(\.needs) == [[.checks, .changes], [.conflicts]])
        #expect(overview.open.map(\.url) == [pr(3), pr(7)])
        #expect(overview.open.map(\.pullRequest?.title) == ["PR 3", nil])
        #expect(overview.merged.map(\.url) == [pr(4)])
        #expect(!overview.urls.contains(pr(6)))
    }

    @Test func `lists each issue once, work in progress first, then by priority with no priority last`() {
        let sorted = Overview.sortIssues([
            issue("backlog", "backlog", 1, "2026-10-24"),
            issue("todo-none", "unstarted", 0, "2026-10-24"),
            issue("todo-low", "unstarted", 4, "2026-10-20"),
            issue("doing", "started", 3, "2026-10-01"),
            issue("todo-low", "unstarted", 4, "2026-10-20"),
        ])
        #expect(sorted.map(\.id) == ["doing", "todo-low", "todo-none", "backlog"])
    }
}

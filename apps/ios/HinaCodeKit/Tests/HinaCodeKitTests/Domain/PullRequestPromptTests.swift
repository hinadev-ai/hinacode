import HinaCodeKit
import Testing

private let pullRequest = PullRequestDetail(
    url: "https://github.com/acme/app/pull/7", number: 7, title: "Fix login", status: .open, author: "octocat",
    headRefName: "fix/login", baseRefName: "main", additions: 0, deletions: 0, body: "", baseRef: "main",
    headRef: "fix/login", head: "abc", mergeable: .mergeable,
    checkRuns: [
        CheckRun(name: "lint", status: .passing),
        CheckRun(name: "test", status: .failing, url: "https://github.com/acme/app/actions/runs/1"),
        CheckRun(name: "e2e", status: .failing),
    ])

struct PullRequestPromptTests {
    @Test func `lists only the failing checks, with their URLs when GitHub has one`() {
        #expect(
            PullRequestPrompt.fixChecks(pullRequest)
                == [
                    "CI is failing on https://github.com/acme/app/pull/7 (branch fix/login). Failing checks:",
                    "- test: https://github.com/acme/app/actions/runs/1",
                    "- e2e",
                    "",
                    "Read the failing logs (for GitHub Actions, `gh run view <run-id> --log-failed`), "
                        + "find the root cause, fix it, verify locally, and push.",
                ].joined(separator: "\n"))
    }

    @Test func `names the pull request and both branches`() {
        #expect(
            PullRequestPrompt.resolveConflicts(pullRequest)
                == "https://github.com/acme/app/pull/7 has merge conflicts with main. "
                + "Fetch origin, merge origin/main into fix/login, "
                + "and resolve the conflicts so both sides keep their intent. "
                + "Run the project's checks, then push.")
    }
}

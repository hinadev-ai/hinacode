/// What the pull request screen sends into the thread so its agent acts on the pull request. Agent-facing, so English.
public enum PullRequestPrompt {
    /// Asks the agent to fix the failing checks.
    public static func fixChecks(_ pullRequest: PullRequestDetail) -> String {
        let failing = pullRequest.checkRuns.filter { $0.status == .failing }.map { run in
            if let url = run.url, !url.isEmpty { "- \(run.name): \(url)" } else { "- \(run.name)" }
        }
        let header = "CI is failing on \(pullRequest.url) (branch \(pullRequest.headRef)). Failing checks:"
        let instructions =
            "Read the failing logs (for GitHub Actions, `gh run view <run-id> --log-failed`), find the root cause, "
            + "fix it, verify locally, and push."
        return ([header] + failing + ["", instructions]).joined(separator: "\n")
    }

    /// Asks the agent to resolve the merge conflicts.
    public static func resolveConflicts(_ pullRequest: PullRequestDetail) -> String {
        [
            "\(pullRequest.url) has merge conflicts with \(pullRequest.baseRef).",
            "Fetch origin, merge origin/\(pullRequest.baseRef) into \(pullRequest.headRef), "
                + "and resolve the conflicts so both sides keep their intent.",
            "Run the project's checks, then push.",
        ].joined(separator: " ")
    }
}

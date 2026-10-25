/// The pull requests of active threads, grouped by what they need from the developer, newest link first. Closed ones
/// are left out, since nobody acts on them. Conflicts are known only from a watch snapshot, the one cheap source.
public struct Overview: Hashable, Sendable {
    /// Why an open pull request waits on the developer.
    public enum Need: Hashable, Sendable {
        case checks
        case changes
        case conflicts
    }

    public struct Row: Hashable, Sendable {
        public var url: String
        /// The thread of the newest link, when several threads linked the same pull request.
        public var threadId: String
        /// Nil until GitHub answers.
        public var pullRequest: PullRequest?
        public var error: String?
        public var needs: [Need]
    }

    /// Open pull requests with failing checks, changes requested or conflicts.
    public var attention: [Row] = []
    public var open: [Row] = []
    public var merged: [Row] = []
    /// Every pull request worth reading from GitHub: the ones linked to a thread that is not archived.
    public var urls: [String] = []

    /// - Parameters:
    ///   - threads: Threads by id.
    ///   - pullRequests: The pull requests GitHub answered, by URL.
    ///   - errors: Why reading a pull request failed, by URL.
    public init(
        links: [PullRequestLink], threads: [String: AgentThread], pullRequests: [String: PullRequest],
        errors: [String: String] = [:]
    ) {
        var newest: [PullRequestLink] = []
        var seen: Set<String> = []
        for link in links.sorted(by: { $0.createdAt > $1.createdAt }) {
            guard let thread = threads[link.threadId], thread.status != .archived, !seen.contains(link.url) else {
                continue
            }
            seen.insert(link.url)
            newest.append(link)
        }

        for link in newest {
            let pullRequest = pullRequests[link.url]
            let snapshot = link.watch?.snapshot
            let status = pullRequest?.status ?? snapshot?.status
            if status == .closed { continue }
            let checks = pullRequest?.checks ?? snapshot?.checks
            let review = pullRequest?.review ?? snapshot?.review
            var needs: [Need] = []
            if status != .merged {
                if checks == .failing { needs.append(.checks) }
                if review == .changesRequested { needs.append(.changes) }
                if snapshot?.mergeable == .conflicting { needs.append(.conflicts) }
            }
            let row = Row(
                url: link.url, threadId: link.threadId, pullRequest: pullRequest, error: errors[link.url], needs: needs)
            if status == .merged {
                merged.append(row)
            } else if !needs.isEmpty {
                attention.append(row)
            } else {
                open.append(row)
            }
        }
        urls = newest.map(\.url)
    }

    /// Issues from every server once each, work in progress first, then by priority and the latest update. Two servers
    /// with the same Linear account answer the same issues.
    public static func sortIssues(_ issues: [LinearIssue]) -> [LinearIssue] {
        // Like a JavaScript Map: a repeated id keeps its first place and takes the last value.
        var order: [String] = []
        var byId: [String: LinearIssue] = [:]
        for issue in issues {
            if byId.updateValue(issue, forKey: issue.id) == nil { order.append(issue.id) }
        }
        return order.compactMap { byId[$0] }.sorted { a, b in
            if stateRank(a) != stateRank(b) { return stateRank(a) < stateRank(b) }
            if priorityRank(a) != priorityRank(b) { return priorityRank(a) < priorityRank(b) }
            return a.updatedAt > b.updatedAt
        }
    }

    /// The draft a thread started from a ticket begins with. The agent reads the rest with its Linear tool.
    public static func issueDraft(_ issue: LinearIssue) -> String { "\(issue.identifier) \(issue.title)" }

    private static let stateRanks = ["started": 0, "unstarted": 1, "triage": 2, "backlog": 3]

    private static func stateRank(_ issue: LinearIssue) -> Int { stateRanks[issue.state.type] ?? 4 }

    /// Linear's 0 means no priority, which sorts after low.
    private static func priorityRank(_ issue: LinearIssue) -> Double { issue.priority == 0 ? 5 : issue.priority }
}

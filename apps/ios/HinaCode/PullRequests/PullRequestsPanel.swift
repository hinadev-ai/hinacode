import HinaCodeKit
import SwiftUI

/// The PRs tab: the pull requests linked to the thread, newest first, plus the one GitHub has for the thread's
/// branch when it is not linked. Rows push the pull request's page.
struct PullRequestsPanel: View {
    let threadId: String

    @Environment(AppModel.self) private var model
    @State private var error: String?
    @State private var branchPullRequest: PullRequest?
    @State private var creating = false
    @State private var watchBusy: Set<String> = []

    private var thread: AgentThread? { model.threads.threads[threadId] }
    private var serverId: String? { model.server(of: thread)?.id }
    private var links: [PullRequestLink]? { model.pullRequests.linksByThread[threadId] }

    var body: some View {
        List {
            if let error {
                Section {
                    Label(.mobilePrLinksFailed(error), systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Tone.danger.color)
                }
            }
            content
        }
        .refreshable { await refresh() }
        .task(id: "\(threadId)@\(model.server(of: thread)?.generation ?? 0)") { await load() }
    }

    @ViewBuilder private var content: some View {
        if let links {
            let branch = branchPullRequest.flatMap { pullRequest in
                links.contains { $0.url == pullRequest.url } ? nil : pullRequest
            }
            if links.isEmpty && branch == nil {
                Section {
                    ContentUnavailableView {
                        Label(.mobilePrEmpty, systemImage: "arrow.triangle.branch")
                    } description: {
                        Text(.mobilePrEmptyHint)
                    } actions: {
                        if thread?.worktreeId != nil {
                            Button {
                                Task { await create() }
                            } label: {
                                if creating {
                                    ProgressView()
                                } else {
                                    Label(.mobilePrCreate, systemImage: "plus")
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(creating)
                        }
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            } else {
                Section {
                    ForEach(links.reversed()) { link in
                        cardRow(url: link.url, link: link)
                    }
                    if let branch {
                        cardRow(url: branch.url, link: nil)
                    }
                }
            }
        } else if error == nil {
            Section {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(.mobilePrLoading)
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 44)
            }
        }
    }

    private func cardRow(url: String, link: PullRequestLink?) -> some View {
        NavigationLink(value: DetailRoute.pullRequest(threadId: threadId, url: url)) {
            PullRequestCard(threadId: threadId, url: url, link: link, fromBranch: link == nil)
        }
        .swipeActions(edge: .leading) {
            if let link { watchButton(link) }
        }
        .contextMenu {
            if let link { watchButton(link) }
        }
    }

    @ViewBuilder private func watchButton(_ link: PullRequestLink) -> some View {
        let watching = link.watch != nil
        Button {
            Task { await setWatching(!watching, url: link.url) }
        } label: {
            Label {
                watching ? Text(.mobilePrUnwatch) : Text(.mobilePrWatch)
            } icon: {
                Image(systemName: watching ? "eye.slash" : "eye")
            }
        }
        .disabled(watchBusy.contains(link.url))
    }

    private func load() async {
        do {
            try await model.pullRequests.loadThread(threadId)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        await loadBranch()
    }

    private func loadBranch() async {
        guard let worktreeId = thread?.worktreeId,
            let worktree = model.threads.worktrees[worktreeId], worktree.status != .removed
        else { return }
        // A branch with no pull request is the common case, so a failure just leaves no card.
        branchPullRequest = (try? await model.hub.call(RPC.worktreesPullRequest, .init(id: worktreeId))) ?? nil
    }

    private func refresh() async {
        await load()
        var urls = (links ?? []).map(\.url)
        if let branchPullRequest { urls.append(branchPullRequest.url) }
        for url in urls {
            await model.pullRequests.loadPullRequest(url, server: serverId, force: true)
        }
    }

    private func create() async {
        creating = true
        defer { creating = false }
        do {
            // The new link arrives through the `thread.pullRequests` push.
            _ = try await model.hub.call(RPC.pullRequestsCreate, PullRequestsCreateRequest(threadId: threadId))
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func setWatching(_ watching: Bool, url: String) async {
        watchBusy.insert(url)
        defer { watchBusy.remove(url) }
        do {
            if watching {
                _ = try await model.hub.call(RPC.pullRequestsWatch, .init(threadId: threadId, url: url))
            } else {
                _ = try await model.hub.call(RPC.pullRequestsUnwatch, .init(threadId: threadId, url: url))
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// One pull request as the PRs tab shows it, reading its state from GitHub through the store.
struct PullRequestCard: View {
    let threadId: String
    let url: String
    let link: PullRequestLink?
    var fromBranch = false

    @Environment(AppModel.self) private var model

    private var remote: RemoteValue<PullRequest>? { model.pullRequests.pullRequests[url] }

    var body: some View {
        Group {
            switch remote {
            case .ready(let pullRequest, _):
                PullRequestSummaryRows(
                    pullRequest: pullRequest, watching: link?.watch != nil, fromBranch: fromBranch)
            case .error(let message, _, _):
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: url)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(.mobilePrCardFailed(message))
                        .font(.subheadline)
                        .foregroundStyle(Tone.danger.color)
                }
            case .loading, nil:
                HStack(spacing: 8) {
                    Text(verbatim: url)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    ProgressView()
                }
            }
        }
        .frame(minHeight: 44)
        .task(id: "\(url)@\(model.server(of: model.threads.threads[threadId])?.generation ?? 0)") {
            await model.pullRequests.loadPullRequest(
                url, server: model.server(of: model.threads.threads[threadId])?.id)
        }
    }
}

/// The title, refs, size and pills of a loaded pull request, shared by the PRs tab and the overview.
struct PullRequestSummaryRows: View {
    let pullRequest: PullRequest
    var watching = false
    var fromBranch = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: PullRequestMarkView.symbol(for: pullRequest.status))
                    .foregroundStyle(pullRequest.status.tone.color)
                    .accessibilityHidden(true)
                Text(verbatim: pullRequest.title)
                    .font(.body.weight(.semibold))
                    .lineLimit(3)
                Text(verbatim: "#\(Int(pullRequest.number))")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            HStack(spacing: 8) {
                Text(verbatim: "\(pullRequest.headRefName) → \(pullRequest.baseRefName)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                PullRequestSize(additions: Int(pullRequest.additions), deletions: Int(pullRequest.deletions))
            }
            PullRequestPills(
                status: pullRequest.status, checks: pullRequest.checks, review: pullRequest.review,
                watching: watching)
            if fromBranch {
                Text(.mobilePrFromBranch)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        var parts = [
            String(localized: .mobilePrNumber(String(Int(pullRequest.number)))),
            pullRequest.title,
            String(localized: pullRequest.status.label),
            String(
                localized: .mobilePrSize(
                    String(Int(pullRequest.additions)), String(Int(pullRequest.deletions)))),
        ]
        if let checks = pullRequest.checks { parts.append(String(localized: checks.label)) }
        if watching { parts.append(String(localized: .mobilePrWatching)) }
        return parts.joined(separator: ", ")
    }
}

/// `+12 −3`, green and red, read aloud as lines added and removed.
struct PullRequestSize: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 4) {
            Text(verbatim: "+\(additions)")
                .foregroundStyle(Tone.running.color)
            Text(verbatim: "−\(deletions)")
                .foregroundStyle(Tone.danger.color)
        }
        .font(.caption)
        .monospacedDigit()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(.mobilePrSize(String(additions), String(deletions))))
    }
}

/// State, checks, review and watching as small pills.
struct PullRequestPills: View {
    let status: PullRequestStatus
    let checks: ChecksStatus?
    let review: ReviewStatus?
    var watching = false
    var mergeable: Mergeable?

    var body: some View {
        // Pills wrap onto the next line at large text sizes instead of squeezing.
        FlowLayout(spacing: 6) {
            pill(status.label, systemImage: PullRequestMarkView.symbol(for: status), color: status.tone.color)
            if status.isOpen, let checks {
                switch checks {
                case .passing:
                    pill(.mobilePrChecksPassing, systemImage: "checkmark", color: .secondary)
                case .failing:
                    pill(.mobilePrChecksFailing, systemImage: "exclamationmark.triangle", color: Tone.danger.color)
                case .pending, .unknown:
                    pill(.mobilePrChecksPending, systemImage: "clock", color: .secondary)
                }
            }
            if let review, let label = review.label {
                pill(label, systemImage: review.symbol, color: review.tone.color)
            }
            if status.isOpen, mergeable == .mergeable {
                pill(.mobilePrMergeable, systemImage: "checkmark", color: .secondary)
            }
            if status.isOpen, mergeable == .conflicting {
                pill(.mobilePrConflicting, systemImage: "exclamationmark.triangle", color: Tone.attention.color)
            }
            if watching {
                pill(.mobilePrWatching, systemImage: "eye", color: .secondary)
            }
        }
        .accessibilityHidden(true)
    }

    private func pill(_ label: LocalizedStringResource, systemImage: String, color: Color) -> some View {
        Label {
            Text(label)
        } icon: {
            Image(systemName: systemImage)
        }
        .labelStyle(.titleAndIcon)
        .font(.caption)
        .foregroundStyle(color)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Color(.tertiarySystemFill), in: .capsule)
    }
}

extension ReviewStatus {
    var label: LocalizedStringResource? {
        switch self {
        case .approved: .mobilePrReviewApproved
        case .changesRequested: .mobilePrReviewChangesRequested
        case .reviewRequired: .mobilePrReviewRequired
        case .unknown: nil
        }
    }

    var symbol: String {
        switch self {
        case .approved: "checkmark.circle"
        case .changesRequested: "exclamationmark.circle"
        case .reviewRequired, .unknown: "eye"
        }
    }
}

/// Rows that wrap like words, for pills that outgrow one line at large Dynamic Type sizes.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
        let rows = rows(in: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) {
        var y = bounds.minY
        for row in rows(in: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func rows(in width: CGFloat, subviews: Subviews) -> [(indices: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(indices: [Int], width: CGFloat, height: CGFloat)] = []
        var row: [Int] = []
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            if !row.isEmpty, rowWidth + spacing + size.width > width {
                rows.append((row, rowWidth, rowHeight))
                row = []
                rowWidth = 0
                rowHeight = 0
            }
            row.append(index)
            rowWidth += (row.count > 1 ? spacing : 0) + size.width
            rowHeight = max(rowHeight, size.height)
        }
        if !row.isEmpty { rows.append((row, rowWidth, rowHeight)) }
        return rows
    }
}

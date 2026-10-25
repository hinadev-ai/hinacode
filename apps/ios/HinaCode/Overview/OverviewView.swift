import HinaCodeKit
import SwiftUI

/// The overview: pull requests on active threads grouped by what they need, then the Linear issues assigned to the
/// developer. An issue opens the new thread sheet with it as the draft.
struct OverviewView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router

    private var connected: Bool { model.hub.status == .connected }

    private var overview: Overview {
        let store = model.pullRequests
        return Overview(
            links: store.linksByThread.values.flatMap { $0 },
            threads: model.threads.threads,
            pullRequests: store.pullRequests.compactMapValues(\.value),
            errors: store.pullRequests.compactMapValues { remote in
                if case .error(let message, _, _) = remote { message } else { nil }
            })
    }

    var body: some View {
        List {
            if !connected {
                Section {
                    Label(.mobileOverviewOffline, systemImage: "wifi.slash")
                        .foregroundStyle(.secondary)
                }
            }
            pullRequestSections
            linearSection
        }
        .navigationTitle(.mobileOverviewTitle)
        .refreshable { await refresh() }
        .task(id: "\(overview.urls.joined(separator: "\0"))@\(model.hub.generation)") {
            guard connected else { return }
            await loadPullRequests(force: false)
            await model.linear.load()
        }
    }

    @ViewBuilder private var pullRequestSections: some View {
        let overview = overview
        if overview.attention.isEmpty && overview.open.isEmpty && overview.merged.isEmpty {
            Section {
                ContentUnavailableView {
                    Label(.mobileOverviewPullRequestsEmpty, systemImage: "arrow.triangle.branch")
                } description: {
                    Text(.mobileOverviewPullRequestsEmptyHint)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            } header: {
                Text(.mobileOverviewPullRequests)
            }
        } else {
            group(overview.attention, header: .mobileOverviewNeedsYou)
            group(overview.open, header: .mobileOverviewOpen)
            group(overview.merged, header: .mobileOverviewMerged)
        }
    }

    @ViewBuilder private func group(_ rows: [Overview.Row], header: LocalizedStringResource) -> some View {
        if !rows.isEmpty {
            Section {
                ForEach(rows, id: \.url) { row in
                    NavigationLink(value: DetailRoute.pullRequest(threadId: row.threadId, url: row.url)) {
                        OverviewPullRequestRow(row: row)
                    }
                }
            } header: {
                Text(header)
            }
        }
    }

    @ViewBuilder private var linearSection: some View {
        Section {
            linearContent
        } header: {
            Text(.mobileOverviewLinear)
        }
    }

    @ViewBuilder private var linearContent: some View {
        switch model.linear.issues {
        case .ready(let issues, _):
            if issues.isEmpty {
                if model.linear.configured == false {
                    ContentUnavailableView {
                        Label(.mobileOverviewLinearNotConnected, systemImage: "checklist")
                    } description: {
                        Text(.mobileOverviewLinearConnectHint)
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(.mobileOverviewLinearEmpty)
                            .foregroundStyle(.secondary)
                        if model.linear.configured == nil {
                            Text(.mobileOverviewLinearConnectHint)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                ForEach(issues) { issue in
                    Button {
                        router.sheet = .newThread(issue)
                    } label: {
                        LinearIssueRow(issue: issue)
                    }
                    .buttonStyle(.plain)
                }
            }
        case .error(let message, let tag, _):
            Label {
                tag == "SchemaError"
                    ? Text(.mobileOverviewLinearUpdateDesktop)
                    : Text(.mobileOverviewLinearFailed(message))
            } icon: {
                Image(systemName: "exclamationmark.triangle")
            }
            .foregroundStyle(Tone.danger.color)
            if connected {
                Button(.mobileHomeRetry) {
                    Task { await model.linear.load(force: true) }
                }
            }
        case .loading, nil:
            if connected {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(.mobileOverviewLinearLoading)
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 44)
            }
        }
    }

    /// Reads the overview's pull requests four at a time; each read runs `gh` on a desktop.
    private struct Read: Sendable {
        let url: String
        let server: String?
    }

    private func loadPullRequests(force: Bool) async {
        let store = model.pullRequests
        let reads = overview.urls.map { url in
            Read(url: url, server: model.server(of: newestThread(for: url))?.id)
        }
        for chunk in reads.chunked(into: 4) {
            let tasks = chunk.map { read in
                Task { @MainActor in
                    await store.loadPullRequest(read.url, server: read.server, force: force)
                }
            }
            for task in tasks { await task.value }
        }
    }

    private func newestThread(for url: String) -> AgentThread? {
        let links = model.pullRequests.linksByThread.values.flatMap { $0 }
            .filter { $0.url == url }
            .sorted { $0.createdAt > $1.createdAt }
        return links.first.flatMap { model.threads.threads[$0.threadId] }
    }

    private func refresh() async {
        guard connected else { return }
        await model.pullRequests.load()
        await loadPullRequests(force: true)
        await model.linear.load(force: true)
    }
}

/// One pull request that may need the developer: its title once read, its repository, its thread, and why it waits.
private struct OverviewPullRequestRow: View {
    let row: Overview.Row

    @Environment(AppModel.self) private var model

    private var reference: String {
        guard let ref = GitHubPullRequestRef(url: row.url) else { return row.url }
        return "\(ref.owner)/\(ref.repository) #\(ref.number)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: PullRequestMarkView.symbol(for: row.pullRequest?.status))
                    .foregroundStyle(row.pullRequest?.status.tone.color ?? .secondary)
                    .accessibilityHidden(true)
                title
                if row.pullRequest == nil, row.error == nil {
                    ProgressView()
                }
            }
            HStack(spacing: 8) {
                Text(verbatim: reference)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                if row.pullRequest?.status != .merged, let checks = row.pullRequest?.checks {
                    Image(systemName: PullRequestMarkView.symbol(for: checks))
                        .foregroundStyle(checks.tone.color)
                        .accessibilityLabel(Text(checks.label))
                }
                if let thread = model.threads.threads[row.threadId] {
                    Label {
                        Text(verbatim: thread.title)
                            .lineLimit(1)
                    } icon: {
                        Image(systemName: "text.bubble")
                    }
                    .labelStyle(.titleAndIcon)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if !row.needs.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(row.needs, id: \.self) { need in
                        Text(need.label)
                            .font(.caption)
                            .foregroundStyle(need.tone.color)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Color(.tertiarySystemFill), in: .capsule)
                    }
                }
            }
            if let error = row.error {
                Text(.mobilePrCardFailed(error))
                    .font(.subheadline)
                    .foregroundStyle(Tone.danger.color)
            }
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    @ViewBuilder private var title: some View {
        if let pullRequest = row.pullRequest {
            Text(verbatim: pullRequest.title)
                .font(.body.weight(.semibold))
                .lineLimit(2)
        } else {
            Text(verbatim: reference)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }

    private var accessibilityLabel: String {
        var parts = [row.pullRequest?.title ?? reference, reference]
        if let status = row.pullRequest?.status { parts.append(String(localized: status.label)) }
        if row.pullRequest?.status != .merged, let checks = row.pullRequest?.checks {
            parts.append(String(localized: checks.label))
        }
        parts += row.needs.map { String(localized: $0.label) }
        if let thread = model.threads.threads[row.threadId] { parts.append(thread.title) }
        if let error = row.error { parts.append(String(localized: .mobilePrCardFailed(error))) }
        return parts.joined(separator: ", ")
    }
}

extension Overview.Need {
    var label: LocalizedStringResource {
        switch self {
        case .checks: .mobilePrChecksFailing
        case .changes: .mobilePrReviewChangesRequested
        case .conflicts: .mobilePrConflicting
        }
    }

    var tone: Tone {
        switch self {
        case .checks, .conflicts: .danger
        case .changes: .attention
        }
    }
}

/// One Linear issue: its state, identifier and title, then its state name and priority.
private struct LinearIssueRow: View {
    let issue: LinearIssue

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .lineLimit(2)
                HStack(spacing: 8) {
                    Text(verbatim: issue.state.name)
                    if let priority {
                        Text(priority.label)
                            .foregroundStyle(priority.tone.color)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 44)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(Text(.mobileOverviewStartThread))
    }

    /// "ENG-123 The title", the identifier monospaced and muted.
    private var title: AttributedString {
        var identifier = AttributedString(issue.identifier)
        identifier.font = .system(.body, design: .monospaced)
        identifier.foregroundColor = .secondary
        return identifier + AttributedString(" \(issue.title)")
    }

    private var symbol: String {
        issue.state.type == "started" ? "circle.lefthalf.filled" : "circle"
    }

    private var color: Color {
        switch issue.state.type {
        case "started": Tone.attention.color
        case "unstarted": .primary
        default: .secondary
        }
    }

    private var priority: (label: LocalizedStringResource, tone: Tone)? {
        switch Int(issue.priority) {
        case 1: (.mobileOverviewPriority1, .danger)
        case 2: (.mobileOverviewPriority2, .neutral)
        case 3: (.mobileOverviewPriority3, .neutral)
        case 4: (.mobileOverviewPriority4, .neutral)
        default: nil
        }
    }

    private var accessibilityLabel: String {
        var parts = [issue.identifier, issue.title, issue.state.name]
        if let priority { parts.append(String(localized: priority.label)) }
        return parts.joined(separator: ", ")
    }
}

extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}

import HinaCodeKit
import SwiftUI

/// One thread in the list: its project, title and who runs it, then where it works and what it needs.
struct ThreadRow: View {
    let thread: AgentThread
    let showProject: Bool

    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var actionError: String?
    @State private var copied = false

    private var state: ThreadRowState {
        ThreadRowState(status: thread.status, unseen: model.unseen.outcomes[thread.id])
    }

    private var project: Project? { model.threads.projects.first { $0.id == thread.projectId } }
    private var server: ServerHub.Server? { model.server(of: thread) }
    private var away: Bool { server.map { $0.status != .connected } ?? false }
    private var severalServers: Bool { model.hub.servers.count > 1 }
    private var links: [PullRequestLink] { model.pullRequests.linksByThread[thread.id] ?? [] }
    private var watching: Bool { links.contains { $0.watch != nil } }

    private var mark: PullRequestMark? {
        guard let url = links.last?.url else { return nil }
        let summary = model.pullRequests.summaries[url]?.value
        return PullRequestMark(
            number: GitHubPullRequestRef(url: url)?.number ?? "?",
            status: summary?.status,
            checks: summary?.checks,
            stacked: links.count > 1)
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            ProviderMark(provider: thread.provider)
                .alignmentGuide(.firstTextBaseline) { $0.height * 0.85 }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(title)
                        .font(state.emphasis == .attention ? .body.weight(.semibold) : .body)
                        .foregroundStyle(titleStyle)
                        .lineLimit(1)
                    statusIndicator
                        .font(.subheadline)
                    Spacer(minLength: 4)
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        RelativeTimeText(iso: thread.updatedAt, now: context.date)
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                details
            }
        }
        .padding(.vertical, 2)
        .opacity(away ? 0.5 : 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(Text(.mobileThreadActionsHint))
        .accessibilityIdentifier("thread-row-\(thread.id)")
        .accessibilityActions { actionButtons }
        .swipeActions(edge: .leading) {
            if thread.status != .archived { pinButton }
        }
        .swipeActions(edge: .trailing) { archiveButton }
        .contextMenu {
            actionButtons
            Button {
                openWindow(value: thread.id)
            } label: {
                Label(.mobileThreadOpenWindow, systemImage: "macwindow.badge.plus")
            }
        }
        .alert(
            Text(.mobileThreadActionFailed),
            isPresented: Binding(get: { actionError != nil }, set: { _ in actionError = nil })
        ) {
            Button(role: .cancel) { actionError = nil }
        } message: {
            Text(verbatim: actionError ?? "")
        }
        .task(id: summaryKey) {
            if let url = links.last?.url {
                model.pullRequests.ensureSummary(url, server: server?.id)
            }
        }
    }

    private var title: String {
        thread.title.isEmpty ? String(localized: .mobileHomeUntitled) : thread.title
    }

    private var titleStyle: Color {
        state.emphasis == .resting ? .primary.opacity(0.85) : .primary
    }

    /// Where the thread works and what it shipped, on one quiet line under the title.
    private var details: some View {
        HStack(spacing: 6) {
            if showProject, severalServers, let server {
                ServerMark(server: server)
            }
            if showProject, let project {
                Text(verbatim: project.name)
                    .lineLimit(1)
            }
            if let branch = model.threads.branch(of: thread) {
                Label {
                    Text(verbatim: branch.name)
                        .font(.system(.footnote, design: .monospaced))
                        .strikethrough(branch.removed)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } icon: {
                    Image(systemName: "arrow.triangle.branch")
                        .imageScale(.small)
                }
                .labelStyle(.titleAndIcon)
                .layoutPriority(1)
            }
            if let mark {
                PullRequestMarkView(mark: mark)
            }
            if watching {
                Image(systemName: "eye")
                    .imageScale(.small)
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }

    private var summaryKey: String {
        "\(links.last?.url ?? "")@\(server?.generation ?? 0)"
    }

    @ViewBuilder private var statusIndicator: some View {
        if let symbol = Self.symbol(for: state), let tone = state.indicatorTone {
            let image = Image(systemName: symbol).foregroundStyle(tone.color)
            if state == .awaitingApproval, !reduceMotion {
                image.symbolEffect(.pulse, options: .repeat(3))
            } else if state == .running, !reduceMotion {
                image.symbolEffect(.breathe)
            } else {
                image
            }
        }
    }

    private static func symbol(for state: ThreadRowState) -> String? {
        switch state {
        case .running: "waveform.path.ecg"
        case .awaitingApproval: "questionmark.circle.fill"
        case .limited: "hourglass"
        case .unseenCompleted: "checkmark.circle.fill"
        case .unseenFailed: "exclamationmark.circle.fill"
        case .idle, .archived, .unknown: nil
        }
    }

    @ViewBuilder private var actionButtons: some View {
        ForEach(ThreadAction.offered(by: thread), id: \.self) { action in
            Button {
                run(action)
            } label: {
                Label {
                    action.label
                } icon: {
                    Image(systemName: action == .copyId && copied ? "checkmark" : action.symbol)
                }
            }
        }
    }

    private var pinButton: some View {
        Button {
            run(thread.pinnedAt == nil ? .pin : .unpin)
        } label: {
            Label {
                thread.pinnedAt == nil ? Text(.mobileThreadActionsPin) : Text(.mobileThreadActionsUnpin)
            } icon: {
                Image(systemName: thread.pinnedAt == nil ? "pin" : "pin.slash")
            }
        }
        .tint(.accentColor)
    }

    private var archiveButton: some View {
        Button {
            run(thread.status == .archived ? .unarchive : .archive)
        } label: {
            Label {
                thread.status == .archived ? Text(.mobileThreadActionsUnarchive) : Text(.mobileThreadActionsArchive)
            } icon: {
                Image(systemName: "archivebox")
            }
        }
        .tint(.secondary)
    }

    private func run(_ action: ThreadAction) {
        if action == .copyId {
            UIPasteboard.general.string = thread.id
            copied = true
            AccessibilityNotification.Announcement(String(localized: .mobileThreadActionsCopied)).post()
            Task {
                try? await Task.sleep(for: .milliseconds(800))
                copied = false
            }
            return
        }
        Task {
            do {
                let updated =
                    switch action {
                    case .pin:
                        try await model.hub.call(
                            RPC.threadsUpdate, ThreadsUpdateRequest(id: thread.id, pinned: true))
                    case .unpin:
                        try await model.hub.call(
                            RPC.threadsUpdate, ThreadsUpdateRequest(id: thread.id, pinned: false))
                    case .archive:
                        try await model.hub.call(RPC.threadsArchive, ThreadsArchiveRequest(threadId: thread.id))
                    case .unarchive:
                        try await model.hub.call(RPC.threadsUnarchive, ThreadsUnarchiveRequest(threadId: thread.id))
                    case .copyId: thread
                    }
                model.threads.upsert(updated)
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    private var accessibilityLabel: String {
        var parts = [title]
        if severalServers, let server, let name = server.name {
            parts.append(
                away
                    ? String(localized: .mobileServerMarkAway(name, String(localized: server.status.label)))
                    : String(localized: .mobileServerMark(name)))
        }
        if showProject, let project { parts.append(project.name) }
        if let branch = model.threads.branch(of: thread) {
            parts.append(String(localized: .mobileRowBranch(branch.name)))
        }
        if let status = state.spokenStatus { parts.append(status) }
        if let mark { parts += mark.spokenParts(more: max(links.count - 1, 0)) }
        if watching { parts.append(String(localized: .mobileRowWatching)) }
        parts.append(String(localized: RelativeTimeText.label(RelativeTime(since: thread.updatedAt, now: .now))))
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

extension ThreadAction {
    var label: Text {
        switch self {
        case .pin: Text(.mobileThreadActionsPin)
        case .unpin: Text(.mobileThreadActionsUnpin)
        case .copyId: Text(.mobileThreadActionsCopyId)
        case .archive: Text(.mobileThreadActionsArchive)
        case .unarchive: Text(.mobileThreadActionsUnarchive)
        }
    }

    var symbol: String {
        switch self {
        case .pin: "pin"
        case .unpin: "pin.slash"
        case .copyId: "doc.on.doc"
        case .archive, .unarchive: "archivebox"
        }
    }
}

extension ThreadRowState {
    /// The status as a row says it, for states worth saying. Idle and archived stay quiet, as in the Expo app.
    var spokenStatus: String? {
        let label: LocalizedStringResource? =
            switch self {
            case .running: .mobileStatusRunning
            case .awaitingApproval: .mobileStatusAwaiting
            case .limited: .mobileStatusLimited
            case .unseenCompleted: .mobileStatusUnseenCompleted
            case .unseenFailed: .mobileStatusUnseenFailed
            case .idle, .archived, .unknown: nil
            }
        return label.map { String(localized: $0) }
    }
}

extension TransportStatus {
    var label: LocalizedStringResource {
        switch self {
        case .connected: .mobileConnectionConnected
        case .connecting: .mobileConnectionConnecting
        case .offline: .mobileConnectionOffline
        case .unauthorized: .mobileConnectionUnauthorized
        }
    }
}

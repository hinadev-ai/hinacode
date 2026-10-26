import HinaCodeKit
import SwiftUI

/// The four views of a thread.
enum ThreadTab: Hashable {
    case chat, files, pullRequests, terminal
}

/// One thread: its chat, files, pull requests and terminal behind a segmented picker. Chat is always mounted;
/// Files and Terminal stay mounted after the first visit; PRs reloads on each visit, as in the Expo app.
struct ThreadView: View {
    let threadId: String

    @Environment(AppModel.self) private var model
    @State private var tab: ThreadTab = .chat
    @State private var visitedFiles = false
    @State private var visitedTerminal = false
    @State private var actionError: String?

    private var thread: AgentThread? { model.threads.threads[threadId] }
    private var server: ServerHub.Server? { model.server(of: thread) }
    private var isConnected: Bool { server?.status == .connected }

    var body: some View {
        Group {
            if let thread {
                panels(thread)
            } else if model.threads.status == .ready {
                ContentUnavailableView(.mobileThreadMissing, systemImage: "text.bubble")
            } else {
                ProgressView { Text(.mobileThreadLoading) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(thread.map { $0.title.isEmpty ? String(localized: .mobileNotifyUntitled) : $0.title } ?? "")
        .navigationSubtitle(subtitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .alert(
            Text(.mobileThreadActionFailed),
            isPresented: Binding(get: { actionError != nil }, set: { _ in actionError = nil })
        ) {
            Button(role: .cancel) { actionError = nil }
        } message: {
            Text(verbatim: actionError ?? "")
        }
        .onChange(of: tab) { _, newTab in
            if newTab == .files { visitedFiles = true }
            if newTab == .terminal { visitedTerminal = true }
        }
    }

    private var subtitle: String {
        guard let thread else { return "" }
        let provider = String(localized: thread.provider.name)
        let status = String(localized: Self.statusLabel(thread.status))
        return "\(provider) · \(status)"
    }

    static func statusLabel(_ status: ThreadStatus) -> LocalizedStringResource {
        switch status {
        case .idle: .mobileStatusIdle
        case .running: .mobileStatusRunning
        case .awaitingApproval: .mobileStatusAwaiting
        case .limited: .mobileStatusLimited
        case .archived: .mobileStatusArchived
        case .unknown(let value): LocalizedStringResource(stringLiteral: value)
        }
    }

    @ViewBuilder private func panels(_ thread: AgentThread) -> some View {
        ZStack {
            ChatPanel(threadId: threadId, isSelected: tab == .chat)
                .opacity(tab == .chat ? 1 : 0)
                .allowsHitTesting(tab == .chat)
                .accessibilityHidden(tab != .chat)
            if visitedFiles {
                FilesPanel(threadId: threadId, isSelected: tab == .files)
                    .opacity(tab == .files ? 1 : 0)
                    .allowsHitTesting(tab == .files)
                    .accessibilityHidden(tab != .files)
            }
            if tab == .pullRequests {
                PullRequestsPanel(threadId: threadId)
            }
            if visitedTerminal, let server {
                TerminalPanel(
                    threadId: threadId, caller: model.hub, pushes: model.pushes, features: server.features,
                    generation: server.generation, isConnected: isConnected, isSelected: tab == .terminal
                )
                .opacity(tab == .terminal ? 1 : 0)
                .allowsHitTesting(tab == .terminal)
                .accessibilityHidden(tab != .terminal)
            }
        }
        .safeAreaBar(edge: .top) {
            VStack(spacing: 8) {
                Picker(selection: $tab) {
                    Text(.mobileThreadTabChat).tag(ThreadTab.chat)
                    Text(.mobileThreadTabFiles).tag(ThreadTab.files)
                    Text(.mobileThreadTabPrs).tag(ThreadTab.pullRequests)
                    Text(.mobileThreadTabTerminal).tag(ThreadTab.terminal)
                } label: {
                    Text(.mobileThreadTabs)
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("thread-views")
                if !isConnected {
                    Label {
                        Text(.mobileReconnectingBanner)
                    } icon: {
                        Image(systemName: "wifi.slash")
                    }
                    .font(.footnote)
                    .foregroundStyle(Tone.attention.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        if let thread {
            ToolbarItemGroup(placement: .topBarTrailing) {
                pullRequestChip
                Menu {
                    if thread.status.isBusy {
                        Button {
                            interrupt()
                        } label: {
                            Label(.mobileComposerInterrupt, systemImage: "stop.circle")
                        }
                    }
                    ForEach(ThreadAction.offered(by: thread), id: \.self) { action in
                        Button {
                            run(action, thread: thread)
                        } label: {
                            Label {
                                action.label
                            } icon: {
                                Image(systemName: action.symbol)
                            }
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel(Text(.mobileThreadActionsHint))
            }
        }
    }

    @ViewBuilder private var pullRequestChip: some View {
        let links = model.pullRequests.linksByThread[threadId] ?? []
        if let url = links.last?.url {
            let summary = model.pullRequests.summaries[url]?.value
            let mark = PullRequestMark(
                number: GitHubPullRequestRef(url: url)?.number ?? "?",
                status: summary?.status,
                checks: summary?.checks,
                stacked: links.count > 1)
            Button {
                tab = .pullRequests
            } label: {
                PullRequestMarkView(mark: mark)
            }
            .accessibilityLabel(mark.spokenParts(more: max(links.count - 1, 0)).joined(separator: ", "))
            .task(id: url) {
                model.pullRequests.ensureSummary(url, server: server?.id)
            }
        }
    }

    private func interrupt() {
        Task {
            do {
                _ = try await model.hub.call(RPC.threadsInterrupt, ThreadsInterruptRequest(threadId: threadId))
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    private func run(_ action: ThreadAction, thread: AgentThread) {
        if action == .copyId {
            UIPasteboard.general.string = thread.id
            AccessibilityNotification.Announcement(String(localized: .mobileThreadActionsCopied)).post()
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
}

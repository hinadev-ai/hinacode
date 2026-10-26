import HinaCodeKit
import SwiftUI

/// A pull request's page: what it is and what it needs (Info), and what it changes (Code), read through the thread's
/// desktop. Merge, close and watch act on GitHub there.
struct PullRequestView: View {
    let threadId: String
    let url: String

    @Environment(AppModel.self) private var model
    @State private var tab: Tab = .info
    @State private var busy: Action?
    @State private var actionError: String?
    @State private var pendingMerge: MergeMethod?
    @State private var confirmingClose = false

    private enum Tab: Hashable {
        case info, code
    }

    private enum Action: Equatable {
        case merge, close, watch
    }

    private var thread: AgentThread? { model.threads.threads[threadId] }
    private var serverId: String? { model.server(of: thread)?.id }
    private var remote: RemoteValue<PullRequestDetail>? { model.pullRequests.details[url] }
    private var link: PullRequestLink? {
        model.pullRequests.linksByThread[threadId]?.first { $0.url == url }
    }
    private var project: Project? {
        thread.flatMap { thread in model.threads.projects.first { $0.id == thread.projectId } }
    }

    /// The page the web button opens: linear.review when the project reviews there, else GitHub.
    private var webURL: URL? {
        URL(string: project?.linearReview == true ? GitHubPullRequestRef.linearReviewUrl(url) : url)
    }

    var body: some View {
        List {
            Group {
                content
            }
            .listRowBackground(Palette.background)
        }
        .paletteList()
        .navigationTitle(Text(verbatim: number.map { "#\($0)" } ?? ""))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                ShareLink(item: url)
            }
        }
        .safeAreaBar(edge: .top) {
            if case .ready = remote {
                Picker(.mobilePrViewLabel, selection: $tab) {
                    Text(.mobilePrTabInfo).tag(Tab.info)
                    Text(.mobilePrTabCode).tag(Tab.code)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal)
                .padding(.vertical, 6)
            }
        }
        .refreshable { await refresh() }
        .task(id: "\(url)@\(model.server(of: thread)?.generation ?? 0)") {
            await model.pullRequests.loadDetail(url, server: serverId)
        }
        .confirmationDialog(
            mergeTitle, isPresented: mergePresented, titleVisibility: .visible
        ) {
            if let method = pendingMerge {
                Button {
                    Task { await merge(method) }
                } label: {
                    Text(method.label)
                }
            }
            Button(role: .cancel) {
                pendingMerge = nil
            } label: {
                Text(.mobilePrCancel)
            }
        } message: {
            if let detail = remote?.value {
                Text(.mobilePrMergeBody(detail.headRef, detail.baseRef))
            }
        }
        .confirmationDialog(
            Text(.mobilePrCloseTitle(number ?? "")), isPresented: $confirmingClose, titleVisibility: .visible
        ) {
            Button(role: .destructive) {
                Task { await close() }
            } label: {
                Text(.mobilePrCloseConfirm)
            }
            Button(role: .cancel) {
            } label: {
                Text(.mobilePrCancel)
            }
        } message: {
            Text(.mobilePrCloseBody)
        }
    }

    private var number: String? {
        remote?.value.map { String(Int($0.number)) } ?? GitHubPullRequestRef(url: url)?.number
            ?? PullRequestsStore.pullRequestNumber(url)
    }

    private var mergePresented: Binding<Bool> {
        Binding(get: { pendingMerge != nil }, set: { if !$0 { pendingMerge = nil } })
    }

    private var mergeTitle: Text {
        guard let method = pendingMerge else { return Text(verbatim: "") }
        return Text(.mobilePrMergeTitle(String(localized: method.label), number ?? ""))
    }

    @ViewBuilder private var content: some View {
        switch remote {
        case .ready(let detail, _):
            header(detail)
            switch tab {
            case .info: info(detail)
            case .code: PullRequestCodeView(threadId: threadId, detail: detail)
            }
        case .error(let message, let tag, _):
            Section {
                Label {
                    tag == "SchemaError" ? Text(.mobilePrUpdateDesktop) : Text(.mobilePrDetailFailed(message))
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                }
                .foregroundStyle(Tone.danger.color)
                Button(.mobilePrRetry) {
                    Task { await model.pullRequests.loadDetail(url, server: serverId, force: true) }
                }
                webLink
            }
        case .loading, nil:
            Section {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(.mobilePrDetailLoading)
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 44)
            }
        }
    }

    private func header(_ detail: PullRequestDetail) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: detail.title)
                        .font(.title3.weight(.semibold))
                        .textSelection(.enabled)
                    Text(verbatim: "#\(Int(detail.number))")
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                HStack(spacing: 8) {
                    Text(.mobilePrAuthor(detail.author))
                    Text(verbatim: "\(detail.headRef) → \(detail.baseRef)")
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(1)
                    PullRequestSize(additions: Int(detail.additions), deletions: Int(detail.deletions))
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
                PullRequestPills(
                    status: detail.status, checks: detail.checks, review: detail.review,
                    watching: link?.watch != nil, mergeable: detail.mergeable)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(headerLabel(detail))
        }
    }

    private func headerLabel(_ detail: PullRequestDetail) -> String {
        var parts = [
            String(localized: .mobilePrNumber(String(Int(detail.number)))),
            detail.title,
            String(localized: detail.status.label),
            String(localized: .mobilePrAuthor(detail.author)),
            String(localized: .mobilePrSize(String(Int(detail.additions)), String(Int(detail.deletions)))),
        ]
        if let checks = detail.checks { parts.append(String(localized: checks.label)) }
        if let review = detail.review, let label = review.label { parts.append(String(localized: label)) }
        if detail.status.isOpen, detail.mergeable == .mergeable {
            parts.append(String(localized: .mobilePrMergeable))
        }
        if detail.status.isOpen, detail.mergeable == .conflicting {
            parts.append(String(localized: .mobilePrConflicting))
        }
        if link?.watch != nil { parts.append(String(localized: .mobilePrWatching)) }
        return parts.joined(separator: ", ")
    }

    @ViewBuilder private func info(_ detail: PullRequestDetail) -> some View {
        if detail.status.isOpen, detail.mergeable == .conflicting {
            Section {
                Label(.mobilePrConflicts(detail.baseRef), systemImage: "exclamationmark.triangle")
                    .foregroundStyle(Tone.attention.color)
                AskAgentButton(
                    threadId: threadId, label: .mobilePrResolve,
                    prompt: PullRequestPrompt.resolveConflicts(detail))
            }
        }
        actions(detail)
        checks(detail)
        Section {
            if detail.body.isEmpty {
                Text(.mobilePrNoDescription)
                    .foregroundStyle(.secondary)
            } else {
                MarkdownView(
                    detail.body, root: nil,
                    loadImage: { _, _ in throw RpcError("Offline", "No workspace for a pull request body.") },
                    openFile: { _, _ in })
            }
        } header: {
            Text(.mobilePrDescription)
        }
    }

    private func actions(_ detail: PullRequestDetail) -> some View {
        Section {
            if let actionError {
                Label {
                    Text(verbatim: actionError)
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                }
                .foregroundStyle(Tone.danger.color)
            }
            if detail.status == .open, detail.mergeable != .conflicting {
                Menu {
                    ForEach(MergeMethod.allCases, id: \.self) { method in
                        Button {
                            pendingMerge = method
                        } label: {
                            Text(method.label)
                        }
                    }
                } label: {
                    HStack {
                        Label(.mobilePrMerge, systemImage: "arrow.triangle.merge")
                        Spacer()
                        if busy == .merge { ProgressView() }
                        Text(.mobilePrMergeMethod)
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.up.chevron.down")
                            .foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .disabled(busy != nil)
            }
            if detail.status == .draft {
                Text(.mobilePrMergeBlockedDraft)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if detail.status.isOpen, detail.mergeable == .conflicting {
                Text(.mobilePrMergeBlockedConflicts)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if detail.status.isOpen {
                Button(role: .destructive) {
                    confirmingClose = true
                } label: {
                    HStack {
                        Label(.mobilePrClose, systemImage: "xmark.circle")
                        Spacer()
                        if busy == .close { ProgressView() }
                    }
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .disabled(busy != nil)
                watchRow(watching: link?.watch != nil)
            }
            webLink
        }
    }

    private func watchRow(watching: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                Task { await setWatching(!watching) }
            } label: {
                HStack {
                    Label {
                        watching ? Text(.mobilePrUnwatch) : Text(.mobilePrWatch)
                    } icon: {
                        Image(systemName: watching ? "eye.slash" : "eye")
                    }
                    Spacer()
                    if busy == .watch { ProgressView() }
                }
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(busy != nil)
            .accessibilityHint(Text(.mobilePrWatchHint))
            Text(.mobilePrWatchHint)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var webLink: some View {
        if let webURL {
            Link(destination: webURL) {
                HStack {
                    Label {
                        project?.linearReview == true
                            ? Text(.mobilePrOpenLinearReview) : Text(.mobilePrOpenGithub)
                    } icon: {
                        Image(systemName: "arrow.up.forward.square")
                    }
                    Spacer()
                }
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
        }
    }

    private func checks(_ detail: PullRequestDetail) -> some View {
        let sorted = detail.checkRuns.enumerated().sorted {
            $0.element.status.rank == $1.element.status.rank
                ? $0.offset < $1.offset : $0.element.status.rank < $1.element.status.rank
        }
        let failing = detail.checkRuns.filter { $0.status == .failing }.count
        return Section {
            if sorted.isEmpty {
                Text(.mobilePrNoChecks)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(sorted, id: \.offset) { _, run in
                    CheckRunRow(run: run)
                }
            }
            if failing > 0, detail.status.isOpen {
                Label(.mobilePrFailingCount(String(failing)), systemImage: "exclamationmark.triangle")
                    .foregroundStyle(Tone.danger.color)
                AskAgentButton(
                    threadId: threadId, label: .mobilePrFix, prompt: PullRequestPrompt.fixChecks(detail))
            }
        } header: {
            Text(.mobilePrChecks)
        }
    }

    private func refresh() async {
        await model.pullRequests.loadDetail(url, server: serverId, force: true)
        guard let detail = model.pullRequests.details[url]?.value else { return }
        if tab == .code {
            if model.pullRequests.files(url: url, head: detail.head) != nil {
                await model.pullRequests.loadFiles(url, head: detail.head, server: serverId, force: true)
            }
            if model.pullRequests.guides[url] != nil {
                await model.pullRequests.loadGuide(url, server: serverId, force: true)
            }
        }
    }

    private func merge(_ method: MergeMethod) async {
        pendingMerge = nil
        busy = .merge
        defer { busy = nil }
        do {
            _ = try await model.hub.call(RPC.githubMerge, .init(url: url, method: method), server: serverId)
            actionError = nil
            await model.pullRequests.loadDetail(url, server: serverId, force: true)
            await model.pullRequests.loadPullRequest(url, server: serverId, force: true)
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func close() async {
        busy = .close
        defer { busy = nil }
        do {
            _ = try await model.hub.call(RPC.githubClose, .init(url: url), server: serverId)
            actionError = nil
            await model.pullRequests.loadDetail(url, server: serverId, force: true)
            await model.pullRequests.loadPullRequest(url, server: serverId, force: true)
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func setWatching(_ watching: Bool) async {
        busy = .watch
        defer { busy = nil }
        do {
            if watching {
                _ = try await model.hub.call(RPC.pullRequestsWatch, .init(threadId: threadId, url: url))
            } else {
                _ = try await model.hub.call(RPC.pullRequestsUnwatch, .init(threadId: threadId, url: url))
            }
            actionError = nil
        } catch {
            actionError = error.localizedDescription
        }
    }
}

/// Sends a prompt into the thread so its agent acts, then says so.
struct AskAgentButton: View {
    let threadId: String
    let label: LocalizedStringResource
    let prompt: String

    @Environment(AppModel.self) private var model
    @State private var phase: Phase = .idle

    private enum Phase: Equatable {
        case idle, sending, sent
        case failed(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                Task { await send() }
            } label: {
                HStack {
                    Label {
                        phase == .sent ? Text(.mobilePrSent) : Text(label)
                    } icon: {
                        Image(systemName: phase == .sent ? "checkmark.circle.fill" : "sparkles")
                    }
                    Spacer()
                    if phase == .sending { ProgressView() }
                }
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .foregroundStyle(phase == .sent ? Tone.running.color : Color.accentColor)
            .disabled(phase == .sending || phase == .sent)
            .sensoryFeedback(.success, trigger: phase == .sent)
            if case .failed(let message) = phase {
                Text(verbatim: message)
                    .font(.subheadline)
                    .foregroundStyle(Tone.danger.color)
            }
        }
    }

    private func send() async {
        phase = .sending
        do {
            _ = try await model.hub.call(RPC.threadsSend, .init(threadId: threadId, prompt: prompt))
            phase = .sent
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

/// One check run: its state, its name, and a link to its logs when GitHub gave one.
private struct CheckRunRow: View {
    let run: CheckRun

    var body: some View {
        Group {
            if let destination = run.url.flatMap(URL.init(string:)),
                destination.scheme == "http" || destination.scheme == "https"
            {
                Link(destination: destination) { row }
                    .accessibilityHint(Text(.mobilePrCheckOpen))
            } else {
                row
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(run.name), \(String(localized: run.status.label))"))
    }

    private var row: some View {
        HStack(spacing: 10) {
            statusIcon
                .accessibilityHidden(true)
            Text(verbatim: run.name)
                .foregroundStyle(run.status == .failing ? .primary : .secondary)
                .lineLimit(1)
            Spacer(minLength: 8)
            if run.url != nil {
                Image(systemName: "arrow.up.forward.square")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 44)
        .contentShape(.rect)
    }

    @ViewBuilder private var statusIcon: some View {
        switch run.status {
        case .passing:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.secondary)
        case .failing:
            Image(systemName: "xmark.circle").foregroundStyle(Tone.danger.color)
        case .pending:
            ProgressView()
        case .skipped:
            Image(systemName: "minus.circle").foregroundStyle(.secondary)
        case .unknown:
            Image(systemName: "clock").foregroundStyle(.secondary)
        }
    }
}

extension CheckRunStatus {
    /// Failing first, then running, passing and skipped, as the checks list orders them.
    var rank: Int {
        switch self {
        case .failing: 0
        case .pending: 1
        case .passing: 2
        case .skipped: 3
        case .unknown: 4
        }
    }

    var label: LocalizedStringResource {
        switch self {
        case .passing: .mobilePrCheckPassing
        case .failing: .mobilePrCheckFailing
        case .pending, .unknown: .mobilePrCheckPending
        case .skipped: .mobilePrCheckSkipped
        }
    }
}

extension MergeMethod {
    var label: LocalizedStringResource {
        switch self {
        case .squash: .mobilePrMergeSquash
        case .merge: .mobilePrMergeCommit
        case .rebase: .mobilePrMergeRebase
        }
    }
}

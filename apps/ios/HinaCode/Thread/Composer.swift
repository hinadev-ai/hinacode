import HinaCodeKit
import SwiftUI

/// The message bar floating at the bottom of the chat: the draft, completions for `@` files and threads and for
/// `/` and `$` commands, the thread settings and workspace chips, and send, steer or stop.
struct Composer: View {
    let threadId: String

    @Environment(AppModel.self) private var model
    @State private var commands: [AgentCommand] = []
    @State private var files: [String] = []
    @State private var loadedFilesKey = ""
    @State private var error: String?
    @State private var selection: TextSelection?
    @State private var showSettings = false
    @State private var showWorkspace = false
    @State private var sentTick = 0
    @FocusState private var focused: Bool

    private var thread: AgentThread? { model.threads.threads[threadId] }
    private var server: ServerHub.Server? { model.server(of: thread) }
    private var isConnected: Bool { server?.status == .connected }
    private var busy: Bool { thread?.status.isBusy ?? false }
    private var text: String { model.drafts.texts[threadId] ?? "" }
    private var isBlank: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private var unstarted: Bool {
        guard let thread, case .ready(let transcript) = model.messages.histories[threadId] else { return false }
        return transcript.messages.isEmpty && thread.worktreeId == nil
    }

    /// The caret as a UTF-16 offset. The selection's indices come from the text field's own string, and measuring
    /// a distance to one traps when it is stale (the text changed under it), so match it by position instead and
    /// fall back to the end.
    private var caret: Int {
        guard let selection, case .selection(let range) = selection.indices else { return text.utf16.count }
        for (offset, index) in text.utf16.indices.enumerated() where index == range.upperBound {
            return offset
        }
        return text.utf16.count
    }

    private var completion: ComposerSyntax.Completion? {
        ComposerSyntax.completion(in: text, caret: caret)
    }

    private var suggestions: [ComposerSyntax.Suggestion] {
        guard let completion, let thread else { return [] }
        let others = ThreadsStore.sortThreads(
            model.threads.threads.values.filter {
                $0.projectId == thread.projectId && $0.id != threadId && $0.status != .archived
            })
        return ComposerSyntax.suggestions(for: completion, commands: commands, files: files, threads: others)
    }

    private var modelLabel: String {
        guard let thread else { return "" }
        let listed = model.models.models(server: server?.id, provider: thread.provider) ?? []
        return listed.first { $0.id == thread.model }?.label ?? thread.model
    }

    var body: some View {
        if let thread {
            VStack(alignment: .leading, spacing: 6) {
                sendingBlocks
                suggestionList
                VStack(alignment: .leading, spacing: 2) {
                    TextField(
                        text: textBinding, selection: $selection,
                        prompt: Text(busy ? .mobileComposerPlaceholderSteer : .mobileComposerPlaceholder),
                        axis: .vertical
                    ) {
                        Text(.mobileComposerMessage)
                    }
                    .lineLimit(1...8)
                    .focused($focused)
                    .padding(.horizontal, 8)
                    .padding(.top, 8)
                    .accessibilityIdentifier("composer-field")
                    HStack(spacing: 6) {
                        settingsChip(thread)
                        if unstarted {
                            WorkspaceChip(threadId: threadId, projectId: thread.projectId) {
                                showWorkspace = true
                            }
                        }
                        Spacer(minLength: 0)
                        sendButton
                    }
                }
                .padding(.horizontal, 6)
                .glassEffect(in: .rect(cornerRadius: 24))
                if let error {
                    Text(verbatim: error)
                        .font(.footnote)
                        .foregroundStyle(Tone.danger.color)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .sensoryFeedback(.success, trigger: sentTick)
            .sheet(isPresented: $showSettings) {
                ThreadSettingsSheet(threadId: threadId, error: $error)
            }
            .sheet(isPresented: $showWorkspace) {
                WorkspaceSheet(threadId: threadId, projectId: thread.projectId, error: $error)
            }
            .task(id: commandsKey(thread)) { await loadCommands(thread) }
            .task(id: modelsKey(thread)) { await loadModels(thread) }
            .task(id: filesKey(thread)) { await loadFiles(thread) }
        }
    }

    @ViewBuilder private var sendingBlocks: some View {
        ForEach(model.drafts.sending[threadId] ?? []) { prompt in
            VStack(alignment: .leading, spacing: 2) {
                Text(isConnected ? .mobileComposerSending : .mobileComposerSendsWhenBack)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Text(verbatim: prompt.text)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder private var suggestionList: some View {
        if let completion, !suggestions.isEmpty {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(suggestions.enumerated()), id: \.offset) { _, suggestion in
                        Button {
                            pick(suggestion, completion: completion)
                        } label: {
                            SuggestionRow(suggestion: suggestion)
                                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(maxHeight: 216)
            .glassEffect(in: .rect(cornerRadius: 14))
            .accessibilityLabel(
                Text(completion.trigger == .at ? .mobileComposerMentions : .mobileComposerCommands))
        }
    }

    private func settingsChip(_ thread: AgentThread) -> some View {
        Button {
            showSettings = true
        } label: {
            HStack(spacing: 5) {
                ProviderMark(provider: thread.provider, size: 13)
                Text(verbatim: modelLabel)
                Image(systemName: "chevron.down")
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.composerChip)
        .accessibilityLabel(Text(.mobileComposerSettings))
        .accessibilityValue("\(String(localized: thread.provider.name)), \(modelLabel)")
    }

    /// Send, or Stop while a turn runs and the draft is empty. One button, so the arrow turns into the stop square
    /// in place.
    private var sendButton: some View {
        let stops = busy && isBlank
        let enabled = stops || !isBlank
        return Button(role: stops ? .destructive : nil) {
            if stops { interrupt() } else { submit() }
        } label: {
            Image(systemName: stops ? "stop.fill" : "arrow.up")
                .font(.body.weight(.semibold))
                .foregroundStyle(enabled ? Color.white : Color.secondary)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 34, height: 34)
                .background(fill(enabled: enabled, stops: stops), in: .circle)
                .frame(width: 44, height: 44)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .animation(.snappy(duration: 0.2), value: stops)
        .animation(.snappy(duration: 0.2), value: enabled)
        .accessibilityIdentifier("composer-send")
        .accessibilityLabel(Text(stops ? .mobileComposerStop : busy ? .mobileComposerSteer : .mobileComposerSend))
        .keyboardShortcut(stops ? .cancelAction : KeyboardShortcut(.return, modifiers: .command))
    }

    private func fill(enabled: Bool, stops: Bool) -> Color {
        guard enabled else { return Color(.tertiarySystemFill) }
        return stops ? Tone.danger.color : .accentColor
    }

    private var textBinding: Binding<String> {
        Binding(
            get: { text },
            set: { typed in
                let next = ComposerSyntax.keepSkillWhole(before: text, after: typed, commands: commands)
                model.drafts.setText(next, threadId: threadId)
            })
    }

    private func pick(_ suggestion: ComposerSyntax.Suggestion, completion: ComposerSyntax.Completion) {
        let edit = completion.inserting(suggestion, into: text)
        model.drafts.setText(edit.text, threadId: threadId)
        let index = edit.text.utf16.index(
            edit.text.startIndex, offsetBy: min(edit.caret, edit.text.utf16.count))
        selection = TextSelection(insertionPoint: index)
        focused = true
    }

    private func submit() {
        guard thread != nil else { return }
        let sent = model.drafts.take(threadId: threadId)
        let prompt = sent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else {
            model.drafts.setText(sent, threadId: threadId)
            return
        }
        let steering = busy
        let workspace = unstarted ? model.drafts.workspaces[threadId] : nil
        error = nil
        sentTick += 1
        Task {
            do {
                try await model.drafts.trackSending(threadId: threadId, text: prompt) {
                    if steering {
                        _ = try await model.hub.call(
                            RPC.threadsSteer, ThreadsSteerRequest(threadId: threadId, text: prompt))
                    } else {
                        _ = try await model.hub.call(
                            RPC.threadsSend,
                            ThreadsSendRequest(
                                threadId: threadId, prompt: prompt,
                                workspace: workspace.map {
                                    WorkspaceChoice(mode: $0.mode, target: CheckoutTarget(workspaceRef: $0.ref))
                                }))
                    }
                }
                if workspace != nil { model.drafts.setWorkspace(nil, threadId: threadId) }
                model.liveActivities.follow(threadId: threadId)
            } catch {
                model.drafts.restore(sent, threadId: threadId)
                self.error = error.localizedDescription
            }
        }
    }

    private func interrupt() {
        error = nil
        Task {
            do {
                _ = try await model.hub.call(RPC.threadsInterrupt, ThreadsInterruptRequest(threadId: threadId))
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func commandsKey(_ thread: AgentThread) -> String {
        "\(threadId)|\(thread.provider.rawValue)|\(thread.accountId ?? "")|\(thread.worktreeId ?? "")|\(busy)|\(isConnected)"
    }

    private func modelsKey(_ thread: AgentThread) -> String {
        "\(server?.id ?? "")|\(thread.provider.rawValue)|\(isConnected)"
    }

    private func filesKey(_ thread: AgentThread) -> String {
        "\(threadId)|\(thread.worktreeId ?? "")|\(busy)|\(completion?.trigger == .at)|\(isConnected)"
    }

    private func loadCommands(_ thread: AgentThread) async {
        guard isConnected else { return }
        do {
            commands = try await model.hub.call(RPC.commandsList, CommandsListRequest(threadId: threadId))
        } catch {
            self.error = String(localized: .mobileComposerCommandsFailed(error.localizedDescription))
        }
    }

    private func loadModels(_ thread: AgentThread) async {
        guard isConnected else { return }
        do {
            try await model.models.load(server: server?.id, provider: thread.provider)
        } catch {
            self.error = String(localized: .mobileSettingsModelsFailed(error.localizedDescription))
        }
    }

    private func loadFiles(_ thread: AgentThread) async {
        guard isConnected, completion?.trigger == .at else { return }
        let key = "\(threadId)|\(thread.worktreeId ?? "")|\(busy)"
        guard key != loadedFilesKey else { return }
        do {
            files = try await model.hub.call(RPC.filesList, FilesListRequest(threadId: threadId))
            loadedFilesKey = key
        } catch {
            self.error = String(localized: .mobileComposerFilesFailed(error.localizedDescription))
        }
    }
}

private struct SuggestionRow: View {
    let suggestion: ComposerSyntax.Suggestion

    var body: some View {
        switch suggestion {
        case .command(let command):
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: suggestion.insert)
                        .font(.system(.body, design: .monospaced))
                    if !command.argumentHint.isEmpty {
                        Text(verbatim: command.argumentHint)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                if !command.description.isEmpty {
                    Text(verbatim: command.description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        case .file(let path):
            Label {
                Text(verbatim: path)
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.head)
            } icon: {
                Image(systemName: "doc")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        case .thread(let thread):
            HStack(spacing: 8) {
                ProviderMark(provider: thread.provider)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: thread.title.isEmpty ? String(localized: .mobileHomeUntitled) : thread.title)
                        .lineLimit(1)
                    Text(verbatim: thread.model)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }
}

/// A compact control on the composer's glass. A plain fill rather than glass, since glass cannot sit on glass.
struct ComposerChipStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.footnote)
            .imageScale(.small)
            .lineLimit(1)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(.fill.tertiary, in: .capsule)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .frame(minHeight: 44)
            .contentShape(.rect)
    }
}

extension ButtonStyle where Self == ComposerChipStyle {
    static var composerChip: ComposerChipStyle { ComposerChipStyle() }
}

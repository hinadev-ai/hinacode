import HinaCodeKit
import SwiftUI

/// Which agent, model, effort and access a thread runs with. Every pick asks the desktop and upserts its answer;
/// the sheet stays open. The agent can only change before the first message.
struct ThreadSettingsSheet: View {
    let threadId: String
    @Binding var error: String?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    private var thread: AgentThread? { model.threads.threads[threadId] }

    private var unstarted: Bool {
        guard let thread, case .ready(let transcript) = model.messages.histories[threadId] else { return false }
        return transcript.messages.isEmpty && thread.worktreeId == nil
    }

    /// The server's models for the thread's agent, with the thread's own model prepended when it is not listed.
    private var models: [ModelInfo] {
        guard let thread else { return [] }
        let listed = model.models.models(server: model.server(of: thread)?.id, provider: thread.provider) ?? []
        if listed.contains(where: { $0.id == thread.model }) { return listed }
        let unlisted = ModelInfo(
            id: thread.model, label: thread.model, provider: thread.provider, efforts: [], fastMode: false,
            autoMode: false)
        return [unlisted] + listed
    }

    private var currentModel: ModelInfo? { models.first { $0.id == thread?.model } }
    private var currentListed: Bool {
        guard let thread else { return false }
        return (model.models.models(server: model.server(of: thread)?.id, provider: thread.provider) ?? [])
            .contains { $0.id == thread.model }
    }

    var body: some View {
        NavigationStack {
            List {
                Group {
                    if let thread {
                        if unstarted { agentSection(thread) }
                        modelSection(thread)
                        if currentListed, let current = currentModel, !current.efforts.isEmpty {
                            effortSection(thread, model: current)
                        }
                        if let current = currentModel, current.fastMode {
                            speedSection(thread)
                        }
                        accessSection(thread)
                    }
                }
                .listRowBackground(Palette.background)
            }
            .paletteList()
            .navigationTitle(Text(.mobileComposerSettings))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Text(.mobileSettingsDone)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func agentSection(_ thread: AgentThread) -> some View {
        Section {
            ForEach(ProviderId.known, id: \.rawValue) { provider in
                optionRow(selected: thread.provider == provider) {
                    update(ThreadsUpdateRequest(id: thread.id, provider: provider))
                } label: {
                    HStack(spacing: 8) {
                        ProviderMark(provider: provider)
                        Text(provider.name)
                    }
                }
            }
        } header: {
            Text(.mobileComposerAgent)
        }
    }

    private func modelSection(_ thread: AgentThread) -> some View {
        Section {
            ForEach(models) { candidate in
                optionRow(selected: thread.model == candidate.id) {
                    pick(candidate, thread: thread)
                } label: {
                    Text(verbatim: candidate.label)
                }
            }
        } header: {
            Text(.mobileComposerModel)
        }
    }

    private func effortSection(_ thread: AgentThread, model current: ModelInfo) -> some View {
        Section {
            optionRow(selected: thread.effort == nil) {
                update(ThreadsUpdateRequest(id: thread.id, effort: .some(nil)))
            } label: {
                if let fallback = current.defaultEffort {
                    Text(.mobileComposerDefaultEffortNamed(Self.effortText(fallback)))
                } else {
                    Text(.mobileComposerDefaultEffort)
                }
            }
            ForEach(current.efforts, id: \.self) { effort in
                optionRow(selected: thread.effort == effort) {
                    update(ThreadsUpdateRequest(id: thread.id, effort: .some(effort)))
                } label: {
                    Self.effortLabel(effort)
                }
            }
        } header: {
            Text(.mobileComposerEffort)
        }
    }

    private func speedSection(_ thread: AgentThread) -> some View {
        Section {
            Toggle(
                isOn: Binding(
                    get: { thread.fastMode }, set: { update(ThreadsUpdateRequest(id: thread.id, fastMode: $0)) })
            ) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(.mobileComposerFastMode)
                        Text(.mobileComposerFastModeHint)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "bolt.fill")
                }
            }
        } header: {
            Text(.mobileComposerSpeed)
        }
    }

    private func accessSection(_ thread: AgentThread) -> some View {
        Section {
            ForEach(AccessMode.known, id: \.rawValue) { mode in
                optionRow(selected: thread.accessMode == mode) {
                    update(ThreadsUpdateRequest(id: thread.id, accessMode: mode))
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(Self.accessLabel(mode))
                                .foregroundStyle(mode == .full ? Tone.danger.color : Color.primary)
                            Text(Self.accessHint(mode))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: Self.accessSymbol(mode))
                    }
                }
            }
        } header: {
            Text(.mobileComposerAccess)
        }
    }

    private func optionRow(
        selected: Bool, action: @escaping () -> Void, @ViewBuilder label: () -> some View
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                label()
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.accentColor)
                }
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func pick(_ candidate: ModelInfo, thread: AgentThread) {
        guard candidate.id != thread.model else { return }
        let effort: String?? =
            if let effort = thread.effort, !candidate.efforts.contains(effort) { .some(nil) } else { nil }
        let fastMode: Bool? = thread.fastMode && !candidate.fastMode ? false : nil
        update(ThreadsUpdateRequest(id: thread.id, model: candidate.id, effort: effort, fastMode: fastMode))
    }

    private func update(_ request: ThreadsUpdateRequest) {
        Task {
            do {
                let updated = try await model.hub.call(RPC.threadsUpdate, request)
                model.threads.upsert(updated)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    static func effortLabel(_ effort: String) -> Text {
        switch effort {
        case "minimal": Text(.mobileComposerEffortMinimal)
        case "low": Text(.mobileComposerEffortLow)
        case "medium": Text(.mobileComposerEffortMedium)
        case "high": Text(.mobileComposerEffortHigh)
        case "xhigh": Text(.mobileComposerEffortXhigh)
        case "max": Text(.mobileComposerEffortMax)
        case "ultra": Text(.mobileComposerEffortUltra)
        default: Text(verbatim: effort)
        }
    }

    static func effortText(_ effort: String) -> String {
        switch effort {
        case "minimal": String(localized: .mobileComposerEffortMinimal)
        case "low": String(localized: .mobileComposerEffortLow)
        case "medium": String(localized: .mobileComposerEffortMedium)
        case "high": String(localized: .mobileComposerEffortHigh)
        case "xhigh": String(localized: .mobileComposerEffortXhigh)
        case "max": String(localized: .mobileComposerEffortMax)
        case "ultra": String(localized: .mobileComposerEffortUltra)
        default: effort
        }
    }

    static func accessLabel(_ mode: AccessMode) -> LocalizedStringResource {
        switch mode {
        case .supervised: .mobileSettingsAccessSupervised
        case .auto: .mobileSettingsAccessAuto
        case .full: .mobileSettingsAccessFull
        case .unknown(let value): LocalizedStringResource(stringLiteral: value)
        }
    }

    static func accessHint(_ mode: AccessMode) -> LocalizedStringResource {
        switch mode {
        case .supervised: .mobileSettingsAccessSupervisedHint
        case .auto: .mobileSettingsAccessAutoHint
        case .full: .mobileSettingsAccessFullHint
        case .unknown(let value): LocalizedStringResource(stringLiteral: value)
        }
    }

    static func accessSymbol(_ mode: AccessMode) -> String {
        switch mode {
        case .supervised: "shield.lefthalf.filled"
        case .auto: "checkmark.shield"
        case .full: "lock.open"
        case .unknown: "shield"
        }
    }
}

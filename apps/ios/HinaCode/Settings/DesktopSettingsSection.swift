import HinaCodeKit
import SwiftUI

extension Settings.DefaultModel {
    func model(for provider: ProviderId) -> String? {
        switch provider {
        case .claude: claude
        case .codex: codex
        case .muse: muse
        case .unknown: nil
        }
    }

    mutating func set(_ id: String?, for provider: ProviderId) {
        switch provider {
        case .claude: claude = id
        case .codex: codex = id
        case .muse: muse = id
        case .unknown: break
        }
    }
}

/// The server picker (when several are paired) and the chosen server's desktop settings.
struct DesktopSettingsSections: View {
    @Environment(AppModel.self) private var model
    @State private var chosenId: String?

    var body: some View {
        let servers = model.hub.servers
        let server =
            servers.first { $0.id == chosenId } ?? servers.first { $0.status == .connected } ?? servers.first

        if servers.count > 1, let server {
            Section {
                Picker(selection: pickerSelection(server)) {
                    ForEach(servers) { entry in
                        Text(verbatim: entry.settingsName).tag(entry.id)
                    }
                } label: {
                    Label(.mobileSettingsServerSettings, systemImage: "desktopcomputer.and.macbook")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            } header: {
                Text(.mobileSettingsServerSettings)
            }
        }

        ServerPreferencesSections(server: server)
            .id(server?.id ?? "")
    }

    private func pickerSelection(_ current: ServerHub.Server) -> Binding<String> {
        Binding(get: { current.id }, set: { chosenId = $0 })
    }
}

/// One server's settings, loaded once per handshake with it. Writes show at once and roll back when refused.
private struct ServerPreferencesSections: View {
    @Environment(AppModel.self) private var model

    let server: ServerHub.Server?

    @State private var settings: Settings?
    @State private var loadError: String?
    @State private var writeError: String?
    @State private var attempt = 0

    private var offline: Bool { server?.status != .connected }

    var body: some View {
        Group {
            if let settings {
                loaded(settings)
            } else {
                Section {
                    if let loadError {
                        LoadFailedRows(message: loadError) { retry() }
                    } else {
                        Label {
                            Text(.mobileSettingsLoading)
                        } icon: {
                            ProgressView()
                        }
                    }
                } header: {
                    if let server {
                        Text(verbatim: server.settingsName)
                    } else {
                        Text(.mobileSettingsServers)
                    }
                }
            }
        }
        .task(id: LoadKey(serverId: server?.id, generation: server?.generation ?? 0, attempt: attempt)) {
            await load()
        }
    }

    private struct LoadKey: Hashable {
        let serverId: String?
        let generation: Int
        let attempt: Int
    }

    @ViewBuilder private func loaded(_ settings: Settings) -> some View {
        if let writeError {
            Section {
                Label(.mobileSettingsSaveFailed(writeError), systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(Palette.destructive)
            }
        }
        if let loadError {
            Section {
                LoadFailedRows(message: loadError) { retry() }
            }
        }

        Section {
            Picker(selection: accessSelection(settings)) {
                ForEach(AccessMode.known, id: \.self) { mode in
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(Self.accessLabel(mode))
                            Text(Self.accessHint(mode))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: Self.accessSymbol(mode))
                            .foregroundStyle(!offline && mode == .full ? Palette.destructive : Color.secondary)
                    }
                    .tag(mode)
                }
            } label: {
                Label(.mobileSettingsAccess, systemImage: "checkmark.shield")
            }
            .pickerStyle(.inline)
            .labelsHidden()
            .disabled(offline)
        } header: {
            Text(.mobileSettingsAccess)
        } footer: {
            if offline {
                Text(.mobileSettingsServerOffline(server?.settingsName ?? ""))
            } else {
                Text(.mobileSettingsServerFootnote(server?.settingsName ?? ""))
            }
        }

        Section {
            ForEach(ProviderId.known, id: \.self) { provider in
                DefaultModelRow(
                    provider: provider, modelId: settings.defaultModel.model(for: provider),
                    server: server, offline: offline
                ) { id in
                    pickModel(provider: provider, id: id, from: settings)
                }
            }
        } header: {
            Text(.mobileSettingsDefaultModel)
        }

        Section {
            Toggle(isOn: archiveBinding(settings, \.whenMerged)) {
                Label(.mobileSettingsArchiveWhenMerged, systemImage: "arrow.triangle.branch")
            }
            Toggle(isOn: archiveBinding(settings, \.removeWorktree)) {
                Label(.mobileSettingsArchiveRemoveWorktree, systemImage: "archivebox")
            }
        } header: {
            Text(.mobileSettingsArchiving)
        } footer: {
            Text(.mobileSettingsArchiveFootnote)
        }
        .disabled(offline)
    }

    private static func accessLabel(_ mode: AccessMode) -> LocalizedStringResource {
        switch mode {
        case .supervised: .mobileSettingsAccessSupervised
        case .auto: .mobileSettingsAccessAuto
        case .full: .mobileSettingsAccessFull
        case .unknown(let raw): LocalizedStringResource(stringLiteral: raw)
        }
    }

    private static func accessHint(_ mode: AccessMode) -> LocalizedStringResource {
        switch mode {
        case .supervised: .mobileSettingsAccessSupervisedHint
        case .auto: .mobileSettingsAccessAutoHint
        case .full: .mobileSettingsAccessFullHint
        case .unknown: .mobileSettingsAccessAutoHint
        }
    }

    private static func accessSymbol(_ mode: AccessMode) -> String {
        switch mode {
        case .supervised: "lock.shield"
        case .auto: "checkmark.shield"
        case .full: "lock.open"
        case .unknown: "shield"
        }
    }

    private func accessSelection(_ settings: Settings) -> Binding<AccessMode> {
        Binding(
            get: { settings.defaultAccessMode },
            set: { mode in
                guard settings.defaultAccessMode != mode else { return }
                write(SettingsSetRequest(defaultAccessMode: mode)) { $0.defaultAccessMode = mode }
            })
    }

    private func archiveBinding(
        _ settings: Settings, _ keyPath: WritableKeyPath<ArchiveSettings, Bool>
    ) -> Binding<Bool> {
        Binding(
            get: { settings.archive[keyPath: keyPath] },
            set: { value in
                var archive = settings.archive
                archive[keyPath: keyPath] = value
                write(SettingsSetRequest(archive: archive)) { $0.archive = archive }
            })
    }

    private func pickModel(provider: ProviderId, id: String?, from settings: Settings) {
        guard settings.defaultModel.model(for: provider) != id else { return }
        var defaultModel = settings.defaultModel
        defaultModel.set(id, for: provider)
        write(SettingsSetRequest(defaultModel: defaultModel)) { $0.defaultModel = defaultModel }
    }

    private func load() async {
        guard let server else { return }
        do {
            settings = try await model.hub.call(RPC.settingsGet, server: server.id)
            loadError = nil
        } catch {
            if !Task.isCancelled { loadError = error.localizedDescription }
        }
    }

    private func retry() {
        loadError = nil
        attempt += 1
    }

    private func write(_ request: SettingsSetRequest, apply: (inout Settings) -> Void) {
        guard let previous = settings, !offline else { return }
        var next = previous
        apply(&next)
        settings = next
        writeError = nil
        let serverId = server?.id
        Task {
            do {
                settings = try await model.hub.call(RPC.settingsSet, request, server: serverId)
            } catch {
                settings = previous
                writeError = error.localizedDescription
            }
        }
    }
}

/// A failed read with its retry, shared by the settings and model loads.
struct LoadFailedRows: View {
    let message: String
    let onRetry: () -> Void

    var body: some View {
        Label(.mobileSettingsLoadFailed(message), systemImage: "exclamationmark.triangle.fill")
            .foregroundStyle(Palette.destructive)
        Button(.mobileSettingsRetry, systemImage: "arrow.clockwise", action: onRetry)
    }
}

/// One agent's default model. Loads its models only to turn a stored id into its label.
private struct DefaultModelRow: View {
    @Environment(AppModel.self) private var model

    let provider: ProviderId
    let modelId: String?
    let server: ServerHub.Server?
    let offline: Bool
    let onPick: (String?) -> Void

    var body: some View {
        NavigationLink {
            ModelListView(provider: provider, current: modelId, serverId: server?.id, onPick: onPick)
        } label: {
            LabeledContent {
                if let modelId {
                    Text(verbatim: label(for: modelId))
                } else {
                    Text(.mobileSettingsAgentDefault)
                }
            } label: {
                Label {
                    Text(Self.agentLabel(provider))
                } icon: {
                    ProviderMark(provider: provider)
                }
            }
        }
        .disabled(offline)
        .task(id: modelId) {
            if modelId != nil { try? await model.models.load(server: server?.id, provider: provider) }
        }
    }

    private func label(for id: String) -> String {
        model.models.models(server: server?.id, provider: provider)?.first { $0.id == id }?.label ?? id
    }

    static func agentLabel(_ provider: ProviderId) -> LocalizedStringResource {
        switch provider {
        case .claude: .mobileSettingsAgentClaude
        case .codex: .mobileSettingsAgentCodex
        case .muse: .mobileSettingsAgentMuse
        case .unknown(let raw): LocalizedStringResource(stringLiteral: raw)
        }
    }
}

/// Every model one agent offers on one server, with the agent default first.
private struct ModelListView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    let provider: ProviderId
    let current: String?
    let serverId: String?
    let onPick: (String?) -> Void

    @State private var attempt = 0
    @State private var error: String?

    var body: some View {
        Form {
            Group {
                Section {
                    option(id: nil) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(.mobileSettingsAgentDefault)
                            Text(.mobileSettingsAgentDefaultHint)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    ForEach(models ?? []) { entry in
                        option(id: entry.id) {
                            Text(verbatim: entry.label)
                        }
                    }
                }

                if let error {
                    Section {
                        Label(.mobileSettingsModelsFailed(error), systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Palette.destructive)
                        Button(.mobileSettingsRetry, systemImage: "arrow.clockwise") { attempt += 1 }
                    }
                } else if models == nil {
                    Section {
                        Label {
                            Text(.mobileSettingsModelsLoading)
                        } icon: {
                            ProgressView()
                        }
                    }
                }
            }
            .listRowBackground(Palette.background)
        }
        .paletteList()
        .navigationTitle(Text(.mobileSettingsModelSheetTitle(agentName)))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: attempt) {
            do {
                try await model.models.load(server: serverId, provider: provider)
                error = nil
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }

    private var models: [ModelInfo]? {
        model.models.models(server: serverId, provider: provider)
    }

    private var agentName: String {
        String(localized: DefaultModelRow.agentLabel(provider))
    }

    @ViewBuilder private func option(id: String?, @ViewBuilder label: () -> some View) -> some View {
        Button {
            onPick(id)
            dismiss()
        } label: {
            HStack {
                label()
                    .foregroundStyle(.primary)
                Spacer()
                if current == id {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(.rect)
        }
        .accessibilityAddTraits(current == id ? [.isSelected] : [])
    }
}

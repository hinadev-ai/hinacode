import HinaCodeKit
import SwiftUI

/// A server's link state, as a tinted dot with its word.
struct ConnectionStatusLabel: View {
    let status: TransportStatus

    var body: some View {
        Label {
            Text(status.label)
        } icon: {
            Image(systemName: "circle.fill")
                .font(.caption2)
                .foregroundStyle(color)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(.mobileConnectionLabel(String(localized: status.label))))
    }

    private var color: Color {
        switch status {
        case .connected: .green
        case .connecting: .secondary
        case .offline: .orange
        case .unauthorized: .red
        }
    }
}

/// Every paired server with its status, and the way to add another.
struct ServersSection: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router

    var body: some View {
        Section {
            ForEach(model.hub.servers) { server in
                NavigationLink {
                    ServerDetailView(serverId: server.id)
                } label: {
                    ServerRow(server: server)
                }
            }
            Button(.mobileSettingsAddServer, systemImage: "plus") {
                router.sheet = .addServer
            }
        } header: {
            Text(.mobileSettingsServers)
        } footer: {
            Text(.mobileSettingsConnectionFootnote)
        }
    }
}

/// A server as a Settings row: its name, wrapping to a second line before it truncates, and its status trailing.
private struct ServerRow: View {
    let server: ServerHub.Server

    var body: some View {
        HStack(spacing: 8) {
            Label {
                Text(verbatim: server.settingsName)
                    .lineLimit(2)
                    .truncationMode(.middle)
            } icon: {
                Image(systemName: "desktopcomputer")
            }
            Spacer(minLength: 8)
            ConnectionStatusLabel(status: server.status)
                .labelStyle(StatusDotLabelStyle())
                .foregroundStyle(.secondary)
                .fixedSize()
        }
    }
}

/// The status word with its dot before it, tighter than a list row's icon column.
private struct StatusDotLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon
            configuration.title
        }
    }
}

/// One server: where it answers, why it refused us, and the ways back in or out.
struct ServerDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss

    let serverId: String

    @State private var confirmingForget = false

    private var server: ServerHub.Server? {
        model.hub.servers.first { $0.id == serverId }
    }

    var body: some View {
        Form {
            if let server {
                Section {
                    ConnectionStatusLabel(status: server.status)

                    if server.source == .relay {
                        Label(.mobileRelayFromRelay, systemImage: "cloud")
                            .foregroundStyle(.secondary)
                    }
                    if let error = server.error {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                    }
                    if let relay = server.relay {
                        address(relay)
                    }
                    ForEach(server.hosts, id: \.self) { host in
                        address("\(host):\(server.port)")
                    }
                }

                Section {
                    if server.status == .offline {
                        Button(.mobileSettingsServerReconnect, systemImage: "arrow.clockwise") {
                            model.hub.reconnectNow(id: server.id)
                        }
                    }
                    if server.status == .unauthorized {
                        Button(.mobileSettingsServerPairAgain, systemImage: "qrcode.viewfinder") {
                            router.sheet = .addServer
                        }
                    }
                    if server.source != .relay {
                        Button(.mobileSettingsServerForget, systemImage: "minus.circle", role: .destructive) {
                            confirmingForget = true
                        }
                    }
                } footer: {
                    if server.source == .relay {
                        Text(.mobileRelayForgetHint)
                    }
                }
            }
        }
        .navigationTitle(Text(verbatim: server?.settingsName ?? ""))
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            Text(.mobileSettingsServerForgetTitle(server?.settingsName ?? "")), isPresented: $confirmingForget
        ) {
            Button(.mobileSettingsServerForget, role: .destructive) {
                model.forget(server: serverId)
                dismiss()
            }
            Button(.mobileSettingsCancel, role: .cancel) {}
        } message: {
            Text(.mobileSettingsServerForgetMessage)
        }
    }

    private func address(_ text: String) -> some View {
        Label {
            Text(verbatim: text)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        } icon: {
            Image(systemName: "network")
                .foregroundStyle(.secondary)
        }
    }
}

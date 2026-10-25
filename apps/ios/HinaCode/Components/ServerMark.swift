import HinaCodeKit
import SwiftUI

/// The machine a project or a thread lives on, shown only while several servers are paired.
struct ServerMark: View {
    let server: ServerHub.Server

    var body: some View {
        Label {
            Text(verbatim: server.name ?? "")
                .lineLimit(1)
        } icon: {
            Image(systemName: server.status == .connected ? "desktopcomputer" : "wifi.slash")
        }
        .labelStyle(.titleAndIcon)
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
    }
}

import HinaCodeKit
import SwiftUI

/// A shell in the thread's workspace. One shell lives as long as the panel: a reconnect catches up on the same shell
/// when the server supports `terminal-attach`, and opens a new one when it does not.
struct TerminalPanel: View {
    let features: Set<String>
    /// The thread's server's handshake count. A change means the socket came back.
    let generation: Int
    let isConnected: Bool
    // Seeded once: the thread screen keeps one panel per thread until it goes away, which closes the shell.
    @State private var shell: TerminalShell

    init(
        threadId: String, caller: any Caller, pushes: PushListeners, features: Set<String>, generation: Int,
        isConnected: Bool
    ) {
        self.features = features
        self.generation = generation
        self.isConnected = isConnected
        _shell = State(initialValue: TerminalShell(threadId: threadId, caller: caller, pushes: pushes))
    }

    private var link: TerminalShell.Link {
        TerminalShell.Link(generation: generation, features: features, connected: isConnected)
    }

    var body: some View {
        TerminalScreen(shell: shell)
            .accessibilityIdentifier("terminal-view")
            .padding(.horizontal, 4)
            .overlay { TerminalStartup(phase: shell.phase, retry: shell.retry) }
            .overlay(alignment: .topTrailing) {
                if shell.attachError != nil || (!isConnected && shell.phase == .running) {
                    TerminalLinkNotice(attachError: shell.attachError)
                }
            }
            .overlay(alignment: .bottom) {
                if shell.phase.isExited || shell.attachError != nil {
                    TerminalRestartButton(restart: shell.restart)
                }
            }
            .onChange(of: link, initial: true) { shell.update(link) }
            .onChange(of: shell.phase) { _, phase in
                if case .exited(let code) = phase {
                    AccessibilityNotification.Announcement(TerminalShell.exitText(code)).post()
                }
            }
    }
}

extension TerminalShell.Phase {
    fileprivate var isExited: Bool {
        if case .exited = self { true } else { false }
    }
}

/// Covers the terminal until its shell is open, or explains why it could not be.
private struct TerminalStartup: View {
    let phase: TerminalShell.Phase
    let retry: () -> Void

    var body: some View {
        switch phase {
        case .opening:
            ProgressView { Text(.mobileTerminalOpening) }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.background)
        case .failed(let message):
            ContentUnavailableView {
                Label {
                    Text(.mobileTerminalOpenFailed)
                } icon: {
                    Image(systemName: "apple.terminal")
                }
            } description: {
                Text(verbatim: message)
            } actions: {
                Button(action: retry) { Text(.mobileChatRetry) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            }
            .background(.background)
        case .running, .exited:
            EmptyView()
        }
    }
}

/// Floats over the top of the terminal while keys cannot reach the shell, or after catching up failed.
private struct TerminalLinkNotice: View {
    let attachError: String?

    var body: some View {
        Group {
            if let attachError {
                Label {
                    Text(.mobileTerminalReattachFailed(attachError))
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Tone.danger.color)
                }
            } else {
                Label {
                    Text(.mobileConnectionOffline)
                } icon: {
                    ProgressView()
                }
            }
        }
        .font(.footnote)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glassEffect(in: .rect(cornerRadius: 20))
        .padding(12)
        .accessibilityElement(children: .combine)
    }
}

private struct TerminalRestartButton: View {
    let restart: () -> Void

    var body: some View {
        Button(action: restart) {
            Label {
                Text(.mobileTerminalRestart)
            } icon: {
                Image(systemName: "arrow.clockwise")
            }
        }
        .buttonStyle(.glassProminent)
        .controlSize(.large)
        .padding()
    }
}

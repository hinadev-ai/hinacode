import SwiftTerm
import SwiftUI

/// The SwiftTerm view of a shell: keys go to the shell, grid sizes open and resize it, and its output is drawn here.
struct TerminalScreen: UIViewRepresentable {
    let shell: TerminalShell

    func makeUIView(context: Context) -> ShellTerminalView {
        let view = ShellTerminalView(frame: .zero)
        view.terminalDelegate = context.coordinator
        context.coordinator.openURL = context.environment.openURL
        shell.screen = view
        return view
    }

    func updateUIView(_ view: ShellTerminalView, context: Context) {
        context.coordinator.openURL = context.environment.openURL
    }

    func makeCoordinator() -> Coordinator { Coordinator(shell: shell) }

    final class Coordinator: TerminalViewDelegate {
        let shell: TerminalShell
        var openURL: OpenURLAction?

        init(shell: TerminalShell) {
            self.shell = shell
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            shell.resized(cols: newCols, rows: newRows)
        }

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            shell.send(String(decoding: data, as: UTF8.self))
        }

        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            guard let url = URL(string: link), ["http", "https"].contains(url.scheme?.lowercased()) else { return }
            openURL?(url)
        }

        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}

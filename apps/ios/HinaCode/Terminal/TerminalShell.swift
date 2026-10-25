import Foundation
import HinaCodeKit
import Observation
import SwiftTerm

/// A shell in a thread's workspace (`apps/mobile/src/components/terminal.tsx`). It opens once the screen knows its
/// grid size, catches up with `terminal.attach` after a reconnect, and is closed when the shell is released, which
/// happens when the thread screen goes away.
@MainActor
@Observable
final class TerminalShell {
    enum Phase: Equatable {
        case opening
        case failed(String)
        case running
        case exited(code: Int?)
    }

    /// What the panel knows about the link to the thread's server.
    struct Link: Equatable {
        /// The server's handshake count. A new one means the socket came back and output may be missing.
        var generation: Int
        var features: Set<String>
        var connected: Bool
    }

    struct Grid: Equatable {
        let cols: Int
        let rows: Int

        init(cols: Int, rows: Int) {
            self.cols = min(1000, max(1, cols))
            self.rows = min(1000, max(1, rows))
        }
    }

    private struct Session {
        let id: String
        var grid: Grid
        /// The link generation this screen last caught up in.
        var generation: Int
    }

    private(set) var phase = Phase.opening
    /// Why catching up after a reconnect failed, until an attach succeeds.
    private(set) var attachError: String?

    /// Where output is written. Nil while no view shows the shell.
    @ObservationIgnored weak var screen: TerminalView?

    @ObservationIgnored private let threadId: String
    @ObservationIgnored private let caller: any Caller
    @ObservationIgnored private let pushes: PushListeners
    @ObservationIgnored private var subscription: PushSubscription?
    @ObservationIgnored private var session: Session?
    @ObservationIgnored private var opening = false
    /// Output can arrive before `terminal.open` answers with the session id.
    @ObservationIgnored private var early: [PushEvent] = []
    @ObservationIgnored private var output = TerminalOutput()
    @ObservationIgnored private var grid: Grid?
    @ObservationIgnored private var link = Link(generation: 0, features: [], connected: false)
    @ObservationIgnored private var input = ""
    @ObservationIgnored private var writing = false
    @ObservationIgnored private var resizing: Task<Void, Never>?

    init(threadId: String, caller: any Caller, pushes: PushListeners) {
        self.threadId = threadId
        self.caller = caller
        self.pushes = pushes
    }

    isolated deinit {
        resizing?.cancel()
        if let id = session?.id { Self.close(id, caller) }
    }

    private var attaches: Bool { link.features.contains("terminal-attach") }

    func update(_ link: Link) {
        self.link = link
        guard link.connected, let session, session.generation != link.generation else { return }
        if attaches { attach() } else { restart() }
    }

    func resized(cols: Int, rows: Int) {
        let grid = Grid(cols: cols, rows: rows)
        guard grid != self.grid else { return }
        self.grid = grid
        if session != nil {
            scheduleResize()
        } else if phase == .opening {
            open()
        }
    }

    /// Keys typed while the shell runs and the server is reachable, in order.
    func send(_ data: String) {
        guard phase == .running, link.connected, session != nil else { return }
        input += data
        guard !writing else { return }
        writing = true
        Task { await flushInput() }
    }

    func retry() {
        guard case .failed = phase else { return }
        open()
    }

    /// Closes the current shell and opens a new one on a cleared screen.
    func restart() {
        guard !opening else { return }
        if let id = session?.id { Self.close(id, caller) }
        session = nil
        output = TerminalOutput()
        input = ""
        attachError = nil
        screen?.feed(text: TerminalOutput.reset)
        open()
    }

    private func open() {
        guard let grid, !opening else { return }
        opening = true
        phase = .opening
        if subscription == nil {
            subscription = pushes.listen { [weak self] push in self?.receive(push) }
        }
        let request = TerminalOpenRequest(threadId: threadId, cols: grid.cols, rows: grid.rows)
        Task { [weak self, caller] in
            do {
                let opened = try await caller.call(RPC.terminalOpen, request)
                guard let self else { return Self.close(opened.id, caller) }
                self.opened(opened)
            } catch {
                self?.openFailed(error)
            }
        }
    }

    private func opened(_ opened: TerminalSession) {
        opening = false
        session = Session(
            id: opened.id, grid: Grid(cols: Int(opened.cols), rows: Int(opened.rows)), generation: link.generation)
        phase = .running
        if attaches { attach() }
        let held = early
        early = []
        held.forEach(receive)
        scheduleResize()
    }

    private func openFailed(_ error: any Error) {
        opening = false
        early = []
        phase = .failed(error.localizedDescription)
    }

    private func receive(_ push: PushEvent) {
        guard let id = push.terminalId else { return }
        guard let session else {
            if opening { early.append(push) }
            return
        }
        guard id == session.id else { return }
        switch push {
        case .terminalData(let data):
            show(output.receive(data.data, offset: data.offset))
            if output.needsAttach, attaches { attach() }
        case .terminalExited(let exit):
            exited(exit.exitCode)
        default:
            break
        }
    }

    private func attach() {
        guard let id = session?.id else { return }
        session?.generation = link.generation
        let token = output.beginAttach()
        let request = TerminalAttachRequest(id: id, since: token.since)
        Task { [weak self, caller] in
            do {
                let attachment = try await caller.call(RPC.terminalAttach, request)
                self?.attached(attachment, token: token, id: id)
            } catch {
                self?.attachFailed(error, token: token, id: id)
            }
        }
    }

    private func attached(_ attachment: TerminalAttachment, token: TerminalOutput.Attach, id: String) {
        guard session?.id == id,
            let text = output.attached(token, offset: attachment.offset, data: attachment.data)
        else { return }
        attachError = nil
        show(text)
        if output.needsAttach { attach() }
        if attachment.session.status == .exited { exited(attachment.session.exitCode) }
    }

    private func attachFailed(_ error: any Error, token: TerminalOutput.Attach, id: String) {
        guard session?.id == id, let text = output.attachFailed(token) else { return }
        show(text)
        attachError = error.localizedDescription
    }

    private func exited(_ code: Double?) {
        guard phase == .running else { return }
        let code = code.map { Int($0) }
        phase = .exited(code: code)
        show("\r\n\u{1b}[2m\(Self.exitText(code))\u{1b}[0m\r\n")
    }

    static func exitText(_ code: Int?) -> String {
        String(
            localized: code.map { LocalizedStringResource.mobileTerminalExitedCode(String($0)) }
                ?? .mobileTerminalExited)
    }

    private func show(_ text: String?) {
        guard let text, !text.isEmpty else { return }
        if let screen {
            screen.feed(text: text)
        } else {
            output.lost()
        }
    }

    private func flushInput() async {
        while let id = session?.id, !input.isEmpty {
            let data = input
            input = ""
            _ = try? await caller.call(RPC.terminalWrite, TerminalWriteRequest(id: id, data: data))
        }
        writing = false
    }

    /// Rotating or bringing up the keyboard changes the grid several times in a row; only the last one is sent.
    private func scheduleResize() {
        resizing?.cancel()
        resizing = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(150))
            } catch {
                return
            }
            self?.sendResize()
        }
    }

    private func sendResize() {
        guard phase == .running, let grid, let session, session.grid != grid else { return }
        self.session?.grid = grid
        let request = TerminalResizeRequest(id: session.id, cols: grid.cols, rows: grid.rows)
        Task { [caller] in _ = try? await caller.call(RPC.terminalResize, request) }
    }

    private static func close(_ id: String, _ caller: any Caller) {
        Task { _ = try? await caller.call(RPC.terminalClose, TerminalCloseRequest(id: id)) }
    }
}

extension PushEvent {
    fileprivate var terminalId: String? {
        switch self {
        case .terminalData(let data): data.id
        case .terminalExited(let exit): exit.id
        default: nil
        }
    }
}

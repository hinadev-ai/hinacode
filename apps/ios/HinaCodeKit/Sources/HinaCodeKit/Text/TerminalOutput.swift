/// Decides what to write to the screen from a session's `terminal.data` pushes and `terminal.attach` answers, so
/// each character of the shell's output is shown once across pushes, reconnects and re-attaches
/// (`apps/mobile/src/lib/terminal-output.ts`). Offsets are positions in the session's whole output in UTF-16 code
/// units, as the desktop's JavaScript counts them.
public struct TerminalOutput: Sendable {
    /// Clears the screen and scrollback before output that does not continue what is shown.
    public static let reset = "\u{1b}c"

    /// An attach in flight. Send `since` in `terminal.attach`. A newer attach supersedes this one.
    public struct Attach: Hashable, Sendable {
        public let since: Int?
        fileprivate let id: Int
    }

    private struct Chunk: Sendable {
        let data: String
        /// Absent from older desktops.
        let offset: Int?
    }

    private struct Pending: Sendable {
        let token: Attach
        var held: [Chunk]
    }

    /// The end of what is on screen, nil when unknown.
    private var nextOffset: Int?
    /// Pushes held because output before them is missing.
    private var gap: [Chunk] = []
    private var pending: Pending?
    private var attaches = 0

    public init() {}

    /// Starts an attach. Output received until it settles is held back.
    public mutating func beginAttach() -> Attach {
        attaches += 1
        let token = Attach(since: nextOffset, id: attaches)
        pending = Pending(token: token, held: gap)
        gap = []
        return token
    }

    /// Some output is missing from the screen, so the caller should attach.
    public var needsAttach: Bool { !gap.isEmpty }

    /// What to write for a push, or "" when it is held back or already shown.
    @discardableResult
    public mutating func receive(_ data: String, offset: Int?) -> String {
        let chunk = Chunk(data: data, offset: offset)
        if pending != nil {
            pending?.held.append(chunk)
            return ""
        }
        if !gap.isEmpty {
            gap.append(chunk)
            return ""
        }
        if let nextOffset, let offset, offset > nextOffset {
            gap.append(chunk)
            return ""
        }
        return take(chunk)
    }

    /// What to write for an attach answer plus any output held back meanwhile, or nil when superseded.
    @discardableResult
    public mutating func attached(_ token: Attach, offset: Int, data: String) -> String? {
        guard let settled = pending, settled.token == token else { return nil }
        pending = nil
        var text: String
        if let since = token.since, offset <= since {
            text = String(decoding: data.utf16.dropFirst(since - offset), as: UTF16.self)
        } else {
            // The first attach, the screen lost track, or the desktop dropped output past what was shown.
            text = Self.reset + data
        }
        nextOffset = offset + data.utf16.count
        for chunk in settled.held { text += receive(chunk.data, offset: chunk.offset) }
        return text
    }

    /// The output held back for a failed attach, or nil when superseded.
    public mutating func attachFailed(_ token: Attach) -> String? {
        guard let settled = pending, settled.token == token else { return nil }
        pending = nil
        var text = ""
        for chunk in settled.held { text += take(chunk) }
        return text
    }

    /// The screen could not show some output, so the next attach repaints from the start of the scrollback.
    public mutating func lost() {
        nextOffset = nil
    }

    private mutating func take(_ chunk: Chunk) -> String {
        guard let offset = chunk.offset else { return chunk.data }
        let end = offset + chunk.data.utf16.count
        if let nextOffset, end <= nextOffset { return "" }
        let skip = nextOffset.map { max(0, $0 - offset) } ?? 0
        nextOffset = end
        return skip == 0 ? chunk.data : String(decoding: chunk.data.utf16.dropFirst(skip), as: UTF16.self)
    }
}

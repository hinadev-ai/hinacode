import Foundation

/// The composer's syntax, as the desktop composer reads it (`src/shared/composerSyntax.ts`): what to color, and the
/// `/command`, `$skill`, `@mention` or `#pull-request` token the caret is completing.
///
/// Offsets (`Completion.start`, `Completion.end`, `Edit.caret`, a caret passed in) are UTF-16 code unit offsets,
/// the unit of `NSRange` and of the desktop's JavaScript. A `String.Index` from a text field's selection belongs
/// to the field's string; match it by position against your own string's indices rather than measuring a
/// distance to it, which traps when the index is stale.
public enum ComposerSyntax {
    public enum Kind: Hashable, Sendable {
        case text, bullet, code, command, mention
        /// The skill that starts the message. Only `spans` produces it.
        case skill
    }

    public struct Span: Hashable, Sendable {
        public let kind: Kind
        public let text: String

        public init(kind: Kind, text: String) {
            self.kind = kind
            self.text = text
        }
    }

    /// Tokens worth coloring: full command tokens such as `/review`, and workspace file paths and thread ids for
    /// `@` mentions.
    public struct KnownTokens: Hashable, Sendable {
        public var commands: Set<String>
        public var files: Set<String>
        public var threads: Set<String>

        public init(commands: Set<String>, files: Set<String>, threads: Set<String>) {
            self.commands = commands
            self.files = files
            self.threads = threads
        }
    }

    /// A fenced block, kept whole so its body can be colored by its language and shown without the fence lines.
    struct Fence: Hashable, Sendable {
        /// The language word of the opening fence, "" when it names none.
        let language: String
        let open: String
        let lines: [String]
        /// Nil while the block is still unclosed.
        let close: String?

        var text: String { ([open] + lines + (close.map { [$0] } ?? [])).joined(separator: "\n") }
    }

    enum Segment: Hashable, Sendable {
        case span(Span)
        case fence(Fence)

        var text: String {
            switch self {
            case .span(let span): span.text
            case .fence(let fence): fence.text
            }
        }
    }

    /// Splits composer text into the spans the composer colors: list markers, inline and fenced code, known
    /// commands and mentions of known files. Joining the segments gives back `text`.
    static func highlight(_ text: String, known: KnownTokens) -> [Segment] {
        var segments: [Segment] = []
        let lines = text.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false).map { String($0) }
        var index = 0
        while index < lines.count {
            if index > 0 { segments.append(.span(Span(kind: .text, text: "\n"))) }
            let line = lines[index]
            if let language = fenceLanguage(line) {
                let close = lines[(index + 1)...].firstIndex { fenceLanguage($0) != nil }
                let end = close ?? lines.count
                let fence = Fence(
                    language: language, open: line, lines: Array(lines[(index + 1)..<end]),
                    close: close.map { lines[$0] })
                segments.append(.fence(fence))
                index = end + 1
                continue
            }
            let scalars = line.unicodeScalars
            var rest = scalars[...]
            if let marker = bullet(scalars) {
                segments.append(.span(Span(kind: .text, text: String(scalars[..<marker.lowerBound]))))
                segments.append(.span(Span(kind: .bullet, text: String(scalars[marker]))))
                rest = scalars[marker.upperBound...]
            }
            segments += inline(rest, known: known)
            index += 1
        }
        return merge(segments)
    }

    private static func isSpace(_ scalar: Unicode.Scalar) -> Bool { scalar.properties.isWhitespace }

    private static func isDigit(_ scalar: Unicode.Scalar) -> Bool { ("0"..."9").contains(scalar) }

    /// The language word of a line that opens or closes a fence, "" when it names none, or nil for other lines.
    private static func fenceLanguage(_ line: String) -> String? {
        let scalars = line.unicodeScalars
        guard let ticks = scalars.firstIndex(where: { !isSpace($0) }),
            scalars[ticks...].starts(with: "```".unicodeScalars)
        else { return nil }
        let afterTicks = scalars.index(ticks, offsetBy: 3)
        let start = scalars[afterTicks...].firstIndex { !isSpace($0) } ?? scalars.endIndex
        let end = scalars[start...].firstIndex { isSpace($0) || $0 == "`" } ?? scalars.endIndex
        return String(scalars[start..<end])
    }

    /// Where the marker of a list item line is: `-`, `*`, `+`, `1.` or `1)` after the indent, then whitespace.
    private static func bullet(_ line: String.UnicodeScalarView) -> Range<String.Index>? {
        guard let start = line.firstIndex(where: { !isSpace($0) }) else { return nil }
        var end = line.index(after: start)
        if !"-*+".unicodeScalars.contains(line[start]) {
            end = line[start...].firstIndex { !isDigit($0) } ?? line.endIndex
            guard end > start, end < line.endIndex, line[end] == "." || line[end] == ")" else { return nil }
            end = line.index(after: end)
        }
        guard end < line.endIndex, isSpace(line[end]) else { return nil }
        return start..<end
    }

    /// The end of the token starting at `at`: inline code, or a `/command`, `$skill` or `@file` token that starts the
    /// text or follows whitespace. Nil when none starts there.
    private static func tokenEnd(_ text: Substring.UnicodeScalarView, at: String.Index) -> String.Index? {
        let next = text.index(after: at)
        if text[at] == "`" {
            guard let close = text[next...].firstIndex(of: "`"), close > next else { return nil }
            return text.index(after: close)
        }
        guard "/$@".unicodeScalars.contains(text[at]),
            at == text.startIndex || isSpace(text[text.index(before: at)]),
            next < text.endIndex, !isSpace(text[next])
        else { return nil }
        return text[next...].firstIndex(where: isSpace) ?? text.endIndex
    }

    private static func inline(_ text: Substring.UnicodeScalarView, known: KnownTokens) -> [Segment] {
        var segments: [Segment] = []
        var last = text.startIndex
        var at = text.startIndex
        while at < text.endIndex {
            guard let end = tokenEnd(text, at: at) else {
                text.formIndex(after: &at)
                continue
            }
            if let token = classify(text[at..<end], known: known) {
                segments.append(.span(Span(kind: .text, text: String(text[last..<at]))))
                segments.append(.span(token))
                last = text.index(at, offsetBy: token.text.unicodeScalars.count)
            }
            at = end
        }
        segments.append(.span(Span(kind: .text, text: String(text[last...]))))
        return segments
    }

    private static func classify(_ token: Substring.UnicodeScalarView, known: KnownTokens) -> Span? {
        if token.first == "`" { return Span(kind: .code, text: String(token)) }
        if token.first == "@" {
            var mention = token
            // Prose punctuation right after a mention, as in "see @src/a.ts, then".
            while let last = mention.last, ",.;:!?)]".unicodeScalars.contains(last) { mention.removeLast() }
            let text = String(mention)
            let threadId = mentionedThreadId(text)
            let isKnown =
                threadId.map { known.threads.contains($0) } ?? known.files.contains(String(mention.dropFirst()))
            return isKnown ? Span(kind: .mention, text: text) : nil
        }
        let command = String(token)
        return known.commands.contains(command) ? Span(kind: .command, text: command) : nil
    }

    private static func merge(_ segments: [Segment]) -> [Segment] {
        var merged: [Segment] = []
        for segment in segments {
            guard case .span(let span) = segment else {
                merged.append(segment)
                continue
            }
            if span.text.isEmpty { continue }
            if case .span(let previous) = merged.last, previous.kind == span.kind {
                merged[merged.count - 1] = .span(Span(kind: span.kind, text: previous.text + span.text))
            } else {
                merged.append(segment)
            }
        }
        return merged
    }

    /// How a prompt names another thread (`src/shared/threadMention.ts`). Agents read it with `read_thread`.
    private static func threadMention(_ threadId: String) -> String { "@thread:\(threadId)" }

    /// The thread id of a mention token, or nil when `token` is not one.
    private static func mentionedThreadId(_ token: String) -> String? {
        guard token.hasPrefix("@thread:") else { return nil }
        let id = token.dropFirst("@thread:".count)
        let isWordOrDash = { (scalar: Unicode.Scalar) in
            scalar.isASCII && (scalar.properties.isAlphabetic || isDigit(scalar) || scalar == "_" || scalar == "-")
        }
        return !id.isEmpty && id.unicodeScalars.allSatisfy(isWordOrDash) ? String(id) : nil
    }
}

// MARK: - Completions

extension ComposerSyntax {
    public enum Trigger: String, Hashable, Sendable {
        case slash = "/"
        case dollar = "$"
        /// Mentions a file or a thread.
        case at = "@"
        /// Names a pull request.
        case hash = "#"
    }

    /// The token the caret is in. `start` and `end` cover the whole token, which a picked suggestion replaces.
    public struct Completion: Hashable, Sendable {
        public let trigger: Trigger
        /// What has been typed after the trigger, up to the caret.
        public let query: String
        /// UTF-16 offset of the trigger.
        public let start: Int
        /// UTF-16 offset of the end of the token.
        public let end: Int

        /// `text` with this token replaced by `suggestion` and a space, and the caret after the space.
        public func inserting(_ suggestion: Suggestion, into text: String) -> Edit {
            let units = Array(text.utf16)
            let insert = suggestion.insert + " "
            var rest = units[min(end, units.count)...]
            if rest.first == UInt16(UInt8(ascii: " ")) { rest = rest.dropFirst() }
            let before = String(decoding: units[..<min(start, units.count)], as: UTF16.self)
            return Edit(
                text: before + insert + String(decoding: rest, as: UTF16.self), caret: start + insert.utf16.count)
        }
    }

    /// Composer text after a change the app made, and where its caret goes, as a UTF-16 offset.
    public struct Edit: Hashable, Sendable {
        public let text: String
        public let caret: Int

        public init(text: String, caret: Int) {
            self.text = text
            self.caret = caret
        }
    }

    /// One row of the completion list. `insert` replaces the token at the caret.
    public enum Suggestion: Hashable, Sendable {
        case command(AgentCommand)
        case file(String)
        case thread(AgentThread)

        public var insert: String {
            switch self {
            case .command(let command): command.trigger.rawValue + command.name
            case .file(let path): "@" + path
            case .thread(let thread): ComposerSyntax.threadMention(thread.id)
            }
        }
    }

    /// The token the caret (a UTF-16 offset) is in, if it starts the line or follows whitespace.
    public static func completion(in text: String, caret: Int) -> Completion? {
        let units = Array(text.utf16)
        // The selection can arrive before the text it belongs to.
        let caret = min(max(caret, 0), units.count)
        let isSpaceUnit = { (unit: UInt16) in Unicode.Scalar(unit).map(isSpace) ?? false }
        var start = caret
        while start > 0, !isSpaceUnit(units[start - 1]) { start -= 1 }
        guard start < caret, let trigger = Trigger(rawValue: String(decoding: units[start...start], as: UTF16.self))
        else { return nil }
        let query = String(decoding: units[(start + 1)..<caret], as: UTF16.self)
        // A Markdown heading.
        if trigger == .hash, query.hasPrefix("#") { return nil }
        let end = units[caret...].firstIndex(where: isSpaceUnit) ?? units.count
        return Completion(trigger: trigger, query: query, start: start, end: end)
    }

    /// Threads then files for `@`, else the commands of the typed trigger, at most 50. The phone has no pull
    /// request search, so `#` suggests nothing.
    public static func suggestions(
        for completion: Completion, commands: [AgentCommand], files: [String], threads: [AgentThread]
    ) -> [Suggestion] {
        let suggestions: [Suggestion] =
            switch completion.trigger {
            case .hash: []
            case .at:
                matchThreads(threads, query: completion.query).map(Suggestion.thread)
                    + matchFiles(files, query: completion.query).map(Suggestion.file)
            case .slash, .dollar:
                matchCommands(commands, trigger: completion.trigger, query: completion.query).map(Suggestion.command)
            }
        return Array(suggestions.prefix(50))
    }

    struct Skill: Hashable, Sendable {
        let command: AgentCommand
        /// `/name ` or `$name `, including the space that ends it.
        let token: String
    }

    /// The skill `text` starts with. Built-in commands such as `/compact` are the agent's own, not skills.
    static func leadingSkill(_ text: String, commands: [AgentCommand]) -> Skill? {
        for command in commands where command.builtin != true {
            let token = command.trigger.rawValue + command.name + " "
            if text.unicodeScalars.starts(with: token.unicodeScalars) { return Skill(command: command, token: token) }
        }
        return nil
    }

    /// Commands for the trigger, names starting with the query first, then names containing it.
    static func matchCommands(_ commands: [AgentCommand], trigger: Trigger, query: String) -> [AgentCommand] {
        let needle = query.lowercased()
        var prefixed: [AgentCommand] = []
        var containing: [AgentCommand] = []
        for command in commands where command.trigger.rawValue == trigger.rawValue {
            let name = command.name.lowercased()
            if name.hasPrefix(needle) {
                prefixed.append(command)
            } else if name.contains(needle) {
                containing.append(command)
            }
        }
        return prefixed + containing
    }

    /// Files whose name starts with `query`, then whose name contains it, then whose path does; shortest first in
    /// each.
    static func matchFiles(_ files: [String], query: String) -> [String] {
        let needle = query.lowercased()
        var nameStarts: [String] = []
        var nameContains: [String] = []
        var pathContains: [String] = []
        for file in files {
            let path = file.lowercased()
            let name = path.lastIndex(of: "/").map { path[path.index(after: $0)...] } ?? path[...]
            if name.hasPrefix(needle) {
                nameStarts.append(file)
            } else if name.contains(needle) {
                nameContains.append(file)
            } else if path.contains(needle) {
                pathContains.append(file)
            }
        }
        let byLength = { (a: String, b: String) in a.utf16.count < b.utf16.count }
        return nameStarts.sorted(by: byLength) + nameContains.sorted(by: byLength) + pathContains.sorted(by: byLength)
    }

    /// Threads whose title starts with `query`, then whose title contains it, each in the given order.
    static func matchThreads(_ threads: [AgentThread], query: String) -> [AgentThread] {
        let needle = query.lowercased()
        var titleStarts: [AgentThread] = []
        var titleContains: [AgentThread] = []
        for thread in threads {
            let title = thread.title.lowercased()
            if title.hasPrefix(needle) {
                titleStarts.append(thread)
            } else if title.contains(needle) {
                titleContains.append(thread)
            }
        }
        return titleStarts + titleContains
    }
}

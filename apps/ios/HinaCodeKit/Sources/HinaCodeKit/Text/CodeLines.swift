/// Source code as lines of labeled text, for a code view (`apps/mobile/src/lib/code-lines.ts`).
public enum CodeLines {
    public struct Span: Hashable, Sendable {
        public let kind: SyntaxToken.Kind
        public let text: String

        public init(kind: SyntaxToken.Kind, text: String) {
            self.kind = kind
            self.text = text
        }
    }

    /// Splits `source` into lines of labeled text. Tokens may cross line breaks, and text no token covers, such as
    /// the part after a highlighted prefix, is plain. `\r\n` ends a line like `\n`, and a final line break does not
    /// start an empty last line. Pass nil tokens to get plain lines.
    public static func lines(_ source: String, tokens: [SyntaxToken]?) -> [[Span]] {
        let newline = UInt16(UInt8(ascii: "\n"))
        let units = Array(source.utf16)
        var lines: [[Span]] = [[]]
        func push(_ kind: SyntaxToken.Kind, _ range: Range<Int>) {
            for (index, part) in units[range].split(separator: newline, omittingEmptySubsequences: false).enumerated() {
                if index > 0 { lines.append([]) }
                if !part.isEmpty {
                    lines[lines.count - 1].append(Span(kind: kind, text: String(decoding: part, as: UTF16.self)))
                }
            }
        }

        var at = 0
        for token in tokens ?? [] {
            let start = max(token.range.lowerBound, at)
            let end = min(token.range.upperBound, units.count)
            if end <= start { continue }
            if start > at { push(.plain, at..<start) }
            push(token.kind, start..<end)
            at = end
        }
        if at < units.count { push(.plain, at..<units.count) }

        if lines.count > 1, units.last == newline { lines.removeLast() }
        return lines.map(withoutCarriageReturn)
    }

    private static func withoutCarriageReturn(_ line: [Span]) -> [Span] {
        guard let last = line.last, last.text.hasSuffix("\r") else { return line }
        let text = String(last.text.dropLast())
        return line.dropLast() + (text.isEmpty ? [] : [Span(kind: last.kind, text: text)])
    }
}

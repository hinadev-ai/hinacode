import HinaCodeKit
import SwiftUI

/// Source code colored with `SyntaxPalette`, as one attributed string, so a long block is one text view instead of
/// one per token. Tabs draw as two spaces, since a phone has no width to spare.
nonisolated enum SyntaxText {
    static func highlight(_ code: String) -> AttributedString {
        attributed(CodeLines.lines(code, tokens: SyntaxLexer.lex(code)))
    }

    /// The lines joined with line breaks.
    static func attributed(_ lines: [[CodeLines.Span]]) -> AttributedString {
        // The text goes in first and the colors after, since appending thousands of small attributed strings is
        // twice as slow.
        var text = ""
        var marks: [(kind: SyntaxToken.Kind, start: Int, length: Int)] = []
        var offset = 0
        for (index, spans) in lines.enumerated() {
            if index > 0 {
                text += "\n"
                offset += 1
            }
            for span in spans {
                let part = span.text.replacing("\t", with: "  ")
                let length = part.utf16.count
                if span.kind != .plain { marks.append((span.kind, offset, length)) }
                text += part
                offset += length
            }
        }
        var colored = AttributedString(text)
        for mark in marks {
            let start = colored.utf16.index(colored.startIndex, offsetBy: mark.start)
            let range = start..<colored.utf16.index(start, offsetBy: mark.length)
            colored[range].foregroundColor = SyntaxPalette.color(mark.kind)
            if mark.kind == .comment { colored[range].inlinePresentationIntent = .emphasized }
        }
        return colored
    }
}

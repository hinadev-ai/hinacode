import HinaCodeKit
import Testing

private func span(_ kind: SyntaxToken.Kind, _ text: String) -> CodeLines.Span {
    CodeLines.Span(kind: kind, text: text)
}

private func token(_ kind: SyntaxToken.Kind, _ range: Range<Int>) -> SyntaxToken {
    SyntaxToken(kind: kind, range: range)
}

@Suite struct CodeLinesTests {
    @Test("returns plain lines without spans")
    func plainLines() {
        #expect(CodeLines.lines("a\n\nb", tokens: nil) == [[span(.plain, "a")], [], [span(.plain, "b")]])
    }

    @Test("gives an empty file one empty line and drops the line after a final break")
    func emptyAndFinalBreak() {
        #expect(CodeLines.lines("", tokens: nil) == [[]])
        #expect(CodeLines.lines("a\n", tokens: nil) == [[span(.plain, "a")]])
        #expect(CodeLines.lines("\n", tokens: nil) == [[]])
    }

    @Test("splits a span that crosses line breaks")
    func spanAcrossLines() {
        let tokens = [token(.plain, 0..<2), token(.comment, 2..<11), token(.plain, 11..<13)]
        #expect(
            CodeLines.lines("x /* a\nb */ y", tokens: tokens) == [
                [span(.plain, "x "), span(.comment, "/* a")],
                [span(.comment, "b */"), span(.plain, " y")],
            ])
    }

    @Test("strips the carriage return of \\r\\n, even when it is a span of its own")
    func carriageReturns() {
        let tokens = [token(.keyword, 0..<3), token(.plain, 3..<5), token(.plain, 5..<6), token(.plain, 6..<10)]
        #expect(
            CodeLines.lines("let a\r\nb\r\n", tokens: tokens) == [
                [span(.keyword, "let"), span(.plain, " a")],
                [span(.plain, "b")],
            ])
    }

    @Test("leaves text after the last span plain, for a highlighted prefix")
    func plainAfterLastSpan() {
        #expect(
            CodeLines.lines("\"a\"\nrest", tokens: [token(.string, 0..<3)]) == [
                [span(.string, "\"a\"")],
                [span(.plain, "rest")],
            ])
    }

    @Test("fills gaps between spans with plain text and ignores spans past the end")
    func gapsAndOverrun() {
        let tokens = [token(.number, 2..<3), token(.number, 9..<12)]
        #expect(
            CodeLines.lines("a 1 b", tokens: tokens) == [
                [span(.plain, "a "), span(.number, "1"), span(.plain, " b")]
            ])
    }
}

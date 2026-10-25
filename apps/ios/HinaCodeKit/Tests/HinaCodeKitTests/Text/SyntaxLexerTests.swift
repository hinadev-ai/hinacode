import HinaCodeKit
import Testing

private func expectCovers(
    _ code: String, _ tokens: [SyntaxToken], sourceLocation: SourceLocation = #_sourceLocation
) {
    var at = 0
    for (index, token) in tokens.enumerated() {
        #expect(token.range.lowerBound == at, sourceLocation: sourceLocation)
        #expect(!token.range.isEmpty, sourceLocation: sourceLocation)
        if index > 0 { #expect(token.kind != tokens[index - 1].kind, sourceLocation: sourceLocation) }
        at = token.range.upperBound
    }
    #expect(at == code.utf16.count, sourceLocation: sourceLocation)
}

/// Each token's text with its kind, leaving out plain text.
private func labeled(_ code: String) -> [[String]] {
    let units = Array(code.utf16)
    return SyntaxLexer.lex(code)
        .filter { $0.kind != .plain }
        .map { [$0.kind.rawValue, String(decoding: units[$0.range], as: UTF16.self)] }
}

private func milliseconds(_ duration: Duration) -> Double {
    Double(duration.components.seconds) * 1_000 + Double(duration.components.attoseconds) / 1e15
}

@Suite struct SyntaxLexerTests {
    @Test("covers the source with no gaps or overlaps")
    func covers() {
        let samples = [
            "",
            "x",
            "const a = 'unterminated\nlet b = \"\\\"\" // done",
            "/* open comment",
            "`multi\nline ${x}`",
            "'''doc\nstring''' + \"\"\"x\"\"\"",
            "it's a stray quote and another ' here",
            "0x1F 1_000 3.14e-10 10n 2.5f .5",
            "日本語 identifiers 🎉 (and emoji)",
        ]
        for code in samples { expectCovers(code, SyntaxLexer.lex(code)) }
    }

    @Test("labels a TypeScript snippet")
    func typeScript() {
        let code = """
            export async function load(id: string): Promise<User> {
              // fetch the user
              const user = await fetchUser(id, { retries: 3 })
              return user ?? null
            }
            """
        expectCovers(code, SyntaxLexer.lex(code))
        #expect(
            labeled(code) == [
                ["keyword", "export"],
                ["keyword", "async"],
                ["keyword", "function"],
                ["function", "load"],
                ["operator", ":"],
                ["keyword", "string"],
                ["operator", ":"],
                ["type", "Promise"],
                ["operator", "<"],
                ["type", "User"],
                ["operator", ">"],
                ["comment", "// fetch the user"],
                ["keyword", "const"],
                ["operator", "="],
                ["keyword", "await"],
                ["function", "fetchUser"],
                ["operator", ":"],
                ["number", "3"],
                ["keyword", "return"],
                ["operator", "??"],
                ["constant", "null"],
            ])
    }

    @Test("keeps a # inside a Python string out of comments")
    func pythonHash() {
        let code = """
            def tag(name):
                # build the tag
                return "#" + name  # trailing
            MAX_SIZE = None
            """
        #expect(
            labeled(code) == [
                ["keyword", "def"],
                ["function", "tag"],
                ["operator", ":"],
                ["comment", "# build the tag"],
                ["keyword", "return"],
                ["string", "\"#\""],
                ["operator", "+"],
                ["comment", "# trailing"],
                ["constant", "MAX_SIZE"],
                ["operator", "="],
                ["constant", "None"],
            ])
    }

    @Test("reads --flag in a shell line as an operator, not a comment")
    func shellFlags() {
        #expect(
            labeled("pnpm test --filter mobile -- --watch # run it") == [
                ["operator", "--"],
                ["comment", "-- --watch # run it"],
            ])
        #expect(labeled("git log --oneline -3") == [["operator", "--"], ["operator", "-"], ["number", "3"]])
    }

    @Test("labels JSON")
    func json() {
        let code = #"{"name": "hinacode", "port": 47821, "debug": false, "tags": [null]}"#
        expectCovers(code, SyntaxLexer.lex(code))
        #expect(
            labeled(code) == [
                ["string", "\"name\""],
                ["operator", ":"],
                ["string", "\"hinacode\""],
                ["string", "\"port\""],
                ["operator", ":"],
                ["number", "47821"],
                ["string", "\"debug\""],
                ["operator", ":"],
                ["constant", "false"],
                ["string", "\"tags\""],
                ["operator", ":"],
                ["constant", "null"],
            ])
    }

    @Test("does not read a CSS color as a comment")
    func cssColor() {
        #expect(
            labeled(".button { color: #fff; margin: 0 4px; } /* end */") == [
                ["operator", ":"],
                ["operator", ":"],
                ["number", "0"],
                ["number", "4px"],
                ["comment", "/* end */"],
            ])
    }

    @Test("reads SQL keywords and -- comments")
    func sql() {
        #expect(
            labeled("SELECT id FROM users -- all of them") == [
                ["keyword", "SELECT"],
                ["keyword", "FROM"],
                ["comment", "-- all of them"],
            ])
    }

    @Test("lexes 200 KB in well under 100 ms")
    func largeSource() {
        let chunk =
            "function render(items: Item[]) {\n"
            + "  // draw each one\n"
            + "  for (const item of items) console.log(\"item\", item.id, 0x1f, 'it\\'s', `${item}`)\n"
            + "  return MAX_ITEMS >= items.length ? true : false /* clamp */\n"
            + "}\n"
        let code = String(repeating: chunk, count: (200_000 + chunk.utf16.count - 1) / chunk.utf16.count)
        _ = SyntaxLexer.lex(code)
        var tokens: [SyntaxToken] = []
        let elapsed = ContinuousClock().measure { tokens = SyntaxLexer.lex(code) }
        expectCovers(code, tokens)
        #expect(milliseconds(elapsed) < 100)
    }

    @Test("stays linear on a line of stray quotes")
    func strayQuotes() {
        let code = String(repeating: "'\\", count: 100_000)
        var tokens: [SyntaxToken] = []
        let elapsed = ContinuousClock().measure { tokens = SyntaxLexer.lex(code) }
        #expect(milliseconds(elapsed) < 100)
        expectCovers(code, tokens)
    }
}

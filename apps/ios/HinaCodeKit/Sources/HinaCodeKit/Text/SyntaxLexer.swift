/// A run of source text and what it is, for coloring.
public struct SyntaxToken: Hashable, Sendable {
    /// The labels `gpu-lexer` gives a span. The view picks their colors.
    public enum Kind: String, Hashable, Sendable {
        case plain, comment, string, number, keyword, type, function, constant
        case `operator`
    }

    public let kind: Kind
    /// Half-open UTF-16 offsets into the source.
    public let range: Range<Int>

    public init(kind: Kind, range: Range<Int>) {
        self.kind = kind
        self.range = range
    }
}

/// Labels source code without knowing its language (`apps/mobile/src/lib/lexer.ts`).
public enum SyntaxLexer {
    /// The tokens cover the whole source in order, and adjacent tokens never share a kind. Runs in linear time.
    public static func lex(_ code: String) -> [SyntaxToken] {
        var lexer = Lexer(Array(code.unicodeScalars))
        return lexer.run()
    }
}

private let keywords = Set(
    (
        // TypeScript and JavaScript
        "abstract as async await break case catch class const continue debugger declare default delete do else enum "
        + "export extends finally for from function get if implements import in infer instanceof interface is "
        + "keyof let namespace new of private protected public readonly return satisfies set static switch throw "
        + "try type typeof var void while with yield "
        // Python
        + "and def del elif except global lambda nonlocal not or pass raise assert "
        // Go
        + "chan defer fallthrough func go goto map range select struct package "
        // Rust
        + "crate dyn fn impl loop match mod move mut pub ref trait unsafe use where "
        // Java, Kotlin, Swift and C#
        + "final native synchronized throws transient volatile fun val when object sealed override open internal "
        + "lateinit companion guard init deinit extension protocol inout subscript fileprivate using virtual "
        + "operator out params event lock "
        // C
        + "auto char double float int long short signed unsigned sizeof typedef union extern register inline bool "
        + "string "
        // Ruby, PHP and shell
        + "begin end ensure rescue unless until module then elsif echo foreach fi esac done local").split(
            separator: " "
        ).map(String.init))

private let sqlKeywords = Set(
    ("SELECT FROM WHERE INSERT INTO UPDATE DELETE JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET "
        + "VALUES CREATE TABLE ALTER DROP INDEX PRIMARY KEY FOREIGN REFERENCES NOT NULL AND OR AS DISTINCT UNION ALL "
        + "CASE WHEN THEN ELSE END BEGIN COMMIT ROLLBACK SET LIKE BETWEEN EXISTS IS IN ASC DESC DEFAULT WITH RETURNING")
        .split(separator: " ").map(String.init))

private let constants = Set(
    "true false True False null nil None undefined NaN Infinity self this super".split(separator: " ").map(String.init))

private let operatorScalars = Set("=+-*/%!<>&|^~?:".unicodeScalars)

private func isSpace(_ c: Unicode.Scalar?) -> Bool { c == " " || c == "\t" || c == "\n" || c == "\r" }
private func isDigit(_ c: Unicode.Scalar?) -> Bool { c.map { ("0"..."9").contains($0) } ?? false }
private func isUpper(_ c: Unicode.Scalar) -> Bool { ("A"..."Z").contains(c) }
private func isIdentStart(_ c: Unicode.Scalar) -> Bool {
    ("a"..."z").contains(c) || isUpper(c) || c == "_" || c == "$" || c.value > 0x7F
}
private func isIdentPart(_ c: Unicode.Scalar) -> Bool { isIdentStart(c) || isDigit(c) }

/// Scans Unicode scalars, which give the same tokens as the JavaScript's UTF-16 code units: every scalar above
/// U+007F, surrogate pairs included there, is an identifier character.
private struct Lexer {
    private struct Span {
        let kind: SyntaxToken.Kind
        let start: Int
        var end: Int
    }

    let code: [Unicode.Scalar]
    private var spans: [Span] = []
    // A quote with no closing partner on its line marks everything up to the line end as failed, so a line full of
    // stray quotes is scanned once, not once per quote.
    private var noSingleCloseBefore = -1
    private var noDoubleCloseBefore = -1

    init(_ code: [Unicode.Scalar]) { self.code = code }

    /// The scalar at `at`, or nil past either end, like indexing a JavaScript string.
    private func char(_ at: Int) -> Unicode.Scalar? { at >= 0 && at < code.count ? code[at] : nil }

    private mutating func push(_ kind: SyntaxToken.Kind, _ start: Int, _ end: Int) {
        guard end > start else { return }
        if let last = spans.last, last.kind == kind {
            spans[spans.count - 1].end = end
        } else {
            spans.append(Span(kind: kind, start: start, end: end))
        }
    }

    private func lineEnd(_ from: Int) -> Int {
        code[from...].firstIndex(of: "\n") ?? code.count
    }

    private func until(_ from: Int, _ close: String) -> Int {
        let close = Array(close.unicodeScalars)
        var at = from
        while at + close.count <= code.count {
            if code[at] == close[0], code[at..<(at + close.count)].elementsEqual(close) { return at + close.count }
            at += 1
        }
        return code.count
    }

    private func atLineStart(_ at: Int) -> Bool {
        var back = at - 1
        while back >= 0, code[back] == " " || code[back] == "\t" { back -= 1 }
        return back < 0 || code[back] == "\n"
    }

    private func followsSpace(_ at: Int) -> Bool { at == 0 || isSpace(code[at - 1]) }

    private func endsWord(_ at: Int) -> Bool { at >= code.count || isSpace(code[at]) }

    /// Where a comment starting at `at` ends, or nil when none starts there.
    private func commentEnd(_ at: Int) -> Int? {
        let c = code[at]
        let next = char(at + 1)
        if c == "/", next == "/" { return lineEnd(at) }
        if c == "/", next == "*" { return until(at + 2, "*/") }
        if c == "<", code[at...].starts(with: "<!--".unicodeScalars) { return until(at + 4, "-->") }
        if c == "#", atLineStart(at) || (followsSpace(at) && endsWord(at + 1)) { return lineEnd(at) }
        if c == "-", next == "-", char(at + 2) == " ", followsSpace(at) { return lineEnd(at) }
        return nil
    }

    /// Where a string starting at `at` ends, or nil when the quote is stray.
    private mutating func stringEnd(_ at: Int) -> Int? {
        let quote = code[at]
        let multiline = quote == "`"
        if !multiline, char(at + 1) == quote, char(at + 2) == quote {
            return until(at + 3, String(repeating: String(quote), count: 3))
        }
        if quote == "'", at < noSingleCloseBefore { return nil }
        if quote == "\"", at < noDoubleCloseBefore { return nil }
        var j = at + 1
        while j < code.count {
            let c = code[j]
            if c == "\\" {
                j += 2
            } else if c == quote {
                return j + 1
            } else if c == "\n", !multiline {
                break
            } else {
                j += 1
            }
        }
        if multiline { return code.count }
        if quote == "'" { noSingleCloseBefore = j } else { noDoubleCloseBefore = j }
        return nil
    }

    private func numberEnd(_ at: Int) -> Int {
        var j = at
        if code[at] == "0", let prefix = char(at + 1), "xXbBoO".unicodeScalars.contains(prefix) {
            j += 2
            while j < code.count, isIdentPart(code[j]) { j += 1 }
            return j
        }
        while j < code.count, isDigit(code[j]) || code[j] == "_" { j += 1 }
        if char(j) == ".", isDigit(char(j + 1)) {
            j += 1
            while j < code.count, isDigit(code[j]) || code[j] == "_" { j += 1 }
        }
        if char(j) == "e" || char(j) == "E", let next = char(j + 1), isDigit(next) || next == "+" || next == "-" {
            let signed = next == "+" || next == "-"
            if !signed || isDigit(char(j + 2)) {
                j += signed ? 2 : 1
                while j < code.count, isDigit(code[j]) { j += 1 }
            }
        }
        while j < code.count, isIdentPart(code[j]) { j += 1 }
        return j
    }

    private func classifyWord(_ start: Int, _ end: Int) -> SyntaxToken.Kind {
        let word = String(String.UnicodeScalarView(code[start..<end]))
        if keywords.contains(word) || sqlKeywords.contains(word) { return .keyword }
        if constants.contains(word) || isAllCaps(code[start..<end]) { return .constant }
        var j = end
        while j < code.count, code[j] == " " || code[j] == "\t" { j += 1 }
        if char(j) == "(" { return .function }
        if isUpper(code[start]) { return .type }
        return .plain
    }

    /// `/^[A-Z][A-Z0-9_]+$/`: at least two characters.
    private func isAllCaps(_ word: ArraySlice<Unicode.Scalar>) -> Bool {
        guard word.count >= 2, let first = word.first, isUpper(first) else { return false }
        return word.dropFirst().allSatisfy { isUpper($0) || isDigit($0) || $0 == "_" }
    }

    mutating func run() -> [SyntaxToken] {
        var i = 0
        while i < code.count {
            let c = code[i]
            if let end = commentEnd(i) {
                push(.comment, i, end)
                i = end
            } else if c == "\"" || c == "'" || c == "`" {
                if let end = stringEnd(i) {
                    push(.string, i, end)
                    i = end
                } else {
                    push(.plain, i, i + 1)
                    i += 1
                }
            } else if isDigit(c) || (c == "." && isDigit(char(i + 1))) {
                let end = numberEnd(i)
                push(.number, i, end)
                i = end
            } else if isIdentStart(c) {
                var end = i + 1
                while end < code.count, isIdentPart(code[end]) { end += 1 }
                push(classifyWord(i, end), i, end)
                i = end
            } else if operatorScalars.contains(c) {
                var end = i + 1
                while end < code.count, operatorScalars.contains(code[end]), commentEnd(end) == nil { end += 1 }
                push(.operator, i, end)
                i = end
            } else {
                push(.plain, i, i + 1)
                i += 1
            }
        }
        return utf16Tokens()
    }

    private func utf16Tokens() -> [SyntaxToken] {
        var offsets: [Int] = []
        offsets.reserveCapacity(code.count + 1)
        var offset = 0
        for scalar in code {
            offsets.append(offset)
            offset += UTF16.width(scalar)
        }
        offsets.append(offset)
        return spans.map { SyntaxToken(kind: $0.kind, range: offsets[$0.start]..<offsets[$0.end]) }
    }
}

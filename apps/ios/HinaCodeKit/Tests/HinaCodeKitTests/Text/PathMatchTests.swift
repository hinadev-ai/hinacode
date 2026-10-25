import HinaCodeKit
import Testing

private func order(_ paths: [String], _ query: String) -> [String] {
    PathMatch.matches(paths, query: query).map(\.path)
}

@Suite struct PathMatchTests {
    @Test("matches a case-insensitive subsequence and skips the rest")
    func subsequence() {
        #expect(order(["src/Button.tsx", "src/index.ts", "README.md"], "btn") == ["src/Button.tsx"])
    }

    @Test("is empty for a blank query")
    func blankQuery() {
        #expect(PathMatch.matches(["a.ts"], query: "  ").isEmpty)
    }

    @Test("ranks a hit in the file name above one that needs the folders")
    func fileNameFirst() {
        #expect(order(["files/index.ts", "src/files.tsx"], "files") == ["src/files.tsx", "files/index.ts"])
    }

    @Test("ranks consecutive and earlier matches higher")
    func consecutiveAndEarlier() {
        #expect(order(["a/xtxhxexmxe.ts", "a/theme.ts"], "theme") == ["a/theme.ts", "a/xtxhxexmxe.ts"])
        #expect(order(["a/use-theme.ts", "a/theme.ts"], "theme") == ["a/theme.ts", "a/use-theme.ts"])
    }

    @Test("prefers word starts when it places the query")
    func wordStarts() {
        #expect(PathMatch.matches(["src/fileViewer.tsx"], query: "fv").first?.positions == [4, 8])
    }

    @Test("returns positions in the whole path, for emphasis")
    func positionsInWholePath() {
        #expect(PathMatch.matches(["src/app/file.tsx"], query: "file").first?.positions == [8, 9, 10, 11])
        #expect(PathMatch.matches(["src/app/x.ts"], query: "sax").first?.positions == [0, 4, 8])
    }

    @Test("ignores whitespace in the query")
    func ignoresWhitespace() {
        #expect(order(["src/app/file.tsx"], "app file") == ["src/app/file.tsx"])
    }

    @Test("returns at most 50 results")
    func atMostFifty() {
        let paths = (0..<80).map { "src/file-\($0).ts" }
        #expect(PathMatch.matches(paths, query: "file").count == 50)
    }
}

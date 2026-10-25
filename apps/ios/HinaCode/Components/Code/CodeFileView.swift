import HinaCodeKit
import SwiftUI

/// A file's text with line numbers and syntax colors, for the file viewer. Rows build as they scroll in, so a 1 MB
/// file opens fast. `highlightedLine` (1-based) is scrolled into view and flashed once.
struct CodeFileView: View {
    let text: String
    let path: String
    let highlightedLine: Int?

    @State private var lines: (text: String, lines: [[CodeLines.Span]])?

    var body: some View {
        Group {
            if text.isEmpty {
                ContentUnavailableView(.mobileFilesEmptyFile, systemImage: "doc.text")
            } else if let lines, lines.text == text {
                CodeLinesList(lines: lines.lines, highlightedLine: highlightedLine)
            } else {
                ProgressView(.mobileFilesLoadingFile)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: text) {
            lines = (text, await Self.split(text, highlight: FileKind.icon(path: path, entry: .file) != .text))
        }
    }

    /// Colors only the first 300,000 characters, cut at a line end, so a huge file still opens quickly. Prose and
    /// logs stay plain, since keyword colors in sentences are noise.
    @concurrent private nonisolated static func split(_ text: String, highlight: Bool) async -> [[CodeLines.Span]] {
        guard highlight else { return CodeLines.lines(text, tokens: nil) }
        let limit = 300_000
        let units = text.utf16
        guard units.count > limit else { return CodeLines.lines(text, tokens: SyntaxLexer.lex(text)) }
        let cut = units.index(units.startIndex, offsetBy: limit)
        let end = units[..<cut].lastIndex(of: UInt16(UInt8(ascii: "\n"))) ?? cut
        return CodeLines.lines(text, tokens: SyntaxLexer.lex(String(decoding: units[..<end], as: UTF16.self)))
    }
}

private struct CodeLinesList: View {
    let lines: [[CodeLines.Span]]
    let highlightedLine: Int?

    @State private var flashing: Int?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .caption) private var digitWidth = 7.4

    var body: some View {
        let gutterWidth = digitWidth * CGFloat(String(lines.count).count)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(0..<lines.count, id: \.self) { index in
                        CodeLineRow(
                            number: index + 1,
                            spans: lines[index],
                            gutterWidth: gutterWidth,
                            flashing: flashing == index
                        )
                    }
                }
                .padding(.vertical, 8)
            }
            .task { await reveal(proxy) }
        }
        .font(.system(.caption, design: .monospaced))
        .textSelection(.enabled)
    }

    private func reveal(_ proxy: ScrollViewProxy) async {
        guard let highlightedLine, highlightedLine > 0, !lines.isEmpty else { return }
        let index = min(highlightedLine, lines.count) - 1
        proxy.scrollTo(index, anchor: UnitPoint(x: 0, y: 0.3))
        flashing = index
        try? await Task.sleep(for: reduceMotion ? .seconds(2) : .milliseconds(500))
        withAnimation(reduceMotion ? nil : .easeOut(duration: 1.5)) { flashing = nil }
    }
}

private struct CodeLineRow: View {
    let number: Int
    let spans: [CodeLines.Span]
    let gutterWidth: CGFloat
    let flashing: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(verbatim: String(number))
                .foregroundStyle(.secondary)
                .fixedSize()
                .frame(width: gutterWidth, alignment: .trailing)
                .accessibilityHidden(true)
            // An empty line still takes a line's height.
            Text(spans.isEmpty ? AttributedString(" ") : SyntaxText.attributed([spans]))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .background(flashing ? Tone.attention.color.opacity(0.25) : .clear)
    }
}

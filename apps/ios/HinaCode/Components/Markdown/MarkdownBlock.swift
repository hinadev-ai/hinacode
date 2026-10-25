import Foundation
import HinaCodeKit
import SwiftUI

/// One block of a Markdown document. `MarkdownView` parses a document into these once, since a transcript renders
/// a streaming reply many times.
struct MarkdownBlock: Equatable, Identifiable {
    enum Kind: Equatable {
        /// Inline text keeps Foundation's emphasis, code and link attributes, which `Text` draws.
        case paragraph(AttributedString)
        case heading(level: Int, AttributedString)
        /// Raw HTML, shown as written.
        case html(String)
        case code(language: String?, code: String)
        case quote([MarkdownBlock])
        case list([MarkdownListItem])
        case table(MarkdownTable)
        /// The source as written, for `MarkdownPath.imageSource`. A paragraph's images follow its text, since a
        /// text view cannot hold them.
        case image(source: String, alt: String)
        case rule
    }

    /// The position among its siblings. Blocks have no other identity, and a streaming reply only appends.
    let id: Int
    let kind: Kind
}

struct MarkdownListItem: Equatable, Identifiable {
    enum Marker: Equatable {
        case bullet
        case number(Int)
        case task(done: Bool)
    }

    let id: Int
    let marker: Marker
    let blocks: [MarkdownBlock]
}

struct MarkdownTable: Equatable {
    let alignments: [PresentationIntent.TableColumn.Alignment]
    let header: [AttributedString]
    /// Every row has one cell per column.
    let rows: [[AttributedString]]
}

extension MarkdownBlock {
    /// Parses GitHub Flavored Markdown. A link keeps its target only when it opens a web page or a file inside
    /// `root`, the thread's working folder; `folder` is where a previewed file sits, relative to `root`.
    static func parse(_ markdown: String, root: String?, folder: String?) -> [MarkdownBlock] {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible)
        guard let document = try? AttributedString(markdown: markdown, options: options) else {
            return [MarkdownBlock(id: 0, kind: .html(markdown))]
        }
        let runs = document.runs[\.presentationIntent].map { intent, range in
            BlockRun(range: range, path: (intent?.components ?? []).reversed())
        }
        let parser = MarkdownParser(document: document, root: root, folder: folder ?? "")
        return parser.blocks(runs[...], depth: 0)
    }
}

/// A stretch of the document inside the same blocks, outermost first.
private struct BlockRun {
    let range: Range<AttributedString.Index>
    let path: [PresentationIntent.IntentType]

    func intent(at depth: Int) -> PresentationIntent.IntentType? {
        depth < path.count ? path[depth] : nil
    }
}

private struct MarkdownParser {
    let document: AttributedString
    let root: String?
    let folder: String

    func blocks(_ runs: ArraySlice<BlockRun>, depth: Int) -> [MarkdownBlock] {
        let kinds = groups(runs, depth: depth).flatMap { group -> [MarkdownBlock.Kind] in
            guard let intent = group.first?.intent(at: depth) else {
                return [.html(String(text(group).characters).trimmingCharacters(in: .whitespacesAndNewlines))]
            }
            switch intent.kind {
            case .paragraph:
                return withImages(inline(group)) { .paragraph($0) }
            case .header(let level):
                return withImages(inline(group)) { .heading(level: level, $0) }
            case .codeBlock(let hint):
                let language = hint?.split(whereSeparator: \.isWhitespace).first.map(String.init)
                var code = String(text(group).characters)
                if code.hasSuffix("\n") { code.removeLast() }
                return [.code(language: language, code: code)]
            case .blockQuote:
                return [.quote(blocks(group, depth: depth + 1))]
            case .orderedList:
                return [.list(items(group, depth: depth + 1, ordered: true))]
            case .unorderedList:
                return [.list(items(group, depth: depth + 1, ordered: false))]
            case .table(let columns):
                return [.table(table(group, columns: columns, depth: depth + 1))]
            case .thematicBreak:
                return [.rule]
            default:
                return withImages(inline(group)) { .paragraph($0) }
            }
        }
        return kinds.enumerated().map { MarkdownBlock(id: $0.offset, kind: $0.element) }
    }

    /// Consecutive runs in the same block at `depth`.
    private func groups(_ runs: ArraySlice<BlockRun>, depth: Int) -> [ArraySlice<BlockRun>] {
        var groups: [ArraySlice<BlockRun>] = []
        var start = runs.startIndex
        for index in runs.indices.dropFirst()
        where runs[index].intent(at: depth)?.identity != runs[index - 1].intent(at: depth)?.identity {
            groups.append(runs[start..<index])
            start = index
        }
        if start < runs.endIndex { groups.append(runs[start...]) }
        return groups
    }

    private func text(_ runs: ArraySlice<BlockRun>) -> AttributedSubstring {
        document[runs.first!.range.lowerBound..<runs.last!.range.upperBound]
    }

    private func items(_ runs: ArraySlice<BlockRun>, depth: Int, ordered: Bool) -> [MarkdownListItem] {
        groups(runs, depth: depth).enumerated().map { index, group in
            var blocks = blocks(group, depth: depth + 1)
            var marker = MarkdownListItem.Marker.bullet
            if ordered, case .listItem(let ordinal) = group.first?.intent(at: depth)?.kind {
                marker = .number(ordinal)
            }
            if let first = blocks.first, case .paragraph(let text) = first.kind, let (done, rest) = taskMarker(text) {
                marker = .task(done: done)
                blocks[0] = MarkdownBlock(id: first.id, kind: .paragraph(rest))
            }
            return MarkdownListItem(id: index, marker: marker, blocks: blocks)
        }
    }

    /// Foundation leaves a task item's `[ ]` or `[x]` in its text.
    private func taskMarker(_ text: AttributedString) -> (done: Bool, rest: AttributedString)? {
        let marker = String(text.characters.prefix(4))
        guard ["[ ] ", "[x] ", "[X] "].contains(marker) else { return nil }
        return (marker != "[ ] ", AttributedString(text[text.characters.index(text.startIndex, offsetBy: 4)...]))
    }

    private func table(
        _ runs: ArraySlice<BlockRun>, columns: [PresentationIntent.TableColumn], depth: Int
    ) -> MarkdownTable {
        var header = Array(repeating: AttributedString(), count: columns.count)
        var rows: [[AttributedString]] = []
        for row in groups(runs, depth: depth) {
            // An empty cell has no runs, so cells are placed by their column.
            var cells = Array(repeating: AttributedString(), count: columns.count)
            for cell in groups(row, depth: depth + 1) {
                if case .tableCell(let column) = cell.first?.intent(at: depth + 1)?.kind, column < cells.count {
                    cells[column] = inline(cell).text
                }
            }
            if row.first?.intent(at: depth)?.kind == .tableHeaderRow {
                header = cells
            } else {
                rows.append(cells)
            }
        }
        return MarkdownTable(alignments: columns.map(\.alignment), header: header, rows: rows)
    }

    private func withImages(
        _ inline: (text: AttributedString, images: [MarkdownBlock.Kind]),
        _ block: (AttributedString) -> MarkdownBlock.Kind
    ) -> [MarkdownBlock.Kind] {
        let blank = inline.text.characters.allSatisfy(\.isWhitespace)
        return (blank ? [] : [block(inline.text)]) + inline.images
    }

    /// A block's inline text, with its images taken out, soft breaks kept as line breaks the way agents write them,
    /// inline code on a fill, and links that cannot open made plain text.
    private func inline(_ runs: ArraySlice<BlockRun>) -> (text: AttributedString, images: [MarkdownBlock.Kind]) {
        let source = text(runs)
        var text = AttributedString()
        var images: [MarkdownBlock.Kind] = []
        for run in source.runs {
            if let image = run.imageURL {
                // Foundation writes an empty alt text as an object replacement character.
                let alt = String(source[run.range].characters).replacing("\u{FFFC}", with: "")
                images.append(.image(source: image.absoluteString, alt: alt))
                continue
            }
            let intent = run.inlinePresentationIntent ?? []
            if intent.contains(.softBreak) || intent.contains(.lineBreak) {
                text += AttributedString("\n")
                continue
            }
            var part = AttributedString(source[run.range])
            part.presentationIntent = nil
            if intent.contains(.code) { part.swiftUI.backgroundColor = Color(.tertiarySystemFill) }
            if let link = run.link {
                if opens(link) {
                    part.swiftUI.underlineStyle = .single
                } else {
                    part.link = nil
                }
            }
            text += part
        }
        return (text, images)
    }

    private func opens(_ link: URL) -> Bool {
        let scheme = link.scheme?.lowercased()
        return scheme == "http" || scheme == "https"
            || MarkdownPath.fileLink(link.absoluteString, root: root, folder: folder) != nil
    }
}

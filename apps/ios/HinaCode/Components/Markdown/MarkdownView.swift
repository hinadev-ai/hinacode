import HinaCodeKit
import SwiftUI

/// Renders an agent's Markdown block by block, selectable. `root` is the thread's working folder, which relative
/// image paths and file links resolve against; nil when it is not known, such as for a pull request body. `folder`
/// is where a previewed file sits, relative to `root`. `loadImage` reads a workspace image (the screens use
/// `fs.preview`); `openFile` opens a linked workspace file, at the line of a `#L10` anchor when there is one. Web
/// links open in the browser.
struct MarkdownView: View {
    typealias LoadImage = @MainActor (_ root: String, _ path: String) async throws -> Data

    let markdown: String
    let root: String?
    let folder: String?
    let loadImage: LoadImage
    let openFile: @MainActor (_ path: String, _ line: Int?) -> Void

    init(
        _ markdown: String,
        root: String?,
        folder: String? = nil,
        loadImage: @escaping LoadImage,
        openFile: @escaping @MainActor (_ path: String, _ line: Int?) -> Void
    ) {
        self.markdown = markdown
        self.root = root
        self.folder = folder
        self.loadImage = loadImage
        self.openFile = openFile
    }

    var body: some View {
        MarkdownBlocks(
            blocks: Self.blocks(markdown, root: root, folder: folder),
            images: MarkdownImages(root: root, folder: folder ?? "", load: loadImage)
        )
        .textSelection(.enabled)
        .environment(\.openURL, OpenURLAction { url in open(url) })
    }

    private static let parsed = TextCache<[MarkdownBlock]>(countLimit: 200)

    private static func blocks(_ markdown: String, root: String?, folder: String?) -> [MarkdownBlock] {
        // Links resolve against the root and folder when parsed, so both are part of the key.
        let key = [root ?? "\u{1}", folder ?? "", markdown].joined(separator: "\0")
        if let blocks = parsed[key] { return blocks }
        let blocks = MarkdownBlock.parse(markdown, root: root, folder: folder)
        parsed[key] = blocks
        return blocks
    }

    private func open(_ url: URL) -> OpenURLAction.Result {
        let scheme = url.scheme?.lowercased()
        if scheme == "http" || scheme == "https" { return .systemAction }
        guard let path = MarkdownPath.fileLink(url.absoluteString, root: root, folder: folder ?? "") else {
            return .discarded
        }
        openFile(path, url.fragment?.prefixMatch(of: /L(\d+)/).flatMap { Int($0.1) })
        return .handled
    }
}

private struct MarkdownBlocks: View {
    let blocks: [MarkdownBlock]
    let images: MarkdownImages

    @ScaledMetric private var spacing = 10.0

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(blocks) { block in
                MarkdownBlockView(block: block, images: images)
            }
        }
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let images: MarkdownImages

    var body: some View {
        switch block.kind {
        case .paragraph(let text):
            Text(text)
        case .heading(let level, let text):
            Text(text)
                .font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
                .accessibilityAddTraits(.isHeader)
                .accessibilityHeading(Self.headingLevels[min(level, 6) - 1])
        case .html(let html):
            Text(verbatim: html)
        case .code(let language, let code):
            CodeBlockView(code: code, language: language)
        case .quote(let blocks):
            MarkdownBlocks(blocks: blocks, images: images)
                .foregroundStyle(.secondary)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Capsule().fill(.tertiary).frame(width: 3)
                }
        case .list(let items):
            MarkdownList(items: items, images: images)
        case .table(let table):
            MarkdownTableView(table: table)
        case .image(let source, let alt):
            MarkdownImage(source: source, alt: alt, images: images)
        case .rule:
            Divider()
        }
    }

    private static let headingLevels: [AccessibilityHeadingLevel] = [.h1, .h2, .h3, .h4, .h5, .h6]
}

private struct MarkdownList: View {
    let items: [MarkdownListItem]
    let images: MarkdownImages

    @ScaledMetric private var markerWidth = 18.0
    @ScaledMetric private var spacing = 4.0

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(items) { item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    ListMarker(marker: item.marker)
                        .frame(minWidth: markerWidth, alignment: .trailing)
                    MarkdownBlocks(blocks: item.blocks, images: images)
                }
            }
        }
    }
}

private struct ListMarker: View {
    let marker: MarkdownListItem.Marker

    var body: some View {
        switch marker {
        case .bullet:
            Text(verbatim: "•")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        case .number(let number):
            Text(verbatim: "\(number).")
                .monospacedDigit()
                .foregroundStyle(.secondary)
        case .task(let done):
            Image(systemName: done ? "checkmark.square.fill" : "square")
                .foregroundStyle(done ? Color.accentColor : Color.secondary)
                .accessibilityLabel(done ? Text(.mobileMarkdownTaskDone) : Text(.mobileMarkdownTaskOpen))
        }
    }
}

private struct MarkdownTableView: View {
    let table: MarkdownTable

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                row(table.header, index: nil)
                ForEach(0..<table.rows.count, id: \.self) { index in
                    Divider()
                    row(table.rows[index], index: index)
                }
            }
            // At its own height, since its cells stretch to fill their row and would share out any height offered.
            .fixedSize(horizontal: false, vertical: true)
            .clipShape(.rect(cornerRadius: 6))
            .overlay {
                RoundedRectangle(cornerRadius: 6).strokeBorder(.separator, lineWidth: 1 / displayScale)
            }
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }

    /// `index` is nil for the header.
    private func row(_ cells: [AttributedString], index: Int?) -> some View {
        GridRow {
            ForEach(0..<cells.count, id: \.self) { column in
                MarkdownTableCell(
                    text: cells[column],
                    alignment: table.alignments[column],
                    isHeader: index == nil,
                    isShaded: (index ?? 0) % 2 == 1,
                    hasRule: column > 0
                )
            }
        }
    }
}

private struct MarkdownTableCell: View {
    let text: AttributedString
    let alignment: PresentationIntent.TableColumn.Alignment
    let isHeader: Bool
    let isShaded: Bool
    let hasRule: Bool

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        WrappingWidth(limit: 280) {
            Text(text)
                .font(.subheadline)
                .fontWeight(isHeader ? .semibold : nil)
                .multilineTextAlignment(textAlignment)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: frameAlignment)
        .background(.fill.quaternary.opacity(isShaded ? 1 : 0))
        .overlay(alignment: .leading) {
            if hasRule { Rectangle().fill(.separator).frame(width: 1 / displayScale) }
        }
    }

    private var frameAlignment: Alignment {
        switch alignment {
        case .center: .center
        case .right: .trailing
        default: .leading
        }
    }

    private var textAlignment: TextAlignment {
        switch alignment {
        case .center: .center
        case .right: .trailing
        default: .leading
        }
    }
}

/// Wraps its content at `limit`. A horizontal scroll view offers unlimited width, where text would stay on one line.
private struct WrappingWidth: Layout {
    let limit: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let content = subviews.first else { return .zero }
        let width = min(content.sizeThatFits(.unspecified).width, proposal.width ?? limit, limit)
        return content.sizeThatFits(ProposedViewSize(width: width, height: nil))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: nil))
    }
}

import HinaCodeKit
import SwiftUI

/// One file's unified diff from a pull request, numbered on both sides, with long lines scrolling sideways. It shows
/// the first 300 rows until asked for the rest, so a generated file does not stall the screen.
struct PatchView: View {
    let patch: String

    @State private var showsAll = false
    @State private var viewportWidth: CGFloat = 0
    @ScaledMetric(relativeTo: .caption) private var digitWidth = 7.4
    private static let firstRows = 300

    var body: some View {
        let lines = PatchLine.lines(of: patch)
        if lines.isEmpty {
            Text(.mobilePrFileNoLines)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } else {
            let shown = showsAll ? lines[...] : lines.prefix(Self.firstRows)
            let widest = lines.lazy.compactMap { max($0.oldLine ?? 0, $0.newLine ?? 0) }.max() ?? 0
            VStack(alignment: .leading, spacing: 0) {
                ScrollView(.horizontal) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(shown.indices, id: \.self) { index in
                            PatchRow(line: lines[index], gutterWidth: digitWidth * CGFloat(String(widest).count))
                        }
                    }
                    .frame(minWidth: viewportWidth, alignment: .leading)
                }
                .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
                .onGeometryChange(for: CGFloat.self) {
                    $0.size.width
                } action: {
                    viewportWidth = $0
                }
                if shown.count < lines.count {
                    Button {
                        showsAll = true
                    } label: {
                        Text(.mobilePrFileMore(String(lines.count - shown.count)))
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderless)
                }
            }
            .font(.system(.caption, design: .monospaced))
            .textSelection(.enabled)
        }
    }
}

private struct PatchRow: View {
    let line: PatchLine
    let gutterWidth: CGFloat

    var body: some View {
        // Top, not baseline, alignment: a missing line number is an empty text, whose baseline is its top.
        HStack(alignment: .top, spacing: 8) {
            number(line.oldLine)
            number(line.newLine)
            Text(verbatim: text)
                .foregroundStyle(isCode ? Color.primary : Color.secondary)
                .fixedSize()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(Text(verbatim: line.text))
    }

    private var isCode: Bool { line.kind != .hunk && line.kind != .note }

    private var text: String {
        let body = line.text.replacing("\t", with: "  ")
        return switch line.kind {
        case .addition: "+ \(body)"
        case .deletion: "− \(body)"
        case .context: "  \(body)"
        case .hunk, .note: body
        }
    }

    private var tint: Color {
        switch line.kind {
        case .addition: Tone.running.color.opacity(0.15)
        case .deletion: Tone.danger.color.opacity(0.15)
        case .hunk: Color(.tertiarySystemFill)
        case .context, .note: .clear
        }
    }

    private var label: Text {
        switch line.kind {
        case .addition: Text(.mobilePrFileAdded)
        case .deletion: Text(.mobilePrFileRemoved)
        case .context, .hunk, .note: Text(verbatim: "")
        }
    }

    private func number(_ value: Int?) -> some View {
        Text(verbatim: value.map(String.init) ?? "")
            .foregroundStyle(.secondary)
            .fixedSize()
            .frame(width: gutterWidth, alignment: .trailing)
    }
}

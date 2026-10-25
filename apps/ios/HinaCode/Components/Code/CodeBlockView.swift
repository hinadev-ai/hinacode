import SwiftUI

/// A fenced code block: its language, a copy button, and the highlighted code scrolling sideways. Copy takes the
/// original text, tabs included.
struct CodeBlockView: View {
    let code: String
    let language: String?

    @State private var highlighted: (code: String, text: AttributedString)?
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CodeBlockHeader(code: code, language: language)
            ScrollView(.horizontal) {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .padding([.horizontal, .bottom], 12)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.fill.quaternary, in: .rect(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10).strokeBorder(.separator, lineWidth: 1 / displayScale)
        }
        .task(id: code) {
            guard CodeHighlights.text(for: code) == nil else { return }
            let text = await CodeHighlights.highlight(code)
            CodeHighlights.cache[code] = text
            highlighted = (code, text)
        }
    }

    /// Long code shows plain until its colors are ready, so the block never holds up a frame.
    private var text: AttributedString {
        if let text = CodeHighlights.text(for: code) { return text }
        if let highlighted, highlighted.code == code { return highlighted.text }
        return AttributedString(code.replacing("\t", with: "  "))
    }
}

private enum CodeHighlights {
    /// Code up to this many UTF-16 units, about a hundred lines, highlights within a frame.
    private static let inlineLimit = 8_000

    static let cache = TextCache<AttributedString>(countLimit: 200, totalCost: 4_000_000)

    /// The highlighted code, computed on the spot when it is short. Nil when longer code is not ready yet.
    static func text(for code: String) -> AttributedString? {
        if let text = cache[code] { return text }
        guard code.utf16.count <= inlineLimit else { return nil }
        let text = SyntaxText.highlight(code)
        cache[code] = text
        return text
    }

    @concurrent nonisolated static func highlight(_ code: String) async -> AttributedString {
        SyntaxText.highlight(code)
    }
}

private struct CodeBlockHeader: View {
    let code: String
    let language: String?

    @State private var copied = false

    var body: some View {
        HStack {
            if let language {
                Text(verbatim: language)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Button {
                UIPasteboard.general.string = code
                copied = true
            } label: {
                Label {
                    Text(copied ? .mobileCodeCopied : .mobileCodeCopy)
                } icon: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .contentTransition(.symbolEffect(.replace))
                }
                .labelStyle(.iconOnly)
                .frame(minWidth: 44, minHeight: 36)
                // A 44 pt target without a 44 pt header.
                .contentShape(Rectangle().inset(by: -4))
            }
            .buttonStyle(.borderless)
            .foregroundStyle(copied ? Tone.running.color : Color.secondary)
            .sensoryFeedback(.success, trigger: copied) { _, copied in copied }
        }
        .padding(.leading, 12)
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

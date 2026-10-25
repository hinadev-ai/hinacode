import HinaCodeKit
import SwiftUI

/// One transcript message. Equatable on the message itself, so only the streaming message redraws while a turn runs.
struct MessageRow: View, Equatable {
    let message: Message
    let root: String?

    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router

    static func == (lhs: MessageRow, rhs: MessageRow) -> Bool {
        lhs.message == rhs.message && lhs.root == rhs.root
    }

    var body: some View {
        switch message.role {
        case .user:
            UserMessageView(message: message)
        case .assistant, .unknown:
            AssistantMessageView(message: message, root: root, openFile: openFile, loadImage: loadImage)
        }
    }

    private func openFile(_ path: String, _ line: Int?) {
        router.path.append(.file(threadId: message.threadId, path: path, line: line))
    }

    private func loadImage(_ root: String, _ path: String) async throws -> Data {
        let preview = try await model.hub.call(RPC.fsPreview, FsPreviewRequest(root: root, path: path))
        guard let comma = preview.dataUrl.firstIndex(of: ","),
            let data = Data(base64Encoded: String(preview.dataUrl[preview.dataUrl.index(after: comma)...]))
        else { throw RpcError("BadPreview", preview.dataUrl.prefix(40).description) }
        return data
    }
}

private struct UserMessageView: View {
    let message: Message

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(.mobileChatYou)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
                PartView(
                    part: part, isAssistant: false, root: nil, openFile: { _, _ in }, loadImage: { _, _ in Data() })
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.fill.quaternary, in: .rect(cornerRadius: 14))
        .accessibilityElement(children: .contain)
    }
}

private struct AssistantMessageView: View {
    let message: Message
    let root: String?
    let openFile: @MainActor (_ path: String, _ line: Int?) -> Void
    let loadImage: MarkdownView.LoadImage

    @State private var showActivity = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var parts: [MessagePart] {
        message.parts.filter { part in
            guard case .toolCall(let call) = part else { return true }
            return call.parentCallId == nil
        }
    }

    private var streaming: Bool { message.completedAt == nil }

    private var hasActivity: Bool {
        parts.contains { part in
            switch part {
            case .reasoning, .toolCall, .fileChange: true
            default: false
            }
        }
    }

    var body: some View {
        if streaming || !parts.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(.mobileChatAgent)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                if streaming {
                    streamingParts
                } else {
                    completedParts
                }
                if let usage = message.usage {
                    Text(.mobileChatUsage(String(Int(usage.inputTokens)), String(Int(usage.outputTokens))))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
        }
    }

    @ViewBuilder private var streamingParts: some View {
        let visible = parts
        ForEach(Array(visible.enumerated()), id: \.offset) { index, part in
            if !(index == visible.count - 1 && isText(part)) {
                PartView(part: part, isAssistant: true, root: root, openFile: openFile, loadImage: loadImage)
            }
        }
        if visible.isEmpty {
            pulse(.mobileChatThinking)
        } else if let last = visible.last, isText(last) {
            pulse(.mobileChatWriting)
        }
    }

    @ViewBuilder private var completedParts: some View {
        if let duration = Self.duration(of: message) {
            if hasActivity {
                Button {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { showActivity.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Text(.mobileChatWorkedFor(duration))
                        Image(systemName: "chevron.right")
                            .rotationEffect(.degrees(showActivity ? 90 : 0))
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint(showActivity ? Text(.mobileChatHideActivity) : Text(.mobileChatShowActivity))
            } else {
                Text(.mobileChatWorkedFor(duration))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Divider()
        }
        ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
            if showActivity || !isActivity(part) {
                PartView(part: part, isAssistant: true, root: root, openFile: openFile, loadImage: loadImage)
            }
        }
    }

    private func pulse(_ label: LocalizedStringResource) -> some View {
        Group {
            if reduceMotion {
                Text(label)
            } else {
                Text(label)
                    .phaseAnimator([1.0, 0.5]) { view, phase in
                        view.opacity(phase)
                    } animation: { _ in
                        .easeInOut(duration: 1)
                    }
            }
        }
        .font(.body)
        .foregroundStyle(.secondary)
    }

    private func isText(_ part: MessagePart) -> Bool {
        if case .text = part { true } else { false }
    }

    private func isActivity(_ part: MessagePart) -> Bool {
        switch part {
        case .reasoning, .toolCall, .fileChange: true
        default: false
        }
    }

    /// `mm:ss`, or `h:mm:ss` past an hour.
    static func duration(of message: Message) -> String? {
        guard let completedAt = message.completedAt,
            let start = parse(message.createdAt), let end = parse(completedAt)
        else { return nil }
        let total = max(Int(end.timeIntervalSince(start)), 0)
        let seconds = total % 60
        let minutes = (total / 60) % 60
        let hours = total / 3600
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
            : String(format: "%d:%02d", minutes, seconds)
    }

    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}

/// One part of a message, rendered by its kind.
struct PartView: View {
    let part: MessagePart
    let isAssistant: Bool
    let root: String?
    let openFile: @MainActor (_ path: String, _ line: Int?) -> Void
    let loadImage: MarkdownView.LoadImage

    var body: some View {
        switch part {
        case .text(let text):
            if isAssistant {
                MarkdownView(text.text, root: root, loadImage: loadImage, openFile: openFile)
            } else {
                Text(verbatim: text.text)
                    .textSelection(.enabled)
            }
        case .reasoning(let reasoning):
            ReasoningView(text: reasoning.text)
        case .toolCall(let call):
            ToolCallRow(call: call)
        case .fileChange(let change):
            Button {
                openFile(change.path, nil)
            } label: {
                Label {
                    Text(.mobileChatEdited(change.path))
                        .font(.system(.footnote, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.head)
                } icon: {
                    Image(systemName: "pencil")
                }
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        case .attachment(let wrapped):
            Label {
                Text(.mobileChatAttached(wrapped.attachment.name))
                    .lineLimit(1)
            } icon: {
                Image(systemName: wrapped.attachment.kind == .image ? "photo" : "paperclip")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.fill.quaternary, in: .capsule)
        case .questions(let posted):
            Text(verbatim: posted.text)
                .textSelection(.enabled)
        case .compaction(let wrapped):
            CompactionView(compaction: wrapped.compaction)
        case .unknown:
            EmptyView()
        }
    }
}

private struct ReasoningView: View {
    let text: String
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(verbatim: text)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Text(expanded ? .mobileChatHideReasoning : .mobileChatReasoning)
                .font(.subheadline)
                .frame(minHeight: 44)
        }
    }
}

private struct ToolCallRow: View {
    let call: MessagePart.ToolCall
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            CodeBlockView(code: Self.pretty(call.input), language: "json")
            if let output = call.output {
                CodeBlockView(code: Self.pretty(output), language: "json")
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "wrench.and.screwdriver")
                Text(verbatim: call.name)
                    .font(.system(.footnote, design: .monospaced))
                if let summary = Self.summary(of: call.input) {
                    Text(verbatim: summary)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 4)
                status
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .padding(.horizontal, 8)
        .overlay {
            RoundedRectangle(cornerRadius: 10).strokeBorder(.separator)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(call.name) \(Self.summary(of: call.input) ?? "")")
    }

    @ViewBuilder private var status: some View {
        switch call.status {
        case .running:
            HStack(spacing: 4) {
                ProgressView()
                Text(.mobileChatToolRunning)
            }
            .font(.caption)
            .foregroundStyle(Tone.running.color)
        case .error:
            Label {
                Text(.mobileChatToolFailed)
            } icon: {
                Image(systemName: "exclamationmark.triangle")
            }
            .font(.caption)
            .foregroundStyle(Tone.danger.color)
        case .done:
            Label {
                Text(.mobileChatToolDone)
            } icon: {
                Image(systemName: "checkmark")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        case .unknown(let value):
            Text(verbatim: value)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    static func summary(of input: JSONValue) -> String? {
        guard case .object(let fields) = input else { return nil }
        for key in ["command", "file_path", "path", "pattern", "url", "description"] {
            if case .string(let value) = fields[key] {
                let firstLine = value.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? value
                if !firstLine.isEmpty { return firstLine }
            }
        }
        return nil
    }

    static func pretty(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) else { return "" }
        return text
    }
}

private struct CompactionView: View {
    let compaction: Compaction

    var body: some View {
        switch compaction {
        case .running:
            Label {
                Text(.mobileChatCompacting)
            } icon: {
                ProgressView()
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        case .done:
            Label(.mobileChatCompacted, systemImage: "archivebox")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .failed(let failed):
            Label {
                Text(.mobileChatCompactionFailed)
            } icon: {
                Image(systemName: "exclamationmark.triangle")
            }
            .font(.footnote)
            .foregroundStyle(Tone.danger.color)
            .accessibilityLabel(failed.message.map { "\(String(localized: .mobileChatCompactionFailed)): \($0)" } ?? "")
        case .unknown:
            EmptyView()
        }
    }
}

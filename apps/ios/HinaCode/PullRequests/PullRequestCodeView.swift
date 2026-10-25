import HinaCodeKit
import SwiftUI

/// The Code tab of a pull request: its changed files as diffs, or the guide that groups them by intent. The choice
/// is kept in the store for the app session.
struct PullRequestCodeView: View {
    let threadId: String
    let detail: PullRequestDetail

    @Environment(AppModel.self) private var model

    private var serverId: String? { model.server(of: model.threads.threads[threadId])?.id }
    private var files: RemoteValue<[PullRequestFile]>? {
        model.pullRequests.files(url: detail.url, head: detail.head)
    }

    var body: some View {
        Section {
            Picker(.mobilePrCodeViewLabel, selection: Bindable(model.pullRequests).codeView) {
                Label(.mobilePrCodeFiles, systemImage: "doc.text").tag(PullRequestsStore.CodeView.files)
                Label(.mobilePrCodeGuide, systemImage: "sparkles").tag(PullRequestsStore.CodeView.guide)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
            .listRowBackground(Color.clear)
        }
        switch model.pullRequests.codeView {
        case .files: filesContent
        case .guide: guideContent
        }
        // The guide resolves against the files, so both tabs read them.
        Color.clear
            .frame(height: 0)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .task(id: "\(detail.url)@\(detail.head)") {
                await model.pullRequests.loadFiles(detail.url, head: detail.head, server: serverId)
            }
            .task(id: "\(detail.url)#\(model.pullRequests.codeView)") {
                if model.pullRequests.codeView == .guide {
                    await model.pullRequests.loadGuide(detail.url, server: serverId)
                }
            }
    }

    @ViewBuilder private var filesContent: some View {
        switch files {
        case .ready(let files, _):
            if files.isEmpty {
                Section {
                    Text(.mobilePrCodeEmpty)
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    summaryRow(files)
                    ForEach(files, id: \.path) { file in
                        FileDiffRow(file: file)
                    }
                }
            }
        case .error(let message, let tag, _):
            Section {
                Label {
                    tag == "SchemaError"
                        ? Text(.mobilePrCodeUpdateDesktop) : Text(.mobilePrCodeFailed(message))
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                }
                .foregroundStyle(Tone.danger.color)
                Button(.mobilePrRetry) {
                    Task {
                        await model.pullRequests.loadFiles(
                            detail.url, head: detail.head, server: serverId, force: true)
                    }
                }
            }
        case .loading, nil:
            Section {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(.mobilePrCodeLoading)
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 44)
            }
        }
    }

    private func summaryRow(_ files: [PullRequestFile]) -> some View {
        HStack(spacing: 8) {
            Text(.mobilePrCodeSummary(String(files.count)))
            Spacer()
            PullRequestSize(
                additions: files.reduce(0) { $0 + $1.additions }, deletions: files.reduce(0) { $0 + $1.deletions })
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }

    @ViewBuilder private var guideContent: some View {
        switch model.pullRequests.guides[detail.url] {
        case .ready(let state, _):
            if let guide = state.guide {
                if guide.head != detail.head {
                    GuideJobRows(threadId: threadId, detail: detail, state: state)
                }
                guideSections(guide)
            } else {
                GuideJobRows(threadId: threadId, detail: detail, state: state)
            }
        case .error(let message, let tag, _):
            Section {
                Label {
                    tag == "SchemaError"
                        ? Text(.mobilePrCodeUpdateDesktop) : Text(.mobilePrCodeFailed(message))
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                }
                .foregroundStyle(Tone.danger.color)
                Button(.mobilePrRetry) {
                    Task { await model.pullRequests.loadGuide(detail.url, server: serverId, force: true) }
                }
            }
        case .loading, nil:
            Section {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(.mobilePrGuideLoading)
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 44)
            }
        }
    }

    @ViewBuilder private func guideSections(_ guide: PullRequestGuide) -> some View {
        switch files {
        case .ready(let files, _):
            let resolution = GuideResolution(guide: guide, files: files)
            Section {
                MarkdownView(
                    guide.summary, root: nil,
                    loadImage: { _, _ in throw RpcError("Offline", "No workspace for a guide.") },
                    openFile: { _, _ in })
            }
            ForEach(resolution.groups, id: \.key) { group in
                GuideGroupSection(group: group, depth: 0)
            }
            if !resolution.others.isEmpty {
                Section {
                    ForEach(resolution.others, id: \.file.path) { entry in
                        FileDiffRow(entry: entry)
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(.mobilePrGuideOther)
                        Text(.mobilePrGuideOtherHint)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textCase(nil)
                    }
                }
            }
            Section {
                Text(.mobilePrGuideWrittenBy(guide.model, String(guide.head.prefix(7))))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .error(let message, let tag, _):
            Section {
                Label {
                    tag == "SchemaError"
                        ? Text(.mobilePrCodeUpdateDesktop) : Text(.mobilePrCodeFailed(message))
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                }
                .foregroundStyle(Tone.danger.color)
                Button(.mobilePrRetry) {
                    Task {
                        await model.pullRequests.loadFiles(
                            detail.url, head: detail.head, server: serverId, force: true)
                    }
                }
            }
        case .loading, nil:
            Section {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(.mobilePrCodeLoading)
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 44)
            }
        }
    }
}

/// What the guide is doing for the current head: writing, failed (with a retry), outdated, or not started.
private struct GuideJobRows: View {
    let threadId: String
    let detail: PullRequestDetail
    let state: PullRequestGuideState

    @Environment(AppModel.self) private var model
    @State private var retrying = false
    @State private var retryError: String?

    /// A job for an older head says nothing about this one.
    private var job: PullRequestGuideJob? {
        switch state.job {
        case .running(let running) where running.head == detail.head: state.job
        case .failed(let failed) where failed.head == detail.head: state.job
        default: nil
        }
    }

    private var outdated: PullRequestGuide? {
        state.guide.flatMap { $0.head == detail.head ? nil : $0 }
    }

    var body: some View {
        Section {
            if let outdated {
                Label(
                    .mobilePrGuideOutdated(String(outdated.head.prefix(7))),
                    systemImage: "exclamationmark.triangle"
                )
                .foregroundStyle(Tone.attention.color)
            }
            switch job {
            case .failed(let failed):
                Label(.mobilePrGuideFailed(failed.message), systemImage: "exclamationmark.triangle")
                    .foregroundStyle(Tone.danger.color)
                retryButton
            case .running:
                if outdated != nil {
                    Text(.mobilePrGuideOutdatedWriting)
                        .foregroundStyle(.secondary)
                } else if state.guide == nil {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(.mobilePrGuideWriting(String(detail.head.prefix(7))))
                    }
                    .frame(minHeight: 44)
                    Text(.mobilePrGuideWritingHint)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            case .unknown, nil:
                if state.guide == nil {
                    Text(detail.status.isOpen ? .mobilePrGuideNotStarted : .mobilePrGuideClosed)
                        .foregroundStyle(.secondary)
                }
            }
            if let retryError {
                Text(verbatim: retryError)
                    .font(.subheadline)
                    .foregroundStyle(Tone.danger.color)
            }
        }
    }

    private var retryButton: some View {
        Button {
            Task { await retry() }
        } label: {
            HStack {
                Text(.mobilePrRetry)
                Spacer()
                if retrying { ProgressView() }
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .disabled(retrying)
    }

    private func retry() async {
        retrying = true
        defer { retrying = false }
        do {
            // The new state arrives as a `pullRequest.guide` push.
            _ = try await model.hub.call(
                RPC.pullRequestGuidesRetry, .init(url: detail.url),
                server: model.server(of: model.threads.threads[threadId])?.id)
            retryError = nil
        } catch {
            retryError = error.localizedDescription
        }
    }
}

/// One guide group: its label, summary and files, with its children indented under it.
private struct GuideGroupSection: View {
    let group: GuideResolution.Group
    let depth: Int

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image(systemName: group.category.symbol)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(Text(group.category.label))
                    Text(verbatim: group.label)
                        .font(.headline)
                    if group.containsCritical {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Tone.attention.color)
                            .accessibilityLabel(Text(.mobilePrGuideCritical))
                    }
                }
                HStack(spacing: 8) {
                    Text(.mobilePrGuideGroupFiles(String(group.allFiles.count)))
                    PullRequestSize(
                        additions: group.allFiles.reduce(0) { $0 + $1.file.additions },
                        deletions: group.allFiles.reduce(0) { $0 + $1.file.deletions })
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if let summary = group.summary, !summary.isEmpty {
                    MarkdownView(
                        summary, root: nil,
                        loadImage: { _, _ in throw RpcError("Offline", "No workspace for a guide.") },
                        openFile: { _, _ in })
                }
            }
            ForEach(group.files, id: \.file.path) { entry in
                FileDiffRow(entry: entry)
                    .padding(.leading, CGFloat(depth) * 16)
            }
        }
        ForEach(group.children, id: \.key) { child in
            GuideGroupSection(group: child, depth: depth + 1)
        }
    }
}

/// One changed file: status, name and size, its guide notes, and its diff on tap.
struct FileDiffRow: View {
    let file: PullRequestFile
    let fileNotes: [GuideFileNote]
    let lineNotesInHunks: [GuideLineNote]
    let lineNotesOutsideHunks: [GuideLineNote]

    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(file: PullRequestFile) {
        self.init(
            file: file, fileNotes: [], lineNotesInHunks: [], lineNotesOutsideHunks: [])
    }

    init(entry: GuideResolution.File) {
        self.init(
            file: entry.file, fileNotes: entry.fileNotes, lineNotesInHunks: entry.lineNotesInHunks,
            lineNotesOutsideHunks: entry.lineNotesOutsideHunks)
    }

    private init(
        file: PullRequestFile, fileNotes: [GuideFileNote], lineNotesInHunks: [GuideLineNote],
        lineNotesOutsideHunks: [GuideLineNote]
    ) {
        self.file = file
        self.fileNotes = fileNotes
        self.lineNotesInHunks = lineNotesInHunks
        self.lineNotesOutsideHunks = lineNotesOutsideHunks
    }

    private var critical: Bool {
        fileNotes.contains { $0.critical == true }
            || (lineNotesInHunks + lineNotesOutsideHunks).contains { $0.critical == true }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(reduceMotion ? nil : .default) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.caption.bold())
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .foregroundStyle(.secondary)
                    Text(verbatim: file.status.letter)
                        .font(.system(.subheadline, design: .monospaced).bold())
                        .foregroundStyle(file.status.tone.color)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: FileKind.basename(file.path))
                            .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        let folder = FileKind.dirname(file.path)
                        if !folder.isEmpty {
                            Text(verbatim: "\(folder)/")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                        if let previousPath = file.previousPath {
                            Text(.mobilePrFileFrom(previousPath))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                    }
                    Spacer(minLength: 8)
                    if critical {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Tone.attention.color)
                    }
                    PullRequestSize(additions: file.additions, deletions: file.deletions)
                }
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityValue(Text(verbatim: expanded ? "expanded" : ""))
            .accessibilityAddTraits(.isButton)
            // PatchView cannot interleave notes between diff lines, so line notes sit with the file notes,
            // labelled with their line.
            ForEach(Array(fileNotes.enumerated()), id: \.offset) { _, note in
                GuideNoteCard(text: note.text, critical: note.critical == true, line: nil)
            }
            ForEach(Array((lineNotesOutsideHunks + lineNotesInHunks).enumerated()), id: \.offset) {
                _, note in
                GuideNoteCard(text: note.text, critical: note.critical == true, line: Int(note.line))
            }
            if expanded {
                if file.binary {
                    Text(.mobilePrFileBinary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    PatchView(patch: file.patch)
                }
            }
        }
    }

    private var accessibilityLabel: String {
        var parts = [file.path]
        if let label = file.status.label { parts.append(String(localized: label)) }
        if critical { parts.append(String(localized: .mobilePrGuideCritical)) }
        return parts.joined(separator: ", ")
    }
}

/// A guide note on a file or a line, in a card that turns amber when it needs extra care.
private struct GuideNoteCard: View {
    let text: String
    let critical: Bool
    let line: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: critical ? "exclamationmark.triangle" : "sparkles")
                    .foregroundStyle(critical ? Tone.attention.color : .secondary)
                if let line {
                    Text(.mobilePrGuideLine(String(line)))
                        .font(.caption.weight(.semibold))
                }
                if critical {
                    Text(.mobilePrGuideCritical)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Tone.attention.color)
                }
            }
            MarkdownView(
                text, root: nil,
                loadImage: { _, _ in throw RpcError("Offline", "No workspace for a guide note.") },
                openFile: { _, _ in })
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            critical ? Tone.attention.color.opacity(0.15) : Color(.tertiarySystemFill),
            in: .rect(cornerRadius: 8)
        )
        .accessibilityElement(children: .combine)
    }
}

extension PullRequestFileStatus {
    var letter: String {
        switch self {
        case .added: "A"
        case .removed: "D"
        case .modified: "M"
        case .renamed: "R"
        case .copied: "C"
        case .unknown(let value): String(value.prefix(1)).uppercased()
        }
    }

    var tone: Tone {
        switch self {
        case .added: .running
        case .removed: .danger
        case .modified: .attention
        case .renamed, .copied, .unknown: .neutral
        }
    }

    var label: LocalizedStringResource? {
        switch self {
        case .added: .mobilePrFileAdded
        case .removed: .mobilePrFileRemoved
        case .modified: .mobilePrFileModified
        case .renamed: .mobilePrFileRenamed
        case .copied: .mobilePrFileCopied
        case .unknown: nil
        }
    }
}

extension GuideCategory {
    var symbol: String {
        switch self {
        case .ui: "rectangle.grid.2x2"
        case .api: "powerplug"
        case .core: "chevron.left.forwardslash.chevron.right"
        case .data: "cylinder"
        case .cli: "terminal"
        case .security: "lock.shield"
        case .tests: "testtube.2"
        case .docs: "book"
        case .examples: "play.circle"
        case .deps: "shippingbox"
        case .build: "hammer"
        case .scripts: "wrench.and.screwdriver"
        case .config: "slider.horizontal.3"
        case .i18n: "globe"
        case .assets: "photo"
        case .other, .unknown: "ellipsis"
        }
    }

    var label: LocalizedStringResource {
        switch self {
        case .ui: .mobilePrGuideCategoryUi
        case .api: .mobilePrGuideCategoryApi
        case .core: .mobilePrGuideCategoryCore
        case .data: .mobilePrGuideCategoryData
        case .cli: .mobilePrGuideCategoryCli
        case .security: .mobilePrGuideCategorySecurity
        case .tests: .mobilePrGuideCategoryTests
        case .docs: .mobilePrGuideCategoryDocs
        case .examples: .mobilePrGuideCategoryExamples
        case .deps: .mobilePrGuideCategoryDeps
        case .build: .mobilePrGuideCategoryBuild
        case .scripts: .mobilePrGuideCategoryScripts
        case .config: .mobilePrGuideCategoryConfig
        case .i18n: .mobilePrGuideCategoryI18N
        case .assets: .mobilePrGuideCategoryAssets
        case .other, .unknown: .mobilePrGuideCategoryOther
        }
    }
}

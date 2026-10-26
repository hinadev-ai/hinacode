import HinaCodeKit
import SwiftUI

/// The Files tab: the thread's workspace from its root, searchable by path and by content. Folders push
/// `FolderView`, files push `FileView`.
struct FilesPanel: View {
    let threadId: String
    /// False while another tab is up. The panel stays mounted, but `.searchable` hoists to the navigation stack and
    /// would float over the other tabs, so it is not applied until the tab returns (see `body`).
    var isSelected: Bool = true

    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var searchPresented = false

    private var thread: AgentThread? { model.threads.threads[threadId] }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        // Not applying `.searchable` at all on other tabs remounts the listing, which then refetches. That beats a
        // search field floating over Chat, PRs and the terminal (on iPad it pins to the toolbar even unpresented).
        if isSelected {
            content
                .searchable(
                    text: $query, isPresented: $searchPresented, prompt: Text(.mobileFilesSearchPlaceholder))
        } else {
            content
        }
    }

    @ViewBuilder private var content: some View {
        Group {
            if let thread {
                if let root = model.threads.root(of: thread) {
                    if searching {
                        FileSearchView(threadId: threadId, query: query.trimmingCharacters(in: .whitespaces))
                    } else {
                        FolderContentsView(threadId: threadId, root: root, path: "")
                    }
                } else {
                    ProgressView(.mobileFilesFindingWorkspace)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else if model.threads.status == .loading {
                ProgressView(.mobileFilesLoadingThread)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView(.mobileFilesThreadMissing, systemImage: "questionmark.circle")
            }
        }
        .background {
            Button("Search") { searchPresented = true }
                .keyboardShortcut("f", modifiers: .command)
                .opacity(0)
                .accessibilityHidden(true)
        }
    }
}

/// One folder level from `fs.list`, folders first, in the order the desktop sends them.
struct FolderContentsView: View {
    let threadId: String
    let root: String
    let path: String

    @Environment(AppModel.self) private var model
    @State private var state: FolderState = .loading
    @State private var reloads = 0

    private enum FolderState: Equatable {
        case loading
        case failed(String)
        case entries([FsEntry])
    }

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView(.mobileFilesLoading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ContentUnavailableView {
                    Label(.mobileFilesFailed(message), systemImage: "exclamationmark.triangle")
                } actions: {
                    Button(.mobileFilesRetry) { reloads += 1 }
                        .buttonStyle(.borderedProminent)
                }
            case .entries(let entries):
                if entries.isEmpty {
                    ContentUnavailableView(.mobileFilesEmptyFolder, systemImage: "folder")
                } else {
                    List {
                        ForEach(entries, id: \.path) { entry in
                            NavigationLink(value: route(for: entry)) {
                                FileEntryRow(entry: entry)
                            }
                        }
                    }
                    .accessibilityIdentifier("files-list")
                    .refreshable { await load() }
                }
            }
        }
        .task(id: "\(root)\0\(path)\0\(reloads)\0\(model.hub.generation)") { await load() }
    }

    private func route(for entry: FsEntry) -> DetailRoute {
        entry.kind == .dir
            ? .folder(threadId: threadId, path: entry.path)
            : .file(threadId: threadId, path: entry.path, line: nil)
    }

    private func load() async {
        if case .entries = state {} else { state = .loading }
        do {
            let entries = try await model.hub.call(RPC.fsList, FsListRequest(root: root, path: path))
            state = .entries(entries.filter { $0.kind == .dir } + entries.filter { $0.kind != .dir })
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

/// One entry in a folder: its kind's symbol, its name, and a git status letter when the file changed.
struct FileEntryRow: View {
    let entry: FsEntry

    var body: some View {
        HStack(spacing: 12) {
            FileKindIcon(path: entry.path, kind: entry.kind)
            Text(verbatim: entry.name)
                .foregroundStyle(entry.ignored ? .secondary : .primary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            if let status = entry.gitStatus {
                Text(verbatim: status.letter)
                    .font(.system(.subheadline, design: .monospaced).bold())
                    .foregroundStyle(status.tone.color)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        var parts = [
            entry.kind == .dir ? String(localized: .mobileFilesFolderLabel(entry.name)) : entry.name
        ]
        if let label = entry.gitStatus?.label { parts.append(String(localized: label)) }
        if entry.ignored { parts.append(String(localized: .mobileFilesIgnored)) }
        return parts.joined(separator: ", ")
    }
}

/// A folder filled in the tint, like the Files app, or the file kind's document symbol, at one fixed width so names
/// line up.
struct FileKindIcon: View {
    let path: String
    let kind: FsEntryKind

    @ScaledMetric(relativeTo: .body) private var width = 28

    var body: some View {
        let icon = FileKind.icon(path: path, entry: kind)
        Image(systemName: icon.symbol)
            .font(.title3)
            .foregroundStyle(icon == .folder ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
            .frame(width: width)
            .accessibilityHidden(true)
    }
}

extension FileKind.Icon {
    var symbol: String {
        switch self {
        case .folder: "folder.fill"
        case .image: "photo"
        case .markdown: "doc.richtext"
        case .code: "doc.text"
        case .text: "doc.plaintext"
        case .file: "doc"
        }
    }
}

extension ChangedFileStatus {
    var letter: String {
        switch self {
        case .added: "A"
        case .modified: "M"
        case .deleted: "D"
        case .untracked: "U"
        case .conflict: "C"
        case .unknown(let value): String(value.prefix(1)).uppercased()
        }
    }

    var tone: Tone {
        switch self {
        case .added, .untracked: .running
        case .modified: .attention
        case .deleted, .conflict, .unknown: .danger
        }
    }

    var label: LocalizedStringResource? {
        switch self {
        case .added: .mobileFilesStatusAdded
        case .modified: .mobileFilesStatusModified
        case .deleted: .mobileFilesStatusDeleted
        case .untracked: .mobileFilesStatusUntracked
        case .conflict: .mobileFilesStatusConflict
        case .unknown: nil
        }
    }
}

/// "Go to file": path matches over the thread's whole file list, then, on request, lines containing the query.
private struct FileSearchView: View {
    let threadId: String
    let query: String

    @Environment(AppModel.self) private var model
    @State private var files: FilesState = .loading
    @State private var filesReloads = 0
    @State private var contentsStarted = false
    @State private var contents: ContentsState = .idle
    @State private var contentsReloads = 0

    private enum FilesState: Equatable {
        case loading
        case failed(String)
        case ready([String])
    }

    private enum ContentsState: Equatable {
        case idle, searching, ripgrepMissing
        case failed(String)
        case hits([FileSearchHit])
    }

    var body: some View {
        Group {
            switch files {
            case .loading:
                ProgressView(.mobileFilesLoading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ContentUnavailableView {
                    Label(.mobileFilesFailed(message), systemImage: "exclamationmark.triangle")
                } actions: {
                    Button(.mobileFilesRetry) { filesReloads += 1 }
                        .buttonStyle(.borderedProminent)
                }
            case .ready(let all):
                resultsList(PathMatch.matches(all, query: query))
            }
        }
        .task(id: "\(threadId)\0\(filesReloads)") { await loadFiles() }
        .task(id: "\(query)\0\(contentsStarted)\0\(contentsReloads)") { await searchContents() }
        .onSubmit(of: .search) { contentsStarted = true }
        .onChange(of: query) { _, _ in
            if !contentsStarted { contents = .idle }
        }
    }

    private func resultsList(_ matches: [PathMatch]) -> some View {
        List {
            if matches.isEmpty {
                Text(.mobileFilesNoMatches(query))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(matches, id: \.path) { match in
                    NavigationLink(value: DetailRoute.file(threadId: threadId, path: match.path, line: nil)) {
                        PathMatchRow(match: match)
                    }
                }
            }
            contentsSection
        }
        .accessibilityIdentifier("files-list")
    }

    @ViewBuilder private var contentsSection: some View {
        if !contentsStarted {
            Button {
                contentsStarted = true
            } label: {
                Label(.mobileFilesSearchContents(query), systemImage: "magnifyingglass")
                    .frame(minHeight: 44)
            }
        } else {
            Section {
                switch contents {
                case .idle, .searching:
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(.mobileFilesSearching)
                            .foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 44)
                case .ripgrepMissing:
                    Label(.mobileFilesRipgrepMissing, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Tone.attention.color)
                case .failed(let message):
                    Label(.mobileFilesFailed(message), systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Tone.danger.color)
                    Button(.mobileFilesRetry) { contentsReloads += 1 }
                case .hits(let hits):
                    if hits.isEmpty {
                        Text(.mobileFilesNoLines(query))
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(hits.enumerated()), id: \.offset) { _, hit in
                            NavigationLink(
                                value: DetailRoute.file(threadId: threadId, path: hit.path, line: Int(hit.line))
                            ) {
                                ContentHitRow(hit: hit, query: query)
                            }
                        }
                    }
                }
            } header: {
                Text(.mobileFilesContentsHeading(query))
            }
        }
    }

    private func loadFiles() async {
        if case .ready = files { return }
        files = .loading
        do {
            files = .ready(try await model.hub.call(RPC.filesList, FilesListRequest(threadId: threadId)))
        } catch {
            files = .failed(error.localizedDescription)
        }
    }

    private func searchContents() async {
        guard contentsStarted else { return }
        contents = .searching
        // One search per pause in typing, as in the Expo app.
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        do {
            let hits = try await model.hub.call(
                RPC.searchFiles, SearchFilesRequest(threadId: threadId, query: query, limit: 100))
            if !Task.isCancelled { contents = .hits(hits) }
        } catch {
            if (error as? RpcError)?.tag == "RipgrepMissingError" {
                contents = .ripgrepMissing
            } else if !Task.isCancelled {
                contents = .failed(error.localizedDescription)
            }
        }
    }
}

/// A matched path: the file name, its folder under it, matched characters bold.
private struct PathMatchRow: View {
    let match: PathMatch

    var body: some View {
        HStack(spacing: 12) {
            FileKindIcon(path: match.path, kind: .file)
            VStack(alignment: .leading, spacing: 2) {
                Text(Self.highlighted(match.path, positions: match.positions, in: nameRange))
                    .lineLimit(1)
                if !folder.isEmpty {
                    Text(Self.highlighted(match.path, positions: match.positions, in: folderRange))
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
        }
        .accessibilityLabel(Text(verbatim: match.path))
    }

    private var folder: String { FileKind.dirname(match.path) }
    private var nameRange: Range<Int> { (match.path.utf16.count - FileKind.basename(match.path).utf16.count)..<Int.max }
    private var folderRange: Range<Int> { 0..<folder.utf16.count }

    /// The slice of `path` inside `range` (UTF-16 offsets), with the matched characters in it bold.
    private static func highlighted(_ path: String, positions: [Int], in range: Range<Int>) -> AttributedString {
        let units = Array(path.utf16)
        let matched = Set(positions)
        var result = AttributedString()
        for (offset, unit) in units.enumerated() where range.contains(offset) {
            var piece = AttributedString(String(decoding: [unit], as: UTF16.self))
            if matched.contains(offset) { piece.font = .body.bold() }
            result += piece
        }
        return result
    }
}

/// One line that contains the query, its first occurrence bold.
private struct ContentHitRow: View {
    let hit: FileSearchHit
    let query: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: "\(hit.path):\(Int(hit.line))")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.head)
            Text(highlighted)
                .font(.system(.subheadline, design: .monospaced))
                .lineLimit(2)
        }
        .accessibilityLabel(Text(verbatim: "\(hit.path), \(hit.text)"))
    }

    private var highlighted: AttributedString {
        var result = AttributedString(hit.text)
        if let range = hit.text.range(of: query, options: .caseInsensitive),
            let attributed = Range(range, in: result)
        {
            result[attributed].font = .body.bold()
            result[attributed].foregroundColor = Tone.attention.color
        }
        return result
    }
}

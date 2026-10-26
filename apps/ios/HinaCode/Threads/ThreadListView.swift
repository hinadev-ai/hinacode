import HinaCodeKit
import SwiftUI

/// Every paired machine's threads in one list: pinned first, then the inbox, the threads by project, or the
/// archived ones. Searching matches titles here and messages on the desktops.
struct ThreadListView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @State private var query = ""
    @State private var searchPresented = false
    @State private var collapsed: Set<String> = []
    @State private var messageSearch: (query: String, state: MessageSearchState) = ("", .idle)
    @State private var creatingIn: String?
    @State private var createError: (projectId: String, message: String)?

    private enum MessageSearchState {
        case idle, loading, failed(String), hits([ThreadSearchHit])
    }

    private var threads: ThreadsStore { model.threads }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        content
            .navigationTitle(.mobileHomeTitle)
            .navigationSubtitle(subtitle)
            .searchable(
                text: $query, isPresented: $searchPresented, placement: .sidebar,
                prompt: Text(.mobileSearchPlaceholder)
            )
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        router.sheet = .settings
                    } label: {
                        Label(.mobileHomeSettings, systemImage: "gearshape")
                    }
                    .accessibilityIdentifier("sidebar-settings")
                    .keyboardShortcut(",", modifiers: .command)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        router.sheet = .newThread(nil)
                    } label: {
                        Label(.mobileHomeNewThread, systemImage: "square.and.pencil")
                    }
                    .accessibilityIdentifier("sidebar-new-thread")
                    .keyboardShortcut("n", modifiers: .command)
                }
            }
            .background {
                Button("Search") { searchPresented = true }
                    .keyboardShortcut("f", modifiers: .command)
                    .opacity(0)
                    .accessibilityHidden(true)
            }
            .task(id: trimmedQuery) { await searchMessages() }
    }

    private var subtitle: Text {
        model.hub.status == .connected ? Text(verbatim: "") : Text(model.hub.status.label)
    }

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces) }

    @ViewBuilder private var content: some View {
        if threads.projects.isEmpty {
            switch threads.status {
            case .loading:
                ProgressView(.mobileHomeLoading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .error(let message):
                List { errorSection(message) }
            case .ready:
                ContentUnavailableView {
                    Label(.mobileHomeNoProjects, systemImage: "folder.badge.plus")
                } description: {
                    Text(.mobileHomeNoProjectsHint)
                } actions: {
                    Button {
                        router.sheet = .addProject
                    } label: {
                        Label(.mobileHomeAddProject, systemImage: "folder.badge.plus")
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("add-project")
                }
            }
        } else {
            threadList
        }
    }

    private var threadList: some View {
        List(selection: Bindable(router).selection) {
            if case .error(let message) = threads.status {
                errorSection(message)
            }
            if searching {
                searchSections
            } else {
                homeSections
            }
        }
        .safeAreaBar(edge: .top) {
            if !searching {
                Picker(.mobileHomeTabs, selection: Bindable(model.preferences).homeTab) {
                    Text(.mobileHomeTabInbox).tag(PhonePreferences.HomeTab.inbox)
                    Text(.mobileHomeTabThreads).tag(PhonePreferences.HomeTab.threads)
                    Text(.mobileHomeTabArchived).tag(PhonePreferences.HomeTab.archived)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal)
                .padding(.vertical, 6)
                .accessibilityIdentifier("home-tabs")
            }
        }
        .refreshable { await threads.load() }
        .animation(.default, value: threads.threads)
    }

    private func errorSection(_ message: String) -> some View {
        Section {
            Label {
                Text(verbatim: message)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Tone.danger.color)
            }
            Button {
                Task { await threads.load() }
            } label: {
                Label(.mobileHomeRetry, systemImage: "arrow.clockwise")
            }
        }
    }

    @ViewBuilder private var homeSections: some View {
        Section {
            Label(.mobileHomeOverview, systemImage: "square.grid.2x2")
                .tag(SidebarItem.overview)
                .accessibilityIdentifier("sidebar-overview")
        }

        let all = Array(threads.threads.values)
        let pinned = ThreadsStore.pinnedThreads(all)
        if !pinned.isEmpty {
            Section(.mobileHomePinned) {
                ForEach(pinned) { thread in
                    ThreadRow(thread: thread, showProject: Self.spansProjects(pinned))
                        .tag(SidebarItem.thread(thread.id))
                }
            }
        }

        switch model.preferences.homeTab {
        case .inbox:
            let inbox = ThreadsStore.inboxThreads(all)
            Section {
                if inbox.isEmpty {
                    ContentUnavailableView(
                        .mobileHomeInboxEmpty, systemImage: "tray", description: Text(.mobileHomeInboxEmptyHint))
                } else {
                    ForEach(inbox) { thread in
                        ThreadRow(thread: thread, showProject: Self.spansProjects(inbox))
                            .tag(SidebarItem.thread(thread.id))
                    }
                }
            }
        case .archived:
            let archived = ThreadsStore.archivedThreads(all)
            Section {
                if archived.isEmpty {
                    ContentUnavailableView(.mobileHomeArchivedEmpty, systemImage: "archivebox")
                } else {
                    ForEach(archived) { thread in
                        ThreadRow(thread: thread, showProject: Self.spansProjects(archived))
                            .tag(SidebarItem.thread(thread.id))
                    }
                }
            }
        case .threads:
            ForEach(threads.projects) { project in
                projectSection(project, threads: all)
            }
        }
    }

    /// A row names its project only when its neighbors could belong to another one.
    private static func spansProjects(_ threads: [AgentThread]) -> Bool {
        Set(threads.map(\.projectId)).count > 1
    }

    private func projectSection(_ project: Project, threads all: [AgentThread]) -> some View {
        let expanded = Binding(
            get: { !collapsed.contains(project.id) },
            set: { if $0 { collapsed.remove(project.id) } else { collapsed.insert(project.id) } })
        let own = all.filter { $0.projectId == project.id }
        let listed = ThreadsStore.sortThreads(own.filter { $0.status != .archived && $0.pinnedAt == nil })
        return Section(isExpanded: expanded) {
            if own.allSatisfy({ $0.status == .archived }) {
                Text(.mobileHomeProjectEmpty)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(listed) { thread in
                ThreadRow(thread: thread, showProject: false)
                    .tag(SidebarItem.thread(thread.id))
            }
            if let createError, createError.projectId == project.id {
                Label {
                    Text(verbatim: createError.message)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Tone.danger.color)
                }
                .font(.footnote)
            }
        } header: {
            HStack(spacing: 6) {
                ProjectIcon(projectId: project.id)
                Text(verbatim: project.name)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .textCase(nil)
                if model.hub.servers.count > 1, let server = model.server(ofProject: project.id) {
                    ServerMark(server: server)
                        .font(.footnote)
                }
                Spacer()
                if creatingIn == project.id {
                    ProgressView()
                } else {
                    Button {
                        createThread(in: project)
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel(Text(.mobileHomeNewInProject(project.name)))
                    .accessibilityIdentifier("new-thread-in-\(project.id)")
                }
            }
        }
    }

    private func createThread(in project: Project) {
        creatingIn = project.id
        createError = nil
        Task {
            defer { creatingIn = nil }
            do {
                let thread = try await model.hub.call(RPC.threadsCreate, ThreadsCreateRequest(projectId: project.id))
                model.threads.upsert(thread)
                router.open(thread: thread.id)
            } catch {
                createError = (project.id, error.localizedDescription)
            }
        }
    }

    @ViewBuilder private var searchSections: some View {
        let matches = ThreadsStore.matchThreads(
            Array(threads.threads.values), projects: threads.projects, query: trimmedQuery)
        if !matches.isEmpty {
            Section(.mobileSearchThreads) {
                ForEach(matches.prefix(20)) { thread in
                    ThreadRow(thread: thread, showProject: true)
                        .tag(SidebarItem.thread(thread.id))
                }
            }
        }

        let state = messageSearch.query == trimmedQuery ? messageSearch.state : MessageSearchState.idle
        switch state {
        case .idle:
            if matches.isEmpty { searchEmpty }
        case .loading:
            Section(.mobileSearchMessages) {
                ProgressView(.mobileSearchSearching)
            }
        case .failed(let message):
            Section(.mobileSearchMessages) {
                Label {
                    Text(verbatim: message)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Tone.danger.color)
                }
            }
        case .hits(let hits):
            if hits.isEmpty {
                if matches.isEmpty { searchEmpty }
            } else {
                Section(.mobileSearchMessages) {
                    ForEach(hits, id: \.messageId) { hit in
                        MessageHitRow(hit: hit, query: trimmedQuery) { router.open(thread: hit.threadId) }
                    }
                }
            }
        }
    }

    private var searchEmpty: some View {
        Section {
            ContentUnavailableView(
                .mobileSearchEmpty, systemImage: "magnifyingglass", description: Text(.mobileSearchEmptyHint))
        }
    }

    private func searchMessages() async {
        let query = trimmedQuery
        guard query.count >= 2 else {
            messageSearch = (query, .idle)
            return
        }
        try? await Task.sleep(for: .milliseconds(150))
        guard !Task.isCancelled, trimmedQuery == query else { return }
        messageSearch = (query, .loading)
        do {
            let hits = try await model.hub.call(RPC.searchThreads, SearchThreadsRequest(query: query, limit: 30))
            guard trimmedQuery == query else { return }
            messageSearch = (query, .hits(hits))
        } catch {
            guard trimmedQuery == query else { return }
            messageSearch = (query, .failed(error.localizedDescription))
        }
    }
}

/// A message found by searching the desktops: its thread, and the matched words standing out in the snippet.
private struct MessageHitRow: View {
    let hit: ThreadSearchHit
    let query: String
    let open: () -> Void

    @Environment(AppModel.self) private var model

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    if let thread = model.threads.threads[hit.threadId] {
                        ProviderMark(provider: thread.provider)
                    }
                    Text(verbatim: hit.threadTitle.isEmpty ? String(localized: .mobileHomeUntitled) : hit.threadTitle)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    RelativeTimeText(iso: hit.at, now: .now)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Text(snippet)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .padding(.leading, 26)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(hit.threadTitle), \(hit.snippet)")
    }

    /// The snippet with each occurrence of the query semibold, unless lowercasing changed its length and the ranges
    /// would no longer line up.
    private var snippet: AttributedString {
        var text = AttributedString(hit.snippet)
        let haystack = hit.snippet.lowercased()
        let needle = query.lowercased()
        guard !needle.isEmpty, haystack.utf16.count == hit.snippet.utf16.count,
            needle.utf16.count == query.utf16.count
        else { return text }
        var from = haystack.startIndex
        while let range = haystack.range(of: needle, range: from..<haystack.endIndex) {
            let start = text.utf16.index(
                text.startIndex, offsetBy: haystack.utf16.distance(from: haystack.startIndex, to: range.lowerBound))
            let end = text.utf16.index(start, offsetBy: needle.utf16.count)
            text[start..<end].inlinePresentationIntent = .stronglyEmphasized
            text[start..<end].foregroundColor = .primary
            from = range.upperBound
        }
        return text
    }
}

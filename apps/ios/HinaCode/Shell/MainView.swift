import HinaCodeKit
import SwiftUI

/// The paired app: the thread list in the sidebar, the open thread (or the overview) beside it. On iPhone and in
/// narrow iPad windows the split view collapses into a stack on its own.
struct MainView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationSplitView(columnVisibility: columnVisibility) {
            ThreadListView()
        } detail: {
            NavigationStack(path: Bindable(router).path) {
                detailRoot
                    .navigationDestination(for: DetailRoute.self) { DetailDestination(route: $0) }
            }
        }
        .sheet(item: Bindable(router).sheet) { sheet in
            switch sheet {
            case .newThread(let issue): NewThreadSheet(issue: issue)
            case .addProject: AddProjectSheet()
            case .addServer: AddServerSheet()
            case .settings: SettingsView()
            }
        }
        .onChange(of: router.selection) { router.path = [] }
        .onChange(of: router.openThreadId) { _, threadId in clearUnseen(threadId) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { clearUnseen(router.openThreadId) }
        }
    }

    @ViewBuilder private var detailRoot: some View {
        switch router.selection {
        case .overview:
            OverviewView()
        case .thread(let threadId):
            ThreadView(threadId: threadId)
        case nil:
            ContentUnavailableView(.mobileHomeNoSelection, systemImage: "text.bubble")
        }
    }

    private var columnVisibility: Binding<NavigationSplitViewVisibility> {
        Binding(
            get: { model.preferences.sidebarHidden ? .detailOnly : .all },
            set: { model.preferences.sidebarHidden = $0 == .detailOnly })
    }

    private func clearUnseen(_ threadId: String?) {
        if let threadId { model.unseen.clear(threadId: threadId) }
    }
}

/// Everything pushed over a thread or the overview.
struct DetailDestination: View {
    let route: DetailRoute

    var body: some View {
        switch route {
        case .folder(let threadId, let path):
            FolderView(threadId: threadId, path: path)
        case .file(let threadId, let path, let line):
            FileView(threadId: threadId, path: path, line: line)
        case .pullRequest(let threadId, let url):
            PullRequestView(threadId: threadId, url: url)
        }
    }
}

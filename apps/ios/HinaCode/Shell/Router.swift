import Foundation
import HinaCodeKit

/// What the sidebar selects.
enum SidebarItem: Hashable {
    case overview
    case thread(String)
}

/// What the detail column pushes over its root.
enum DetailRoute: Hashable {
    case folder(threadId: String, path: String)
    case file(threadId: String, path: String, line: Int?)
    case pullRequest(threadId: String, url: String)
}

/// What a sheet over the whole window shows.
enum AppSheet: Identifiable, Hashable {
    case newThread(LinearIssue?)
    case addProject
    case addServer
    case settings

    var id: Self { self }
}

/// Where the window is. Every way into a thread (a row, a search hit, a notification) goes through `open(thread:)`.
@MainActor
@Observable
final class Router {
    var selection: SidebarItem?
    var path: [DetailRoute] = []
    var sheet: AppSheet?

    var openThreadId: String? {
        if case .thread(let id) = selection { id } else { nil }
    }

    func open(thread id: String) {
        sheet = nil
        path = []
        selection = .thread(id)
    }
}

import HinaCodeKit
import SwiftUI

/// A folder in a thread's workspace, pushed over the thread. The crumb bar pops back to any folder above it.
struct FolderView: View {
    let threadId: String
    let path: String

    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router

    private var thread: AgentThread? { model.threads.threads[threadId] }

    var body: some View {
        Group {
            if let thread {
                if let root = model.threads.root(of: thread) {
                    FolderContentsView(threadId: threadId, root: root, path: path)
                        .safeAreaBar(edge: .top) { crumbs(root: root) }
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
        .navigationTitle(Text(verbatim: FileKind.basename(path)))
    }

    /// The workspace root's name, then each folder above this one. The current folder is not a button.
    private func crumbs(root: String) -> some View {
        let parts = path.split(separator: "/").map(String.init)
        return ScrollView(.horizontal) {
            HStack(spacing: 4) {
                crumb(Project.baseName(of: root), depth: 0)
                ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    crumb(part, depth: index + 1, current: index == parts.count - 1)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .defaultScrollAnchor(.trailing)
        .accessibilityLabel(Text(.mobileFilesCrumbsLabel))
    }

    @ViewBuilder private func crumb(_ name: String, depth: Int, current: Bool = false) -> some View {
        if current {
            Text(verbatim: name)
                .font(.subheadline.bold())
                .lineLimit(1)
        } else {
            Button {
                pop(toDepth: depth)
            } label: {
                Text(verbatim: name)
                    .font(.subheadline)
                    .lineLimit(1)
                    .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
    }

    /// Drops the pushed routes below the crumb: depth 0 is the Files tab itself, depth n keeps n folder pushes.
    private func pop(toDepth depth: Int) {
        let parts = path.split(separator: "/").map(String.init)
        guard depth < parts.count else { return }
        let target: DetailRoute? =
            if depth == 0 {
                nil
            } else {
                .folder(threadId: threadId, path: parts.prefix(depth).joined(separator: "/"))
            }
        if let target, let index = router.path.lastIndex(of: target) {
            router.path = Array(router.path[...index])
        } else if let first = router.path.firstIndex(where: { route in
            if case .folder(let id, _) = route { return id == threadId }
            return false
        }) {
            router.path = Array(router.path[..<first])
        }
    }
}

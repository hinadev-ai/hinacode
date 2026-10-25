import HinaCodeKit
import SwiftUI

/// Where a thread's first turn runs: the project root switched to a branch, or a new worktree. The pick lives in
/// the drafts store and rides along with the first `threads.send`.
struct WorkspaceSheet: View {
    let threadId: String
    let projectId: String
    @Binding var error: String?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var branches: [String] = []
    @State private var pullRequests: [OpenPullRequest] = []
    @State private var defaultBranch: String?

    private var workspace: DraftsStore.Workspace? { model.drafts.workspaces[threadId] }
    private var mode: WorkspaceChoice.Mode { workspace?.mode ?? .local }
    private var ref: String { workspace?.ref ?? "" }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField(text: refBinding, prompt: Text(.mobileComposerWorkspacePlaceholder)) {
                        Text(.mobileComposerWorkspaceRef)
                    }
                    .font(.system(.body, design: .monospaced))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityLabel(Text(.mobileComposerWorkspaceRef))
                }
                runInSection
                if !filteredPullRequests.isEmpty {
                    Section {
                        ForEach(filteredPullRequests, id: \.number) { pullRequest in
                            pickRow(
                                selected: trimmedRef == "#\(pullRequest.number)",
                                title: "#\(pullRequest.number) \(pullRequest.title)",
                                subtitle: pullRequest.isDraft
                                    ? "\(String(localized: .mobilePrStateDraft)), \(pullRequest.headRefName)"
                                    : pullRequest.headRefName,
                                symbol: "arrow.triangle.pull"
                            ) {
                                setRef("#\(pullRequest.number)")
                            }
                        }
                    } header: {
                        Text(.mobileOverviewPullRequests)
                    }
                }
                if !filteredBranches.isEmpty {
                    Section {
                        ForEach(filteredBranches, id: \.self) { branch in
                            pickRow(
                                selected: trimmedRef == branch, title: branch, subtitle: nil,
                                symbol: "arrow.triangle.branch"
                            ) {
                                setRef(branch)
                            }
                        }
                    } header: {
                        Text(.mobileComposerBranches)
                    }
                }
            }
            .navigationTitle(Text(.mobileComposerWorkspace))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Text(.mobileSettingsDone)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
    }

    private var runInSection: some View {
        Section {
            pickRow(
                selected: mode != .worktree, title: String(localized: .mobileComposerProjectRoot),
                subtitle: String(localized: .mobileComposerProjectRootHint), symbol: "folder"
            ) {
                if mode == .worktree { model.drafts.setWorkspace(nil, threadId: threadId) }
            }
            pickRow(
                selected: mode == .worktree, title: String(localized: .mobileComposerNewWorktree),
                subtitle: String(localized: .mobileComposerNewWorktreeHint), symbol: "arrow.triangle.branch"
            ) {
                model.drafts.setWorkspace(
                    DraftsStore.Workspace(mode: .worktree, ref: defaultBranch ?? ref), threadId: threadId)
            }
        } header: {
            Text(.mobileComposerRunIn)
        }
    }

    private func pickRow(
        selected: Bool, title: String, subtitle: String?, symbol: String, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: symbol)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: title)
                        .lineLimit(1)
                    if let subtitle, !subtitle.isEmpty {
                        Text(verbatim: subtitle)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.accentColor)
                }
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var refBinding: Binding<String> {
        Binding(
            get: { ref },
            set: { typed in
                if typed.isEmpty && mode == .local {
                    model.drafts.setWorkspace(nil, threadId: threadId)
                } else {
                    model.drafts.setWorkspace(DraftsStore.Workspace(mode: mode, ref: typed), threadId: threadId)
                }
            })
    }

    private func setRef(_ newRef: String) {
        model.drafts.setWorkspace(DraftsStore.Workspace(mode: mode, ref: newRef), threadId: threadId)
    }

    private var trimmedRef: String { ref.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Everything is shown when the field exactly names a listed branch or pull request.
    private var showAll: Bool {
        branches.contains(trimmedRef) || pullRequests.contains { "#\($0.number)" == trimmedRef }
    }

    private var filteredBranches: [String] {
        let query = trimmedRef.lowercased()
        let matches = showAll || query.isEmpty ? branches : branches.filter { $0.lowercased().contains(query) }
        return Array(matches.prefix(20))
    }

    private var filteredPullRequests: [OpenPullRequest] {
        let query = trimmedRef.lowercased()
        let matches =
            showAll || query.isEmpty
            ? pullRequests
            : pullRequests.filter { "#\($0.number) \($0.title) \($0.headRefName)".lowercased().contains(query) }
        return Array(matches.prefix(20))
    }

    private func load() async {
        do {
            async let listed = model.hub.call(RPC.projectsBranches, ProjectsBranchesRequest(id: projectId))
            async let fallback = model.hub.call(
                RPC.projectsDefaultBranch, ProjectsDefaultBranchRequest(id: projectId))
            branches = try await listed
            defaultBranch = try await fallback
        } catch {
            self.error = error.localizedDescription
        }
        pullRequests =
            (try? await model.hub.call(RPC.projectsPullRequests, ProjectsPullRequestsRequest(id: projectId))) ?? []
        // Fresh refs, then the branch list again. Both are allowed to fail (offline, no remote).
        _ = try? await model.hub.call(RPC.projectsFetch, ProjectsFetchRequest(id: projectId))
        if let fresh = try? await model.hub.call(RPC.projectsBranches, ProjectsBranchesRequest(id: projectId)) {
            branches = fresh
        }
    }
}

/// The composer's workspace chip, shown until the first message: the picked ref, else the root's current branch.
struct WorkspaceChip: View {
    let threadId: String
    let projectId: String
    let action: () -> Void

    @Environment(AppModel.self) private var model

    private var workspace: DraftsStore.Workspace? { model.drafts.workspaces[threadId] }

    private var label: String {
        if let ref = workspace?.ref, !ref.isEmpty { return ref }
        return model.threads.branches[projectId] ?? String(localized: .mobileComposerProjectRoot)
    }

    private var isPullRequest: Bool {
        guard let ref = workspace?.ref else { return false }
        if case .pullRequest = CheckoutTarget(workspaceRef: ref) { return true }
        return false
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: isPullRequest ? "arrow.triangle.pull" : "arrow.triangle.branch")
                Text(verbatim: label)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                if workspace?.mode == .worktree {
                    Text(.mobileComposerWorktree)
                        .font(.caption)
                }
                Image(systemName: "chevron.down")
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.glass)
        .accessibilityLabel(Text(.mobileComposerWorkspace))
        .accessibilityValue(
            workspace?.mode == .worktree
                ? String(localized: .mobileComposerWorktreeFrom(label))
                : label)
    }
}

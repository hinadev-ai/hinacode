import HinaCodeKit
import SwiftUI

/// Starts a thread: pick a project, and for a folder that lives on several machines, the machine. With a Linear
/// issue, the new thread starts with the issue as its draft.
struct NewThreadSheet: View {
    let issue: LinearIssue?

    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var group: [Project]?
    @State private var creatingIn: String?
    @State private var createError: String?

    private var groups: [[Project]] {
        Project.groupedByRepository(
            Project.byActivity(model.threads.projects, threads: Array(model.threads.threads.values)))
    }

    var body: some View {
        NavigationStack {
            List {
                if let createError {
                    Label {
                        Text(verbatim: createError)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Tone.danger.color)
                    }
                }
                if let group {
                    chooser(group)
                } else {
                    projectList
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .cancel) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var title: Text {
        if let group, let first = group.first {
            Text(.mobileHomeNewInProject(first.name))
        } else if let issue {
            Text(verbatim: issue.identifier)
        } else {
            Text(.mobileHomeNewThreadTitle)
        }
    }

    @ViewBuilder private var projectList: some View {
        if let issue {
            Section {
                Text(verbatim: issue.title)
                    .font(.body)
                if let url = URL(string: issue.url),
                    url.scheme?.lowercased() == "https" || url.scheme?.lowercased() == "http"
                {
                    Link(destination: url) {
                        Label(.mobileOverviewOpenLinear, systemImage: "arrow.up.right.square")
                    }
                }
            } header: {
                Text(.mobileOverviewStartThread)
            }
        }
        Section {
            ForEach(groups, id: \.first?.id) { group in
                if let first = group.first {
                    projectRow(group, first: first)
                }
            }
            Button {
                router.sheet = .addProject
            } label: {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(.mobileHomeAddProject)
                        Text(.mobileHomeAddProjectHint)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "folder.badge.plus")
                }
            }
            .accessibilityIdentifier("add-project")
        }
    }

    private func projectRow(_ group: [Project], first: Project) -> some View {
        Button {
            if group.count > 1 {
                self.group = group
            } else {
                create(in: first)
            }
        } label: {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: first.name)
                    Text(verbatim: hint(for: group, first: first))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            } icon: {
                Image(systemName: "folder")
            }
        }
        .disabled(creatingIn != nil)
        .accessibilityLabel(Text(.mobileHomeNewInProject(first.name)))
        .accessibilityHint(Text(verbatim: hint(for: group, first: first)))
        .accessibilityIdentifier("new-thread-project-\(first.id)")
    }

    private func hint(for group: [Project], first: Project) -> String {
        if group.count > 1 {
            let servers = group.compactMap { model.server(ofProject: $0.id)?.name }
            return String(localized: .mobileHomeProjectServers(servers.joined(separator: ", ")))
        }
        if model.hub.servers.count > 1, let server = model.server(ofProject: first.id)?.name {
            return String(localized: .mobileHomeProjectOnServer(first.rootPath, server))
        }
        return first.rootPath
    }

    private func chooser(_ group: [Project]) -> some View {
        Section {
            ForEach(group) { project in
                let server = model.server(ofProject: project.id)
                let connected = server?.status == .connected
                Button {
                    create(in: project)
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: server?.name ?? "")
                            Text(verbatim: project.rootPath)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                    } icon: {
                        Image(systemName: connected ? "desktopcomputer" : "wifi.slash")
                    }
                }
                .disabled(!connected || creatingIn != nil)
                .accessibilityLabel(Text(.mobileHomeNewOnServer(project.name, server?.name ?? "")))
                .accessibilityIdentifier("new-thread-project-\(project.id)")
            }
            Button {
                self.group = nil
            } label: {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(.mobileHomeNewThreadBack)
                        Text(.mobileHomeNewThreadBackHint)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "chevron.left")
                }
            }
        }
    }

    private func create(in project: Project) {
        creatingIn = project.id
        createError = nil
        Task {
            defer { creatingIn = nil }
            do {
                let thread = try await model.hub.call(RPC.threadsCreate, ThreadsCreateRequest(projectId: project.id))
                model.threads.upsert(thread)
                if let issue {
                    model.drafts.setText("\(issue.identifier) \(issue.title)", threadId: thread.id)
                }
                dismiss()
                router.open(thread: thread.id)
            } catch {
                createError = error.localizedDescription
            }
        }
    }
}

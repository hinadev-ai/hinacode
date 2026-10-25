import HinaCodeKit
import SwiftUI

/// Adds a project on one desktop: a folder there, or a GitHub repository it clones. Then opens its first thread.
struct AddProjectSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var serverId: String?
    @State private var source = ""
    @State private var cloneFolder = ""
    @State private var cloneEdited = false
    @State private var name = ""
    @State private var busy = false
    @State private var submitError: String?
    @State private var createdProject: Project?
    @FocusState private var sourceFocused: Bool

    private var servers: [ServerHub.Server] { model.hub.servers }

    private var server: ServerHub.Server? {
        servers.first { $0.id == serverId } ?? servers.first { $0.status == .connected } ?? servers.first
    }

    private var repository: GitHubRepository? { GitHubRepository(parsing: source) }

    private var ready: Bool {
        if repository != nil { return !effectiveCloneFolder.trimmingCharacters(in: .whitespaces).isEmpty }
        return !source.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var effectiveCloneFolder: String {
        if cloneEdited { return cloneFolder }
        guard let repository, let server else { return cloneFolder }
        let onServer = model.threads.projects.filter { model.server(ofProject: $0.id)?.id == server.id }
        return Project.defaultCloneFolder(among: onServer, repositoryName: repository.name)
    }

    var body: some View {
        NavigationStack {
            Form {
                if servers.count > 1 {
                    Section(.mobileProjectServer) {
                        Picker(.mobileProjectServer, selection: serverBinding) {
                            ForEach(servers) { server in
                                Text(verbatim: server.name ?? "").tag(server.id)
                            }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                    }
                }

                Section {
                    TextField(text: $source, prompt: Text(.mobileProjectSourcePlaceholder)) {
                        Text(.mobileProjectSourceLabel)
                    }
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($sourceFocused)
                    .submitLabel(ready ? .go : .next)
                    .onSubmit { if ready { submit() } }
                    .accessibilityIdentifier("project-source")
                    .onChange(of: source) {
                        cloneEdited = false
                        createdProject = nil
                    }

                    if let repository {
                        Label {
                            Text(.mobileProjectRepository("\(repository.owner)/\(repository.name)"))
                        } icon: {
                            Image(systemName: "arrow.triangle.branch")
                        }
                        TextField(text: cloneBinding, prompt: Text(verbatim: effectiveCloneFolder)) {
                            Text(.mobileProjectCloneTo)
                        }
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    }

                    TextField(text: $name, prompt: Text(verbatim: namePlaceholder)) {
                        HStack(spacing: 6) {
                            Text(.mobileProjectName)
                            Text(.mobileProjectOptional)
                                .foregroundStyle(.secondary)
                        }
                    }
                } footer: {
                    Text(repository == nil ? .mobileProjectFolderHint : .mobileProjectCloneHint)
                }

                if let submitError {
                    Label {
                        Text(verbatim: submitError)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Tone.danger.color)
                    }
                }

                Section {
                    Button(action: submit) {
                        if busy {
                            ProgressView()
                        } else if repository != nil {
                            Label(.mobileProjectClone, systemImage: "arrow.down.circle")
                        } else {
                            Label(.mobileProjectAdd, systemImage: "folder.badge.plus")
                        }
                    }
                    .disabled(!ready || busy)
                    .accessibilityIdentifier("project-submit")
                }
            }
            .navigationTitle(.mobileHomeAddProject)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .cancel) { dismiss() }
                }
            }
            .task { sourceFocused = true }
        }
        .presentationDetents([.medium, .large])
    }

    private var serverBinding: Binding<String> {
        Binding(
            get: { server?.id ?? "" },
            set: {
                serverId = $0
                cloneEdited = false
                createdProject = nil
            })
    }

    private var cloneBinding: Binding<String> {
        Binding(
            get: { effectiveCloneFolder },
            set: {
                cloneFolder = $0
                cloneEdited = true
            })
    }

    private var namePlaceholder: String {
        if let repository { return repository.name }
        let base = Project.baseName(of: source)
        return base.isEmpty ? String(localized: .mobileProjectNamePlaceholder) : base
    }

    private func submit() {
        guard ready, !busy, let server else { return }
        busy = true
        submitError = nil
        Task {
            defer { busy = false }
            do {
                let project: Project
                if let createdProject {
                    project = createdProject
                } else if let repository {
                    project = try await model.hub.call(
                        RPC.projectsClone,
                        ProjectsCloneRequest(
                            repository: repository,
                            rootPath: effectiveCloneFolder.trimmingCharacters(in: .whitespaces),
                            name: name.trimmingCharacters(in: .whitespaces).isEmpty
                                ? repository.name : name.trimmingCharacters(in: .whitespaces),
                            setupScript: nil),
                        server: server.id)
                } else {
                    let trimmed = source.trimmingCharacters(in: .whitespaces)
                    project = try await model.hub.call(
                        RPC.projectsCreate,
                        ProjectsCreateRequest(
                            name: name.trimmingCharacters(in: .whitespaces).isEmpty
                                ? Project.baseName(of: trimmed) : name.trimmingCharacters(in: .whitespaces),
                            rootPath: trimmed,
                            setupScript: nil),
                        server: server.id)
                }
                createdProject = project
                model.threads.addProject(project)
                let thread = try await model.hub.call(RPC.threadsCreate, ThreadsCreateRequest(projectId: project.id))
                model.threads.upsert(thread)
                dismiss()
                router.open(thread: thread.id)
            } catch {
                submitError = error.localizedDescription
            }
        }
    }
}

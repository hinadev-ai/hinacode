import Foundation

extension Project {
    /// The last folder of `path`, ignoring trailing slashes: `~/code/app/` is `app`.
    public static func baseName(of path: String) -> String {
        path.trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: isSeparator).last.map(String.init)
            ?? ""
    }

    /// Where a clone lands unless the developer picks another folder: next to the newest project, else `~/code`.
    public static func defaultCloneFolder(among projects: [Project], repositoryName: String) -> String {
        let newest = projects.max { $0.createdAt < $1.createdAt }
        return "\(newest.map { parent(of: $0.rootPath) } ?? "~/code")/\(repositoryName)"
    }

    /// Projects with the latest activity first: their newest thread, else when the project was added.
    public static func byActivity(_ projects: [Project], threads: [AgentThread]) -> [Project] {
        var latest: [String: String] = [:]
        for thread in threads {
            if let current = latest[thread.projectId], current >= thread.updatedAt { continue }
            latest[thread.projectId] = thread.updatedAt
        }
        let activity = { (project: Project) in latest[project.id] ?? project.createdAt }
        return projects.sorted { activity($0) > activity($1) }
    }

    /// Folds projects into groups of one repository, keeping their order: a project joins the earlier group with its
    /// `repository` unless that group already has a project on its server, so two clones on one machine stay apart.
    public static func groupedByRepository(_ projects: [Project]) -> [[Project]] {
        var groups: [[Project]] = []
        for project in projects {
            let index = project.repository.flatMap { repository in
                groups.firstIndex { group in
                    group[0].repository == repository
                        && !group.contains { $0.environmentId == project.environmentId }
                }
            }
            if let index {
                groups[index].append(project)
            } else {
                groups.append([project])
            }
        }
        return groups
    }

    private static func isSeparator(_ character: Character) -> Bool { character == "/" || character == "\\" }

    private static func parent(of path: String) -> String {
        var path = Substring(path.trimmingCharacters(in: .whitespacesAndNewlines))
        while path.last.map(isSeparator) == true { path.removeLast() }
        guard let separator = path.lastIndex(where: isSeparator) else { return String(path) }
        return String(path[..<separator])
    }
}

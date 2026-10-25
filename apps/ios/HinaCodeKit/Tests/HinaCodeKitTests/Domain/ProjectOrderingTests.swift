import HinaCodeKit
import Testing

private func project(
    _ id: String, rootPath: String = "/root", createdAt: String = "2026-01-01T00:00:00.000Z",
    environmentId: String? = nil, repository: String? = nil
) -> Project {
    Project(
        id: id, name: id, rootPath: rootPath, createdAt: createdAt, updatedAt: createdAt,
        environmentId: environmentId, repository: repository, linearReview: false, kind: .folder)
}

private func thread(_ projectId: String, _ updatedAt: String) -> AgentThread {
    AgentThread(
        id: "\(projectId)-\(updatedAt)", projectId: projectId, title: "", provider: .claude, model: "m",
        fastMode: false, userSkills: false, accessMode: .supervised, status: .idle, sortIndex: 0, queue: [],
        createdBy: "user", createdAt: updatedAt, updatedAt: updatedAt)
}

struct ProjectBaseNameTests {
    @Test func `names the last folder`() {
        #expect(Project.baseName(of: "/Users/me/code/app") == "app")
        #expect(Project.baseName(of: "~/code/app") == "app")
    }

    @Test func `ignores trailing slashes and spaces`() {
        #expect(Project.baseName(of: "~/code/app/") == "app")
        #expect(Project.baseName(of: " /srv/app// ") == "app")
    }

    @Test func `keeps a bare home folder`() {
        #expect(Project.baseName(of: "~") == "~")
        #expect(Project.baseName(of: "") == "")
    }
}

struct ProjectCloneFolderTests {
    @Test func `puts the clone next to the newest project`() {
        let projects = [
            project("old", rootPath: "/Users/me/work/old", createdAt: "2026-01-01T00:00:00.000Z"),
            project("new", rootPath: "/Users/me/code/new/", createdAt: "2026-02-01T00:00:00.000Z"),
        ]
        #expect(Project.defaultCloneFolder(among: projects, repositoryName: "repo") == "/Users/me/code/repo")
    }

    @Test func `keeps a ~ parent`() {
        let projects = [project("a", rootPath: "~/src/a")]
        #expect(Project.defaultCloneFolder(among: projects, repositoryName: "repo") == "~/src/repo")
    }

    @Test func `falls back to ~/code without projects`() {
        #expect(Project.defaultCloneFolder(among: [], repositoryName: "repo") == "~/code/repo")
    }
}

struct ProjectActivityTests {
    @Test func `orders by the newest thread, else when the project was added`() {
        let projects = [
            project("quiet", createdAt: "2026-01-01T00:00:00.000Z"),
            project("busy", createdAt: "2026-01-01T00:00:00.000Z"),
            project("fresh", createdAt: "2026-03-01T00:00:00.000Z"),
        ]
        let threads = [
            thread("busy", "2026-02-01T00:00:00.000Z"),
            thread("busy", "2026-04-01T00:00:00.000Z"),
            thread("quiet", "2026-01-02T00:00:00.000Z"),
        ]
        #expect(Project.byActivity(projects, threads: threads).map(\.id) == ["busy", "fresh", "quiet"])
    }
}

struct ProjectGroupingTests {
    private func on(_ id: String, _ environmentId: String, _ repository: String? = nil) -> Project {
        project(id, environmentId: environmentId, repository: repository)
    }

    private func ids(_ groups: [[Project]]) -> [[String]] { groups.map { $0.map(\.id) } }

    @Test func `puts one repository on two servers in one group, where the first of them was`() {
        let groups = Project.groupedByRepository([
            on("web-a", "a", "acme/web"), on("api", "a", "acme/api"), on("web-b", "b", "acme/web"),
        ])
        #expect(ids(groups) == [["web-a", "web-b"], ["api"]])
    }

    @Test func `keeps two clones on one server apart`() {
        let groups = Project.groupedByRepository([on("one", "a", "acme/web"), on("two", "a", "acme/web")])
        #expect(ids(groups) == [["one"], ["two"]])
    }

    @Test func `does not group projects without a repository`() {
        #expect(ids(Project.groupedByRepository([on("x", "a"), on("y", "b")])) == [["x"], ["y"]])
    }
}

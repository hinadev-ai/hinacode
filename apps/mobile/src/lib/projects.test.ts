import type { Project, Thread } from "@shared/domain.ts"
import { describe, expect, it } from "vitest"
import { baseName, defaultCloneFolder, groupByRepository, projectsByActivity } from "./projects"

const project = (id: string, rootPath: string, createdAt: string) => ({ id, rootPath, createdAt }) as unknown as Project
const thread = (projectId: string, updatedAt: string) => ({ projectId, updatedAt }) as unknown as Thread

describe("baseName", () => {
  it("names the last folder", () => {
    expect(baseName("/Users/me/code/app")).toBe("app")
    expect(baseName("~/code/app")).toBe("app")
  })

  it("ignores trailing slashes and spaces", () => {
    expect(baseName("~/code/app/")).toBe("app")
    expect(baseName(" /srv/app// ")).toBe("app")
  })

  it("keeps a bare home folder", () => {
    expect(baseName("~")).toBe("~")
    expect(baseName("")).toBe("")
  })
})

describe("defaultCloneFolder", () => {
  it("puts the clone next to the newest project", () => {
    const projects = [
      project("old", "/Users/me/work/old", "2026-01-01T00:00:00.000Z"),
      project("new", "/Users/me/code/new/", "2026-02-01T00:00:00.000Z"),
    ]
    expect(defaultCloneFolder(projects, "repo")).toBe("/Users/me/code/repo")
  })

  it("keeps a ~ parent", () => {
    expect(defaultCloneFolder([project("a", "~/src/a", "2026-01-01T00:00:00.000Z")], "repo")).toBe("~/src/repo")
  })

  it("falls back to ~/code without projects", () => {
    expect(defaultCloneFolder([], "repo")).toBe("~/code/repo")
  })
})

describe("projectsByActivity", () => {
  it("orders by the newest thread, else when the project was added", () => {
    const projects = [
      project("quiet", "/a", "2026-01-01T00:00:00.000Z"),
      project("busy", "/b", "2026-01-01T00:00:00.000Z"),
      project("fresh", "/c", "2026-03-01T00:00:00.000Z"),
    ]
    const threads = [
      thread("busy", "2026-02-01T00:00:00.000Z"),
      thread("busy", "2026-04-01T00:00:00.000Z"),
      thread("quiet", "2026-01-02T00:00:00.000Z"),
    ]
    expect(projectsByActivity(projects, threads).map((each) => each.id)).toEqual(["busy", "fresh", "quiet"])
  })
})

describe("groupByRepository", () => {
  const on = (id: string, environmentId: string, repository?: string) =>
    ({ id, environmentId, ...(repository && { repository }) }) as unknown as Project
  const ids = (groups: readonly (readonly Project[])[]) => groups.map((group) => group.map((member) => member.id))

  it("puts one repository on two servers in one group, where the first of them was", () => {
    const groups = groupByRepository([on("web-a", "a", "acme/web"), on("api", "a", "acme/api"), on("web-b", "b", "acme/web")])
    expect(ids(groups)).toEqual([["web-a", "web-b"], ["api"]])
  })

  it("keeps two clones on one server apart", () => {
    expect(ids(groupByRepository([on("one", "a", "acme/web"), on("two", "a", "acme/web")]))).toEqual([["one"], ["two"]])
  })

  it("does not group projects without a repository", () => {
    expect(ids(groupByRepository([on("x", "a"), on("y", "b")]))).toEqual([["x"], ["y"]])
  })
})

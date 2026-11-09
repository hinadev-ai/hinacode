import type { Project, Thread } from "@shared/domain.ts"
import { describe, expect, it } from "vitest"
import { baseName, defaultCloneFolder, projectsByActivity } from "./projects"

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

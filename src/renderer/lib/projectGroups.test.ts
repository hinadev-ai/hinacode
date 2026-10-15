import { describe, expect, test } from "@effect/vitest"
import type { Project } from "../../shared/domain.ts"
import { groupProjects } from "./projectGroups.ts"

const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id,
  name: id,
  rootPath: `/code/${id}`,
  setupScript: null,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
  ...extra,
})

const keysAndIds = (projects: ReadonlyArray<Project>) =>
  groupProjects(projects).map((group) => [group.key, group.projects.map((member) => member.id)])

describe("groupProjects", () => {
  test("the same repository on This Mac and a cloud is one group, This Mac first", () => {
    const projects = [
      project("mac-web", { repository: "acme/web" }),
      project("mac-docs", { repository: "acme/docs" }),
      project("cloud-web", { repository: "acme/web", environmentId: "home" }),
    ]
    expect(keysAndIds(projects)).toStrictEqual([
      ["acme/web", ["mac-web", "cloud-web"]],
      ["acme/docs", ["mac-docs"]],
    ])
  })

  test("a group holds one project per machine, so two clones on one machine stay apart", () => {
    const projects = [
      project("web", { repository: "acme/web" }),
      project("web-copy", { repository: "acme/web" }),
      project("cloud-web", { repository: "acme/web", environmentId: "home" }),
      project("other-cloud-web", { repository: "acme/web", environmentId: "office" }),
    ]
    expect(keysAndIds(projects)).toStrictEqual([
      ["acme/web", ["web", "cloud-web", "other-cloud-web"]],
      ["web-copy", ["web-copy"]],
    ])
  })

  test("projects without a repository never group, even with the same name", () => {
    const projects = [project("a", { name: "app" }), project("b", { name: "app", environmentId: "home" })]
    expect(keysAndIds(projects)).toStrictEqual([
      ["a", ["a"]],
      ["b", ["b"]],
    ])
  })

  test("a cloud-only repository is a group of its own", () => {
    expect(keysAndIds([project("ml", { repository: "acme/ml", environmentId: "home" })])).toStrictEqual([
      ["acme/ml", ["ml"]],
    ])
  })
})

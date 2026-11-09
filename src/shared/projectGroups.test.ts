import { describe, expect, test } from "@effect/vitest"
import type { Project } from "./domain.ts"
import {
  filterPickedProjects,
  groupProjects,
  isGroupPicked,
  pickProjectGroup,
  type ProjectGroup,
} from "./projectGroups.ts"

const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id,
  name: id,
  rootPath: `/code/${id}`,
  setupScript: null,
  linearReview: false,
  kind: "folder",
  actions: [],
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
  ...extra,
})

const keysAndIds = (projects: ReadonlyArray<Project>) =>
  groupProjects(projects).map((group) => [group.key, group.projects.map((member) => member.id)])

describe("groupProjects", () => {
  test("the same repository on this machine and a cloud is one group, this machine first", () => {
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

  test("every machine's chats project is one group", () => {
    const projects = [
      project("chats", { kind: "chats" }),
      project("cloud-chats", { kind: "chats", environmentId: "home" }),
    ]
    expect(keysAndIds(projects)).toStrictEqual([["chats", ["chats", "cloud-chats"]]])
  })
})

const ids = (list: ReadonlyArray<Project>) => list.map((member) => member.id)

describe("filterPickedProjects", () => {
  const projects = [project("web"), project("api"), project("docs")]

  test("keeps the picked projects", () => {
    expect(ids(filterPickedProjects(projects, ["api", "docs"]))).toStrictEqual(["api", "docs"])
  })

  test("keeps every project when none of the picked ones is reachable", () => {
    expect(ids(filterPickedProjects(projects, []))).toStrictEqual(["web", "api", "docs"])
    expect(ids(filterPickedProjects(projects, ["gone"]))).toStrictEqual(["web", "api", "docs"])
  })
})

describe("pickProjectGroup", () => {
  const web: ProjectGroup = {
    key: "acme/web",
    projects: [project("mac-web"), project("cloud-web", { environmentId: "home" })],
  }

  test("picks every member of the group and drops them together", () => {
    const picked = pickProjectGroup(["api"], web, true)
    expect(picked).toStrictEqual(["api", "mac-web", "cloud-web"])
    expect(isGroupPicked(web, picked)).toBe(true)
    expect(pickProjectGroup(picked, web, false)).toStrictEqual(["api"])
  })

  test("a group is picked only when all its members are", () => {
    expect(isGroupPicked(web, ["mac-web"])).toBe(false)
  })
})

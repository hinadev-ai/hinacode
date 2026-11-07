import { describe, expect, test } from "@effect/vitest"
import type { Project } from "../../shared/domain.ts"
import { allEnvironments } from "../../shared/environmentFilter.ts"
import type { Cloud } from "./environments.ts"
import { filterSidebarProjects, hiddenEnvironmentIds, sidebarEnvironments } from "./sidebarFilter.ts"

const project = (id: string, environmentId?: string): Project => ({
  id,
  name: id,
  rootPath: `/code/${id}`,
  setupScript: null,
  linearReview: false,
  kind: "folder",
  actions: [],
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
  ...(environmentId === undefined ? {} : { environmentId }),
})

const cloud = (id: string, status: Cloud["status"]) =>
  ({ id, name: id, host: "10.0.0.2", port: 48081, status, lastSeenAt: null }) as Cloud

const projects = [project("mac-web"), project("gpu-web", "gpu"), project("work-api", "work")]
const environments = sidebarEnvironments(projects, [cloud("gpu", "connected"), cloud("work", "offline")])
const ids = (list: ReadonlyArray<Project>) => list.map((member) => member.id)

describe("sidebarEnvironments", () => {
  test("lists this machine only when a project lives on it", () => {
    expect(environments.map(({ id, offline }) => [id, offline])).toStrictEqual([
      [null, false],
      ["gpu", false],
      ["work", true],
    ])
    expect(sidebarEnvironments([project("gpu-web", "gpu")], []).map(({ id }) => id)).toStrictEqual([])
  })
})

describe("filterSidebarProjects", () => {
  test("lists every project with no filter", () => {
    expect(ids(filterSidebarProjects(projects, hiddenEnvironmentIds(environments, allEnvironments), []))).toStrictEqual(
      ["mac-web", "gpu-web", "work-api"],
    )
  })

  test("keeps the projects of the picked environments, then the picked projects among them", () => {
    const hidden = hiddenEnvironmentIds(environments, { environmentIds: [null, "gpu"], hideOffline: false })
    expect(ids(filterSidebarProjects(projects, hidden, []))).toStrictEqual(["mac-web", "gpu-web"])
    expect(ids(filterSidebarProjects(projects, hidden, ["gpu-web"]))).toStrictEqual(["gpu-web"])
  })

  test("falls back to every shown project when the picked project is on a hidden environment", () => {
    const hidden = hiddenEnvironmentIds(environments, { environmentIds: [], hideOffline: true })
    expect(ids(filterSidebarProjects(projects, hidden, ["work-api"]))).toStrictEqual(["mac-web", "gpu-web"])
  })

  test("keeps a project whose environment the sidebar does not know", () => {
    const hidden = hiddenEnvironmentIds(environments, { environmentIds: ["gpu"], hideOffline: false })
    expect(ids(filterSidebarProjects([...projects, project("old", "removed")], hidden, []))).toStrictEqual([
      "gpu-web",
      "old",
    ])
  })
})

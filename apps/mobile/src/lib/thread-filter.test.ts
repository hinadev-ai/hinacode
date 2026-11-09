import type { Project, Thread, ThreadSearchHit } from "@shared/domain.ts"
import { allEnvironments } from "@shared/environmentFilter.ts"
import { describe, expect, it } from "vitest"
import { hitsWithinFilter, pickedGroups, projectChoices, shownServers, withinFilter } from "./thread-filter"

const project = (id: string, environmentId?: string, repository?: string) =>
  ({ id, name: id, environmentId, repository, kind: "folder" }) as unknown as Project
const thread = (id: string, projectId: string) => ({ id, projectId }) as unknown as Thread
const hit = (messageId: string, projectId: string) => ({ messageId, projectId }) as unknown as ThreadSearchHit
const ids = (list: readonly { readonly id: string }[]) => list.map((entry) => entry.id)

const studio = { id: "studio", status: "connected" } as const
const cloud = { id: "cloud", status: "offline" } as const
const everything = { servers: null, projectIds: [] }

describe("shownServers", () => {
  it("shows everything with one server, whatever was picked before", () => {
    expect(shownServers({ environmentIds: ["cloud"], hideOffline: true }, [{ ...studio, status: "offline" }])).toBe(
      null,
    )
  })

  it("shows everything until a server is picked", () => {
    expect(shownServers(allEnvironments, [studio, cloud])).toBe(null)
  })

  it("shows the picked servers", () => {
    expect(shownServers({ environmentIds: ["cloud"], hideOffline: false }, [studio, cloud])).toEqual(new Set(["cloud"]))
  })

  it("hides an offline server but not one still connecting", () => {
    const filter = { environmentIds: [], hideOffline: true }
    expect(shownServers(filter, [studio, cloud])).toEqual(new Set(["studio"]))
    expect(shownServers(filter, [studio, { ...cloud, status: "connecting" }])).toBe(null)
  })
})

describe("withinFilter", () => {
  const projects = [project("app", "studio"), project("api", "cloud"), project("docs", "cloud"), project("unstamped")]
  const threads = [thread("t1", "app"), thread("t2", "api"), thread("t3", "docs"), thread("t4", "unstamped")]

  it("keeps everything when nothing narrows it", () => {
    expect(withinFilter(everything, projects, threads)).toEqual({ projects, threads })
  })

  it("keeps the projects on shown servers and their threads", () => {
    expect(withinFilter({ servers: new Set(["cloud"]), projectIds: [] }, projects, threads)).toEqual({
      projects: [projects[1], projects[2]],
      threads: [threads[1], threads[2]],
    })
  })

  it("narrows to the picked projects", () => {
    const listed = withinFilter({ servers: null, projectIds: ["app", "docs"] }, projects, threads)
    expect(ids(listed.projects)).toEqual(["app", "docs"])
    expect(ids(listed.threads)).toEqual(["t1", "t3"])
  })

  it("applies the server filter before the project filter", () => {
    const listed = withinFilter({ servers: new Set(["cloud"]), projectIds: ["app", "docs"] }, projects, threads)
    expect(ids(listed.projects)).toEqual(["docs"])
  })

  it("shows every project on the shown servers when the picked ones are all hidden", () => {
    const listed = withinFilter({ servers: new Set(["cloud"]), projectIds: ["app"] }, projects, threads)
    expect(ids(listed.projects)).toEqual(["api", "docs"])
    expect(ids(listed.threads)).toEqual(["t2", "t3"])
  })
})

describe("hitsWithinFilter", () => {
  const projects = [project("app", "studio"), project("api", "cloud")]
  const hits = [hit("m1", "app"), hit("m2", "api"), hit("m3", "gone")]

  it("keeps every hit when nothing narrows it", () => {
    expect(hitsWithinFilter(everything, projects, hits)).toEqual(hits)
  })

  it("keeps the hits in projects on shown servers", () => {
    expect(hitsWithinFilter({ servers: new Set(["studio"]), projectIds: [] }, projects, hits)).toEqual([hits[0]])
  })

  it("keeps the hits in picked projects", () => {
    expect(hitsWithinFilter({ servers: null, projectIds: ["api"] }, projects, hits)).toEqual([hits[1]])
  })
})

describe("project choices", () => {
  const projects = [
    project("studio-web", "studio", "acme/web"),
    project("cloud-web", "cloud", "acme/web"),
    project("cloud-ml", "cloud", "acme/ml"),
    project("studio-docs", "studio"),
  ]
  const keys = (groups: readonly { readonly key: string }[]) => groups.map((group) => group.key)

  it("offers one choice per repository across servers", () => {
    expect(projectChoices(null, projects).map((group) => ids(group.projects))).toEqual([
      ["studio-web", "cloud-web"],
      ["cloud-ml"],
      ["studio-docs"],
    ])
  })

  it("offers only the groups with a project on a shown server", () => {
    expect(keys(projectChoices(new Set(["studio"]), projects))).toEqual(["acme/web", "studio-docs"])
  })

  it("picking a group lists its projects on every shown server", () => {
    const filter = { servers: null, projectIds: ["studio-web", "cloud-web"] }
    expect(keys(pickedGroups(filter, projects))).toEqual(["acme/web"])
    expect(ids(withinFilter(filter, projects, []).projects)).toEqual(["studio-web", "cloud-web"])
  })

  it("counts no group as picked when its picked projects are all hidden", () => {
    expect(pickedGroups({ servers: new Set(["studio"]), projectIds: ["cloud-ml"] }, projects)).toEqual([])
  })
})

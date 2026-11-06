import type { Project, Thread, ThreadSearchHit } from "@shared/domain.ts"
import { allEnvironments } from "@shared/environmentFilter.ts"
import { describe, expect, it } from "vitest"
import { hitsWithinServers, shownServers, withinServers } from "./server-filter"

const project = (id: string, environmentId?: string) => ({ id, environmentId }) as unknown as Project
const thread = (id: string, projectId: string) => ({ id, projectId }) as unknown as Thread
const hit = (messageId: string, projectId: string) => ({ messageId, projectId }) as unknown as ThreadSearchHit

const studio = { id: "studio", status: "connected" } as const
const cloud = { id: "cloud", status: "offline" } as const

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

describe("withinServers", () => {
  const projects = [project("app", "studio"), project("api", "cloud"), project("unstamped")]
  const threads = [thread("t1", "app"), thread("t2", "api"), thread("t3", "unstamped")]

  it("keeps everything when every server is shown", () => {
    expect(withinServers(null, projects, threads)).toEqual({ projects, threads })
  })

  it("keeps the projects on shown servers and their threads", () => {
    expect(withinServers(new Set(["cloud"]), projects, threads)).toEqual({
      projects: [projects[1]],
      threads: [threads[1]],
    })
  })
})

describe("hitsWithinServers", () => {
  const projects = [project("app", "studio"), project("api", "cloud")]
  const hits = [hit("m1", "app"), hit("m2", "api"), hit("m3", "gone")]

  it("keeps every hit when every server is shown", () => {
    expect(hitsWithinServers(null, projects, hits)).toEqual(hits)
  })

  it("keeps the hits in projects on shown servers", () => {
    expect(hitsWithinServers(new Set(["studio"]), projects, hits)).toEqual([hits[0]])
  })
})

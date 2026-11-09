import { describe, expect, it } from "vitest"
import {
  allEnvironments,
  type EnvironmentFilter,
  parseEnvironmentFilter,
  pickEnvironment,
  shownEnvironmentIds,
} from "./environmentFilter.ts"

const environments = [
  { id: null, offline: false },
  { id: "gpu-box", offline: false },
  { id: "work-mac", offline: true },
]

const shown = (filter: EnvironmentFilter) => [...shownEnvironmentIds(filter, environments)]

describe("shownEnvironmentIds", () => {
  it("shows every environment by default", () => {
    expect(shown(allEnvironments)).toStrictEqual([null, "gpu-box", "work-mac"])
  })

  it("shows only the picked environments", () => {
    expect(shown({ environmentIds: [null, "work-mac"], hideOffline: false })).toStrictEqual([null, "work-mac"])
  })

  it("shows every environment once the picked ones are gone", () => {
    expect(shown({ environmentIds: ["removed"], hideOffline: false })).toStrictEqual([null, "gpu-box", "work-mac"])
  })

  it("ignores the filter with one environment, which has no filter to turn off", () => {
    const offline = [{ id: "work-mac", offline: true }]
    expect([...shownEnvironmentIds({ environmentIds: [], hideOffline: true }, offline)]).toStrictEqual(["work-mac"])
  })

  it("hides offline environments, even a picked one", () => {
    expect(shown({ environmentIds: [], hideOffline: true })).toStrictEqual([null, "gpu-box"])
    expect(shown({ environmentIds: ["work-mac"], hideOffline: true })).toStrictEqual([])
  })
})

describe("pickEnvironment", () => {
  it("adds and removes one environment", () => {
    const picked = pickEnvironment(allEnvironments, "gpu-box", true)
    expect(picked.environmentIds).toStrictEqual(["gpu-box"])
    expect(pickEnvironment(picked, "gpu-box", false)).toStrictEqual(allEnvironments)
  })
})

describe("parseEnvironmentFilter", () => {
  it("reads what was stored, this machine included", () => {
    const filter = { environmentIds: [null, "gpu-box"], hideOffline: true }
    expect(parseEnvironmentFilter(JSON.stringify(filter))).toStrictEqual(filter)
  })

  it("falls back to every environment on missing or broken data", () => {
    expect(parseEnvironmentFilter(null)).toStrictEqual(allEnvironments)
    expect(parseEnvironmentFilter("{")).toStrictEqual(allEnvironments)
    expect(parseEnvironmentFilter('{"environmentIds":[1]}')).toStrictEqual(allEnvironments)
  })
})

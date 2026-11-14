import { describe, expect, test } from "vitest"
import { type DeviceCheck, platformReady } from "./device.ts"

const ready = (requirement: DeviceCheck["requirement"], needed: DeviceCheck["needed"]): DeviceCheck => ({
  requirement,
  needed,
  fix: "install",
  state: "ready",
})

describe("platformReady", () => {
  test("a platform is ready once every check it needs is ready, whatever the recommended rows say", () => {
    const checks: ReadonlyArray<DeviceCheck> = [
      ready("xcode", "ios"),
      ready("iosRuntime", "ios"),
      { ...ready("simslim", "recommended"), state: "missing" },
    ]
    expect(platformReady(checks, "ios")).toBe(true)
  })

  test("one missing or unsupported required row keeps its platform off, and leaves the other alone", () => {
    const checks: ReadonlyArray<DeviceCheck> = [
      { ...ready("xcode", "ios"), state: "unsupported" },
      ready("androidSdk", "android"),
      ready("androidImage", "android"),
      ready("avd", "android"),
    ]
    expect(platformReady(checks, "ios")).toBe(false)
    expect(platformReady(checks, "android")).toBe(true)
    expect(platformReady([...checks, { ...ready("avd", "android"), state: "missing" }], "android")).toBe(false)
  })

  test("a machine that reports no checks for a platform cannot run it", () => {
    expect(platformReady([], "android")).toBe(false)
  })
})

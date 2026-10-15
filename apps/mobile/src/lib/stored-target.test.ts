import { describe, expect, it } from "vitest"
import { parseStoredTarget } from "./stored-target"

describe("parseStoredTarget", () => {
  it("reads a pairing with every address in order", () => {
    const target = { hosts: ["100.64.0.2", "192.168.1.5"], port: 47821, token: "abc" }
    expect(parseStoredTarget(JSON.stringify(target))).toEqual(target)
  })

  it("reads a single-host pairing saved by an older app", () => {
    expect(parseStoredTarget(JSON.stringify({ host: "192.168.1.5", port: 47821, token: "abc" }))).toEqual({
      hosts: ["192.168.1.5"],
      port: 47821,
      token: "abc",
    })
  })

  it.each([null, "not json", JSON.stringify({ hosts: [], port: 47821, token: "abc" })])("drops %s", (raw) => {
    expect(parseStoredTarget(raw)).toBeNull()
  })
})

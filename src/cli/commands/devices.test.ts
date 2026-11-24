import { describe, expect, test } from "@effect/vitest"
import { Result } from "effect"
import type { RemoteDevice } from "../../shared/domain.ts"
import { resolveDevice } from "./devices.ts"

const device = (key: string, name: string): RemoteDevice => ({
  key,
  name,
  createdAt: 0,
  lastSeenAt: null,
  connected: false,
})

const devices = [
  device("Ab3dEfGh-phone-key", "iPhone"),
  device("Ab3dXyZw-tablet-key", "iPad"),
  device("Zz9_laptop-key", "Ab3d"),
]

describe("resolveDevice", () => {
  test("finds a device by its name in any case, before a key that starts with the same text", () => {
    expect(resolveDevice("iphone", devices)).toStrictEqual(Result.succeed(devices[0]))
    expect(resolveDevice("Ab3d", devices)).toStrictEqual(Result.succeed(devices[2]))
  })

  test("finds a device by the start of its key, which is case sensitive", () => {
    expect(resolveDevice("Ab3dX", devices)).toStrictEqual(Result.succeed(devices[1]))
    expect(Result.isFailure(resolveDevice("ab3dx", devices))).toBe(true)
  })

  test("refuses a key prefix shorter than four characters and one that matches two devices", () => {
    expect(Result.isFailure(resolveDevice("Zz9", devices))).toBe(true)
    const ambiguous = resolveDevice("Ab3", [devices[0]!, devices[1]!])
    expect(Result.isFailure(ambiguous)).toBe(true)
    const twoKeys = resolveDevice("Ab3dE", [...devices, device("Ab3dEfZz-other", "Pixel")])
    expect(Result.isFailure(twoKeys) && twoKeys.failure.message).toMatch(/matches more than one device/)
  })
})

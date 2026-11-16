import { expect, test } from "vitest"
import { iosVersionOf } from "./iosParsers.ts"

test("reads the iOS version from a simulator runtime id", () => {
  expect(iosVersionOf("com.apple.CoreSimulator.SimRuntime.iOS-27-2")).toBe("27.2")
})

test("reads the iOS version from a runtime made for one device, such as the iPhone Duo's", () => {
  expect(iosVersionOf("com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4")).toBe("27.2")
})

test("skips runtimes for other platforms", () => {
  expect(iosVersionOf("com.apple.CoreSimulator.SimRuntime.tvOS-27-2")).toBeNull()
  expect(iosVersionOf("com.apple.CoreSimulator.SimRuntime.watchOS-13-2")).toBeNull()
  expect(iosVersionOf("com.apple.CoreSimulator.SimRuntime.xrOS-27-2")).toBeNull()
})

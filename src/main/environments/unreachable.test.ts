import { describe, expect, test } from "vitest"
import { unreachableMessage } from "./unreachable.ts"

const cloud = { host: "100.64.0.2", port: 47821 }

describe("unreachableMessage", () => {
  test("says nothing is listening when the port refuses", () => {
    expect(unreachableMessage(cloud, "ECONNREFUSED", "connect ECONNREFUSED 100.64.0.2:47821")).toBe(
      "Nothing is listening on 100.64.0.2:47821. Check that hinacode serve is running there and uses port 47821.",
    )
  })

  test.each(["ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"])("asks to check the network for %s", (code) => {
    expect(unreachableMessage(cloud, code, "")).toBe(
      "100.64.0.2 did not answer. Check that this computer is on the same network or tailnet as it.",
    )
  })

  test.each(["ENOTFOUND", "EAI_AGAIN"])("suggests another address for %s", (code) => {
    expect(unreachableMessage({ host: "mac.local", port: 47821 }, code, "")).toBe(
      "Could not find mac.local. Use its Tailscale or LAN address instead.",
    )
  })

  test("keeps the reason for anything else", () => {
    expect(unreachableMessage(cloud, undefined, "Unexpected server response: 404")).toBe(
      "Could not reach 100.64.0.2:47821: Unexpected server response: 404",
    )
  })
})

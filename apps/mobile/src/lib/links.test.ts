import { describe, expect, it } from "vitest"
import { connectLink, threadLink } from "@shared/links.ts"
import { pairingUrl, parsePairingUrl } from "@shared/remote.ts"
import { routeForLink } from "./links"

const target = { hosts: ["192.168.1.5"], port: 47821, token: "t/k+n", relay: null } as const
const pairingOf = (href: string) => parsePairingUrl(new URL(href, "hinacode://app").searchParams.get("pairing") ?? "")

describe("routeForLink", () => {
  it("opens the first pairing form filled in while nothing is paired", () => {
    const href = routeForLink(connectLink(target), { paired: false, environmentIds: [] })
    expect(href).toBe(`/connect?pairing=${encodeURIComponent(pairingUrl(target))}`)
    expect(pairingOf(href)).toEqual(target)
  })

  it("opens the add-machine form filled in on a paired phone", () => {
    const href = routeForLink(connectLink(target), { paired: true, environmentIds: ["env-a"] })
    expect(href).toBe(`/server/new?pairing=${encodeURIComponent(pairingUrl(target))}`)
    expect(pairingOf(href)).toEqual(target)
  })

  it("reads the older hinacode:// pairing URLs", () => {
    expect(routeForLink(pairingUrl(target), { paired: false, environmentIds: [] })).toBe(
      `/connect?pairing=${encodeURIComponent(pairingUrl(target))}`,
    )
  })

  it("opens a thread on a machine this phone paired with", () => {
    expect(routeForLink(threadLink("env-a", "thread 1"), { paired: true, environmentIds: [null, "env-a"] })).toBe(
      `/thread/${encodeURIComponent("thread 1")}`,
    )
  })

  it("opens the thread list for a machine this phone never paired with", () => {
    expect(routeForLink(threadLink("env-z", "thread-1"), { paired: true, environmentIds: ["env-a"] })).toBe("/")
  })

  it("opens the thread list for a link it does not understand", () => {
    expect(routeForLink("https://relay.hinacode.app/elsewhere", { paired: true, environmentIds: ["env-a"] })).toBe("/")
  })
})

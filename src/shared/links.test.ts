import { describe, expect, it } from "vitest"
import { connectLink, LINK_ORIGIN, parseAppLink, threadLink } from "./links.ts"
import { pairingUrl, parsePairingUrl } from "./remote.ts"

const target = {
  hosts: ["100.64.0.2", "fd7a:115c::2"],
  port: 47821,
  token: "t/k+n",
  relay: "hinacode-1a2b3c4d.example.com",
} as const

describe("connect links", () => {
  it("round-trips a pairing with every host in order", () => {
    const link = connectLink(target)
    expect(link).toBe(
      `${LINK_ORIGIN}/connect#relay=hinacode-1a2b3c4d.example.com&host=100.64.0.2&host=fd7a%3A115c%3A%3A2&port=47821&token=t%2Fk%2Bn`,
    )
    expect(parseAppLink(link)).toEqual({ type: "connect", target })
  })

  it("keeps the token in the fragment, which never reaches a server", () => {
    const url = new URL(connectLink(target))
    expect(url.search).toBe("")
    expect(url.pathname).toBe("/connect")
    expect(url.hash).toContain("token=")
  })

  it("reads the older hinacode:// pairing URLs", () => {
    expect(parseAppLink(pairingUrl(target))).toEqual({ type: "connect", target })
  })

  it("is a pairing URL wherever one can be pasted", () => {
    expect(parsePairingUrl(connectLink(target))).toEqual(target)
    expect(parsePairingUrl(`scan this:\n  ${connectLink(target)}\n`)).toEqual(target)
  })
})

describe("thread links", () => {
  it("round-trips the environment and the thread", () => {
    const link = threadLink("env-a", "thread-1")
    expect(link).toBe(`${LINK_ORIGIN}/t/env-a/thread-1`)
    expect(parseAppLink(link)).toEqual({ type: "thread", environmentId: "env-a", threadId: "thread-1" })
  })

  it("round-trips ids with slashes, spaces and percent signs", () => {
    const link = threadLink("env/a b", "thread 1/2%")
    expect(new URL(link).pathname.split("/")).toHaveLength(4)
    expect(parseAppLink(link)).toEqual({ type: "thread", environmentId: "env/a b", threadId: "thread 1/2%" })
  })
})

describe("parseAppLink", () => {
  it.each([
    ["an empty string", ""],
    ["text that is not a URL", "open the thread"],
    ["another origin", "https://example.com/t/env-a/thread-1"],
    ["plain http", "http://relay.hinacode.app/t/env-a/thread-1"],
    ["another port", "https://relay.hinacode.app:8443/t/env-a/thread-1"],
    ["a thread link without the thread", "https://relay.hinacode.app/t/env-a"],
    ["a thread link with an empty id", "https://relay.hinacode.app/t/env-a/"],
    ["a thread link with an extra segment", "https://relay.hinacode.app/t/env-a/thread-1/file"],
    ["a thread link with a broken escape", "https://relay.hinacode.app/t/env-a/%E0%A4%A"],
    ["the relay's root", "https://relay.hinacode.app/"],
    ["a connect link with its params in the query", "https://relay.hinacode.app/connect?host=a&port=1&token=t"],
    ["a connect link without a token", "https://relay.hinacode.app/connect#host=a&port=1"],
    ["a connect link on another origin", "https://example.com/connect#host=a&port=1&token=t"],
    ["the app's root", "hinacode:///"],
    ["an Expo dev client URL", "exp+hinacode://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081"],
  ])("refuses %s", (_, text) => {
    expect(parseAppLink(text)).toBeNull()
  })
})

import { describe, expect, test } from "vitest"
import { type Approver, waitingPage } from "./approvalPage.ts"

const SIGNED_OUT: Approver = { signedIn: false, signInPath: "/oauth/sign-in?request=r" }

const tileOf = (appName: string, redirectHost: string) =>
  waitingPage({ appName, redirectHost, approver: SIGNED_OUT }).html.match(/<span class="tile ([^"]+)"/)?.[1]

describe("waiting page", () => {
  test("shows the mark of a known app, found by its name or its callback host", () => {
    expect(tileOf("Grok Bot", "grok.example")).toBe("glyph grok")
    expect(tileOf("Connector", "x.ai")).toBe("glyph grok")
    expect(tileOf("Claude Code", "localhost:4567")).toBe("glyph claude")
    expect(tileOf("MCP client", "chatgpt.com")).toBe("glyph chatgpt")
    expect(tileOf("hermes-agent", "127.0.0.1:9000")).toBe("hermes")
  })

  test("falls back to the first letter of any other app", () => {
    const html = waitingPage({ appName: "  ōtter <i>", redirectHost: "otter.example", approver: SIGNED_OUT }).html
    expect(html).toContain('<span class="tile letter" aria-hidden="true">ō</span>')
    expect(html).toContain("ōtter &#60;i&#62; wants to connect to HinaCode")
  })
})

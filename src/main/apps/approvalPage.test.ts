import { describe, expect, test } from "vitest"
import { type Approver, waitingPage } from "./approvalPage.ts"

const SIGNED_OUT: Approver = { signedIn: false, signInPath: "/oauth/sign-in?request=r" }

const tileOf = (appName: string, redirectHost: string) =>
  waitingPage({ appName, redirectHost, approver: SIGNED_OUT }).html.match(/<span class="tile ([^"]+)"/)?.[1]

describe("waiting page", () => {
  test("shows the mark of a known app, by its own domain or, on loopback, by its name", () => {
    expect(tileOf("Grok Bot", "grok.com")).toBe("glyph grok")
    expect(tileOf("Connector", "x.ai")).toBe("glyph grok")
    expect(tileOf("Connector", "connectors.claude.ai")).toBe("glyph claude")
    expect(tileOf("Claude Code", "localhost:4567")).toBe("glyph claude")
    expect(tileOf("MCP client", "chatgpt.com")).toBe("glyph chatgpt")
    expect(tileOf("hermes-agent", "127.0.0.1:9000")).toBe("hermes")
  })

  test("does not lend a brand's mark to an app that only borrows its name", () => {
    expect(tileOf("Claude", "claude.evil.example")).toBe("letter")
    expect(tileOf("Claude", "evil.example")).toBe("letter")
    expect(tileOf("Connector", "evilclaude.ai")).toBe("letter")
    expect(tileOf("Grok Bot", "grok.com.evil.example:8443")).toBe("letter")
  })

  test("falls back to the first letter of any other app", () => {
    const html = waitingPage({ appName: "  ōtter <i>", redirectHost: "otter.example", approver: SIGNED_OUT }).html
    expect(html).toContain('<span class="tile letter" aria-hidden="true">ō</span>')
    expect(html).toContain("ōtter &#60;i&#62; wants to connect to HinaCode")
  })
})

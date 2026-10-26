import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { BrowserCommand, BrowserFrame, BrowserUrl } from "./browser.ts"
import { desktopOnlyMethods, RpcMethods } from "./contract.ts"
import { routes } from "./routes.ts"

describe("remote browser boundary", () => {
  test.each(["http://localhost:5173/", "https://example.com/path", "http://[::1]:3000/"])(
    "accepts a web address %s",
    (url) => expect(Schema.decodeUnknownSync(BrowserUrl)(url)).toBe(url),
  )

  test.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hello",
    "chrome://settings",
    "localhost:5173",
  ])("refuses a non-web navigation %s", (url) => {
    expect(Schema.is(BrowserUrl)(url)).toBe(false)
    expect(Schema.is(BrowserCommand)({ kind: "navigate", url })).toBe(false)
  })

  test("refuses arbitrary protocol calls and script evaluation", () => {
    expect(Schema.is(BrowserCommand)({ kind: "Runtime.evaluate", expression: "process.exit()" })).toBe(false)
    expect(Schema.is(BrowserCommand)({ kind: "evaluate", script: "document.cookie" })).toBe(false)
  })

  test("bounds remote viewports and text input", () => {
    expect(Schema.is(BrowserCommand)({ kind: "resize", width: 0, height: 800 })).toBe(false)
    expect(Schema.is(BrowserCommand)({ kind: "resize", width: 640, height: Infinity })).toBe(false)
    expect(Schema.is(BrowserCommand)({ kind: "resize", width: 100000, height: 800 })).toBe(false)
    expect(Schema.is(BrowserCommand)({ kind: "text", text: "a".repeat(10001) })).toBe(false)
  })

  test("bounds input batches and rejects an unsafe command inside a batch", () => {
    const input = { threadId: "thread", sessionId: "session" }
    const command = RpcMethods["browser.command"].request
    expect(Schema.is(command)({ ...input, commands: [] })).toBe(false)
    expect(Schema.is(command)({ ...input, commands: Array.from({ length: 129 }, () => ({ kind: "release" })) })).toBe(
      false,
    )
    expect(
      Schema.is(command)({
        ...input,
        commands: [{ kind: "release" }, { kind: "navigate", url: "file:///etc/passwd" }],
      }),
    ).toBe(false)
  })

  test("bounds screencast frames below the transport's output limit", () => {
    expect(
      Schema.is(BrowserFrame)({ sequence: 1, width: 800, height: 600, jpeg: "a".repeat(4 * 1024 * 1024 + 1) }),
    ).toBe(false)
  })

  test("all browser calls run on the thread's host and are available to a daemon", () => {
    const methods = ["browser.open", "browser.command", "browser.frame", "browser.close"] as const
    for (const method of methods) {
      expect(routes[method]).toStrictEqual({ to: "owner", entity: "thread", key: "threadId" })
      expect(desktopOnlyMethods.has(method)).toBe(false)
      expect(Schema.is(RpcMethods[method].request)({})).toBe(false)
    }
  })
})

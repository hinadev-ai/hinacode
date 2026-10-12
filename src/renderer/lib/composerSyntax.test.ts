import { describe, expect, test } from "@effect/vitest"
import { completionAt, highlight, matchFiles } from "./composerSyntax.ts"

const known = { commands: new Set(["/kalan-mode", "$verify-kkcode"]), files: new Set(["src/main/ipc.ts"]) }

describe("highlight", () => {
  test("marks bullets, inline code and known commands, and keeps every character", () => {
    const text =
      "This is kalan\n* item\n  - nested\n1. first\n`hello` and /kalan-mode\n/usr/bin is a path\nsee @src/main/ipc.ts, not @nope or a@b.c"
    const segments = highlight(text, known)
    expect(segments.map((segment) => segment.text).join("")).toBe(text)
    expect(segments.filter((segment) => segment.kind !== "text")).toStrictEqual([
      { kind: "bullet", text: "*" },
      { kind: "bullet", text: "-" },
      { kind: "bullet", text: "1." },
      { kind: "code", text: "`hello`" },
      { kind: "command", text: "/kalan-mode" },
      { kind: "mention", text: "@src/main/ipc.ts" },
    ])
  })

  test("treats a fenced block as code, fences included, and nothing inside it as a command", () => {
    const text = "run\n```\n/kalan-mode\n```\nafter"
    expect(highlight(text, known).filter((segment) => segment.kind !== "text")).toStrictEqual([
      { kind: "code", text: "```\n/kalan-mode\n```" },
    ])
  })

  test("leaves an unclosed backtick as text", () => {
    expect(highlight("a `b", known)).toStrictEqual([{ kind: "text", text: "a `b" }])
  })
})

describe("completionAt", () => {
  test("finds the command being typed at the caret, at line start or after a space", () => {
    expect(completionAt("/kal", 4)).toStrictEqual({ trigger: "/", query: "kal", start: 0, end: 4 })
    expect(completionAt("use $ver now", 8)).toStrictEqual({ trigger: "$", query: "ver", start: 4, end: 8 })
    expect(completionAt("read @src/ma", 12)).toStrictEqual({ trigger: "@", query: "src/ma", start: 5, end: 12 })
  })

  test("covers the whole token when the caret is inside it", () => {
    expect(completionAt("x /kalan-mode y", 5)).toStrictEqual({ trigger: "/", query: "ka", start: 2, end: 13 })
  })

  test("ignores triggers inside words and after whitespace has been typed", () => {
    expect(completionAt("src/foo", 7)).toBeNull()
    expect(completionAt("a@b.c", 5)).toBeNull()
    expect(completionAt("/kalan-mode ", 12)).toBeNull()
    expect(completionAt("plain", 5)).toBeNull()
  })
})

describe("matchFiles", () => {
  const files = ["src/main/ipc.ts", "src/renderer/lib/rpc.ts", "docs/ipc-notes.md", "README.md"]

  test("ranks file names starting with the query, then names containing it, then paths containing it", () => {
    expect(matchFiles(files, "ipc")).toStrictEqual(["src/main/ipc.ts", "docs/ipc-notes.md"])
    expect(matchFiles(files, "rpc")).toStrictEqual(["src/renderer/lib/rpc.ts"])
    expect(matchFiles(files, "renderer/")).toStrictEqual(["src/renderer/lib/rpc.ts"])
  })

  test("lists the shortest paths first for an empty query", () => {
    expect(matchFiles(files, "").at(0)).toBe("README.md")
  })
})

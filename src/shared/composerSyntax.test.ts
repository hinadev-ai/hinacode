import { describe, expect, test } from "@effect/vitest"
import {
  completionAt,
  continueList,
  endsWithClosedFence,
  highlight,
  leadingSkill,
  listBackspace,
  matchFiles,
  matchPullRequests,
  matchThreads,
  segmentText,
  suggestionsFor,
} from "./composerSyntax.ts"

const known = {
  commands: new Set(["/kalan-mode", "$verify-hinacode"]),
  files: new Set(["src/main/ipc.ts"]),
  threads: new Set(["t-1"]),
}

const typeShiftEnter = (text: string, caret = text.length) => {
  const edit = continueList(text, caret, caret)
  return edit && text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
}

describe("continueList", () => {
  test("starts the next bullet, number or task with the same indent", () => {
    expect(typeShiftEnter("- first")).toBe("- first\n- ")
    expect(typeShiftEnter("  * nested")).toBe("  * nested\n  * ")
    expect(typeShiftEnter("9. ninth")).toBe("9. ninth\n10. ")
    expect(typeShiftEnter("1) one")).toBe("1) one\n2) ")
    expect(typeShiftEnter("- [x] done")).toBe("- [x] done\n- [ ] ")
  })

  test("carries the text after the caret into the new item", () => {
    const edit = continueList("- split here", 8, 8)
    expect(edit).toStrictEqual({ from: 8, to: 8, insert: "\n- ", anchor: 11 })
  })

  test("ends the list on an empty item", () => {
    expect(continueList("- a\n- ", 6, 6)).toStrictEqual({ from: 4, to: 6, insert: "", anchor: 4 })
    expect(typeShiftEnter("- a\n2. ")).toBe("- a\n")
  })

  test("leaves plain lines, the marker itself and fenced code alone", () => {
    expect(typeShiftEnter("plain")).toBeNull()
    expect(typeShiftEnter("-dash")).toBeNull()
    expect(continueList("- item", 1, 1)).toBeNull()
    expect(typeShiftEnter("```\n- in code")).toBeNull()
    expect(typeShiftEnter("```\n```\n- after code")).toBe("```\n```\n- after code\n- ")
  })
})

describe("listBackspace", () => {
  test("removes the marker when the caret sits right after it", () => {
    expect(listBackspace("  - ", 4)).toStrictEqual({ from: 2, to: 4, insert: "", anchor: 2 })
    expect(listBackspace("12. ", 4)).toStrictEqual({ from: 0, to: 4, insert: "", anchor: 0 })
    expect(listBackspace("- text", 2)).toStrictEqual({ from: 0, to: 2, insert: "", anchor: 0 })
  })

  test("leaves every other caret to the normal backspace", () => {
    expect(listBackspace("- text", 4)).toBeNull()
    expect(listBackspace("plain", 5)).toBeNull()
  })
})

describe("highlight", () => {
  test("marks bullets, inline code and known commands, and keeps every character", () => {
    const text =
      "This is kalan\n* item\n  - nested\n1. first\n`hello` and /kalan-mode\n/usr/bin is a path\nsee @src/main/ipc.ts, not @nope or a@b.c"
    const segments = highlight(text, known)
    expect(segments.map(segmentText).join("")).toBe(text)
    expect(segments.filter((segment) => segment.kind !== "text")).toStrictEqual([
      { kind: "bullet", text: "*" },
      { kind: "bullet", text: "-" },
      { kind: "bullet", text: "1." },
      { kind: "code", text: "`hello`" },
      { kind: "command", text: "/kalan-mode" },
      { kind: "mention", text: "@src/main/ipc.ts" },
    ])
  })

  test("marks bold text and a thematic break on its own line", () => {
    const text = "a **bold** b\n---\n***\n** not bold**\nx --- y"
    const segments = highlight(text, known)
    expect(segments.map(segmentText).join("")).toBe(text)
    expect(segments.filter((segment) => segment.kind !== "text")).toStrictEqual([
      { kind: "strong", text: "**bold**" },
      { kind: "rule", text: "---" },
      { kind: "rule", text: "***" },
    ])
  })

  test("keeps a fenced block whole, with its language, and nothing inside it as a command", () => {
    const text = "run\n```ts title=a.ts\nconst a = 1\n/kalan-mode\n```\nafter"
    expect(highlight(text, known)).toStrictEqual([
      { kind: "text", text: "run\n" },
      { kind: "fence", language: "ts", open: "```ts title=a.ts", lines: ["const a = 1", "/kalan-mode"], close: "```" },
      { kind: "text", text: "\nafter" },
    ])
  })

  test("keeps every character of empty and unclosed fences", () => {
    for (const text of ["```\n```", "```\n\n```", "```py", "```py\nx = 1\n"])
      expect(highlight(text, known).map(segmentText).join("")).toBe(text)
  })

  test("marks every known command, also before punctuation and Japanese text", () => {
    const text = "/kalan-mode first, then $verify-hinacode. Again /kalan-mode、and /kalan-modeで。Not /kalan-modes"
    const segments = highlight(text, known)
    expect(segments.map(segmentText).join("")).toBe(text)
    expect(
      segments.filter((segment) => segment.kind === "command").map((segment) => segmentText(segment)),
    ).toStrictEqual(["/kalan-mode", "$verify-hinacode", "/kalan-mode", "/kalan-mode"])
  })

  test("marks mentions of known threads only", () => {
    expect(
      highlight("ask @thread:t-1. and @thread:t-2", known).filter((segment) => segment.kind !== "text"),
    ).toStrictEqual([{ kind: "mention", text: "@thread:t-1" }])
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
    expect(completionAt("see #26", 7)).toStrictEqual({ trigger: "#", query: "26", start: 4, end: 7 })
  })

  test("covers the whole token when the caret is inside it", () => {
    expect(completionAt("x /kalan-mode y", 5)).toStrictEqual({ trigger: "/", query: "ka", start: 2, end: 13 })
  })

  test("ignores triggers inside words and after whitespace has been typed", () => {
    expect(completionAt("src/foo", 7)).toBeNull()
    expect(completionAt("a@b.c", 5)).toBeNull()
    expect(completionAt("/kalan-mode ", 12)).toBeNull()
    expect(completionAt("plain", 5)).toBeNull()
    expect(completionAt("a#1", 3)).toBeNull()
  })

  test("leaves a Markdown heading alone", () => {
    expect(completionAt("## Plan", 2)).toBeNull()
    expect(completionAt("# Plan", 1)).toStrictEqual({ trigger: "#", query: "", start: 0, end: 1 })
  })
})

describe("matchPullRequests", () => {
  test("matches a number prefix or a title substring", () => {
    const pullRequests = [
      { number: 261, title: "Reopen the last route" },
      { number: 26, title: "Add the ports panel" },
      { number: 12, title: "Persist ROUTE state" },
    ]
    expect(matchPullRequests(pullRequests, "26").map((pr) => pr.number)).toStrictEqual([261, 26])
    expect(matchPullRequests(pullRequests, "route").map((pr) => pr.number)).toStrictEqual([261, 12])
  })
})

const command = (trigger: "/" | "$", name: string, builtin?: true) => ({
  trigger,
  name,
  description: "",
  argumentHint: "",
  ...(builtin && { builtin }),
})

describe("leadingSkill", () => {
  const commands = [command("/", "compact", true), command("/", "kalan-mode"), command("$", "verify-hinacode")]

  test("finds the skill whose token and a space start the text", () => {
    expect(leadingSkill("/kalan-mode fix it", commands)).toStrictEqual({
      command: command("/", "kalan-mode"),
      token: "/kalan-mode ",
    })
    expect(leadingSkill("$verify-hinacode ", commands)?.token).toBe("$verify-hinacode ")
  })

  test("ignores a skill still being typed, one later in the text, and the agent's own commands", () => {
    expect(leadingSkill("/kalan-mode", commands)).toBeNull()
    expect(leadingSkill("/kalan-mode\nfix it", commands)).toBeNull()
    expect(leadingSkill("use /kalan-mode now", commands)).toBeNull()
    expect(leadingSkill("/kalan-modes ", commands)).toBeNull()
    expect(leadingSkill("/compact now", commands)).toBeNull()
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

describe("matchThreads", () => {
  const threads = [
    { id: "a", title: "Refactor login form" },
    { id: "b", title: "Login flaky test" },
    { id: "c", title: "Docs" },
  ]

  test("ranks titles starting with the query before titles containing it, ignoring case", () => {
    expect(matchThreads(threads, "login").map((thread) => thread.id)).toStrictEqual(["b", "a"])
  })

  test("keeps the given order for an empty query", () => {
    expect(matchThreads(threads, "").map((thread) => thread.id)).toStrictEqual(["a", "b", "c"])
  })
})

describe("suggestionsFor", () => {
  test("lists a command once when the agent reports it from several places", () => {
    const commands = [command("$", "animate"), command("$", "animation-vocabulary"), command("$", "animate")]
    const completion = { trigger: "$" as const, query: "anim", start: 0, end: 5 }
    expect(
      suggestionsFor(completion, commands, [], { sameMachine: [], otherMachines: [] }, []).map(
        (suggestion) => suggestion.insert,
      ),
    ).toStrictEqual(["$animate", "$animation-vocabulary"])
  })
})

describe("endsWithClosedFence", () => {
  test("is true only when the last line closes a fence", () => {
    expect(endsWithClosedFence("look\n```json\n{}\n```")).toBe(true)
    expect(endsWithClosedFence("```\na\n```\n")).toBe(false)
    expect(endsWithClosedFence("```json\n{}")).toBe(false)
    expect(endsWithClosedFence("```")).toBe(false)
    expect(endsWithClosedFence("```\na\n```\n```")).toBe(false)
  })
})

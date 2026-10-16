import { describe, expect, it } from "vitest"
import { RESET, TerminalOutput } from "./terminal-output"

describe("TerminalOutput", () => {
  it("holds a push that skips output until the missing range is attached", () => {
    const output = new TerminalOutput()
    output.attached(output.beginAttach(), { offset: 0, data: "abc" })
    expect(output.receive({ offset: 6, data: "gh" })).toBe("")
    expect(output.needsAttach).toBe(true)
    const attach = output.beginAttach()
    expect(attach.since).toBe(3)
    expect(output.attached(attach, { offset: 3, data: "defgh" })).toBe("defgh")
    expect(output.needsAttach).toBe(false)
  })

  it("detects a gap in pushes held during an attach", () => {
    const output = new TerminalOutput()
    const first = output.beginAttach()
    output.receive({ offset: 6, data: "gh" })
    expect(output.attached(first, { offset: 0, data: "abc" })).toBe(RESET + "abc")
    expect(output.needsAttach).toBe(true)
    const next = output.beginAttach()
    expect(next.since).toBe(3)
    expect(output.attached(next, { offset: 3, data: "defgh" })).toBe("defgh")
  })

  it("repaints from the scrollback on the first attach and trims pushes it already covered", () => {
    const output = new TerminalOutput()
    const attach = output.beginAttach()
    expect(attach.since).toBeNull()
    expect(output.receive({ data: "abc", offset: 0 })).toBe("")
    expect(output.receive({ data: "def", offset: 3 })).toBe("")
    expect(output.receive({ data: "ghi", offset: 6 })).toBe("")
    expect(output.attached(attach, { offset: 0, data: "abcdefg" })).toBe(`${RESET}abcdefghi`)
    expect(output.receive({ data: "j", offset: 9 })).toBe("j")
  })

  it("appends only what is new when attaching since the last shown offset", () => {
    const output = new TerminalOutput()
    output.attached(output.beginAttach(), { offset: 0, data: "hello" })
    const attach = output.beginAttach()
    expect(attach.since).toBe(5)
    expect(output.attached(attach, { offset: 2, data: "llo world" })).toBe(" world")
  })

  it("clears the screen when the desktop dropped output past the last shown offset", () => {
    const output = new TerminalOutput()
    output.attached(output.beginAttach(), { offset: 0, data: "12345" })
    const attach = output.beginAttach()
    expect(output.attached(attach, { offset: 100, data: "tail" })).toBe(`${RESET}tail`)
    expect(output.receive({ data: "tail!", offset: 100 })).toBe("!")
  })

  it("ignores an attach answer superseded by a newer attach", () => {
    const output = new TerminalOutput()
    const first = output.beginAttach()
    const second = output.beginAttach()
    expect(output.attached(first, { offset: 0, data: "old" })).toBeNull()
    expect(output.attachFailed(first)).toBeNull()
    expect(output.attached(second, { offset: 0, data: "new" })).toBe(`${RESET}new`)
  })

  it("releases held output when an attach fails", () => {
    const output = new TerminalOutput()
    const attach = output.beginAttach()
    output.receive({ data: "ab", offset: 0 })
    expect(output.attachFailed(attach)).toBe("ab")
    expect(output.receive({ data: "bc", offset: 1 })).toBe("c")
  })

  it("repaints on the next attach after output could not be shown", () => {
    const output = new TerminalOutput()
    output.attached(output.beginAttach(), { offset: 0, data: "abc" })
    output.lost()
    const attach = output.beginAttach()
    expect(attach.since).toBeNull()
    expect(output.attached(attach, { offset: 0, data: "abcdef" })).toBe(`${RESET}abcdef`)
  })

  it("writes pushes from an older desktop as they come", () => {
    const output = new TerminalOutput()
    expect(output.receive({ data: "x" })).toBe("x")
    expect(output.receive({ data: "x" })).toBe("x")
  })
})

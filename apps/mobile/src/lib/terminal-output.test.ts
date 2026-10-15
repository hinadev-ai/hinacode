import { describe, expect, it } from "vitest"
import { RESET, TerminalOutput } from "./terminal-output"

describe("TerminalOutput", () => {
  it("repaints from the scrollback on the first attach and trims pushes it already covered", () => {
    const output = new TerminalOutput()
    const attach = output.beginAttach()
    expect(attach.since).toBeNull()
    // Pushes from before and after the attach snapshot, received while it was in flight.
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

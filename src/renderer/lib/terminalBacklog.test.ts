import { describe, expect, it } from "vitest"
import { MAX_BACKLOG_CHARS, TerminalBacklog } from "./terminalBacklog.ts"

describe("terminal output before the screen initializes", () => {
  it("bounds sustained output and keeps the newest text", () => {
    const backlog = new TerminalBacklog()
    const chunkSize = MAX_BACKLOG_CHARS / 4
    for (let index = 0; index < 16; index++) backlog.append(String.fromCharCode(65 + index).repeat(chunkSize))
    const replay = backlog.drain()
    expect(replay.chunks.join("")).toBe(["M", "N", "O", "P"].map((letter) => letter.repeat(chunkSize)).join(""))
    expect(replay.truncated).toBe(true)
  })

  it("bounds a single oversized output batch", () => {
    const backlog = new TerminalBacklog()
    backlog.append("discard".repeat(MAX_BACKLOG_CHARS) + "x".repeat(MAX_BACKLOG_CHARS))
    const replay = backlog.drain()
    expect(replay.chunks.join("")).toBe("x".repeat(MAX_BACKLOG_CHARS))
    expect(replay.truncated).toBe(true)
  })

  it("drains once and resets truncation for subsequent output", () => {
    const backlog = new TerminalBacklog()
    backlog.append("x".repeat(MAX_BACKLOG_CHARS + 1))
    expect(backlog.drain().truncated).toBe(true)
    expect(backlog.drain()).toStrictEqual({ chunks: [], truncated: false })
    backlog.append("new prompt")
    expect(backlog.drain()).toStrictEqual({ chunks: ["new prompt"], truncated: false })
  })
})

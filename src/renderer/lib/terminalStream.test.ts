import { describe, expect, it } from "vitest"
import type { TerminalAttachment, TerminalSession } from "../../shared/domain.ts"
import { TerminalStream } from "./terminalStream.ts"

const session: TerminalSession = {
  id: "t1",
  threadId: "th1",
  cwd: "/repo",
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
}

/** A stream whose screen is a list of writes, and whose `terminal.attach` calls wait until the test answers them. */
const setup = () => {
  const screen: Array<string> = []
  const calls: Array<{ since: number; answer: (attachment: TerminalAttachment) => void; fail: () => void }> = []
  const stream = new TerminalStream(
    {
      write: (data) => screen.push(data),
      reset: () => screen.push("<reset>"),
      exited: (exitCode) => screen.push(`<exit ${exitCode}>`),
    },
    (since) =>
      new Promise((resolve, reject) => {
        calls.push({ since, answer: resolve, fail: () => reject(new Error("offline")) })
      }),
  )
  return { screen, calls, stream }
}

describe("terminal output ordered by offset", () => {
  it("trims pushes that overlap what attach returned", async () => {
    const { screen, calls, stream } = setup()
    const attached = stream.attach()
    stream.data("abc", 0)
    stream.data("def", 3)
    calls[0]!.answer({ session, offset: 0, data: "abcd" })
    expect(await attached).toStrictEqual(session)
    stream.data("ghi", 6)
    expect(calls.map((call) => call.since)).toStrictEqual([0])
    expect(screen).toStrictEqual(["abcd", "ef", "ghi"])
  })

  it("appends when attach starts where the screen ends", async () => {
    const { screen, calls, stream } = setup()
    stream.data("abc", 0)
    const attached = stream.attach()
    calls[0]!.answer({ session, offset: 3, data: "de" })
    await attached
    expect(calls[0]!.since).toBe(3)
    expect(screen).toStrictEqual(["abc", "de"])
  })

  it("clears the screen when the scrollback no longer reaches the screen's end", async () => {
    const { screen, calls, stream } = setup()
    stream.data("abc", 0)
    const attached = stream.attach()
    calls[0]!.answer({ session, offset: 10, data: "xyz" })
    await attached
    stream.data("!", 13)
    expect(screen).toStrictEqual(["abc", "<reset>", "xyz", "!"])
  })

  it("attaches when pushes skip output, then trims the skipped push", async () => {
    const { screen, calls, stream } = setup()
    stream.data("ab", 0)
    stream.data("fg", 5)
    expect(calls.map((call) => call.since)).toStrictEqual([2])
    calls[0]!.answer({ session, offset: 2, data: "cdefg" })
    await stream.attach()
    expect(screen).toStrictEqual(["ab", "cdefg"])
  })

  it("shows an exit once, after the output attach returned", async () => {
    const { screen, calls, stream } = setup()
    const attached = stream.attach()
    stream.data("bye", 0)
    stream.exited(3)
    calls[0]!.answer({ session: { ...session, status: "exited", exitCode: 3 }, offset: 0, data: "bye" })
    await attached
    stream.exited(3)
    expect(screen).toStrictEqual(["bye", "<exit 3>"])
  })

  it("shows the exit again after the screen was cleared", async () => {
    const { screen, calls, stream } = setup()
    stream.data("bye", 0)
    stream.exited(0)
    const attached = stream.attach()
    calls[0]!.answer({ session: { ...session, status: "exited", exitCode: 0 }, offset: 9, data: "end" })
    await attached
    expect(screen).toStrictEqual(["bye", "<exit 0>", "<reset>", "end", "<exit 0>"])
  })

  it("writes held output once when attach fails, without attaching again", async () => {
    const { screen, calls, stream } = setup()
    stream.data("ab", 0)
    stream.data("fg", 5)
    stream.data("hi", 7)
    calls[0]!.fail()
    expect(await stream.attach()).toBeNull()
    expect(calls).toHaveLength(1)
    expect(screen).toStrictEqual(["ab", "fg", "hi"])
  })

  it("writes pushes from a cloud that sends no offsets", () => {
    const { screen, calls, stream } = setup()
    stream.data("ab")
    stream.data("ab")
    expect(calls).toHaveLength(0)
    expect(screen).toStrictEqual(["ab", "ab"])
  })
})

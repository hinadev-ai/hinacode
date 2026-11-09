import { describe, expect, test } from "@effect/vitest"
import { ShellMarks } from "./shellMarks.ts"

const osc = (body: string) => `\u001B]${body}\u0007`

describe("ShellMarks", () => {
  test("follows a command from its start to its exit code", () => {
    const marks = new ShellMarks("/repo")
    expect(marks.read(`${osc("133;A")}$ ${osc("633;E;pnpm test")}${osc("133;C")}`)).toBe(true)
    expect(marks.state).toStrictEqual({ cwd: "/repo", command: "pnpm test", lastExitCode: null })
    marks.read(`ok\r\n${osc("133;D;1")}${osc("133;A")}$ `)
    expect(marks.state).toStrictEqual({ cwd: "/repo", command: null, lastExitCode: 1 })
  })

  test("ignores the exit code a prompt reports when no command ran, such as after an empty line", () => {
    const marks = new ShellMarks("/repo")
    expect(marks.read(`${osc("133;D;0")}${osc("133;A")}`)).toBe(false)
    expect(marks.state.lastExitCode).toBeNull()
  })

  test("keeps a command line that contains semicolons", () => {
    const marks = new ShellMarks("/repo")
    marks.read(`${osc("633;E;cd web; pnpm dev")}${osc("133;C")}`)
    expect(marks.state.command).toBe("cd web; pnpm dev")
  })

  test("reports a running command whose line it never saw as empty", () => {
    const marks = new ShellMarks("/repo")
    marks.read(osc("133;C"))
    expect(marks.state.command).toBe("")
  })

  test("reads the command line fish 4 puts in its own command mark, and keeps it through a second mark", () => {
    const marks = new ShellMarks("/repo")
    marks.read(`${osc("133;C;cmdline_url=echo%20%27a%0Ab%27")}${osc("133;C")}`)
    expect(marks.state.command).toBe("echo 'a b'")
  })

  test("follows the cwd from OSC 7, ended by BEL or ESC \\", () => {
    const marks = new ShellMarks("/repo")
    marks.read(osc("7;file://host/repo/web"))
    expect(marks.state.cwd).toBe("/repo/web")
    marks.read("\u001B]7;file:///tmp/a b\u001B\\")
    expect(marks.state.cwd).toBe("/tmp/a b")
  })

  test("reads a mark split across chunks", () => {
    const marks = new ShellMarks("/repo")
    const data = `out${osc("633;E;vite")}${osc("133;C")}`
    for (const char of data) marks.read(char)
    expect(marks.state.command).toBe("vite")
  })

  test("does not report a change when the shell repeats the same cwd", () => {
    const marks = new ShellMarks("/repo")
    expect(marks.read(osc("7;file://host/repo"))).toBe(false)
  })
})

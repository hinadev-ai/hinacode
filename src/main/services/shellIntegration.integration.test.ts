import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "@effect/vitest"
import * as pty from "node-pty"
import { makeShellIntegration } from "./shellIntegration.ts"
import { ShellMarks, type ShellState } from "./shellMarks.ts"

const installed = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim()
  } catch {
    return null
  }
}

const integration = makeShellIntegration()
const base = realpathSync(mkdtempSync(join(tmpdir(), "kk-shell-integration-")))
afterAll(() => {
  integration.dispose()
  rmSync(base, { recursive: true, force: true })
})

const userFiles: Record<string, Record<string, string>> = {
  zsh: { ".zshenv": "export FROM_USER=yes\n" },
  bash: { ".bash_profile": "export FROM_USER=yes\n" },
  fish: { ".config/fish/config.fish": "set -gx FROM_USER yes\n" },
}

const shellIn = (name: string, file: string) => {
  const home = join(base, name)
  for (const [path, text] of Object.entries(userFiles[name] ?? {})) {
    mkdirSync(join(home, path, ".."), { recursive: true })
    writeFileSync(join(home, path), text)
  }
  const env = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    TERM: "xterm-256color",
    XDG_CONFIG_HOME: join(home, ".config"),
  }
  const launch = integration.launch({ file, args: ["-l"] }, env)
  const proc = pty.spawn(launch.file, [...launch.args], {
    cols: 200,
    rows: 24,
    cwd: home,
    env: { ...env, ...launch.env },
  })
  const marks = new ShellMarks(home)
  let output = ""
  const states: Array<ShellState> = []
  proc.onData((data) => {
    output += data
    if (marks.read(data)) states.push(marks.state)
  })
  const until = (done: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!done()) return
        data.dispose()
        exit.dispose()
        resolve()
      }
      const data = proc.onData(check)
      const exit = proc.onExit(() => reject(new Error(`${name} exited:\n${output}`)))
      check()
    })
  return { proc, home, states, marks, output: () => output, until }
}

describe.each(["zsh", "bash", "fish"])("%s integration", (name) => {
  const file = installed(name)
  test.skipIf(file === null)(
    "reports the running command, its exit code and the cwd, after the user's own startup files",
    async () => {
      const shell = shellIn(name, file!)
      try {
        await shell.until(() => shell.output().includes("\u001B]133;A"))
        shell.proc.write("echo from:$FROM_USER\r")
        await shell.until(() => shell.output().includes("from:yes"))
        shell.proc.write("cd /tmp; sleep 0.3; false\r")
        await shell.until(() => shell.marks.state.lastExitCode === 1 && shell.marks.state.cwd !== shell.home)
        expect(shell.states).toContainEqual({ cwd: shell.home, command: "cd /tmp; sleep 0.3; false", lastExitCode: 0 })
        expect(shell.marks.state).toStrictEqual({ cwd: realpathSync("/tmp"), command: null, lastExitCode: 1 })
      } finally {
        shell.proc.kill()
      }
    },
  )
})

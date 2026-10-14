import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { cachedExecutable, lookupExecutable } from "./binary.ts"

let root = ""
let bin = ""
let noisyLoginShell = ""

const writeScript = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kk-binary-test-"))
  bin = join(root, "bin")
  mkdirSync(bin)
  writeScript(join(bin, "kk-tool"), "exit 0")
  noisyLoginShell = join(root, "noisy-shell")
  writeScript(noisyLoginShell, 'echo "Welcome back"\n/bin/sh -c "$2"\nstatus=$?\necho "Logged out"\nexit $status')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("lookupExecutable", () => {
  it("preserves login lookup when interactive startup prevents the command from running", () => {
    const loginOnlyShell = join(root, "login-only-shell")
    writeScript(loginOnlyShell, 'if [ "$1" = "-ilc" ]; then exit 7; fi\n/bin/sh -c "$2"')
    const env = { PATH: bin, SHELL: loginOnlyShell }
    expect(lookupExecutable("kk-tool", { env, mode: "interactive" })).toBeUndefined()
    expect(lookupExecutable("kk-tool", { env, mode: "login" })).toBe(join(bin, "kk-tool"))
  })

  it("keeps cached results separate for the two shell modes", () => {
    const loginOnlyShell = join(root, "cached-login-only-shell")
    const name = "kk-cached-mode-tool"
    writeScript(join(bin, name), "exit 0")
    writeScript(loginOnlyShell, 'if [ "$1" = "-ilc" ]; then exit 7; fi\n/bin/sh -c "$2"')
    const previous = { PATH: process.env.PATH, SHELL: process.env.SHELL }
    process.env.PATH = bin
    process.env.SHELL = loginOnlyShell
    try {
      expect(cachedExecutable(name, { mode: "interactive" })).toBeUndefined()
      expect(cachedExecutable(name, { mode: "login" })).toBe(join(bin, name))
    } finally {
      if (previous.PATH === undefined) delete process.env.PATH
      else process.env.PATH = previous.PATH
      if (previous.SHELL === undefined) delete process.env.SHELL
      else process.env.SHELL = previous.SHELL
    }
  })

  it("finds an executable on PATH", () => {
    expect(lookupExecutable("kk-tool", { env: { PATH: `${bin}:/usr/bin:/bin`, SHELL: noisyLoginShell } })).toBe(
      join(bin, "kk-tool"),
    )
  })

  it("falls back when which is missing and takes the last absolute path over profile output", () => {
    expect(lookupExecutable("kk-tool", { env: { PATH: bin, SHELL: noisyLoginShell } })).toBe(join(bin, "kk-tool"))
  })

  it("is undefined when neither PATH nor the shell has it", () => {
    expect(
      lookupExecutable("kk-no-such-tool", { env: { PATH: `${bin}:/usr/bin:/bin`, SHELL: noisyLoginShell } }),
    ).toBeUndefined()
  })
})

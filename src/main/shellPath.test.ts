import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { hydratePath } from "./shellPath.ts"

const fakeShell = (dir: string, path: string, gate?: string) => {
  const shell = join(dir, "shell")
  const wait = gate === undefined ? "" : `while [ ! -e '${gate}' ]; do sleep 0.01; done\n`
  writeFileSync(shell, `#!/bin/sh\n${wait}printf '%s' __HINACODE_PATH_START__ '${path}' __HINACODE_PATH_END__\n`)
  chmodSync(shell, 0o755)
  return shell
}

describe.skipIf(process.platform === "win32")("hydratePath", () => {
  it("waits for the login shell on the first launch and remembers its PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kk-shell-path-"))
    const cache = join(dir, "shell-path")
    const env = { SHELL: fakeShell(dir, "/opt/homebrew/bin:/usr/bin"), PATH: "/usr/bin:/bin" }

    await hydratePath(env, cache).ready

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
    expect(readFileSync(cache, "utf8")).toBe("/opt/homebrew/bin:/usr/bin")
  })

  it("starts from the remembered PATH and refreshes it from the login shell in the background", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kk-shell-path-"))
    const cache = join(dir, "shell-path")
    const gate = join(dir, "gate")
    writeFileSync(cache, "/old/nvm/bin:/usr/bin")
    const env = { SHELL: fakeShell(dir, "/new/nvm/bin:/usr/bin", gate), PATH: "/usr/bin:/bin" }

    const { ready, refreshed } = hydratePath(env, cache)
    await ready
    expect(env.PATH).toBe("/old/nvm/bin:/usr/bin:/bin")

    writeFileSync(gate, "")
    await refreshed
    expect(env.PATH).toBe("/new/nvm/bin:/usr/bin:/bin")
    expect(readFileSync(cache, "utf8")).toBe("/new/nvm/bin:/usr/bin")
  })
})

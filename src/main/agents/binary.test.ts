import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { installedBinary } from "./binary.ts"

const inherited = process.env["PATH"]

const cliIn = (root: string, dir: string) => {
  const bin = join(root, dir)
  mkdirSync(bin)
  writeFileSync(join(bin, "kk-fake-cli"), "#!/bin/sh\n")
  chmodSync(join(bin, "kk-fake-cli"), 0o755)
  return bin
}

describe.skipIf(process.platform === "win32")("installedBinary", () => {
  afterEach(() => {
    process.env["PATH"] = inherited
  })

  it("finds the CLI again once the login shell's PATH replaces the remembered one", async () => {
    const root = mkdtempSync(join(tmpdir(), "kk-binary-"))
    const remembered = cliIn(root, "old")
    const fresh = cliIn(root, "new")

    process.env["PATH"] = `${remembered}:${inherited}`
    expect(await Effect.runPromise(installedBinary("claude", "kk-fake-cli"))).toBe(join(remembered, "kk-fake-cli"))

    process.env["PATH"] = `${fresh}:${inherited}`
    expect(await Effect.runPromise(installedBinary("claude", "kk-fake-cli"))).toBe(join(fresh, "kk-fake-cli"))
  })
})

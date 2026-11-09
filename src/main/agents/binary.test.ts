import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { AgentBinaries, type AgentBinarySource, binaryStatuses, installedBinary } from "./binary.ts"

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

  it("finds the CLI on a PATH that has no `which`, as on Windows", async () => {
    const bin = cliIn(mkdtempSync(join(tmpdir(), "kk-binary-")), "bin")

    process.env["PATH"] = bin
    expect(await Effect.runPromise(installedBinary("claude", "kk-fake-cli"))).toBe(join(bin, "kk-fake-cli"))
  })

  const withBinaries = <A, E>(effect: Effect.Effect<A, E>, source: Partial<AgentBinarySource>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(AgentBinaries, {
          configured: Effect.succeed({}),
          simulated: new Set(),
          ...source,
        }),
      ),
    )

  it("runs the CLI at the path set in Settings, and magpie follows Claude Code's", async () => {
    const root = mkdtempSync(join(tmpdir(), "kk-binary-"))
    const custom = join(cliIn(root, "custom"), "kk-fake-cli")
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "kk-binary-path-"))

    const statuses = await withBinaries(binaryStatuses, {
      configured: Effect.succeed({ claude: custom, codex: join(root, "missing", "codex") }),
    })

    expect(statuses.claude).toStrictEqual({ installed: true, path: custom })
    expect(statuses.magpie).toStrictEqual({ installed: true, path: custom })
    expect(statuses.codex).toStrictEqual({ installed: false, path: null })
    expect(statuses.muse).toStrictEqual({ installed: false, path: null })
  })

  it("names the configured path when nothing runs there", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "kk-binary-")), "codex")

    const error = await withBinaries(Effect.flip(installedBinary("codex", "codex")), {
      configured: Effect.succeed({ codex: missing }),
    })

    expect(error.message).toContain(missing)
  })

  it("counts a simulated agent as installed without a CLI", async () => {
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "kk-binary-"))

    const statuses = await withBinaries(binaryStatuses, { simulated: new Set(["claude"] as const) })

    expect(statuses.claude).toStrictEqual({ installed: true, path: null })
    expect(statuses.codex.installed).toBe(false)
  })
})

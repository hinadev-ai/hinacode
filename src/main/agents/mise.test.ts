import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { miseOwnership } from "./mise.ts"
import { availableUpdates, installUpdate } from "./updates.ts"

const inherited = process.env["PATH"]

const executable = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

const fakeMise = ({ requested = "latest", latest = "2.1.328" } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "kk-mise-"))
  const bin = join(root, "bin")
  const versionDir = join(root, "installs", "claude", "2.1.327")
  const latestLink = join(root, "installs", "claude", "latest")
  const wrappers = join(root, "command-wrappers", "bin")
  for (const dir of [bin, versionDir, wrappers]) mkdirSync(dir, { recursive: true })
  symlinkSync(versionDir, latestLink)
  writeFileSync(join(root, "version"), "2.1.327")
  writeFileSync(join(root, "latest"), latest)
  writeFileSync(join(root, "which"), join(latestLink, "claude"))
  writeFileSync(
    join(root, "ls.json"),
    JSON.stringify([{ install_path: versionDir, requested_version: requested, active: true }]),
  )
  executable(
    join(versionDir, "claude"),
    `[ "$1" = update ] && echo "claude $*" >> "${root}/ran"\necho "$(cat "${root}/version") (Claude Code)"`,
  )
  executable(
    join(bin, "mise"),
    [
      `root="${root}"`,
      `[ "$(basename "$0")" = claude ] && exec "$(cat "$root/which")" "$@"`,
      `case "$1" in`,
      `  which) cat "$root/which" ;;`,
      `  ls) cat "$root/ls.json" ;;`,
      `  latest) cat "$root/latest" ;;`,
      `  upgrade) echo "mise $*" >> "$root/ran"; cp "$root/latest" "$root/version" ;;`,
      `  *) exit 1 ;;`,
      `esac`,
    ].join("\n"),
  )
  symlinkSync(join(bin, "mise"), join(wrappers, "claude"))
  process.env["PATH"] = `${wrappers}:${bin}:/usr/bin:/bin`
  return {
    root,
    wrapper: join(wrappers, "claude"),
    latestLink: join(latestLink, "claude"),
    versionDir: join(versionDir, "claude"),
    ran: () => readFileSync(join(root, "ran"), "utf8").trim().split("\n"),
  }
}

const ownership = (binary: string) => Effect.runPromise(miseOwnership(binary, "claude"))

describe.skipIf(process.platform === "win32")("mise", () => {
  afterEach(() => {
    process.env["PATH"] = inherited
  })

  it("upgrades a tool requested as latest through a command wrapper, a shim or the latest link", async () => {
    const mise = fakeMise()

    expect(await ownership(mise.wrapper)).toStrictEqual({ kind: "upgradable", mise: join(mise.root, "bin", "mise") })
    expect((await ownership(mise.latestLink)).kind).toBe("upgradable")
  })

  it("runs a launcher script that execs the tool through `mise x` as mise would resolve it", async () => {
    const mise = fakeMise()
    const script = join(mise.root, "claude")
    executable(script, 'mise use -g claude >/dev/null || exit 1\nexec mise x "claude" -- claude "$@"')

    expect((await ownership(script)).kind).toBe("upgradable")
  })

  it("leaves a pinned tool and a path into one version's directory to the developer", async () => {
    expect((await ownership(fakeMise({ requested: "2.1.327" }).wrapper)).kind).toBe("manual")
    expect((await ownership(fakeMise().versionDir)).kind).toBe("manual")
  })

  it("does not claim a CLI that mise did not install", async () => {
    const mise = fakeMise()
    const npmGlobal = join(mise.root, "npm-claude")
    executable(npmGlobal, "echo 2.1.327")

    expect((await ownership(npmGlobal)).kind).toBe("none")
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "kk-no-mise-"))
    expect((await ownership(npmGlobal)).kind).toBe("none")
  })

  it("offers the version mise would install and updates with `mise upgrade`, never `claude update`", async () => {
    const mise = fakeMise()

    expect(await Effect.runPromise(availableUpdates)).toStrictEqual([
      { provider: "claude", current: "2.1.327", latest: "2.1.328" },
    ])
    expect(await Effect.runPromise(installUpdate("claude"))).toBe("2.1.328")
    expect(mise.ran()).toStrictEqual(["mise upgrade claude"])
  })

  it("offers nothing for a pinned tool", async () => {
    fakeMise({ requested: "2.1.327" })

    expect(await Effect.runPromise(availableUpdates)).toStrictEqual([])
  })
})

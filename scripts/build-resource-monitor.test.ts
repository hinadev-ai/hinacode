import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("..", import.meta.url))
const script = fileURLToPath(new URL("./build-resource-monitor.ts", import.meta.url))

test("a Go that cannot build the monitor prints one line and lets pnpm dev continue", (t) => {
  const bin = mkdtempSync(join(tmpdir(), "old-go-"))
  t.after(() => rmSync(bin, { recursive: true, force: true }))
  writeFileSync(
    join(bin, "go"),
    `#!/bin/sh\necho "go: go.mod requires go >= 1.26.0 (running go 1.25.1; GOTOOLCHAIN=local)" >&2\necho "second line" >&2\nexit 1\n`,
  )
  chmodSync(join(bin, "go"), 0o755)

  const build = spawnSync(process.execPath, [script], {
    cwd: repo,
    env: { ...process.env, PATH: bin },
    encoding: "utf8",
  })

  assert.equal(build.status, 0)
  assert.equal(
    build.stdout,
    "Skipping the resource monitor: go: go.mod requires go >= 1.26.0 (running go 1.25.1; GOTOOLCHAIN=local)\n",
  )
  assert.equal(build.stderr, "")
})

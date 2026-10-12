// node-pty publishes its macOS spawn-helper prebuilds without the executable bit, and every pty spawn
// fails with "posix_spawnp failed" until it is set (microsoft/node-pty#850).
import { chmodSync, existsSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const prebuilds = join(dirname(createRequire(import.meta.url).resolve("node-pty/package.json")), "prebuilds")
for (const platform of existsSync(prebuilds) ? readdirSync(prebuilds) : []) {
  const helper = join(prebuilds, platform, "spawn-helper")
  if (existsSync(helper)) chmodSync(helper, 0o755)
}

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"

const binary = join(import.meta.dirname, "../../tools/resource-monitor/bin/resource-monitor")

export const startResourceMonitor = (userData: string) => {
  if (!existsSync(binary)) return
  const instance = randomUUID()
  process.env["HINACODE_INSTANCE"] = instance
  const log = join(userData, "resource-monitor", `${new Date().toISOString().replaceAll(":", "-")}.ndjson`)
  // FIXME: Ctrl+C signals the whole process group, so the monitor detaches to outlive the app
  spawn(binary, ["watch", "-root", String(process.pid), "-instance", instance, "-out", log], {
    detached: true,
    stdio: ["ignore", "ignore", "inherit"],
  })
    .on("error", (error) => console.error(`Resource monitor did not start: ${error.message}`))
    .unref()
  console.log(`Resource monitor log: ${log}`)
}

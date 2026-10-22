import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"

const binary = join(import.meta.dirname, "../../tools/resource-monitor/bin/resource-monitor")

/**
 * Starts the development resource monitor next to this process when `pnpm dev` has built it. It logs every
 * process this app starts to `<userData>/resource-monitor/` and prints the ones still running after the app quits.
 * See docs/features/2026-10-22-resource-monitor.md.
 */
export const startResourceMonitor = (userData: string) => {
  if (!existsSync(binary)) return
  // Inherited by everything this process starts, so the monitor still finds a process that was reparented away.
  // A new value per launch keeps a restart from counting the last run's processes while they shut down.
  const instance = randomUUID()
  process.env["HINACODE_INSTANCE"] = instance
  const log = join(userData, "resource-monitor", `${new Date().toISOString().replaceAll(":", "-")}.ndjson`)
  // Detached, so Ctrl+C in the `pnpm dev` terminal does not stop it before it samples what outlived the app.
  spawn(binary, ["watch", "-root", String(process.pid), "-instance", instance, "-out", log], {
    detached: true,
    stdio: ["ignore", "ignore", "inherit"],
  })
    .on("error", (error) => console.error(`Resource monitor did not start: ${error.message}`))
    .unref()
  console.log(`Resource monitor log: ${log}`)
}

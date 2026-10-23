// Builds the development resource monitor (docs/features/2026-10-22-resource-monitor.md). Go is optional for
// contributors, so without it the app runs without the monitor.
import { execFileSync } from "node:child_process"

try {
  execFileSync("go", ["build", "-o", "bin/resource-monitor", "."], {
    cwd: "tools/resource-monitor",
    env: { ...process.env, CGO_ENABLED: "0" },
    stdio: "inherit",
  })
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  console.log("Skipping the resource monitor: Go is not installed.")
}

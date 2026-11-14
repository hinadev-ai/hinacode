import { execFileSync } from "node:child_process"

try {
  execFileSync("go", ["build", "-o", "bin/resource-monitor", "."], {
    cwd: "tools/resource-monitor",
    env: { ...process.env, CGO_ENABLED: "0" },
    stdio: ["ignore", "inherit", "pipe"],
    encoding: "utf8",
  })
} catch (error) {
  const { code, stderr } = error as NodeJS.ErrnoException & { stderr?: string }
  const reason = code === "ENOENT" ? "Go is not installed." : stderr?.trim().split("\n")[0] || String(error)
  console.log(`Skipping the resource monitor: ${reason}`)
}

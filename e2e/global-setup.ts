import { execSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { projectRoot } from "./support/app.ts"
import { WEB_APP_DIR } from "./support/web.ts"

const SKIPPED_DIRS = new Set(["paraglide", "node_modules"])
const isTest = (name: string) => name.endsWith(".test.ts") || name.endsWith(".test.tsx")

const newestMtime = (path: string): number => {
  const stat = statSync(path)
  if (!stat.isDirectory()) return isTest(path) ? 0 : stat.mtimeMs
  return readdirSync(path, { withFileTypes: true }).reduce(
    (newest, entry) =>
      entry.isDirectory() && SKIPPED_DIRS.has(entry.name)
        ? newest
        : Math.max(newest, newestMtime(join(path, entry.name))),
    0,
  )
}

const isStale = (output: string, sources: ReadonlyArray<string>) =>
  !existsSync(output) ||
  Math.max(...sources.map((source) => newestMtime(join(projectRoot, source)))) > statSync(output).mtimeMs

const ensureFreshBuild = () => {
  if (!isStale(join(projectRoot, "out/main/index.js"), ["src", "messages"])) return
  console.log("e2e: building hinacode")
  execSync("pnpm build", { cwd: projectRoot, stdio: "inherit" })
}

const ensureFreshServerBuild = () => {
  if (!isStale(join(projectRoot, "out/server/cli.js"), ["src/main", "src/shared", "src/cli", "messages"])) return
  console.log("e2e: building the hinacode serve package")
  execSync("pnpm build:server", { cwd: projectRoot, stdio: "inherit" })
}

const ensureFreshWebBuild = () => {
  const sources = ["apps/web/src", "apps/web/public", "apps/web/index.html", "src/renderer", "src/shared", "messages"]
  if (!isStale(join(WEB_APP_DIR, "index.html"), sources)) return
  console.log("e2e: building the web app")
  execSync(`pnpm exec vite build --config apps/web/vite.config.ts --outDir ${WEB_APP_DIR}`, {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, VITE_RELAY_URL: "https://relay.hinacode.app" },
  })
}

const ensureDisplay = () => {
  if (process.platform === "darwin") return
  if (process.env.DISPLAY) return
  if (existsSync("/tmp/.X11-unix/X99")) process.env.DISPLAY = ":99"
}

export default function globalSetup() {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"
  ensureDisplay()
  ensureFreshBuild()
  ensureFreshServerBuild()
  ensureFreshWebBuild()
}

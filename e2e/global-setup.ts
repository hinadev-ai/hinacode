import { execSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { projectRoot } from "./support/app.ts"

const SKIPPED_DIRS = new Set(["paraglide"])
const isTest = (name: string) => name.endsWith(".test.ts")

/** Latest modification time of app sources under `dir`, in milliseconds. */
const newestMtime = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((newest, entry) => {
    if (entry.isDirectory())
      return SKIPPED_DIRS.has(entry.name) ? newest : Math.max(newest, newestMtime(join(dir, entry.name)))
    return isTest(entry.name) ? newest : Math.max(newest, statSync(join(dir, entry.name)).mtimeMs)
  }, 0)

/** The suite drives `out/`, so a build older than the sources would test stale code. */
const ensureFreshBuild = () => {
  const entry = join(projectRoot, "out/main/index.js")
  const sources = ["src", "messages"].map((dir) => newestMtime(join(projectRoot, dir)))
  const stale = !existsSync(entry) || Math.max(...sources) > statSync(entry).mtimeMs
  if (!stale) return
  console.log("e2e: building kkcode")
  execSync("pnpm build", { cwd: projectRoot, stdio: "inherit" })
}

/** Electron needs an X display. Workers inherit the environment of this process. */
const ensureDisplay = () => {
  if (process.env.DISPLAY) return
  if (existsSync("/tmp/.X11-unix/X99")) {
    process.env.DISPLAY = ":99"
    return
  }
  throw new Error("No DISPLAY for Electron. Run under `xvfb-run -a pnpm test:e2e` or start `Xvfb :99`.")
}

export default function globalSetup() {
  ensureDisplay()
  ensureFreshBuild()
}

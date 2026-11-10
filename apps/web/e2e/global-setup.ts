import { execSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { CLERK_HOST, repoRoot, webBuildDir } from "./support/stack.ts"

const SKIPPED_DIRS = new Set(["paraglide", "node_modules", "dist", "e2e"])

const newestMtime = (path: string): number => {
  const stat = statSync(path)
  if (!stat.isDirectory()) return /\.test\.tsx?$/.test(path) ? 0 : stat.mtimeMs
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
  Math.max(...sources.map((source) => newestMtime(join(repoRoot, source)))) > statSync(output).mtimeMs

const build = (output: string, sources: ReadonlyArray<string>, command: string, env: NodeJS.ProcessEnv = {}) => {
  if (!isStale(output, sources)) return
  console.log(`web e2e: ${command}`)
  execSync(command, { cwd: repoRoot, stdio: "inherit", env: { ...process.env, ...env } })
}

export default function globalSetup() {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"
  build(join(repoRoot, "out/server/cli.js"), ["src/main", "src/shared", "src/cli", "messages"], "pnpm build:server")
  build(
    join(webBuildDir, "index.html"),
    ["apps/web", "src/renderer", "src/shared", "messages"],
    `pnpm exec vite build --config apps/web/vite.config.ts --outDir ${webBuildDir}`,
    { VITE_RELAY_URL: "https://relay.hinacode.app", CLERK_SCRIPT_SOURCES: `https://${CLERK_HOST}` },
  )
}

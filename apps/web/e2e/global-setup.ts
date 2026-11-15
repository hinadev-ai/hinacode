import { spawn } from "node:child_process"
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

const run = (command: string, env: NodeJS.ProcessEnv) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, { cwd: repoRoot, stdio: "inherit", shell: true, env: { ...process.env, ...env } })
    child.on("error", reject)
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))))
  })

const build = async (output: string, sources: ReadonlyArray<string>, command: string, env: NodeJS.ProcessEnv = {}) => {
  if (!isStale(output, sources)) return
  console.log(`web e2e: ${command}`)
  await run(command, env)
}

export default async function globalSetup() {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"
  await Promise.all([
    build(join(repoRoot, "out/server/cli.js"), ["src/main", "src/shared", "src/cli", "messages"], "pnpm build:server"),
    build(
      join(webBuildDir, "index.html"),
      ["apps/web", "src/renderer", "src/shared", "messages"],
      `pnpm exec vite build --config apps/web/vite.config.ts --outDir ${webBuildDir}`,
      { VITE_RELAY_URL: "https://relay.hinacode.app", CLERK_SCRIPT_SOURCES: `https://${CLERK_HOST}` },
    ),
  ])
}

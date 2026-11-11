#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { build, type Plugin } from "esbuild"
import { isServerExternal, SERVER_EXTERNALS } from "./server-package.ts"

const repoRoot = resolve(import.meta.dirname, "..")
const serverCli = join(repoRoot, "out", "server", "cli.js")
if (!existsSync(serverCli)) throw new Error(`${serverCli} is missing. Run pnpm build:server first.`)

const target = `${process.platform}-${process.arch}`
const outDir = join(repoRoot, "dist-exe")
const stage = join(outDir, "hinacode")
const executable = join(stage, "hinacode")
const archive = join(outDir, `hinacode-${target}.tar.gz`)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// FIXME: a Node single executable's require loads only built-ins, so the externals load from beside the executable
const requireBesideExecutable: Plugin = {
  name: "require-beside-executable",
  setup: (plugin) => {
    plugin.onResolve({ filter: /.*/ }, ({ path }) =>
      isServerExternal(path) ? { path, namespace: "beside-executable" } : undefined,
    )
    plugin.onLoad({ filter: /.*/, namespace: "beside-executable" }, ({ path }) => ({
      contents: `module.exports = require("node:module").createRequire(process.execPath)(${JSON.stringify(path)})`,
      loader: "js",
    }))
  },
}

const bundle = join(outDir, "hinacode.cjs")
await build({
  entryPoints: [serverCli],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node26",
  plugins: [requireBesideExecutable],
  banner: { js: 'var importMetaUrl = require("node:url").pathToFileURL(__filename).href' },
  define: { "import.meta.url": "importMetaUrl" },
  logLevel: "error",
})

const seaConfig = join(outDir, "sea-config.json")
writeFileSync(
  seaConfig,
  JSON.stringify({
    main: bundle,
    output: executable,
    useCodeCache: true,
    disableExperimentalSEAWarning: true,
  }),
)
execFileSync(process.execPath, ["--build-sea", seaConfig], { stdio: "inherit" })
rmSync(seaConfig)
rmSync(bundle)
if (process.platform === "darwin")
  execFileSync("codesign", ["--sign", "-", "--force", executable], { stdio: "inherit" })

const isNodePtyRuntime = (inside: string) => {
  const [top = "", platform] = inside.split(sep)
  if (top === "") return true
  if (top === "prebuilds") return platform === undefined || platform === target
  return top === "package.json" || top === "LICENSE" || top === "lib"
}

for (const name of SERVER_EXTERNALS) {
  const source = realpathSync(join(repoRoot, "node_modules", name))
  cpSync(source, join(stage, "node_modules", name), {
    recursive: true,
    dereference: true,
    filter: (path) => name !== "node-pty" || isNodePtyRuntime(relative(source, path)),
  })
}

execFileSync("tar", ["-czf", archive, "-C", outDir, "hinacode"], { stdio: "inherit" })
console.log(`built ${relative(repoRoot, archive)}`)

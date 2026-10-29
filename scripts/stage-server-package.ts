#!/usr/bin/env node
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseRootManifest, SERVER_BIN, serverManifest } from "./server-package.ts"

const repoRoot = resolve(import.meta.dirname, "..")
const outDir = resolve(repoRoot, process.argv[2] ?? "dist-npm")
if (outDir === repoRoot) throw new Error("staging directory must not be the repository root")

const built = join(repoRoot, "out", "server", "daemon.js")
if (!existsSync(built)) throw new Error(`${built} is missing. Run pnpm build:server first.`)

const root = parseRootManifest(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")))

rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, "bin"), { recursive: true })
cpSync(join(repoRoot, "out", "server"), join(outDir, "out", "server"), { recursive: true })
cpSync(join(repoRoot, "LICENSE"), join(outDir, "LICENSE"))
cpSync(join(repoRoot, "README.md"), join(outDir, "README.md"))
writeFileSync(join(outDir, "package.json"), `${JSON.stringify(serverManifest(root), null, 2)}\n`)
writeFileSync(join(outDir, "bin", "hinacode.mjs"), SERVER_BIN)
chmodSync(join(outDir, "bin", "hinacode.mjs"), 0o755)

console.log(`staged hinacode@${root.version} in ${outDir}`)

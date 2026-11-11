#!/usr/bin/env node
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { withServe } from "./serve-probe.ts"

const run = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")
const staged = resolve(repoRoot, process.argv[2] ?? "dist-npm")
assert.ok(
  existsSync(join(staged, "package.json")),
  `${staged} is missing. Run pnpm build:server and pnpm stage:server first.`,
)

const work = mkdtempSync(join(tmpdir(), "hinacode-server-verify-"))
const pkg = join(work, "package")
cpSync(staged, pkg, { recursive: true })
const parsed: unknown = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"))
if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
  throw new Error("staged package.json must be an object")
const fields = parsed as Record<string, unknown>
if (typeof fields["version"] !== "string") throw new Error("staged package.json version must be a string")
if (
  typeof fields["dependencies"] !== "object" ||
  fields["dependencies"] === null ||
  Array.isArray(fields["dependencies"])
)
  throw new Error("staged package.json dependencies must be an object")
const manifest = {
  version: fields["version"],
  dependencies: fields["dependencies"] as Record<string, unknown>,
}

const bundleFiles = [
  join(pkg, "out", "server", "cli.js"),
  ...readdirSync(join(pkg, "out", "server", "chunks")).map((f) => join(pkg, "out", "server", "chunks", f)),
]
for (const file of bundleFiles) {
  const head = readFileSync(file, "utf8").slice(0, 8000)
  assert.ok(!/from\s+"electron"/.test(head) && !/import\s+"electron"/.test(head), `${file} imports electron`)
}

await run("npm", ["install", "--prefix", pkg, "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
  timeout: 300_000,
})

const installed = new Set(readdirSync(join(pkg, "node_modules")).filter((name) => !name.startsWith(".")))
for (const forbidden of ["electron", "electron-updater", "react", "effect", "@anthropic-ai"]) {
  assert.ok(!installed.has(forbidden), `staged install pulled ${forbidden}`)
}
assert.deepEqual(Object.keys(manifest.dependencies).toSorted(), ["node-pty", "playwright-core"])

const bin = join(pkg, "bin", "hinacode.mjs")
const version = await run(process.execPath, [bin, "--version"])
assert.equal(version.stdout.trim(), `hinacode v${manifest.version}`, "--version output")
const help = await run(process.execPath, [bin, "--help"])
assert.ok(help.stdout.includes("hinacode <subcommand>"), "--help output")

const dataDir = join(work, "data")
const cloud = await withServe([process.execPath, bin], dataDir, async () => {
  assert.ok(existsSync(join(dataDir, "hinacode.sqlite")), "serve created its database")
})
assert.equal(cloud.exitCode, 0, "serve exits 0 on SIGTERM")

rmSync(work, { recursive: true, force: true })
console.log(
  `verified hinacode@${manifest.version} staged install: --version, --help, serve boot on port ${cloud.port}, SIGTERM exit 0`,
)

#!/usr/bin/env node
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

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
  join(pkg, "out", "server", "daemon.js"),
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
assert.equal(version.stdout.trim(), manifest.version, "--version output")
const help = await run(process.execPath, [bin, "--help"])
assert.ok(help.stdout.includes("Usage: hinacode"), "--help output")

const freePort = await new Promise<number>((resolvePort, reject) => {
  const probe = createServer()
  probe.once("error", reject)
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address()
    probe.close(() =>
      typeof address === "object" && address !== null ? resolvePort(address.port) : reject(new Error("no port")),
    )
  })
})

const dataDir = join(work, "data")
const child = spawn(
  process.execPath,
  [bin, "serve", "--host", "127.0.0.1", "--port", String(freePort), "--relay", "off"],
  {
    env: { ...process.env, HINACODE_USER_DATA: dataDir, HINACODE_SERVE_AUTO_UPDATE: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  },
)
let output = ""
child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()))
child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()))
try {
  await new Promise<void>((resolveBoot, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`serve did not print its pairing block in 30s:\n${output}`)),
      30_000,
    )
    child.stdout.on("data", () => {
      if (output.includes("Pair a phone")) {
        clearTimeout(deadline)
        resolveBoot()
      }
    })
    child.once("exit", (code) => {
      clearTimeout(deadline)
      reject(new Error(`serve exited with ${code} before boot:\n${output}`))
    })
  })
  assert.ok(existsSync(join(dataDir, "hinacode.sqlite")), "serve created its database")
} finally {
  child.kill("SIGTERM")
}
const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)))
assert.equal(exitCode, 0, "serve exits 0 on SIGTERM")

rmSync(work, { recursive: true, force: true })
console.log(
  `verified hinacode@${manifest.version} staged install: --version, --help, serve boot on port ${freePort}, SIGTERM exit 0`,
)

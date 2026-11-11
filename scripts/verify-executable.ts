#!/usr/bin/env node
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { withServe } from "./serve-probe.ts"

const run = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")
const archive = resolve(repoRoot, process.argv[2] ?? `dist-exe/hinacode-${process.platform}-${process.arch}.tar.gz`)
const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }

const work = mkdtempSync(join(tmpdir(), "hinacode-exe-verify-"))
await run("tar", ["-xzf", archive, "-C", work])
const hinacode = join(work, "hinacode", "hinacode")
const elsewhere = join(work, "elsewhere")
const repo = join(work, "repo")
const dataDir = join(work, "data")
mkdirSync(elsewhere)
mkdirSync(repo)

const cli = async (...args: ReadonlyArray<string>) =>
  (await run(hinacode, args, { cwd: elsewhere, env: { ...process.env, HINACODE_USER_DATA: dataDir } })).stdout
const rpc = async (method: string, payload: unknown) => JSON.parse(await cli("rpc", method, JSON.stringify(payload)))

assert.equal((await cli("--version")).trim(), `hinacode v${version}`, "--version output")
assert.ok((await cli("--help")).includes("hinacode <subcommand>"), "--help output")

await run("git", ["init", "--quiet", repo])
await run("git", [
  "-C",
  repo,
  "-c",
  "user.name=verify",
  "-c",
  "user.email=verify@hinacode.invalid",
  "commit",
  "--allow-empty",
  "--quiet",
  "-m",
  "init",
])

const readTerminal = async (id: string, expected: string) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { data } = await rpc("terminal.attach", { id, since: null })
    if (typeof data === "string" && data.includes(expected)) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  assert.fail(`the terminal never printed ${expected}`)
}

const cloud = await withServe([hinacode], dataDir, async () => {
  const project = await rpc("projects.create", { name: "repo", rootPath: repo, setupScript: null })
  const thread = await rpc("threads.create", { projectId: project.id })
  const terminal = await rpc("terminal.open", { threadId: thread.id, cols: 80, rows: 24 })
  await rpc("terminal.write", { id: terminal.id, data: "echo hinacode-$((6*7))\r" })
  await readTerminal(terminal.id, "hinacode-42")
})
assert.equal(cloud.exitCode, 0, "serve exits 0 on SIGTERM")

rmSync(work, { recursive: true, force: true })
console.log(
  `verified ${archive}: --version, --help, serve boot on port ${cloud.port}, a terminal command's output, SIGTERM exit 0`,
)

#!/usr/bin/env node
// Usage: tlc.mjs [specs/Name.cfg ...]   Model-checks every config in specs/ (or the ones given) with TLC.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const TLA_TOOLS = {
  url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
  sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const specsDir = join(root, "specs")
const jar = join(root, "node_modules", ".cache", "tla2tools-1.7.4.jar")
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java"

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

if (!existsSync(jar)) {
  const bytes = Buffer.from(await (await fetch(TLA_TOOLS.url)).arrayBuffer())
  if (sha256(bytes) !== TLA_TOOLS.sha256) throw new Error(`tla2tools.jar checksum mismatch from ${TLA_TOOLS.url}`)
  mkdirSync(dirname(jar), { recursive: true })
  writeFileSync(jar, bytes)
}

if (spawnSync(java, ["-version"]).status !== 0) {
  console.error("TLC needs Java 11 or newer on PATH or in JAVA_HOME, e.g. `mise use java@temurin-21`.")
  process.exit(1)
}

const configs =
  process.argv.length > 2 ? process.argv.slice(2) : readdirSync(specsDir).filter((f) => f.endsWith(".cfg"))
let failed = 0

for (const config of configs) {
  const cfgPath = join(specsDir, basename(config))
  const module = basename(config).split(".")[0]
  const expected = readFileSync(cfgPath, "utf8").match(/^\\\* expect: (.+)$/m)?.[1] ?? "No error has been found"
  const metadir = mkdtempSync(join(tmpdir(), "tlc-"))
  const started = Date.now()
  const { stdout, stderr } = spawnSync(
    java,
    [
      "-XX:+UseParallelGC",
      "-cp",
      jar,
      "tlc2.TLC",
      "-workers",
      "auto",
      "-metadir",
      metadir,
      "-config",
      cfgPath,
      `${module}.tla`,
    ],
    { cwd: specsDir, encoding: "utf8" },
  )
  rmSync(metadir, { recursive: true, force: true })
  const output = stdout + stderr
  const states = output.match(/([\d,]+) distinct states found/g)?.at(-1) ?? "no states"
  const ok = output.includes(expected)
  console.log(`${ok ? "ok  " : "FAIL"} ${basename(config)}: ${expected} (${states}, ${Date.now() - started} ms)`)
  if (!ok) {
    failed++
    console.log(output.split("\n").slice(-40).join("\n"))
  }
}

process.exit(failed === 0 ? 0 : 1)

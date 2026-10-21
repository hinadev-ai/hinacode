#!/usr/bin/env node
// Usage: tlc.mjs [specs/Name.cfg ...]   Model-checks every config in specs/ (or the ones given) with TLC.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { jar, java, specsDir } from "./tla-tools.mjs"

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

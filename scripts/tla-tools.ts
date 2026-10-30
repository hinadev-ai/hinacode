import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const TLA_TOOLS = {
  url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
  sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
}

export const root = join(dirname(fileURLToPath(import.meta.url)), "..")
export const specsDir = join(root, "specs")
export const jar = join(root, "node_modules", ".cache", "tla2tools-1.7.4.jar")
export const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java"

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

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

import { cpSync, existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync } from "node:fs"
import { hostname } from "node:os"
import { join, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"

export const chromiumDir = (dataDir: string) => join(dataDir, "chromium")

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export const desktopPid = (profile: string) => {
  let lock: string
  try {
    lock = readlinkSync(join(profile, "SingletonLock"))
  } catch {
    return undefined
  }
  const prefix = `${hostname()}-`
  const pid = lock.startsWith(prefix) ? Number(lock.slice(prefix.length)) : NaN
  return isAlive(pid) ? pid : undefined
}

const OWN_DIRS = new Set(["chats", "attachments", "accounts", "tiny-vm", "cloudflared", "resource-monitor"])

const isOwn = (name: string) =>
  OWN_DIRS.has(name) || name.startsWith("hinacode.sqlite") || name.startsWith("kkcode.sqlite")

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code

const move = (from: string, to: string) => {
  try {
    renameSync(from, to)
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error
    cpSync(from, to, { recursive: true, verbatimSymlinks: true })
    rmSync(from, { recursive: true, force: true })
  }
}

const asIs = (path: string) => path
const inJson = (path: string) => JSON.stringify(path).slice(1, -1)

const PATH_COLUMNS = [
  ["message", "parts", inJson],
  ["thread", "queue", inJson],
  ["agent_account", "config_dir", asIs],
] as const

const rewritePaths = (dataDir: string, legacy: string) => {
  const file = ["hinacode.sqlite", "kkcode.sqlite"].map((name) => join(dataDir, name)).find((path) => existsSync(path))
  if (file === undefined) return
  const db = new DatabaseSync(file)
  try {
    db.exec("BEGIN")
    for (const [table, column, encode] of PATH_COLUMNS) {
      if (db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column) === undefined) continue
      const from = encode(legacy + sep)
      db.prepare(`UPDATE ${table} SET ${column} = replace(${column}, ?, ?) WHERE instr(${column}, ?) > 0`).run(
        from,
        encode(dataDir + sep),
        from,
      )
    }
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}

export const moveLegacyProfile = (legacy: string, dataDir: string) => {
  if (existsSync(dataDir) || !existsSync(legacy)) return
  const running = desktopPid(legacy)
  if (running !== undefined)
    throw new Error(`HinaCode (pid ${running}) is running on ${legacy}. Quit it, then start again to move its data.`)
  const chromium = chromiumDir(dataDir)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  try {
    move(legacy, chromium)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return
    throw error
  }
  for (const name of readdirSync(chromium)) if (isOwn(name)) move(join(chromium, name), join(dataDir, name))
  rewritePaths(dataDir, legacy)
}

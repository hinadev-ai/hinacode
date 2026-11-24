import { readFile, writeFile } from "node:fs/promises"
import type { Globals } from "./sandbox.ts"

export interface FileGrant {
  readonly path: string
  readonly writable?: boolean
}

export const fileBindings = (grants: Readonly<Record<string, FileGrant>>): Globals => {
  const granted = (name: unknown): FileGrant => {
    if (typeof name !== "string" || !Object.hasOwn(grants, name)) throw new Error(`No file named ${String(name)}.`)
    return grants[name]!
  }
  return {
    list: () => Object.entries(grants).map(([name, { writable = false }]) => ({ name, writable })),
    read: ([name]) => readFile(granted(name).path, "utf8"),
    write: async ([name, content]) => {
      const grant = granted(name)
      if (grant.writable !== true) throw new Error(`${String(name)} is read-only.`)
      if (typeof content !== "string") throw new Error("write takes the file name and its new text.")
      await writeFile(grant.path, content)
      return null
    },
  }
}

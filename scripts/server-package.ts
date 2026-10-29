/**
 * The shape of the published `hinacode` npm package. Everything except the externals below is bundled
 * into `out/server`, so the manifest lists only what the bundle still loads from `node_modules` at runtime.
 */
export const SERVER_EXTERNALS = ["node-pty", "playwright-core"] as const

export const isServerExternal = (id: string): boolean =>
  SERVER_EXTERNALS.some((name) => id === name || id.startsWith(`${name}/`))

export const SERVER_BIN = `#!/usr/bin/env node
await import("../out/server/daemon.js")
`

export interface RootManifest {
  readonly version: string
  readonly description: string
  readonly license: string
  readonly repository: unknown
  readonly engines: unknown
  readonly dependencies: Readonly<Record<string, string>>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringField = (record: Record<string, unknown>, name: string): string => {
  const value = record[name]
  if (typeof value !== "string") throw new Error(`package.json field ${name} must be a string`)
  return value
}

const stringRecord = (value: unknown, name: string): Record<string, string> => {
  if (!isRecord(value)) throw new Error(`package.json field ${name} must be an object`)
  const record: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`package.json field ${name}.${key} must be a string`)
    record[key] = entry
  }
  return record
}

export const parseRootManifest = (value: unknown): RootManifest => {
  if (!isRecord(value)) throw new Error("package.json must be an object")
  return {
    version: stringField(value, "version"),
    description: stringField(value, "description"),
    license: stringField(value, "license"),
    repository: value["repository"],
    engines: value["engines"],
    dependencies: stringRecord(value["dependencies"], "dependencies"),
  }
}

export const serverManifest = (root: RootManifest) => {
  const dependencies: Record<string, string> = {}
  for (const name of SERVER_EXTERNALS) {
    const range = root.dependencies[name]
    if (range === undefined) throw new Error(`server external ${name} is missing from package.json dependencies`)
    dependencies[name] = range
  }
  return {
    name: "hinacode",
    version: root.version,
    description: root.description,
    license: root.license,
    repository: root.repository,
    bin: { hinacode: "bin/hinacode.mjs" },
    files: ["bin", "out/server"],
    type: "module",
    engines: root.engines,
    dependencies,
  }
}

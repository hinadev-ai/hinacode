import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import pluginReact from "@vitejs/plugin-react"
import type { Plugin, TransformResult } from "vite"

const root = import.meta.dirname
const cacheRoot = resolve(root, "node_modules/.cache/react-compiler")
const versionOf = (name: string) =>
  (JSON.parse(readFileSync(resolve(root, "node_modules", name, "package.json"), "utf8")) as { version: string }).version

const options = {
  exclude: [/\/node_modules\//, /\/src\/renderer\/paraglide\//],
  babel: { plugins: ["babel-plugin-react-compiler"] },
}

const toolchain = JSON.stringify({
  options: { exclude: options.exclude.map(String), plugins: options.babel.plugins },
  versions: ["@vitejs/plugin-react", "@babel/core", "babel-plugin-react-compiler"].map(versionOf),
})

type Handler = (
  this: unknown,
  code: string,
  id: string,
  extra?: { ssr?: boolean },
) => Promise<TransformResult | undefined>

const cachedBabel = (plugin: Plugin): Plugin => {
  const transform = plugin.transform as { filter: unknown; handler: Handler }
  const used = new Set<string>()
  let building = false
  let cacheDir = cacheRoot
  return {
    ...plugin,
    configResolved(config) {
      building = config.command === "build"
      cacheDir = join(cacheRoot, relative(root, config.root) || "root")
      return (plugin.configResolved as ((this: unknown, c: typeof config) => void) | undefined)?.call(this, config)
    },
    transform: {
      filter: transform.filter,
      async handler(code, id, extra) {
        if (!building) return transform.handler.call(this, code, id, extra)
        const key = createHash("sha256")
          .update(toolchain)
          .update(relative(root, id))
          .update(extra?.ssr ? "ssr" : "client")
          .update(process.env["NODE_ENV"] ?? "")
          .update(code)
          .digest("hex")
        const file = join(cacheDir, `${key}.json`)
        used.add(`${key}.json`)
        try {
          return (JSON.parse(readFileSync(file, "utf8")) as TransformResult | null) ?? undefined
        } catch {}
        const result = await transform.handler.call(this, code, id, extra)
        mkdirSync(cacheDir, { recursive: true })
        writeFileSync(file, JSON.stringify(result ?? null))
        return result
      },
    } as Plugin["transform"],
    buildEnd() {
      if (!building || used.size === 0) return
      for (const name of readdirSync(cacheDir)) if (!used.has(name)) rmSync(join(cacheDir, name), { force: true })
    },
  }
}

export const react = () =>
  pluginReact(options).map((plugin) => (plugin.name === "vite:react-babel" ? cachedBabel(plugin) : plugin))

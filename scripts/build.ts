import { spawn } from "node:child_process"
import { compile } from "@inlang/paraglide-js"
import { resolveConfig } from "electron-vite"
import { build } from "vite"
import { paraglideOptions } from "../vite.paraglide.ts"

const groups = { node: ["main", "preload"], renderer: ["renderer"] } as const
type Group = keyof typeof groups

const buildGroup = async (group: Group) => {
  process.env["NODE_ENV_ELECTRON_VITE"] = "production"
  const { config } = await resolveConfig({}, "build", "production")
  if (!config) throw new Error("electron.vite.config.ts has no build config")
  for (const target of groups[group]) {
    const viteConfig = config[target]
    if (viteConfig) await build(viteConfig)
  }
}

const runGroup = (group: Group) =>
  new Promise<void>((done, fail) => {
    const child = spawn(process.execPath, [import.meta.filename, group], {
      stdio: "inherit",
      env: { ...process.env, HINACODE_PARAGLIDE_COMPILED: "1" },
    })
    child.on("error", fail)
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`${group} build exited with ${code}`))))
  })

const group = process.argv[2]
if (group === "node" || group === "renderer") {
  await buildGroup(group)
} else {
  await compile(paraglideOptions)
  await Promise.all([runGroup("node"), runGroup("renderer")])
}

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

interface LiquidGlass {
  addView(handle: Buffer): number
}

export const liquidGlass: LiquidGlass | undefined = (() => {
  if (process.platform !== "darwin") return undefined
  try {
    // FIXME: `require` keeps the optional darwin-only package out of TypeScript resolution
    return require("electron-liquid-glass") as LiquidGlass
  } catch {
    return undefined
  }
})()

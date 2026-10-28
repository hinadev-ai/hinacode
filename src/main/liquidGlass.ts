import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

interface LiquidGlass {
  addView(handle: Buffer): number
}

/**
 * macOS glass behind the window, which the title bar and sidebar let through.
 * `electron-liquid-glass` is an optional dependency that only installs on macOS, so elsewhere this is undefined.
 */
export const liquidGlass: LiquidGlass | undefined = (() => {
  if (process.platform !== "darwin") return undefined
  try {
    // Keep the optional, darwin-only package out of TypeScript resolution on Linux and Windows.
    return require("electron-liquid-glass") as LiquidGlass
  } catch {
    return undefined
  }
})()

import { createRequire } from "node:module"
import { resolve } from "node:path"
import { paraglideVitePlugin } from "@inlang/paraglide-js"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"

// Electron 44 no longer downloads its binary on install. It downloads on the first `require("electron")`, which
// electron-vite 5 never calls, so `pnpm dev` failed with "Electron uninstall". See docs/operations/electron-binary.md.
process.env.ELECTRON_EXEC_PATH ??= createRequire(import.meta.url)("electron")

// Main builds first and labels native menus with the same catalogs, so it compiles them too.
const paraglide = () =>
  paraglideVitePlugin({
    project: resolve(import.meta.dirname, "project.inlang"),
    outdir: resolve(import.meta.dirname, "src/renderer/paraglide"),
    strategy: ["globalVariable", "baseLocale"],
  })

export default defineConfig({
  main: {
    plugins: [paraglide()],
    build: {
      // `daemon` is `hinacode serve`, the same services as plain Node with no Electron (see `bin/hinacode.mjs`).
      rollupOptions: { input: { index: "src/main/index.ts", daemon: "src/main/daemon.ts" } },
      // Optional dependencies are bundled by default, which breaks these native modules' binding lookup.
      externalizeDeps: {
        include: ["node-mac-permissions", "electron-liquid-glass"],
        exclude: ["effect", "@effect/platform-node", "@effect/sql-sqlite-node"],
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preload scripts cannot be ES modules.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer") } },
    plugins: [react({ babel: { plugins: ["babel-plugin-react-compiler"] } }), tailwindcss(), paraglide()],
  },
})

import { createRequire } from "node:module"
import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"
import { lazyLocales, paraglide } from "./vite.paraglide.ts"

// FIXME: Electron 44 downloads its binary on the first require("electron"), which electron-vite 5 never calls
process.env.ELECTRON_EXEC_PATH ??= createRequire(import.meta.url)("electron")

export default defineConfig({
  main: {
    plugins: [paraglide()],
    build: {
      rollupOptions: { input: { index: "src/main/index.ts" } },
      // FIXME: electron-vite bundles optional dependencies, which breaks these native modules' binding lookup
      externalizeDeps: {
        include: ["node-mac-permissions", "electron-liquid-glass"],
        exclude: ["effect", "@effect/platform-node", "@effect/sql-sqlite-node"],
      },
    },
  },
  preload: {
    build: {
      // FIXME: Electron's sandboxed preload scripts cannot be ES modules
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer") } },
    build: { minify: true },
    esbuild: process.env.HINACODE_KEEP_NAMES ? { keepNames: true } : undefined,
    plugins: [
      react({
        exclude: [/\/node_modules\//, /\/src\/renderer\/paraglide\//],
        babel: { plugins: ["babel-plugin-react-compiler"] },
      }),
      tailwindcss(),
      paraglide(),
      lazyLocales(),
    ],
  },
})

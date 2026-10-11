import { resolve } from "node:path"
import { paraglideVitePlugin } from "@inlang/paraglide-js"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"

export default defineConfig({
  main: {},
  preload: {
    build: {
      // Sandboxed preload scripts cannot be ES modules.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer") } },
    plugins: [
      react(),
      tailwindcss(),
      paraglideVitePlugin({
        project: resolve(import.meta.dirname, "project.inlang"),
        outdir: resolve(import.meta.dirname, "src/renderer/paraglide"),
        strategy: ["globalVariable", "baseLocale"],
      }),
    ],
  },
})

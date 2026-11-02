import { resolve } from "node:path"
import { paraglideVitePlugin } from "@inlang/paraglide-js"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  root: resolve(import.meta.dirname, "site/app"),
  base: "/app/",
  resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer") } },
  plugins: [
    react({
      exclude: [/\/node_modules\//, /\/src\/renderer\/paraglide\//],
      babel: { plugins: ["babel-plugin-react-compiler"] },
    }),
    tailwindcss(),
    paraglideVitePlugin({
      project: resolve(import.meta.dirname, "project.inlang"),
      outdir: resolve(import.meta.dirname, "src/renderer/paraglide"),
      strategy: ["globalVariable", "baseLocale"],
    }),
  ],
  build: { outDir: resolve(import.meta.dirname, "site/public/app"), emptyOutDir: true, target: "es2024" },
  worker: { format: "es" },
  server: { port: 4419, strictPort: true },
})

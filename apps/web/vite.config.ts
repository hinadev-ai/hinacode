import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { lazyLocales, paraglide } from "../../vite.paraglide.ts"

const repo = resolve(import.meta.dirname, "../..")

export default defineConfig({
  root: import.meta.dirname,
  envDir: import.meta.dirname,
  resolve: { alias: { "@": resolve(repo, "src/renderer") } },
  plugins: [
    react({
      exclude: [/\/node_modules\//, /\/src\/renderer\/paraglide\//],
      babel: { plugins: ["babel-plugin-react-compiler"] },
    }),
    tailwindcss(),
    paraglide(),
    lazyLocales(),
  ],
  build: { outDir: resolve(import.meta.dirname, "dist"), emptyOutDir: true, target: "es2024" },
  worker: { format: "es" },
  server: { host: true, port: 4420, strictPort: true, fs: { allow: [repo] } },
  preview: { host: true, port: 4420, strictPort: true },
})

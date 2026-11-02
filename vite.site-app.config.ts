import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { excalidraw } from "./vite.excalidraw.ts"
import { paraglide } from "./vite.paraglide.ts"

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
    paraglide(),
    excalidraw(),
  ],
  build: { outDir: resolve(import.meta.dirname, "site/public/app"), emptyOutDir: true, target: "es2024" },
  worker: { format: "es" },
  server: { port: 4419, strictPort: true },
})

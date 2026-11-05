import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { lazyLocales, paraglide } from "../../vite.paraglide.ts"

const repo = resolve(import.meta.dirname, "../..")

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src * data: blob:",
  "frame-src 'self' https:",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ")

const contentSecurityPolicy = (): Plugin => ({
  name: "hinacode-web-csp",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
      injectTo: "head-prepend",
    },
  ],
})

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
    contentSecurityPolicy(),
  ],
  build: { outDir: resolve(import.meta.dirname, "dist"), emptyOutDir: true, target: "es2024" },
  worker: { format: "es" },
  server: { host: true, port: 4420, strictPort: true, fs: { allow: [repo] } },
  preview: { host: true, port: 4420, strictPort: true },
})

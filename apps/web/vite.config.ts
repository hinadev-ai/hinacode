import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, type Plugin } from "vite"
import { withoutExcalidrawMermaid } from "../../vite.excalidraw.ts"
import { lazyLocales, paraglide } from "../../vite.paraglide.ts"
import { react } from "../../vite.react.ts"

const repo = resolve(import.meta.dirname, "../..")

const CLERK_SCRIPT_SOURCES =
  process.env["CLERK_SCRIPT_SOURCES"] ??
  "https://clerk.hinacode.app https://*.clerk.accounts.dev https://challenges.cloudflare.com"

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval' ${CLERK_SCRIPT_SOURCES}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src * data: blob:",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
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
  plugins: [react(), tailwindcss(), paraglide(), lazyLocales(), withoutExcalidrawMermaid(), contentSecurityPolicy()],
  build: { outDir: resolve(import.meta.dirname, "dist"), emptyOutDir: true, target: "es2024" },
  worker: { format: "es" },
  server: { host: true, port: 4420, strictPort: true, fs: { allow: [repo] } },
  preview: { host: true, port: 4420, strictPort: true },
})

import { createRequire, isBuiltin } from "node:module"
import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "electron-vite"
import { withoutExcalidrawMermaid } from "./vite.excalidraw.ts"
import { lazyLocales, paraglide } from "./vite.paraglide.ts"
import { react } from "./vite.react.ts"

// FIXME: Electron 44 downloads its binary on the first require("electron"), which electron-vite 5 never calls
process.env.ELECTRON_EXEC_PATH ??= createRequire(import.meta.url)("electron")

export default defineConfig({
  main: {
    plugins: [paraglide()],
    esbuild: { minifyIdentifiers: false, minifySyntax: false },
    // FIXME: Vite bundles ws's missing optional bufferutil and utf-8-validate as empty modules, which ws then calls
    define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' },
    build: {
      minify: "esbuild",
      rollupOptions: { input: { index: "src/main/boot.ts", main: "src/main/index.ts" } },
      // FIXME: electron-vite bundles optional dependencies, which breaks these native modules' binding lookup
      externalizeDeps: { include: ["node-mac-permissions", "electron-liquid-glass"] },
      // FIXME: the ES module bundle has no `require`, so protobufjs's try/catch require("fs") silently fails
      commonjsOptions: { ignoreTryCatch: (id: string) => !isBuiltin(id) },
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
    worker: { format: "es" },
    esbuild: process.env.HINACODE_KEEP_NAMES ? { keepNames: true } : undefined,
    plugins: [react(), tailwindcss(), paraglide(), lazyLocales(), withoutExcalidrawMermaid()],
  },
})

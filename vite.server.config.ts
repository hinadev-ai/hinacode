import { defineConfig } from "vite"
import { isServerExternal, SERVER_EXTERNALS } from "./scripts/server-package.ts"

export default defineConfig({
  build: {
    outDir: "out/server",
    emptyOutDir: true,
    target: "node24",
    commonjsOptions: { transformMixedEsModules: true },
    rollupOptions: {
      input: { daemon: "src/main/daemon.ts" },
      external: (id) => isServerExternal(id),
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        // Bundled CommonJS such as protobufjs loads `fs` with a bare `require` in a try/catch, and without one
        // it falls back to its browser path. A module-scope `const require` gets renamed by the build, so the
        // daemon sets a global instead.
        banner:
          'import { createRequire as __createRequire } from "node:module"\nglobalThis.require ??= __createRequire(import.meta.url)',
      },
    },
  },
  // ws loads `bufferutil` and `utf-8-validate` in a try/catch, but Vite replaces a missing optional peer
  // dependency with an empty object instead of throwing, so ws would call methods that don't exist.
  define: {
    "process.env.WS_NO_BUFFER_UTIL": JSON.stringify("1"),
    "process.env.WS_NO_UTF_8_VALIDATE": JSON.stringify("1"),
  },
  ssr: { noExternal: true, external: [...SERVER_EXTERNALS] },
})

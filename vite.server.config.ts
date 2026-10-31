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
        // FIXME: bundled CommonJS like protobufjs needs a global `require`, a module-scope one gets renamed
        banner:
          'import { createRequire as __createRequire } from "node:module"\nglobalThis.require ??= __createRequire(import.meta.url)',
      },
    },
  },
  // FIXME: Vite stubs ws optional peers with an empty object instead of throwing
  define: {
    "process.env.WS_NO_BUFFER_UTIL": JSON.stringify("1"),
    "process.env.WS_NO_UTF_8_VALIDATE": JSON.stringify("1"),
  },
  ssr: { noExternal: true, external: [...SERVER_EXTERNALS] },
})

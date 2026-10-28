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
      output: { format: "es", entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
  ssr: { noExternal: true, external: [...SERVER_EXTERNALS] },
})

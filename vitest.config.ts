import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { playwright } from "@vitest/browser-playwright"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"
import { excalidrawFonts } from "./vite.excalidraw.ts"
import { lazyLocales, paraglide } from "./vite.paraglide.ts"

export default defineConfig({
  test: {
    globalSetup: "./vitest.global-setup.ts",
    projects: [
      {
        resolve: { alias: { "@": fileURLToPath(new URL("./src/renderer", import.meta.url)) } },
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts", "apps/web/src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
        },
      },
      {
        // FIXME: a string skips Vite's Expo tsconfig lookup, and CI installs only the root workspace
        esbuild: { tsconfigRaw: "{}" },
        resolve: {
          alias: {
            "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
            "@": fileURLToPath(new URL("./apps/mobile/src", import.meta.url)),
          },
          // FIXME: two copies of effect cannot decode each other's schemas
          dedupe: ["effect"],
        },
        test: {
          name: "mobile",
          include: ["apps/mobile/src/{lib,stores}/*.test.ts"],
        },
      },
      {
        resolve: { alias: { "@": fileURLToPath(new URL("./src/renderer", import.meta.url)) } },
        plugins: [react(), tailwindcss(), paraglide(), lazyLocales(), excalidrawFonts()],
        // FIXME: Vite finds lazily imported dependencies only when a test loads them, then re-optimizes and reloads mid-run
        optimizeDeps: { include: ["pele/lazy", "shiki/core", "shiki/engine/javascript", "@excalidraw/excalidraw"] },
        test: {
          name: "component",
          include: ["src/renderer/**/*.component.test.tsx"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
      {
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
})

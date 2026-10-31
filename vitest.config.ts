import { fileURLToPath } from "node:url"
import { paraglideVitePlugin } from "@inlang/paraglide-js"
import tailwindcss from "@tailwindcss/vite"
import { playwright } from "@vitest/browser-playwright"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { "@": fileURLToPath(new URL("./src/renderer", import.meta.url)) } },
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
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
        plugins: [
          react(),
          tailwindcss(),
          paraglideVitePlugin({
            project: "./project.inlang",
            outdir: "./src/renderer/paraglide",
            strategy: ["globalVariable", "baseLocale"],
          }),
        ],
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

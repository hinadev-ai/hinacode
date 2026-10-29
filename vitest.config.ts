import { fileURLToPath } from "node:url"
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

import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * `unit` runs in-process with no I/O beyond memory. `integration` drives real SQLite files, git,
 * child processes and HTTP, so it gets longer timeouts and runs after unit in CI.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { "@": fileURLToPath(new URL("./src/renderer", import.meta.url)) } },
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
        },
      },
      {
        // Only the phone's React Native-free logic, e.g. its transport against a fake WebSocket.
        // `dedupe` keeps one copy of effect, since schemas built by one copy fail to decode in the other.
        resolve: {
          alias: { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) },
          dedupe: ["effect"],
        },
        test: {
          name: "mobile",
          include: ["apps/mobile/src/lib/*.test.ts"],
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

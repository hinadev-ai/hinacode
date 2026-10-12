import { defineConfig } from "@playwright/test"
import { defineBddConfig } from "playwright-bdd"

const testDir = defineBddConfig({
  features: "features/*.feature",
  steps: ["steps/*.ts", "support/fixtures.ts"],
  outputDir: ".features-gen",
})

/**
 * Every worker runs its own kkcode instance on its own user-data directory, so scenarios in
 * different workers never see each other's projects, threads or settings.
 */
export default defineConfig({
  testDir,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: "test-results",
  globalSetup: "./global-setup.ts",
})

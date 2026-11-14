import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: "test-results",
  globalSetup: "./global-setup.ts",
  use: { browserName: "chromium", trace: "retain-on-failure" },
})

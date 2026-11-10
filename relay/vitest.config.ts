import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          CLOUDFLARE_API_TOKEN: "test-api-token",
          CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsudGVzdCQ",
          CLERK_SECRET_KEY: "sk_test_fake",
          CLOUDFLARE_ACCOUNT_ID: "account",
          TUNNEL_ZONE_ID: "zone",
          TUNNEL_ZONE_NAME: "tunnels.test",
          WEB_ORIGINS: "https://code.test,http://localhost:4420",
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
})

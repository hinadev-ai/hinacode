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
          CLERK_SECRET_KEY: "sk_test_unused",
          CLOUDFLARE_ACCOUNT_ID: "account",
          TUNNEL_ZONE_ID: "zone",
          TUNNEL_ZONE_NAME: "tunnels.test",
          CLERK_PUBLISHABLE_KEY: "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
})

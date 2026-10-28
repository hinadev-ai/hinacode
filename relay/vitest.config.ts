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
          OWNER_TOKEN: "test-owner-token",
          CLOUDFLARE_ACCOUNT_ID: "account",
          TUNNEL_ZONE_ID: "zone",
          TUNNEL_ZONE_NAME: "tunnels.test",
          APPLE_APP_ID: "TEAMID1234.com.hinadev.hinacode",
          ANDROID_PACKAGE: "com.hinadev.hinacode",
          ANDROID_CERT_SHA256: "AA:BB:CC, DD:EE:FF,",
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
})

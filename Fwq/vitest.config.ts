import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          AI_CONFIG_SECRET: "test-only-ai-config-secret-with-32-bytes"
        }
      }
    }))
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"]
  }
});

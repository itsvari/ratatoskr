import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        SHORT_ORIGIN: "http://localhost:5173", ADMIN_ORIGIN: "http://localhost:5173",
        PREVIEW_ORIGIN: "http://127.0.0.1:5173", ACCESS_ISSUER: "https://test.cloudflareaccess.com",
        ACCESS_AUDIENCE: "test-audience", ADMIN_EMAILS: "developer@localhost", LOCAL_DEVELOPMENT: "true",
      },
    },
  }))],
  test: { fsModuleCache: false, setupFiles: ["./tests/setup.ts"], include: ["tests/**/*.test.ts"] },
});

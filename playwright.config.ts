import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests-browser",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5174", launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
  webServer: { command: "node tests-browser/server.mjs", url: "http://127.0.0.1:5174/admin", reuseExistingServer: false, timeout: 120_000 },
});

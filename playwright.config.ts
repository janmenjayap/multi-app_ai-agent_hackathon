import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: ".local/playwright-results",
  use: { baseURL: "http://127.0.0.1:4173", viewport: { width: 1440, height: 900 }, browserName: "chromium", trace: "retain-on-failure" },
  webServer: {
    command: "node dist/server/index.js",
    url: "http://127.0.0.1:4173/api/health",
    reuseExistingServer: false,
    timeout: 20000,
    env: { PG_HOST: "127.0.0.1", PG_PORT: "4173", PG_MODEL_MODE: "mock", PG_ADAPTER_MODE: "fake", PG_FIXTURE_ID: "bootstrap-synthetic-v1" },
  },
});

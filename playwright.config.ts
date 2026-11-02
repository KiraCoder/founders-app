import { defineConfig, devices } from "@playwright/test";

/**
 * E2E smoke tests. By default Playwright builds and starts the app on port 3100
 * (production mode, local PGlite DB). Set E2E_BASE_URL to test an already running app.
 * Run `npm run db:migrate && npm run db:seed` first.
 */
const PORT = 3100;
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    // Use a preinstalled Chromium when PLAYWRIGHT_CHROMIUM_PATH is set (CI images without `playwright install`).
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npm run build && npx next start -p ${PORT}`,
        url: `${baseURL}/login`,
        reuseExistingServer: true,
        timeout: 240_000,
        env: {
          SESSION_SECRET: process.env.SESSION_SECRET ?? "e2e-local-secret-0123456789abcdef0123456789",
        },
      },
});

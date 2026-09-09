import { defineConfig, devices } from "@playwright/test";

const isCI = !!process.env["CI"];
const chromiumPath = process.env["CHROMIUM_PATH"];
const launchOptions = chromiumPath
  ? { launchOptions: { executablePath: chromiumPath } }
  : {};

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30000,
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? "100%" : undefined,
  use: {
    baseURL: "http://localhost:8000",
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...launchOptions,
      },
    },
    {
      name: "mobile-chromium",
      testMatch: /(core|layers|state)\.spec\.ts$/,
      use: {
        ...devices["Pixel 7"],
        ...launchOptions,
      },
    },
  ],
  webServer: {
    command: "python3 -m http.server 8000 -d docs",
    port: 8000,
    reuseExistingServer: !isCI,
  },
});

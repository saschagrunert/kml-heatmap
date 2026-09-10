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
  ...(isCI ? { workers: "100%" } : {}),
  use: {
    baseURL: "http://localhost:8000",
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      // The bar and sheet only exist below the breakpoint
      testIgnore: /mobile\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        ...launchOptions,
      },
    },
    {
      name: "mobile",
      // mobile.spec.ts drives the bottom bar and sheet; the other three are
      // viewport-agnostic and run against whichever controls the bar puts up
      testMatch: /(core|layers|mobile|state)\.spec\.ts$/,
      // The bar and sheet are built at runtime and every interaction here
      // goes through them, so a retry would hide exactly the intermittent
      // failures this project exists to catch
      retries: 0,
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

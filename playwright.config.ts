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
  // The console reporter Playwright would pick anyway, plus the HTML report
  // that CI uploads with the traces when a run fails
  reporter: [[isCI ? "dot" : "list"], ["html", { open: "never" }]],
  // Fails fast when docs/ is stale; see the file for why
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:8000",
    headless: true,
    // The page honours prefers-reduced-motion, so the entry animations and
    // slide transitions are skipped and a scan never catches a half-faded
    // panel. Specs that measure animations settle them explicitly as well.
    reducedMotion: "reduce",
    // Kept for every failed attempt: the mobile project does not retry, so
    // "on-first-retry" never recorded a trace there
    trace: "retain-on-failure",
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
    {
      name: "webkit",
      // The page targets iOS and leans on :has(), @starting-style and dvh,
      // so the phone interface also runs in Safari's engine. Install it with
      // `npx playwright install webkit`.
      testMatch: /(core|mobile)\.spec\.ts$/,
      // Like the mobile project: a retry would hide the flaky bar and sheet
      retries: 0,
      use: {
        ...devices["iPhone 15"],
      },
    },
  ],
  webServer: {
    command: "python3 -m http.server 8000 -d docs",
    port: 8000,
    reuseExistingServer: !isCI,
    // http.server logs every request to stderr
    stderr: "ignore",
  },
});

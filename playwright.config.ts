import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: "http://localhost:8000",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(process.env.CHROMIUM_PATH && {
          launchOptions: { executablePath: process.env.CHROMIUM_PATH },
        }),
      },
    },
  ],
  webServer: {
    command: "python3 -m http.server 8000 -d docs",
    port: 8000,
    reuseExistingServer: !process.env.CI,
  },
});

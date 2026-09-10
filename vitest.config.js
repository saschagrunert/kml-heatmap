import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: [
      "tests/frontend/unit/**/*.test.ts",
      "tests/frontend/contract/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["kml_heatmap/frontend/**/*.{js,ts}"],
      exclude: ["**/node_modules/**", "**/tests/**"],
      clean: true,
      // Just under what the suite reaches today, so a real regression fails
      // the build instead of quietly eating a wide margin
      thresholds: {
        lines: 98,
        branches: 89,
        functions: 97,
        statements: 97,
      },
    },
    alias: {
      leaflet: fileURLToPath(
        new URL("./tests/mocks/leaflet.ts", import.meta.url),
      ),
    },
  },
});

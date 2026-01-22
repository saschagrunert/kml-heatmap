import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/frontend/unit/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["kml_heatmap/frontend/**/*.{js,ts}"],
      exclude: ["**/node_modules/**", "**/tests/**"],
      clean: false,
    },
    alias: {
      leaflet: fileURLToPath(
        new URL("./tests/mocks/leaflet.ts", import.meta.url)
      ),
    },
  },
});

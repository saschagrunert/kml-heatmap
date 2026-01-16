import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["kml_heatmap/frontend/**/*.{js,ts}"],
      exclude: ["**/node_modules/**", "**/tests/**"],
      clean: false,
    },
  },
});

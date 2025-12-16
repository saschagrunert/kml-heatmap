import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/main.ts"),
      name: "KMLHeatmap",
      fileName: () => "map.js",
      formats: ["iife"],
    },
    rollupOptions: {
      external: ["leaflet", "leaflet.heat"],
      output: {
        globals: {
          leaflet: "L",
        },
        assetFileNames: "[name][extname]",
        entryFileNames: "map.js",
      },
    },
    outDir: "../static",
    emptyOutDir: false,
  },
  test: {
    globals: true,
    environment: "jsdom",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["**/*.test.ts", "**/types/**", "dist/**"],
    },
  },
});

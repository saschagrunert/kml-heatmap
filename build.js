#!/usr/bin/env node

/**
 * Build script for KML Heatmap JavaScript modules
 * Uses esbuild to bundle ES6 modules into a single file
 */

import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isWatch = process.argv.includes("--watch");

// Build KMLHeatmap library (bundle.js) - IIFE format for global window.KMLHeatmap
const libraryBuildOptions = {
  entryPoints: [join(__dirname, "kml_heatmap/frontend/main.ts")],
  bundle: true,
  format: "iife",
  globalName: "KMLHeatmapModules",
  outfile: join(__dirname, "kml_heatmap/static/bundle.js"),
  sourcemap: true,
  target: ["es2020"],
  platform: "browser",
  logLevel: "info",
  minify: false, // Set to true for production
};

// Plugin to replace Leaflet import with global L variable
const leafletGlobalPlugin = {
  name: "leaflet-global",
  setup(build) {
    build.onResolve({ filter: /^leaflet$/ }, (args) => ({
      path: args.path,
      namespace: "leaflet-global",
    }));
    build.onLoad({ filter: /.*/, namespace: "leaflet-global" }, () => ({
      contents: "module.exports = window.L;",
      loader: "js",
    }));
  },
};

// Build MapApp (mapApp.js) - IIFE format to work with file:// protocol
const appBuildOptions = {
  entryPoints: [join(__dirname, "kml_heatmap/frontend/mapApp.ts")],
  bundle: true,
  format: "iife",
  globalName: "MapAppModule",
  outfile: join(__dirname, "kml_heatmap/static/mapApp.bundle.js"),
  sourcemap: true,
  target: ["es2020"],
  platform: "browser",
  logLevel: "info",
  minify: false,
  plugins: [leafletGlobalPlugin],
};

async function build() {
  try {
    if (isWatch) {
      console.log("👀 Watching for changes...");
      const libraryCtx = await esbuild.context(libraryBuildOptions);
      const appCtx = await esbuild.context(appBuildOptions);
      await Promise.all([libraryCtx.watch(), appCtx.watch()]);
    } else {
      console.log("🔨 Building JavaScript bundles...");
      await Promise.all([
        esbuild.build(libraryBuildOptions),
        esbuild.build(appBuildOptions),
      ]);
      console.log("✅ Build complete!");
    }
  } catch (error) {
    console.error("❌ Build failed:", error);
    process.exit(1);
  }
}

build();

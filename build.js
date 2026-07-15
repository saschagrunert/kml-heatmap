#!/usr/bin/env node

/**
 * Build script for KML Heatmap JavaScript modules
 * Uses esbuild to bundle ES6 modules into IIFE format for file:// protocol compatibility
 */

import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { statSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isWatch = process.argv.includes("--watch");
const isDevelopment = process.env.NODE_ENV === "development" || isWatch;
const minify = !isDevelopment;

// Shared build options for IIFE format bundles (file:// protocol compatible)
const sharedBuildOptions = {
  bundle: true,
  format: "iife",
  sourcemap: isDevelopment,
  target: ["es2020"],
  platform: "browser",
  logLevel: "info",
  minify,
  metafile: true,

  // Advanced minification options
  minifyWhitespace: !isDevelopment,
  minifyIdentifiers: !isDevelopment,
  minifySyntax: !isDevelopment,

  // Tree shaking
  treeShaking: true,

  // Don't drop console statements - they are guarded by debug flags in code
  drop: isDevelopment ? [] : ["debugger"],

  // Enable mangling for smaller identifiers
  mangleProps: isDevelopment ? undefined : /^_/,
};

// Build KMLHeatmap library
const libraryBuildOptions = {
  ...sharedBuildOptions,
  entryPoints: [join(__dirname, "kml_heatmap/frontend/main.ts")],
  globalName: "KMLHeatmapModules",
  outfile: join(__dirname, "kml_heatmap/static/bundle.js"),
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

// Build MapApp
const appBuildOptions = {
  ...sharedBuildOptions,
  entryPoints: [join(__dirname, "kml_heatmap/frontend/mapApp.ts")],
  globalName: "MapAppModule",
  outfile: join(__dirname, "kml_heatmap/static/mapApp.bundle.js"),
  plugins: [leafletGlobalPlugin],
};

/**
 * Format bytes to human-readable size
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Analyze bundle composition from metafile
 */
function analyzeBundleComposition(metafile, bundleName) {
  console.log(`\n📊 ${bundleName} Composition:`);

  const outputs = Object.values(metafile.outputs)[0];
  if (!outputs || !outputs.inputs) {
    console.log("  No composition data available");
    return;
  }

  // Group imports by type
  const composition = {};
  const totalBytes = outputs.bytes;

  for (const [file, data] of Object.entries(outputs.inputs)) {
    const bytes = data.bytesInOutput || 0;

    // Categorize files
    let category;
    if (file.includes("node_modules")) {
      const match = file.match(/node_modules\/([^/]+)/);
      category = match ? `📦 ${match[1]}` : "📦 dependencies";
    } else if (file.includes("frontend/calculations")) {
      category = "🧮 calculations";
    } else if (file.includes("frontend/features")) {
      category = "✨ features";
    } else if (file.includes("frontend/ui")) {
      category = "🎨 ui";
    } else if (file.includes("frontend/utils")) {
      category = "🔧 utils";
    } else if (file.includes("frontend/services")) {
      category = "⚙️  services";
    } else if (file.includes("frontend/state")) {
      category = "💾 state";
    } else {
      category = "📄 other";
    }

    composition[category] = (composition[category] || 0) + bytes;
  }

  // Sort by size descending
  const sorted = Object.entries(composition)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10); // Top 10

  console.log("  Top contributors:");
  for (const [category, bytes] of sorted) {
    const percentage = ((bytes / totalBytes) * 100).toFixed(1);
    console.log(
      `    ${category.padEnd(25)} ${formatBytes(bytes).padStart(10)}  (${percentage}%)`
    );
  }
}

// Bundle size budgets in bytes
const BUDGET_LIBRARY = 50 * 1024;
const BUDGET_APP = 100 * 1024;
const BUDGET_TOTAL = 150 * 1024;

/**
 * Print bundle size analysis and enforce budgets in CI
 * Returns true if all budgets pass, false if any are exceeded
 */
function analyzeBundleSizes() {
  console.log("\n📦 Bundle Size Analysis:");
  console.log("─".repeat(60));

  const bundlePath = join(__dirname, "kml_heatmap/static/bundle.js");
  const appBundlePath = join(__dirname, "kml_heatmap/static/mapApp.bundle.js");

  try {
    const bundleSize = statSync(bundlePath).size;
    const appBundleSize = statSync(appBundlePath).size;
    const totalSize = bundleSize + appBundleSize;

    console.log(
      `  📚 KMLHeatmap Library:  ${formatBytes(bundleSize).padStart(10)}`
    );
    console.log(
      `  🗺️  MapApp Bundle:      ${formatBytes(appBundleSize).padStart(10)}`
    );
    console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(
      `  📊 Total:              ${formatBytes(totalSize).padStart(10)}`
    );

    let budgetExceeded = false;

    if (bundleSize > BUDGET_LIBRARY) {
      console.log(
        `  ⚠️  Library bundle exceeds budget (${formatBytes(bundleSize)} > ${formatBytes(BUDGET_LIBRARY)})`
      );
      budgetExceeded = true;
    }
    if (appBundleSize > BUDGET_APP) {
      console.log(
        `  ⚠️  MapApp bundle exceeds budget (${formatBytes(appBundleSize)} > ${formatBytes(BUDGET_APP)})`
      );
      budgetExceeded = true;
    }
    if (totalSize > BUDGET_TOTAL) {
      console.log(
        `  ⚠️  Total bundle size exceeds budget (${formatBytes(totalSize)} > ${formatBytes(BUDGET_TOTAL)})`
      );
      budgetExceeded = true;
    }

    console.log("─".repeat(60));
    return !budgetExceeded;
  } catch (error) {
    console.error("  ❌ Could not analyze bundle sizes:", error.message);
    console.log("─".repeat(60));
    return true; // Don't fail on missing files
  }
}

async function build() {
  try {
    const mode = isDevelopment ? "development" : "production";
    console.log(`📦 Build mode: ${mode} (minify: ${minify})`);

    if (isWatch) {
      console.log("👀 Watching for changes...");
      const libraryCtx = await esbuild.context(libraryBuildOptions);
      const appCtx = await esbuild.context(appBuildOptions);
      await Promise.all([libraryCtx.watch(), appCtx.watch()]);
    } else {
      console.log("🔨 Building JavaScript bundles...");
      const [libraryResult, appResult] = await Promise.all([
        esbuild.build(libraryBuildOptions),
        esbuild.build(appBuildOptions),
      ]);

      console.log("✅ Build complete!");

      // Analyze bundle sizes and composition
      const withinBudget = analyzeBundleSizes();

      if (libraryResult.metafile) {
        analyzeBundleComposition(libraryResult.metafile, "KMLHeatmap Library");
      }

      if (appResult.metafile) {
        analyzeBundleComposition(appResult.metafile, "MapApp Bundle");
      }

      // Fail build in CI when bundle size budget is exceeded
      if (!withinBudget && process.env.CI) {
        console.error("\n❌ Bundle size budget exceeded!");
        process.exit(1);
      }
    }
  } catch (error) {
    console.error("❌ Build failed:", error);
    process.exit(1);
  }
}

build();

#!/usr/bin/env node

/**
 * Build script for KML Heatmap JavaScript modules
 * Uses esbuild to bundle the TypeScript sources into ES modules
 */

import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { statSync } from "fs";
import {
  buildBanner as makeBanner,
  computeSourceHash,
} from "./scripts/source-hash.js";
import { copyCountryFlags, copyVendorAssets } from "./scripts/vendor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isWatch = process.argv.includes("--watch");
const isDevelopment = process.env.NODE_ENV === "development" || isWatch;
const minify = !isDevelopment;

const sourceHash = computeSourceHash();
const buildBanner = makeBanner(sourceHash);

/**
 * Leave MapLibre out of the bundles and import the vendored module instead.
 *
 * It is three quarters of a megabyte that changes only when the dependency
 * is bumped, so it stays a file of its own that the browser caches apart
 * from the app. It also has to: MapLibre finds its worker relative to its
 * own URL (see scripts/vendor.js), which a copy inside the bundle would not
 * have. The bundles sit next to vendor/, so the path is the same for all.
 * @type {import("esbuild").Plugin}
 */
const maplibreVendorPlugin = {
  name: "maplibre-vendor",
  setup(build) {
    build.onResolve({ filter: /^maplibre-gl$/ }, () => ({
      path: "./vendor/maplibre-gl.mjs",
      external: true,
    }));
  },
};

const STATIC_DIR = join(__dirname, "kml_heatmap/static");
const FRONTEND_DIR = join(__dirname, "kml_heatmap/frontend");

// The page loads mapApp.bundle.js as a module. Replay and Wrapped are a
// quarter of the frontend and most visits open neither, so features.ts is an
// entry point of its own that the app imports the first time one of them is
// used (services/featureLoader.ts). With splitting, what the two entry points
// both use is moved into one chunk that each of them imports, so there is a
// single instance of every module that holds state (the DOM cache, the toast
// live region). Two entry points can only ever share one chunk, which is why
// it can carry a fixed name instead of a hash; assertExpectedOutputs() fails
// the build if that stops being true.
/** @type {import("esbuild").BuildOptions} */
const buildOptions = {
  entryPoints: [
    join(FRONTEND_DIR, "mapApp.ts"),
    join(FRONTEND_DIR, "features.ts"),
  ],
  outdir: STATIC_DIR,
  entryNames: "[name].bundle",
  chunkNames: "shared.bundle",
  bundle: true,
  format: "esm",
  splitting: true,
  // Always emit a .map file next to the bundle (linked via sourceMappingURL).
  // It carries the mappings and file names only: the TypeScript sources
  // stay out of the site, the container and the wheel alike.
  sourcemap: "linked",
  sourcesContent: false,
  target: ["es2022"],
  platform: "browser",
  logLevel: "info",
  minify,
  metafile: true,
  banner: { js: buildBanner },

  // Tree shaking
  treeShaking: true,

  // Don't drop console statements - they are guarded by debug flags in code
  drop: isDevelopment ? [] : ["debugger"],
  plugins: [maplibreVendorPlugin],
};

/**
 * Format bytes to human-readable size
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Analyze the composition of one output file from the metafile
 * @param {import("esbuild").Metafile} metafile
 * @param {string} fileName
 */
function analyzeBundleComposition(metafile, fileName) {
  console.log(`\n📊 ${fileName} Composition:`);

  const outputs = Object.entries(metafile.outputs).find(([path]) =>
    path.endsWith(`/${fileName}`),
  )?.[1];
  if (!outputs || !outputs.inputs) {
    console.log("  No composition data available");
    return;
  }

  // Group imports by type
  /** @type {Record<string, number>} */
  const composition = {};
  const totalBytes = outputs.bytes;

  for (const [file, data] of Object.entries(outputs.inputs)) {
    const bytes = data.bytesInOutput || 0;

    // Categorize files
    let category;
    if (file.includes("frontend/calculations")) {
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
      `    ${category.padEnd(25)} ${formatBytes(bytes).padStart(10)}  (${percentage}%)`,
    );
  }
}

// Size budgets of the minified bundles in bytes. Every production build
// checks them, so every CI job that builds the bundles enforces them. Raise
// one on purpose when a change needs the room, not to make a build pass.
// The stylesheet has a budget of its own, in tests/test_asset_budget.py: it is
// minified by the Python side, not here.
// What a first visit downloads: the app and the chunk it shares with the
// features, which the page loads together.
// Raised from 90 KB for the visual review of 2026-09-18: the selection chip,
// the scroll-fade watcher, and the icon set moving to Lucide, whose shapes
// carry more detail than the hand drawn paths they replaced (33 of them for
// about 4 KB more). The split of #250 had left it at 86 KB.
// Raised from 96 KB for MapLibre. Leaflet drew polylines, tooltips and a
// heatmap by itself; on a WebGL map the app builds the GeoJSON of the path
// runs, keeps the tables that map a rendered feature back to its segment,
// does its own hit testing for hover and click, owns the popups (there is
// no auto pan and no bound popup) and captures the canvas for the export.
// That is about 10 KB of code Leaflet used to carry in its 148 KB.
// Raised from 106 KB for two changes that each fitted on their own and not
// together, which no check saw because a pull request is only built against
// the main branch of its day: the download progress of the year files
// (105.8 KB) and the fixes from the review of the MapLibre port (about 2 KB:
// the fallback when the base style never answers, the guards that keep
// marker and Wrapped interactions away from the map). 107.9 KB with both.
// The room on top is small on purpose. Decoding the year files in a worker
// will take that code out of this bundle again.
// Raised from 110 KB for the map that turns, tilts and becomes a globe: 3.3 KB
// on top of the 108.2 KB main had, which is 111.6 KB. 1.6 KB of it is the
// compass and the globe switch (the app's own buttons rather than MapLibre's
// controls, see ui/mapOrientation.ts). The rest is the bearing, the pitch and
// the projection in the link and the saved state, the row in the mobile
// sheet, one more icon, and what a globe needs that MapLibre does not do:
// telling what is behind it, closing the popups there, and a pan that brings
// a popup into view on a map where a pixel is not the same way everywhere.
// None of it can load later: a link may open turned and as a globe, and the
// controls are on the first paint.
const BUDGET_APP = 112 * 1024;
// The feature bundle is fetched only when replay or Wrapped is opened, so it
// is not part of what a first visit downloads; it still gets a budget so it
// cannot grow without anyone noticing.
const BUDGET_FEATURES = 40 * 1024;

const APP_BUNDLE = "mapApp.bundle.js";
const FEATURES_BUNDLE = "features.bundle.js";
const SHARED_BUNDLE = "shared.bundle.js";

/**
 * Print bundle size analysis and check it against the budget
 * Returns true if the budget passes, false if it is exceeded
 */
function analyzeBundleSizes() {
  console.log("\n📦 Bundle Size Analysis:");
  console.log("─".repeat(60));

  /** @type {[label: string, names: string[], budget: number][]} */
  const bundles = [
    ["🗺️  First visit", [APP_BUNDLE, SHARED_BUNDLE], BUDGET_APP],
    ["✨ Features", [FEATURES_BUNDLE], BUDGET_FEATURES],
  ];

  let budgetExceeded = false;
  for (const [label, names, budget] of bundles) {
    const described = names.join(" + ");
    try {
      let size = 0;
      for (const name of names) size += statSync(join(STATIC_DIR, name)).size;
      console.log(`  ${label} (${described}):  ${formatBytes(size)}`);
      if (size > budget) {
        console.log(
          `  ⚠️  ${described} exceeds budget (${formatBytes(size)} > ${formatBytes(budget)})`,
        );
        budgetExceeded = true;
      }
    } catch (error) {
      console.error(
        `  ❌ Could not measure ${described}:`,
        error instanceof Error ? error.message : error,
      );
      // A bundle that cannot be measured cannot be within budget either
      budgetExceeded = true;
    }
  }

  console.log("─".repeat(60));
  return !budgetExceeded;
}

/**
 * Fail the build when it wrote anything but the three bundles.
 *
 * The site publishes them by name (SITE_FILES in kml_heatmap/site_assets.py)
 * and the page preloads the shared chunk by name. A third entry point or a
 * second dynamic import would make esbuild write further chunks, all called
 * shared.bundle.js; that has to be a decision about naming, not a surprise.
 * @param {import("esbuild").Metafile | undefined} metafile
 */
function assertExpectedOutputs(metafile) {
  const written = Object.keys(metafile?.outputs ?? {})
    .filter((path) => path.endsWith(".js"))
    .map((path) => path.slice(path.lastIndexOf("/") + 1))
    .sort();
  const expected = [APP_BUNDLE, FEATURES_BUNDLE, SHARED_BUNDLE].sort();
  if (written.join() !== expected.join()) {
    throw new Error(
      `the build wrote ${written.join(", ")} but the site publishes ` +
        `${expected.join(", ")}; see chunkNames in build.js`,
    );
  }
}

async function build() {
  try {
    const mode = isDevelopment ? "development" : "production";
    console.log(`📦 Build mode: ${mode} (minify: ${minify})`);
    console.log(`🔖 ${buildBanner}`);

    const vendored = copyVendorAssets();
    const pinned = Object.entries(vendored.versions)
      .map(([name, version]) => `${name} ${version}`)
      .join(", ");
    console.log(`📥 Vendored ${vendored.count} third-party files: ${pinned}`);

    const flags = copyCountryFlags();
    console.log(
      `🏳️  Copied ${flags.count} country flags (flag-icons ${flags.version})`,
    );

    if (isWatch) {
      console.log("👀 Watching for changes...");
      const ctx = await esbuild.context(buildOptions);
      await ctx.watch();
    } else {
      console.log("🔨 Building the JavaScript bundles...");
      const result = await esbuild.build(buildOptions);
      assertExpectedOutputs(result.metafile);

      console.log("✅ Build complete!");

      // Analyze bundle size and composition
      const withinBudget = analyzeBundleSizes();

      if (result.metafile) {
        for (const name of [APP_BUNDLE, SHARED_BUNDLE, FEATURES_BUNDLE]) {
          analyzeBundleComposition(result.metafile, name);
        }
      }

      // A production bundle over budget fails the build wherever it runs;
      // a development bundle is unminified and only gets the warning
      if (!withinBudget && minify) {
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

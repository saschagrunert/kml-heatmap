#!/usr/bin/env node

/**
 * Build script for KML Heatmap JavaScript modules
 * Uses esbuild to bundle ES6 modules into IIFE format for file:// protocol compatibility
 */

import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join, relative, resolve } from "path";
import { statSync } from "fs";
import {
  buildBanner as makeBanner,
  computeSourceHash,
} from "./scripts/source-hash.js";
import { copyVendorAssets } from "./scripts/vendor.js";
import { SHARED_GLOBAL, SHARED_MODULES } from "./scripts/shared-modules.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isWatch = process.argv.includes("--watch");
const isDevelopment = process.env.NODE_ENV === "development" || isWatch;
const minify = !isDevelopment;

const sourceHash = computeSourceHash();
const buildBanner = makeBanner(sourceHash);

// Shared build options for IIFE format bundles (file:// protocol compatible)
const sharedBuildOptions = {
  bundle: true,
  format: "iife",
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

const FRONTEND_DIR = join(__dirname, "kml_heatmap/frontend");

/**
 * Resolve the shared modules to the global the main bundle publishes them on,
 * instead of bundling a second copy into the feature bundle. Several of them
 * hold state (the DOM cache, the toast live region), so a second copy would
 * be a correctness problem and not only dead weight.
 */
const sharedGlobalPlugin = {
  name: "shared-global",
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (!args.importer) return null;
      const absolute = resolve(dirname(args.importer), args.path);
      const name = relative(FRONTEND_DIR, absolute).replace(/\.ts$/, "");
      if (!SHARED_MODULES.includes(name)) return null;
      return { path: name, namespace: "shared-global" };
    });
    build.onLoad({ filter: /.*/, namespace: "shared-global" }, (args) => ({
      contents: `module.exports = window.${SHARED_GLOBAL}[${JSON.stringify(args.path)}];`,
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

// The feature bundle: replay and Wrapped, fetched the first time one of them
// is opened. It shares everything else with the main bundle through the
// plugin above.
const featuresBuildOptions = {
  ...sharedBuildOptions,
  entryPoints: [join(__dirname, "kml_heatmap/frontend/features.ts")],
  outfile: join(__dirname, "kml_heatmap/static/features.bundle.js"),
  plugins: [leafletGlobalPlugin, sharedGlobalPlugin],
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

  const outputs = Object.values(metafile.outputs).find(
    (output) => output.inputs && Object.keys(output.inputs).length > 0,
  );
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

// Size budget of the minified bundle in bytes. Every production build checks
// it, so every CI job that builds the bundle enforces it. Raise it on purpose
// when a change needs the room, not to make a build pass.
// The stylesheet has a budget of its own, in tests/test_asset_budget.py: it is
// minified by the Python side, not here.
const BUDGET_APP = 90 * 1024;
// The feature bundle is fetched only when replay or Wrapped is opened, so it
// is not part of what a first visit downloads; it still gets a budget so it
// cannot grow without anyone noticing.
const BUDGET_FEATURES = 40 * 1024;

/**
 * Print bundle size analysis and check it against the budget
 * Returns true if the budget passes, false if it is exceeded
 */
function analyzeBundleSizes() {
  console.log("\n📦 Bundle Size Analysis:");
  console.log("─".repeat(60));

  const bundles = [
    ["🗺️  MapApp Bundle", "mapApp.bundle.js", BUDGET_APP],
    ["✨ Features Bundle", "features.bundle.js", BUDGET_FEATURES],
  ];

  let budgetExceeded = false;
  for (const [label, name, budget] of bundles) {
    try {
      const size = statSync(join(__dirname, "kml_heatmap/static", name)).size;
      console.log(`  ${label}:  ${formatBytes(size).padStart(10)}`);
      if (size > budget) {
        console.log(
          `  ⚠️  ${name} exceeds budget (${formatBytes(size)} > ${formatBytes(budget)})`,
        );
        budgetExceeded = true;
      }
    } catch (error) {
      console.error(`  ❌ Could not measure ${name}:`, error.message);
      // A bundle that cannot be measured cannot be within budget either
      budgetExceeded = true;
    }
  }

  console.log("─".repeat(60));
  return !budgetExceeded;
}

/**
 * The frontend modules a bundle carries, by their path below frontend/
 * @param {import("esbuild").Metafile | undefined} metafile
 * @returns {Set<string>}
 */
function bundledModules(metafile) {
  // By entryPoint, not by having `inputs`: every output has that property
  // and the source map's is an empty object, which is truthy. Picking the
  // map would compare an empty set and never report anything.
  const output = Object.values(metafile?.outputs ?? {}).find(
    (o) => o.entryPoint,
  );
  return new Set(
    Object.keys(output?.inputs ?? {})
      .filter((file) => file.startsWith("kml_heatmap/frontend/"))
      .map((file) =>
        file.replace(/^kml_heatmap\/frontend\//, "").replace(/\.ts$/, ""),
      ),
  );
}

/**
 * Fail the build when a module ended up inside both bundles.
 *
 * A second copy is not only dead weight: several of these modules hold
 * state, and two instances of `domCache` or of the toast live region
 * disagree in ways nothing would report at runtime. The plugin resolves
 * everything in SHARED_MODULES to the global, so a module in both bundles
 * means that list has fallen behind what the features import. Comparing the
 * two bundles catches that, which checking against the list alone cannot.
 */
function assertNoSharedCopies(appMetafile, featuresMetafile) {
  const inApp = bundledModules(appMetafile);
  const duplicated = [...bundledModules(featuresMetafile)].filter((name) =>
    inApp.has(name),
  );
  if (duplicated.length > 0) {
    throw new Error(
      `features.bundle.js bundled a second copy of ${duplicated.join(", ")}; ` +
        "add them to SHARED_MODULES in scripts/shared-modules.js and to " +
        "kml_heatmap/frontend/shared.ts so both bundles use one instance",
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

    if (isWatch) {
      console.log("👀 Watching for changes...");
      for (const options of [appBuildOptions, featuresBuildOptions]) {
        const ctx = await esbuild.context(options);
        await ctx.watch();
      }
    } else {
      console.log("🔨 Building the JavaScript bundles...");
      const appResult = await esbuild.build(appBuildOptions);
      const featuresResult = await esbuild.build(featuresBuildOptions);
      assertNoSharedCopies(appResult.metafile, featuresResult.metafile);

      console.log("✅ Build complete!");

      // Analyze bundle size and composition
      const withinBudget = analyzeBundleSizes();

      if (appResult.metafile) {
        analyzeBundleComposition(appResult.metafile, "MapApp Bundle");
      }
      if (featuresResult.metafile) {
        analyzeBundleComposition(featuresResult.metafile, "Features Bundle");
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

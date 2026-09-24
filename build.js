#!/usr/bin/env node

/**
 * Build script for KML Heatmap JavaScript modules
 * Uses esbuild to bundle the TypeScript sources into ES modules
 */

import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import { gzipSync } from "zlib";
import {
  buildBanner as makeBanner,
  computeSourceHash,
} from "./scripts/source-hash.js";
import {
  copyCountryFlags,
  copyVendorAssets,
  VENDOR_FILES,
  VENDOR_MODULES,
} from "./scripts/vendor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isWatch = process.argv.includes("--watch");
const isDevelopment = process.env.NODE_ENV === "development" || isWatch;
const minify = !isDevelopment;

const sourceHash = computeSourceHash();
const buildBanner = makeBanner(sourceHash);

/**
 * Leave MapLibre out of the bundles and import the vendored module instead,
 * and html-to-image with it.
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
    // html-to-image likewise: only an export needs it, so the app imports
    // it on the first one (ui/uiToggles.ts). Pointing the import() at the
    // vendored module keeps it out of the bundles without making esbuild
    // write a second chunk, which would need a name (assertExpectedOutputs).
    build.onResolve({ filter: /^html-to-image$/ }, () => ({
      path: "./vendor/html-to-image.mjs",
      external: true,
    }));
  },
};

/**
 * Leave the year decoder out of the bundles as well. The app decodes the
 * year files in a worker, which is a build of its own (workerBuildOptions);
 * where the worker cannot be used, the app imports the decoder from that
 * same file (services/yearDecoder.ts). Without this, esbuild would write the
 * decoder a second time, as a chunk of the app.
 * @type {import("esbuild").Plugin}
 */
const yearWorkerPlugin = {
  name: "year-worker",
  setup(build) {
    build.onResolve({ filter: /^\.\/yearWorker$/ }, (args) =>
      args.kind === "dynamic-import"
        ? { path: `./${WORKER_BUNDLE}`, external: true }
        : undefined,
    );
  },
};

const STATIC_DIR = join(__dirname, "kml_heatmap/static");
const FRONTEND_DIR = join(__dirname, "kml_heatmap/frontend");

// The page loads mapApp.bundle.js as a module. Replay and Wrapped are a
// quarter of the frontend and most visits open neither, so features.ts
// (replay) and wrapped.ts are entry points of their own that the app imports
// the first time each is used (services/featureLoader.ts). With splitting,
// what the entry points have in common is moved into a chunk that each of
// them imports, so there is a single instance of every module that holds
// state (the DOM cache, the toast live region).
//
// esbuild makes one chunk for every set of entry points that reach a module,
// so three entry points could share code in up to four chunks. Both lazy
// entry points import mapApp.ts for that reason: everything the app reaches
// is then reached by all three, and the one chunk that holds it (the app
// itself; mapApp.bundle.js only starts it) can carry a fixed name instead of
// a hash. What is left of each lazy bundle is its own code. A module that
// replay and Wrapped use and the app does not would still get a chunk of
// its own; assertExpectedOutputs() fails the build when that happens (move
// it where the app reaches it, as with segmentBounds in utils/geometry.ts).
/** @type {import("esbuild").BuildOptions} */
const buildOptions = {
  entryPoints: [
    join(FRONTEND_DIR, "mapApp.ts"),
    join(FRONTEND_DIR, "features.ts"),
    join(FRONTEND_DIR, "wrapped.ts"),
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
  plugins: [maplibreVendorPlugin, yearWorkerPlugin],
};

// The year worker (services/yearWorker.ts). A build of its own rather than a
// third entry point: a worker shares no module instance with the page, so a
// chunk in common would only be one more file to fetch before it can start,
// and splitting would name that chunk shared.bundle.js as well.
/** @type {import("esbuild").BuildOptions} */
const workerBuildOptions = {
  ...buildOptions,
  entryPoints: [join(FRONTEND_DIR, "services/yearWorker.ts")],
  splitting: false,
  plugins: [],
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

// Size budgets in bytes, each for the minified files as written (raw) and
// for the same files gzipped at level 9 (gzip), which is closer to what a
// visit downloads. Every production build checks them, so every CI job that
// builds the bundles enforces them. Raise one on purpose when a change needs
// the room, not to make a build pass.
//
// The policy: an app bundle gets about 2 KB of raw and 1 KB of gzipped room
// over its size when the budget is set, a vendored file about 1 %. That is
// little on purpose. The raw budget of the first visit has been raised eleven
// times, each for a change that was worth it, and each raise was a decision
// someone wrote down below rather than a slow drift nobody saw. The gzipped
// budget catches what the raw one rewards the wrong way: a change that saves
// raw bytes by making the code harder to compress. Two pull requests that each
// fit can still not fit together, since each is built against the main branch
// of its day; the budget is checked again on main.
//
// The stylesheet has a budget of its own, in tests/test_asset_budget.py: it is
// minified by the Python side, not here.
//
// What a first visit downloads: the app and the chunk it shares with the
// lazy bundles, which the page loads together. Since Wrapped got a bundle of
// its own, the chunk holds nearly all of the app and mapApp.bundle.js only
// starts it; the sum is what counts.
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
// The room on top is small on purpose. What decodes the year files and
// builds their datasets has since moved into the year worker's bundle, which
// took 0.5 KB out of this one.
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
// Raised by 0.5 KB for the WebGL 2 check, the context loss toasts and the
// double tap filter of the markers (WebKit counts no taps in `detail`),
// which took it to 112.05 KB.
// Raised from 112.5 KB for the heat lines the heatmap hands over to when
// zoomed in (see HEAT_LINES in constants.ts): their source, two layers, the
// cross fade, and the time spent around every stretch that colours them
// and sets their width, smoothed along each flight (calculations/
// heatLines.ts), 3.5 KB on top of main's 112.05 KB. They cannot load later:
// a link may open zoomed in.
// Raised from 116 KB for the airport codes as a label layer of the map
// (ui/airportLabels.ts): the layer's style, the chip it computes as a
// distance field, the label data and the hover that joins label and
// marker, less the DOM declutter it replaces, which took 115.76 KB to
// 118.43 KB. The codes are on the first paint.
// Raised from 118.5 KB for the 3D view (calculations/lift.ts): the ribbon
// layers and their sources, the runs cut by height and written as ribbons
// instead of lines, as wide as the zoom asks, the ranking of a lifted
// ribbon under the pointer, the ribbons mitred at their bends, sloped with
// the climb and smoothed along a spline through each flight, the switch
// with its link flag and sheet row, the sky of a map tilted past 60
// degrees, the airports hidden towards its horizon, and the ground of
// each flight from its fields, which took 118.48 KB to 129.22 KB. A link
// may open in 3D, so none of it waits for a later bundle.
// Raised from 130 KB on 2026-09-24 for the fixes of that day's review (the
// real init errors, the load watchdog, the checked metadata and airports,
// the abandoned year, antimeridian unwrapping, the redraw after a lost
// WebGL context), and given a gzipped budget next to the raw one: 135,184 B
// raw and 45,871 B gzipped.
// Raised from 134 KB for the relief under the 3D view (issue #297). The
// relief itself, its elevation source and the hiding of the ribbons while
// they settle on it come with the feature bundle (ui/terrain.ts); what
// cannot wait is in the path every ribbon is cut on: the choice of ground
// by the level being cut, the flights smoothed as altitudes before the
// ground is taken off, and the switch that fetches the relief's code,
// 1.15 KB on top of the 133.42 KB main had after #304; with the single
// cut of the ribbons as the relief's code arrives, the release of the old
// cut before the new one, and North up shown unavailable while there is
// nothing to reset: 138,262 B raw and 45.8 KB gzipped.
// Raised from 136 KB for Reset view (MapApp.resetView), with its button and
// sheet row shown unavailable while there is nothing to reset: the start
// view it measures and compares the camera with. The button is on the
// first paint. 140,018 B raw and 46.31 KB gzipped together with the relief.
// The Satellite switch fits without a raise: its button, sheet row, store
// key and link parameter add 1.06 KB (141,095 B raw, 46.6 KB gzipped),
// leaving about 200 B; the imagery itself waits in the feature bundle.
// Wrapped moving into a bundle of its own made the app one chunk
// (see buildOptions), which compresses better than two: 139,549 B raw and
// 46,584 B gzipped, from 140,030 B and 47,417 B.
// The relief at every zoom takes 1.99 KB of it: the ground smoothed as the
// relief is drawn at each level, which every ribbon is cut on, and the
// level and its exaggeration carried by the ribbons, the replay's trail
// and its airplane; 141,543 B raw and 46.17 KB gzipped, over the 138 KB by
// 231 B.
const BUDGET_APP = { raw: 139 * 1024, gzip: 47 * 1024 };
// The feature bundle is fetched only when replay is opened, the relief of
// the 3D view is first drawn, the Satellite switch is first on or an
// airport's popup is first opened, so
// it is not part of what a first visit downloads; it still gets a budget so
// it cannot grow without anyone noticing.
// Raised from 40 KB for the replay in the 3D view: the trail drawn as
// ribbons sloped with the flight, each run cut once and handed back to its
// line zoomed in close, and the airplane lifted to its height on the
// flight's curve (41.22 KB).
// 41,150 B raw and 13,712 B gzipped on 2026-09-24.
// Raised from 42 KB for the replay along the flight's curve (2D and replay
// smoothing): the airplane moved by time along the curve the lines are
// drawn on, with the logged times smoothed and the speed eased across the
// fixes, its heading from the curve, the trail ending at the airplane, and
// the camera following it as a damped spring instead of a pan restarted on
// every frame: 45,510 B raw and 15,587 B gzipped.
// Raised from 47 KB for the relief of the 3D view and its shading
// (ui/terrain.ts), which wait here for the first zoom that draws them
// rather than in the first visit, and the replay's curve lifted anew as
// the relief comes or goes: 47,861 B raw and 16,495 B gzipped.
// Lowered from 48 KB when Wrapped moved into a bundle of its own
// (wrapped.ts), from 48,065 B raw and 16,575 B gzipped to 32,287 B raw and
// 11,531 B gzipped. The budget keeps the policy's room over that rather than
// the room Wrapped left, so what comes next is a decision like any other.
// The satellite imagery (see its raise before) comes on top of that:
// 33,989 B raw and 12,141 B gzipped with both.
// Raised for the chase view of the replay (ui/chaseCamera.ts): the camera
// that looks at the airplane in the air from behind it, its springs for the
// turn, the tilt, the zoom and where it looks, the tilt held above the
// relief, the airplane drawn upright where that camera sees it, the control
// with its slower speeds, and the camera given back as it ends, about 7.5 KB:
// 41,650 B raw and 14,720 B gzipped.
const BUDGET_FEATURES = { raw: 43 * 1024, gzip: 16 * 1024 };

// The Wrapped bundle is fetched only when the Wrapped dialog is opened, and
// no longer with replay's code or replay with it: the two have nothing in
// common that the app does not have as well.
// 15,731 B raw and 5,529 B gzipped on 2026-09-24.
const BUDGET_WRAPPED = { raw: 17.5 * 1024, gzip: 6.5 * 1024 };

// The year worker's bundle is fetched by every visit, but next to the first
// year file rather than ahead of the app, so it holds up nothing on the page.
// 4,808 B raw and 2,273 B gzipped on 2026-09-24.
const BUDGET_WORKER = { raw: 6 * 1024, gzip: 3 * 1024 };

// The vendored files are copied as they are (scripts/vendor.js), so a budget
// cannot make them smaller. It is there so a Dependabot bump that makes
// MapLibre, which every visit loads before the map can draw, noticeably
// larger fails the build and gets looked at instead of merged unseen. Raise
// it in the pull request of the bump, with the new sizes here.
// maplibre-gl 6.10.0: the three modules and the stylesheet come to
// 1,200,360 B raw and 310,925 B gzipped.
const BUDGET_MAPLIBRE = { raw: 1184 * 1024, gzip: 307 * 1024 };
// html-to-image 1.11.13, bundled into one module: 13,667 B raw and 5,441 B
// gzipped. Loaded on the first export only.
const BUDGET_HTML_TO_IMAGE = { raw: 14 * 1024, gzip: 5.5 * 1024 };

const APP_BUNDLE = "mapApp.bundle.js";
const FEATURES_BUNDLE = "features.bundle.js";
const WRAPPED_BUNDLE = "wrapped.bundle.js";
const SHARED_BUNDLE = "shared.bundle.js";
const WORKER_BUNDLE = "yearWorker.bundle.js";

/**
 * Size of a file as written and gzipped at the highest level
 * @param {string} path
 * @returns {{raw: number, gzip: number}}
 */
function measure(path) {
  const content = readFileSync(path);
  return {
    raw: content.length,
    gzip: gzipSync(content, { level: 9 }).length,
  };
}

/**
 * Print bundle size analysis and check it against the budget
 * Returns true if the budget passes, false if it is exceeded
 */
function analyzeBundleSizes() {
  console.log("\n📦 Bundle Size Analysis:");
  console.log("─".repeat(60));

  const vendor = (/** @type {string} */ name) => `vendor/${name}`;
  /** @type {[label: string, names: string[], budget: {raw: number, gzip: number}][]} */
  const bundles = [
    ["🗺️  First visit", [APP_BUNDLE, SHARED_BUNDLE], BUDGET_APP],
    ["✨ Features", [FEATURES_BUNDLE], BUDGET_FEATURES],
    ["🎁 Wrapped", [WRAPPED_BUNDLE], BUDGET_WRAPPED],
    ["🧵 Year worker", [WORKER_BUNDLE], BUDGET_WORKER],
    [
      "🧭 MapLibre",
      Object.keys(VENDOR_FILES)
        .filter((name) => name.startsWith("maplibre-gl"))
        .map(vendor),
      BUDGET_MAPLIBRE,
    ],
    [
      "🖼️  html-to-image",
      Object.keys(VENDOR_MODULES).map(vendor),
      BUDGET_HTML_TO_IMAGE,
    ],
  ];

  let budgetExceeded = false;
  for (const [label, names, budget] of bundles) {
    const described = names.join(" + ");
    try {
      // Every file is its own download, so each is gzipped on its own
      const size = { raw: 0, gzip: 0 };
      for (const name of names) {
        const file = measure(join(STATIC_DIR, name));
        size.raw += file.raw;
        size.gzip += file.gzip;
      }
      console.log(
        `  ${label} (${described}):  ${formatBytes(size.raw)} ` +
          `(budget ${formatBytes(budget.raw)}), ` +
          `${formatBytes(size.gzip)} gzipped ` +
          `(budget ${formatBytes(budget.gzip)})`,
      );
      for (const kind of /** @type {const} */ (["raw", "gzip"])) {
        if (size[kind] > budget[kind]) {
          console.log(
            `  ⚠️  ${described} exceeds its ${kind} budget ` +
              `(${size[kind]} B > ${budget[kind]} B)`,
          );
          budgetExceeded = true;
        }
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
 * Fail the build when it wrote anything but the five bundles.
 *
 * The site publishes them by name (SITE_FILES in kml_heatmap/site_assets.py)
 * and the page preloads the shared chunk by name. A module the lazy entry
 * points share without the app, another entry point or a second dynamic
 * import would make esbuild write further chunks, all called
 * shared.bundle.js; that has to be a decision about naming, not a surprise.
 * @param {(import("esbuild").Metafile | undefined)[]} metafiles
 */
function assertExpectedOutputs(metafiles) {
  const written = metafiles
    .flatMap((metafile) => Object.keys(metafile?.outputs ?? {}))
    .filter((path) => path.endsWith(".js"))
    .map((path) => path.slice(path.lastIndexOf("/") + 1))
    .sort();
  const expected = [
    APP_BUNDLE,
    FEATURES_BUNDLE,
    WRAPPED_BUNDLE,
    SHARED_BUNDLE,
    WORKER_BUNDLE,
  ].sort();
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
      for (const options of [buildOptions, workerBuildOptions]) {
        const ctx = await esbuild.context(options);
        await ctx.watch();
      }
    } else {
      console.log("🔨 Building the JavaScript bundles...");
      const [result, workerResult] = await Promise.all([
        esbuild.build(buildOptions),
        esbuild.build(workerBuildOptions),
      ]);
      assertExpectedOutputs([result.metafile, workerResult.metafile]);

      console.log("✅ Build complete!");

      // Analyze bundle size and composition
      const withinBudget = analyzeBundleSizes();

      if (result.metafile) {
        for (const name of [SHARED_BUNDLE, FEATURES_BUNDLE, WRAPPED_BUNDLE]) {
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

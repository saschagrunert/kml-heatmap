#!/usr/bin/env node

/**
 * Build script for KML Heatmap JavaScript modules
 * Uses esbuild to bundle the TypeScript sources into ES modules
 */

import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import { readFile } from "fs/promises";
import { gzipSync } from "zlib";
import ts from "typescript";
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

/**
 * Take utils/constants.ts for a module without side effects in the year
 * worker's bundle, which uses none of it: the worker reaches it through
 * helpers of the heat lines (utils/mapHelpers.ts, utils/geometry.ts), and
 * esbuild kept 0.85 KB of constants that it cannot tell are free of side
 * effects (MAP_LAYERS and HEATMAP_LAYER_IDS, sums of other constants).
 * With no import of it used, the module is left out.
 * @type {import("esbuild").Plugin}
 */
const pureConstantsPlugin = {
  name: "pure-constants",
  setup(build) {
    build.onResolve({ filter: /\/constants$/ }, async (args) => {
      if (args.pluginData === "pure-constants") return undefined;
      const { path, errors } = await build.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: args.resolveDir,
        pluginData: "pure-constants",
      });
      return errors.length > 0 ? { errors } : { path, sideEffects: false };
    });
  },
};

/**
 * GLSL as a minified build ships it: `text` without its comments, and each
 * line without its indentation and the spaces around the punctuation that
 * separates tokens anyway. Not around + and -, where "a - -b" would become
 * a decrement, and not in a directive, where "#define A (b)" would become a
 * macro of a parameter. The lines stay lines, for the preprocessor and for
 * the line numbers a compiler's error names. `open` and `close` say
 * whether the text starts or ends a line rather than meets an
 * interpolation, whose value a space may separate from a word.
 * @param {string} text
 * @param {boolean} open
 * @param {boolean} close
 * @returns {string}
 */
function tightenGlsl(text, open, close) {
  const lines = text
    // Whichever comment opens first, a block one as a space or the breaks
    // of the lines it spans
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (comment) =>
      comment.startsWith("//") ? "" : comment.replace(/[^\n]+/g, " "),
    )
    .split("\n");
  return lines
    .map((line, i) => {
      let tight = line.replace(/[ \t]+/g, " ");
      if (!/^ ?#/.test(tight)) {
        tight = tight.replace(/ ?([=,;(){}[\]*/<>?:&|!]) ?/g, "$1");
      }
      if (i > 0 || open) tight = tight.trimStart();
      if (i < lines.length - 1 || close) tight = tight.trimEnd();
      return tight;
    })
    .join("\n");
}

/**
 * Write the shaders of the custom layers (ui/*Layer.ts) as a minified
 * build ships them (tightenGlsl). esbuild leaves a template literal as it
 * is written, and their GLSL, some 12 KB of the feature bundle, was a
 * sixth indentation and spaces. A template literal is taken for GLSL where
 * its text holds "gl_" or "uniform ", and only its text is changed, never
 * the expressions it interpolates. Tests and development builds read the
 * shaders as they are written.
 * @type {import("esbuild").Plugin}
 */
const shaderPlugin = {
  name: "shaders",
  setup(build) {
    build.onLoad({ filter: /[\\/]ui[\\/]\w+Layer\.ts$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const file = ts.createSourceFile(
        args.path,
        source,
        ts.ScriptTarget.Latest,
      );
      /** @type {ts.Node[]} */
      const parts = [];
      /** @param {ts.Node} node */
      const visit = (node) => {
        const literals = ts.isTemplateExpression(node)
          ? [node.head, ...node.templateSpans.map((span) => span.literal)]
          : ts.isNoSubstitutionTemplateLiteral(node)
            ? [node]
            : [];
        if (/gl_|uniform /.test(literals.map((part) => part.text).join(""))) {
          parts.push(...literals);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      // From the end, so the offsets of those before stay where they were
      parts.sort((a, b) => b.end - a.end);
      let contents = source;
      for (const part of parts) {
        const start = part.getStart(file);
        const raw = source.slice(start, part.end);
        // Between the backtick or the brace it opens with and the backtick
        // or "${" it closes with
        const close = raw.endsWith("${") ? 2 : 1;
        const text = tightenGlsl(
          raw.slice(1, -close),
          raw[0] === "`",
          close === 1,
        );
        contents =
          contents.slice(0, start + 1) +
          text +
          contents.slice(part.end - close);
      }
      return { contents, loader: "ts" };
    });
  },
};

const STATIC_DIR = join(__dirname, "kml_heatmap/static");
const FRONTEND_DIR = join(__dirname, "kml_heatmap/frontend");

// The page loads mapApp.bundle.js as a module. Replay and Wrapped are a
// quarter of the frontend and most visits open neither, so features.ts
// (replay) and wrapped.ts (Wrapped and the statistics panel) are entry
// points of their own that the app imports the first time each is used
// (services/featureLoader.ts). With splitting, what the entry points have
// in common is moved into a chunk that each of them imports, so there is a
// single instance of every module that holds state (the DOM cache, the
// toast live region).
//
// esbuild makes one chunk for every set of entry points that reach a module,
// so three entry points could share code in up to four chunks. Both lazy
// entry points import mapApp.ts for that reason: everything the app reaches
// is then reached by all three, and the one chunk that holds it (the app
// itself; mapApp.bundle.js only starts it) can carry a fixed name instead of
// a hash. What is left of each lazy bundle is its own code. A module that
// replay and Wrapped use and the app does not would still get a chunk of
// its own; assertExpectedOutputs() fails the build when that happens (move
// it where the app reaches it, as with segmentBounds in utils/geometry.ts,
// or inline it in each lazy module that uses it).
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
  plugins: [
    maplibreVendorPlugin,
    yearWorkerPlugin,
    ...(minify ? [shaderPlugin] : []),
  ],
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
  plugins: [pureConstantsPlugin],
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
// for the same files gzipped at level 9 (gzip, see measure()), which is
// closer to what a visit downloads. Every production build checks them and
// prints each size next to its budget, so every CI job that builds the
// bundles enforces them. Raise one on purpose, in the change that needs the
// room, and say what it paid for in the commit message; `git log -L` on a
// budget line lists every earlier raise and why.
//
// The policy: an app bundle gets about 2 KB of raw and 1 KB of gzipped room
// over its size when the budget is set, a vendored file about 1 %. The
// gzipped budget catches what the raw one rewards the wrong way: a change
// that saves raw bytes by making the code harder to compress. Two pull
// requests that each fit can still not fit together, since each is built
// against the main branch of its day; the budget is checked again on main.
//
// The gzipped sizes depend on the zlib that Node.js was built with, not on
// the Node.js version, and CI's differs from a local build's by up to about
// 0.5 %, larger for the big files: MapLibre 6.10.0 is 312,146 B gzipped in
// CI and 310,925 B on a NixOS machine (0.4 %), the first visit 0.4 % more
// (48.64 KB against 48.45 KB). CI is what enforces the budgets, so size a
// raise by the sizes CI prints (the "Build the JavaScript bundle" step of
// any job), not by a local build. Each comment below says which of its
// sizes are CI's and which a local build's; the earlier ones are what was
// quoted when those budgets were set.
//
// The stylesheet has a budget of its own, in tests/test_asset_budget.py: it is
// minified by the Python side, not here.

// What a first visit downloads: the app and the chunk it shares with the
// lazy bundles, which the page loads together. The chunk holds nearly all of
// the app and mapApp.bundle.js only starts it, so the sum is what counts.
// What the map draws cannot move to a lazy bundle: a link may open turned,
// as a globe, zoomed in or in 3D. What only a panel shows can, and the
// statistics panel did (ui/statsPanel.ts). 138.19 KB raw and 46.36 KB gzipped.
// Raised from 139 KB and 47 KB for the ribbons that carry the ground of the
// relief levels around their own, stand on the one of each tile and switch
// their exaggeration with the relief: 140.70 KB raw and 47.19 KB gzipped.
// Raised from 142 KB and 48 KB for the UI fixes of the review of 2026-09-25
// (guarded phone actions, the failed first load with Retry, sticky error
// toasts, the wrapping map credit, new icons): 144.21 KB raw and 48.64 KB
// gzipped. That raise was sized by a local build (48.45 KB), so in CI it
// left about 370 B of gzipped room, not the 1 KB the policy above means.
// Lowered from 145 KB and 49 KB when the statistics panel moved to the
// Wrapped bundle and the flight list of the airport popups came here from
// the feature bundle: 134.61 KB raw and 45.86 KB gzipped in a local build,
// about 46.04 KB in CI going by the 0.4 % above, which the budget is sized
// for. Raised from 136.5 KB and 47 KB for the UI fixes of the second review
// of 2026-09-25 (framing an isolated selection clear of the panels, an
// aircraft picked during a year switch, the announcements of a load and of
// a cleared selection, the year placeholder, cached number formats): 138.34
// KB raw and 47.18 KB gzipped in a local build, about 47.37 KB in CI.
// Raised from 140.5 KB and 48.25 KB for the performance fixes of that
// review (the ribbons of the 3D view cut for the pixels on the screen and
// written around the view only, the heatmap of an isolated selection from
// a source of its own, the ranks of the groundspeeds selected rather than
// sorted), which together with the other fixes of that review come to
// 144.38 KB raw and 49.57 KB gzipped in a local build, 49.76 KB in CI (the
// run of 7a79b77). Raised from 146.5 KB and 50.75 KB for the fixes of the
// final review of that change (runs of a dataset that waits for the relief
// left stale, a mode that shows during a camera move drawn at its end, the
// flights isolate mode hides left as they are, one toast per lazy file):
// 145.44 KB raw and 49.92 KB gzipped in a local build, about 50.12 KB in CI.
// Raised from 147.5 KB and 51.25 KB for the features that land together:
// the landings, the flight list, the flight profile, replay of all flights,
// the Wrapped intro and the heatmap weighed by time with its switches for
// routes, airborne and new areas. The heatmap alone comes to 148.3 KB raw
// and 50.96 KB gzipped in a local build; all of them together are about
// 150.2 KB raw and 51.5 KB gzipped.
// Raised from 152 KB and 52.5 KB for the heat legend, the hotspot tour and
// the cross-section, landing next to the heatmap weighed by time: about
// 153.4 KB raw and 53 KB gzipped together in CI. The heatmap weighed by
// time with its switches for routes, airborne and new areas, and the new
// airspace of a year that Wrapped names, counted by the app
// (DataManager.newAreaKm2) so that Wrapped never fetches the feature
// bundle: 150.26 KB raw and 51.51 KB gzipped before, 153.41 KB raw and
// 52.81 KB gzipped after, in a local build. The heat legend with its
// scale on top of that: 154.56 KB raw and 53.28 KB gzipped. The
// cross-section's control and its row in the phone's More sheet on top of
// that: 155.06 KB raw and 53.4 KB gzipped. The hotspot tour's on top of
// that: 155.38 KB raw and 53.54 KB gzipped. The Airborne and New areas
// switches taken out again, and Routes turned into By distance in a Heat
// group of its own: 154.11 KB raw and 53.18 KB gzipped.
// Raised from 156 KB and 54 KB for the roll-off of the heat, the heatmap's
// narrower reach and the base map's labels dimmed under the heat: 155.58
// KB raw and 53.66 KB gzipped before, 156.51 KB raw and 53.94 KB gzipped
// after, in a local build.
const BUDGET_APP = { raw: 158 * 1024, gzip: 54.5 * 1024 };
// The feature bundle is fetched only when replay is opened, the relief, the
// heat cloud and the ribbons of a selection of the 3D view are first drawn,
// the Satellite switch is first on, a single flight is first
// selected or the cross-section is first opened, so it is not part of what a
// first visit downloads; it still gets a budget so it cannot grow without
// anyone noticing. 41.01 KB raw and 14.53 KB gzipped.
// Raised from 43 KB for the replay camera's own rest and the relief and
// imagery placed on the ground: 43.19 KB raw and 15.18 KB gzipped then,
// 42.68 KB raw and 15.12 KB gzipped in CI before the flight list of the
// airport popups left it, 41.28 KB raw and 14.48 KB gzipped (local) after.
// Raised from 43.5 KB, which the relief fixes of the second review of
// 2026-09-25 had filled to 370 B: 43.13 KB raw in both, 15.09 KB gzipped
// in a local build and 15.16 KB in CI (the run of 7a79b77).
// Raised from 45 KB and 16 KB for the heat cloud of the 3D view (its layer
// with its own shaders, which esbuild leaves as they are written, and its
// points, cached for the last relief levels): 55.99 KB raw and 20.3 KB
// gzipped in a local build, about 20.38 KB in CI going by the 0.4 % above.
// Raised from 57.5 KB and 21 KB for the selection drawn as ribbons in the
// 3D view, cut around the view only when zoomed in: 58.1 KB raw and
// 21.08 KB gzipped in a local build, about 21.19 KB in CI; the budget keeps
// the room the policy asks for.
// Raised from 60 KB and 22.25 KB for the replay of all flights (its layer,
// with shaders of its own, the player, its panel, and the clock of every
// flight): 75.54 KB raw and 25.97 KB gzipped in a local build, about
// 26.07 KB in CI going by the 0.4 % above.
// Raised from 77 KB and 26.75 KB for the profile of a single selected
// flight, which the app fetches this bundle for, and its place in the
// replay panel: 84.88 KB raw and 29.67 KB gzipped in a local build (76.77
// KB and 26.39 KB before), about 29.8 KB in CI.
// Raised from 87 KB and 30.75 KB for Wrapped's intro: the heat cloud drawn
// with the 3D view off and cut ahead of time as its button is pointed at
// (prepareHeatCloud), and the replay of all flights under its camera, cut
// ahead for where the camera comes down (ReplayAllRun.zoom): 84.88 KB raw
// and 29.67 KB gzipped before, 85.78 KB raw and 29.97 KB gzipped after, in
// a local build.
// Raised from 88 KB and 31 KB for the band of heights of the heat cloud:
// its control, the text of its link and its fade in the cloud's shaders
// (ui/heightBand.ts, calculations/heightBand.ts): 84.19 KB raw and 30.05 KB
// gzipped before, 87.06 KB raw and 31.06 KB gzipped after, in a local build,
// about 31.18 KB in CI going by the 0.4 % above.
// Raised from 89 KB and 32 KB for the fixes of the heat cloud's rendering
// (the shadow kept at its brightest, cheaper and left out while dimmed, the
// glow near the ground pulled clear of the ground in front, the dimmed cloud
// filled towards its strength, pulses that fade where they would comb, rest
// sooner and hold still for an export, far lines that fade), and for the
// cloud cut close in for the zoom's own level and around the view, its steps
// merged along straight runs and its heat added up in a table of its own
// (calculations/heatCloud.ts): 87.06 KB raw and 31.06 KB gzipped before
// both, 89.3 KB raw and 31.9 KB gzipped after the first (90.34 KB and
// 32.35 KB with the flights smoothed once), 93.47 KB raw and 33.82 KB
// gzipped after both, in a local build, about 33.96 KB in CI going by the
// 0.4 % above. Raised from 94 KB and 34.25 KB for the heatmap weighed by
// time, whose weighing the cloud takes (the pieces of a curve kept per
// clock and weighing, the steps of no heat left out), and the places new
// in a year of the New areas switch: 95.04 KB raw and 34.52 KB gzipped
// after, in a local build, about 34.66 KB in CI. Raised from 95.5 KB and
// 35 KB for the readout of the heat cloud under the pointer
// (ui/cloudReadout.ts, with its grid of the segments and the line of sight
// in calculations/cloudReadout.ts): 103.21 KB raw and 37.82 KB gzipped
// after, in a local build, about 37.97 KB in CI. Raised from 103.5 KB and
// 38.25 KB for the marks of the way flown in the heat cloud (their blocks
// of its shaders, and the directions of its cells,
// calculations/cloudCells.ts): 108.32 KB raw and 39.68 KB gzipped after, in
// a local build, about 39.84 KB in CI. Raised from 108.5 KB and 40.25 KB
// for the cross-section (ui/crossSection.ts, calculations/crossSection.ts):
// the line drawn on the map with its corridor, and the chart of the heat
// along it with its panel, readout and summary. 127.38 KB raw and 46.69 KB
// gzipped after, in a local build, about 46.88 KB in CI. Raised from
// 127.75 KB and 47.25 KB for the hotspot tour (ui/hotspotTour.ts,
// calculations/hotspots.ts: the busiest places of the heat, its panel and
// its steps) and the camera moves it shares with Wrapped's intro, which
// came here from the Wrapped bundle (ui/cameraScript.ts): 137.78 KB raw
// and 50.42 KB gzipped after, in a local build, about 50.62 KB in CI. The
// places new in a year of the New areas switch taken out again: 136.28 KB
// raw and 49.75 KB gzipped, in a local build. The shaders written as a
// minified build ships them (shaderPlugin) made room for the slider of
// the replay of all flights, its thousand times and the heat it builds up
// with the cloud: 137.52 KB raw and 50.31 KB gzipped before, 138.74 KB
// and 50.62 KB with them as written, 136.82 KB and 50.3 KB tightened, in a
// local build.
const BUDGET_FEATURES = { raw: 138 * 1024, gzip: 50.75 * 1024 };

// The Wrapped bundle is fetched only when the Wrapped dialog or the
// statistics panel is first opened, and not with replay's code or replay
// with it: the two have nothing in common that the app does not have as
// well. 15.37 KB raw and 5.4 KB gzipped. Raised from 17.5 KB and 6.5 KB for
// the statistics panel, which it carries since it left the first visit
// (a bundle of its own would share modules with Wrapped alone, see
// assertExpectedOutputs): 24.88 KB raw and 8.25 KB gzipped in a local
// build, about 8.28 KB in CI. Raised from 27 KB and 9.25 KB, whose gzipped
// room the fixes of the second review of 2026-09-25 had taken to 0.6 KB:
// 25.83 KB raw and 8.65 KB gzipped in CI (the run of 7a79b77), and with
// the statistics panel's own teardown 25.98 KB raw and 8.68 KB gzipped in
// a local build. Raised from 28 KB and 9.75 KB for the flight list, the
// Flights tab of the statistics rail with its flight times and distances:
// 26.83 KB raw and 8.92 KB gzipped before, 32.85 KB raw and 10.94 KB
// gzipped after, in a local build. Raised from 35 KB and 12 KB for Wrapped's
// intro, the flight over the heat cloud before the cards with every
// flight of the year playing underneath (ui/wrappedIntro.ts): 37.07 KB raw
// and 12.42 KB gzipped after, in a local build.
const BUDGET_WRAPPED = { raw: 40 * 1024, gzip: 14 * 1024 };

// The year worker's bundle is fetched by every visit, but next to the first
// year file rather than ahead of the app, so it holds up nothing on the page.
// 4.95 KB raw and 2.34 KB gzipped. Raised from 6 KB and 3 KB for the heat
// sources, which the worker draws and writes as GeoJSON off the main
// thread, with the heat lines the page works out with the bundle's code
// (services/heatSource.ts): 4.78 KB raw and 2.28 KB gzipped before, 9.11 KB
// raw and 4.14 KB gzipped after, in a local build.
const BUDGET_WORKER = { raw: 10 * 1024, gzip: 5 * 1024 };

// The vendored files are copied as they are but for a few bytes of fixes
// (VENDOR_PATCHES in scripts/vendor.js), so a budget cannot make them
// smaller. It is there so a Dependabot bump that makes
// MapLibre, which every visit loads before the map can draw, noticeably
// larger fails the build and gets looked at instead of merged unseen. Raise
// it in the pull request of the bump, with the new sizes here.
// maplibre-gl 6.10.0: the three modules and the stylesheet come to
// 1,200,360 B raw and 312,146 B gzipped, and with the fixes of
// VENDOR_PATCHES to 1,200,570 B raw and 311,014 B gzipped in a local build.
const BUDGET_MAPLIBRE = { raw: 1184 * 1024, gzip: 307 * 1024 };
// html-to-image 1.11.13, bundled into one module: 13,667 B raw and 5.3 KB
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

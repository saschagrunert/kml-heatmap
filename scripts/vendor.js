/**
 * The third-party files the published page loads.
 *
 * They used to come from unpkg and jsdelivr with subresource integrity
 * hashes. Serving them from the site instead means the map still works
 * during a CDN outage, no visitor's IP reaches a third party, and the
 * page's CSP needs no foreign origin. The
 * copies are taken straight from node_modules, so package-lock.json stays
 * the single place their versions are pinned and Dependabot can bump them
 * like any other dependency. The one thing left off a copy is the closing
 * comment that names a source map the site does not carry, and the one
 * thing changed in one is a few fixes of MapLibre bugs (VENDOR_PATCHES).
 * html-to-image is the exception to "as it is": the package has no module
 * in one file, so its module is bundled into one here (VENDOR_MODULES).
 *
 * build.js copies them into kml_heatmap/static/vendor/ (generated, not
 * committed) and the Python side publishes that directory next to the page.
 */

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, join, posix } from "node:path";
import { buildSync } from "esbuild";
import { REPO_ROOT } from "./source-hash.js";

const NODE_MODULES = join(REPO_ROOT, "node_modules");
const VENDOR_DIR = join(REPO_ROOT, "kml_heatmap/static/vendor");

/**
 * Country flags, kept apart from the vendored files above because the page
 * never loads all of them: the Python side publishes only the countries an
 * export actually visited, and the rest never leave the checkout.
 */
const FLAG_DIR = join(REPO_ROOT, "kml_heatmap/static/flags");
const FLAG_SOURCE = join(NODE_MODULES, "flag-icons/flags/4x3");

/**
 * Published path inside vendor/ -> path inside node_modules.
 *
 * MapLibre is three modules that have to sit next to each other under these
 * names: maplibre-gl.mjs imports the shared one by its relative path, and
 * starts its worker from `./maplibre-gl-worker.mjs` relative to its own URL.
 * That worker is a module of the site's own origin, which is why the page's
 * CSP gets by with `worker-src 'self'` and no `blob:`. The app bundle imports
 * maplibre-gl.mjs from here instead of carrying a copy (see build.js).
 * kml_heatmap/site_assets.py keeps the list of the files it publishes in
 * step with this one; tests/frontend/unit/vendor.test.ts checks this list
 * against node_modules.
 * @type {Record<string, string>}
 */
export const VENDOR_FILES = {
  "maplibre-gl.mjs": "maplibre-gl/dist/maplibre-gl.mjs",
  "maplibre-gl-shared.mjs": "maplibre-gl/dist/maplibre-gl-shared.mjs",
  "maplibre-gl-worker.mjs": "maplibre-gl/dist/maplibre-gl-worker.mjs",
  "maplibre-gl.css": "maplibre-gl/dist/maplibre-gl.css",
};

/**
 * Published path inside vendor/ -> package whose module entry point is
 * bundled into that one file.
 *
 * The app loads html-to-image with import(), on the first export (see
 * build.js and ui/uiToggles.ts). The package ships its ES module as a dozen
 * files and its single file as UMD, which import() cannot take exports from,
 * so the module is bundled here: nothing but the package's own code, under
 * a banner that names it, its version and its licence.
 * @type {Record<string, string>}
 */
export const VENDOR_MODULES = {
  "html-to-image.mjs": "html-to-image",
};

/**
 * The version package-lock.json pins for a vendored package
 * @param {string} name
 * @returns {string}
 */
function pinnedVersion(name) {
  const lock = JSON.parse(
    readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8"),
  );
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry) throw new Error(`package-lock.json does not pin ${name}`);
  return String(entry.version);
}

/**
 * The `//# sourceMappingURL=` line or block comment that closes a file, with
 * the name it points at. It has to stand on a line of its own and be the
 * last thing in the file, so the same words inside a string literal, or
 * inside another comment, are never taken for it. The name ends at plain
 * white space and not at `\s`: the bytes are read as latin1, where the second
 * byte of many UTF-8 characters is the no-break space that `\s` matches.
 */
const SOURCE_MAP_COMMENT =
  /(?:^|\n)[ \t]*(?:\/\/[#@] ?sourceMappingURL=([^ \t\r\n]+)|\/\*[#@] ?sourceMappingURL=([^ \t\r\n]+?) ?\*\/)[ \t\r\n]*$/;

/**
 * A vendored file without the closing comment that names its source map.
 *
 * The packages ship their maps next to the files, and MapLibre's come to
 * five megabytes, so they are not vendored. Left in, the comment makes every
 * DevTools session on the published site ask for a map and get a 404. A
 * comment whose map is vendored is kept: the name is resolved against the
 * directory the file is published in, as a browser would. Every other byte
 * stays: the content is matched as latin1, one character per byte, so
 * nothing is decoded and written back differently and a binary file passes
 * through.
 * @param {Buffer} content
 * @param {string} [published] - Path of the file inside vendor/
 * @returns {Buffer}
 */
export function stripSourceMapComment(content, published = "") {
  const match = SOURCE_MAP_COMMENT.exec(content.toString("latin1"));
  if (!match) return content;
  const map = posix.normalize(
    posix.join(posix.dirname(published), match[1] ?? match[2] ?? ""),
  );
  // Not `in`: that also finds what every object inherits ("constructor")
  if (Object.hasOwn(VENDOR_FILES, map)) return content;
  // The line break before the comment belongs to the code above it
  const start = match[0].startsWith("\n") ? match.index + 1 : match.index;
  return content.subarray(0, start);
}

/**
 * @typedef {object} VendorPatch
 * @property {string} name - What it fixes, for the error when it no longer
 *   applies
 * @property {RegExp} find - The code it replaces, which has to occur exactly
 *   once in the file; its groups keep the minifier's names
 * @property {string} replace - The code in its place (`$1` and on for the
 *   groups)
 */

/**
 * Published path inside vendor/ -> the fixes made to that file as it is
 * copied, each to the minified code of the version package-lock.json pins.
 *
 * Kept to MapLibre bugs that the app cannot work around from the outside,
 * each a few characters, with its upstream issue text in the owner's hands.
 * A fix whose code is no longer found exactly once fails the build: after a
 * bump, see whether the new version fixed the bug (drop the patch) or only
 * renamed the code around it (match it again). A patch in place of a copy
 * of the source keeps the version pinned in one place, and the file small.
 * @type {Record<string, VendorPatch[]>}
 */
export const VENDOR_PATCHES = {
  "maplibre-gl.mjs": [
    {
      // MercatorCoveringTilesDetailsProvider.getTileBoundingVolume: with the
      // relief, a tile's box spans the relief's lowest to highest point, and
      // leaves out the height of the point the camera looks at, which the
      // globe's provider keeps (Math.max). The chase view looks at the
      // airplane in the air: the tiles of its trail under the camera fell
      // outside the view and were never loaded, and no trail was drawn near
      // the airplane.
      name: "tiles culled below the camera's centre on the relief",
      find: /(getTileBoundingVolume\(\w+,\w+,(\w+),(\w+)\)\{let (\w+)=Math\.min\(0,\2\),(\w+)=Math\.max\(0,\2\);if\(\3\?\.terrain\)\{[^}]*?\5=)(\w+)\.maxElevation\?\?\5\}/,
      replace: "$1Math.max($6.maxElevation??$5,$5)}",
    },
    {
      // Tile.loadVectorData: a GeoJSON tile that loads empty after a
      // `setData` keeps the raw data of what it held before. Leaving the 3D
      // view empties the ribbons' sources, and their tiles held on to
      // 12 MB (a year) to 38 MB (all years) of data nothing drew anymore.
      name: "raw tile data kept by a tile that loads empty",
      find: /(!(\w+)\)\{this\.collisionBoxArray=new \w+)(;return\}\2\.featureIndex&&\(this\.latestFeatureIndex=\2\.featureIndex,\2\.rawTileData\?)/,
      replace: "$1,this.latestRawTileData=null,this.latestEncoding=null$3",
    },
  ],
};

/**
 * A vendored file with its fixes (VENDOR_PATCHES) made. Matched as latin1,
 * one character per byte, like stripSourceMapComment, so every other byte
 * stays as it is.
 * @param {Buffer} content
 * @param {string} published - Path of the file inside vendor/
 * @returns {Buffer}
 */
export function applyVendorPatches(content, published) {
  const patches = VENDOR_PATCHES[published];
  if (!patches) return content;
  let text = content.toString("latin1");
  for (const { name, find, replace } of patches) {
    const found = [...text.matchAll(new RegExp(find.source, "g"))].length;
    if (found !== 1) {
      throw new Error(
        `scripts/vendor.js: the fix "${name}" matches ${found} places in ` +
          `${published} instead of one. Has MapLibre changed there? See ` +
          `VENDOR_PATCHES.`,
      );
    }
    text = text.replace(find, replace);
  }
  return Buffer.from(text, "latin1");
}

/**
 * Copy the vendored files into kml_heatmap/static/vendor/.
 *
 * The directory is replaced rather than written over, so a file dropped
 * from the list above does not linger in a checkout and get published.
 * @returns {{count: number, versions: Record<string, string>}}
 */
export function copyVendorAssets() {
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  for (const [published, source] of Object.entries(VENDOR_FILES)) {
    const destination = join(VENDOR_DIR, published);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      applyVendorPatches(
        stripSourceMapComment(
          readFileSync(join(NODE_MODULES, source)),
          published,
        ),
        published,
      ),
    );
  }
  for (const [published, name] of Object.entries(VENDOR_MODULES)) {
    const manifest = JSON.parse(
      readFileSync(join(NODE_MODULES, name, "package.json"), "utf8"),
    );
    buildSync({
      entryPoints: [join(NODE_MODULES, name, manifest.module)],
      outfile: join(VENDOR_DIR, published),
      bundle: true,
      format: "esm",
      target: ["es2022"],
      platform: "browser",
      minify: true,
      legalComments: "none",
      banner: {
        js: `/* ${name} ${pinnedVersion(name)}, ${manifest.license} licence, ${manifest.homepage} */`,
      },
      logLevel: "warning",
    });
  }
  /** @type {Record<string, string>} */
  const versions = {};
  for (const name of ["maplibre-gl", ...Object.values(VENDOR_MODULES)]) {
    versions[name] = pinnedVersion(name);
  }
  const count =
    Object.keys(VENDOR_FILES).length + Object.keys(VENDOR_MODULES).length;
  return { count, versions };
}

/**
 * Copy the country flags into kml_heatmap/static/flags/.
 *
 * All of them, because which ones a site needs depends on the flights it is
 * built from; `kml_heatmap/site_assets.py` publishes the handful an export
 * touched. Like vendor/, the directory is generated, gitignored and left out
 * of the wheel, so a copy installed from PyPI falls back to the country
 * code rather than shipping two megabytes of flags nobody asked for.
 * @returns {{count: number, version: string}}
 */
export function copyCountryFlags() {
  rmSync(FLAG_DIR, { recursive: true, force: true });
  mkdirSync(FLAG_DIR, { recursive: true });
  const flags = readdirSync(FLAG_SOURCE).filter((name) =>
    name.endsWith(".svg"),
  );
  for (const name of flags) {
    copyFileSync(join(FLAG_SOURCE, name), join(FLAG_DIR, name));
  }
  return { count: flags.length, version: pinnedVersion("flag-icons") };
}

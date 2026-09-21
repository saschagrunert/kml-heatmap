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
 * comment that names a source map the site does not carry.
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
import { dirname, join, posix } from "node:path";
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
  "html-to-image.js": "html-to-image/dist/html-to-image.js",
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
      stripSourceMapComment(
        readFileSync(join(NODE_MODULES, source)),
        published,
      ),
    );
  }
  /** @type {Record<string, string>} */
  const versions = {};
  for (const name of ["maplibre-gl", "html-to-image"]) {
    versions[name] = pinnedVersion(name);
  }
  return { count: Object.keys(VENDOR_FILES).length, versions };
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

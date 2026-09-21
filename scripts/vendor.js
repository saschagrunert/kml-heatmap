/**
 * The third-party files the published page loads.
 *
 * They used to come from unpkg and jsdelivr with subresource integrity
 * hashes. Serving them from the site instead means the map still works
 * during a CDN outage, no visitor's IP reaches a third party, `file://`
 * is genuinely offline, and the page's CSP needs no foreign origin. The
 * copies are taken straight from node_modules, so package-lock.json stays
 * the single place their versions are pinned and Dependabot can bump them
 * like any other dependency.
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
} from "node:fs";
import { dirname, join } from "node:path";
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
 * leaflet.css asks for `images/layers.png` and `images/marker-icon.png`
 * relative to itself, and L.Icon.Default builds marker-icon-2x.png and
 * marker-shadow.png from JavaScript, so the whole image set comes along.
 * kml_heatmap/site_assets.py keeps the list of the files it publishes in
 * step with this one; tests/frontend/unit/vendor.test.ts checks this list
 * against node_modules.
 * @type {Record<string, string>}
 */
export const VENDOR_FILES = {
  "leaflet.js": "leaflet/dist/leaflet.js",
  "leaflet.css": "leaflet/dist/leaflet.css",
  "leaflet-heat.js": "leaflet.heat/dist/leaflet-heat.js",
  "html-to-image.js": "html-to-image/dist/html-to-image.js",
  "images/layers.png": "leaflet/dist/images/layers.png",
  "images/layers-2x.png": "leaflet/dist/images/layers-2x.png",
  "images/marker-icon.png": "leaflet/dist/images/marker-icon.png",
  "images/marker-icon-2x.png": "leaflet/dist/images/marker-icon-2x.png",
  "images/marker-shadow.png": "leaflet/dist/images/marker-shadow.png",
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
    copyFileSync(join(NODE_MODULES, source), destination);
  }
  /** @type {Record<string, string>} */
  const versions = {};
  for (const name of ["leaflet", "leaflet.heat", "html-to-image"]) {
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

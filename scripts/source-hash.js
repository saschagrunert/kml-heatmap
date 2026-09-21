/**
 * Content hash of the frontend sources and the build configuration.
 *
 * build.js stamps it into the bundle banner, and the e2e global setup reads
 * the banner back to refuse a site that was built from other sources. Both
 * import it from here so the two can never hash differently. The build
 * script, the compiler options, the esbuild version and the version of every package bundled into the
 * page (only Lucide: MapLibre is vendored next to the bundles) shape the bundle as much as the
 * sources do, so they are part of the hash.
 *
 * The stylesheets are in it as well. They are not part of any bundle, but
 * they are part of what a built site renders, and the visual snapshots
 * compare exactly that: without them a stylesheet-only change left `docs/`
 * stale and nothing said so.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND_DIR = join(REPO_ROOT, "kml_heatmap/frontend");
/** Files outside the sources that change what a built site renders */
const BUILD_FILES = [
  "build.js",
  "tsconfig.json",
  "kml_heatmap/static/styles.css",
  "kml_heatmap/static/features.css",
].map((name) => join(REPO_ROOT, name));

/**
 * Packages whose pinned version changes the bundles: the bundler and what
 * it bundles from node_modules. Hashed in this order, after the files.
 */
const BUILD_PACKAGES = ["esbuild", "lucide"];

/**
 * The version package-lock.json pins for each of BUILD_PACKAGES
 * @returns {string[]}
 */
function buildPackageVersions() {
  const lock = JSON.parse(
    readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8"),
  );
  return BUILD_PACKAGES.map(
    (name) =>
      `${name} ${String(lock.packages[`node_modules/${name}`].version)}`,
  );
}

/** First line of every bundle; the capture group is the source hash */
export const BANNER_PATTERN = /^\/\* kml-heatmap build ([0-9a-f]{12}) \*\//;

/**
 * Recursively list files under a directory
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      // Only the sources: an editor's swap file must not change the hash
      files.push(path);
    }
  }
  return files.sort();
}

/**
 * Hash of all frontend sources and the build configuration (deterministic,
 * independent of git)
 * @returns {string}
 */
export function computeSourceHash() {
  const hash = createHash("sha1");
  for (const file of [...listFiles(FRONTEND_DIR), ...BUILD_FILES]) {
    hash.update(relative(REPO_ROOT, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  for (const version of buildPackageVersions()) {
    hash.update(version);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/**
 * The banner build.js puts at the top of the bundle
 * @param {string} sourceHash
 * @returns {string}
 */
export function buildBanner(sourceHash) {
  return `/* kml-heatmap build ${sourceHash} */`;
}

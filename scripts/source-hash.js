/**
 * Content hash of the frontend sources.
 *
 * build.js stamps it into the bundle banner, and the e2e global setup reads
 * the banner back to refuse a site that was built from other sources. Both
 * import it from here so the two can never hash differently.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND_DIR = join(REPO_ROOT, "kml_heatmap/frontend");

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
 * Hash of all frontend sources (deterministic, independent of git)
 * @returns {string}
 */
export function computeSourceHash() {
  const hash = createHash("sha1");
  for (const file of listFiles(FRONTEND_DIR)) {
    hash.update(relative(REPO_ROOT, file));
    hash.update("\0");
    hash.update(readFileSync(file));
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

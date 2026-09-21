/**
 * Refuse to test a site that does not match the checkout.
 *
 * The specs run against docs/, which Playwright never builds itself. A site
 * generated before the last change used to fail (or pass) locally for reasons
 * unrelated to the change at hand. build.js stamps the hash of the frontend
 * sources into the first line of the bundle, so a mismatch with the sources
 * on disk is caught here, before any spec starts. The stylesheet, the page
 * template and the generator are not part of the bundle; a site older than
 * any of them is refused too.
 *
 * CI builds one site with a dummy tile API key and one without, and says
 * which through E2E_API_KEYS ("dummy" or "none"). A build that lost its key
 * fails here instead of quietly skipping the specs that need one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  BANNER_PATTERN,
  computeSourceHash,
  REPO_ROOT,
} from "../../scripts/source-hash.js";

/** The directory the web server serves and the specs test */
export const SITE_DIR = join(REPO_ROOT, "docs");

const REBUILD_HINT =
  "rebuild it with `npm run build && python -m kml_heatmap data --output-dir docs`";

/** A file of the site; one that is missing says how to build the site */
export function readSiteBytes(name: string): Buffer {
  try {
    return readFileSync(join(SITE_DIR, name));
  } catch {
    throw new Error(`docs/${name} is missing; ${REBUILD_HINT}`);
  }
}

export function readSiteFile(name: string): string {
  return readSiteBytes(name).toString("utf8");
}

function checkBuildHash(): void {
  const built = BANNER_PATTERN.exec(readSiteFile("mapApp.bundle.js"))?.[1];
  const current = computeSourceHash();
  if (built !== current) {
    throw new Error(
      `docs/ was built from other frontend sources (bundle ${built ?? "without a build hash"}, ` +
        `sources ${current}); ${REBUILD_HINT}`,
    );
  }
}

/**
 * Files the generator copies or renders into the site, besides the bundle,
 * and the dependency lock: a bumped MapLibre or esbuild changes what the
 * site serves and what the bundle contains
 */
function generatorSources(): string[] {
  const packageDir = join(REPO_ROOT, "kml_heatmap");
  const inDir = (dir: string, suffix: string): string[] =>
    readdirSync(join(packageDir, dir))
      .filter((name) => name.endsWith(suffix))
      .map((name) => join(packageDir, dir, name));
  return [
    ...inDir(".", ".py"),
    // Every static asset but the bundle and its map, which checkBuildHash
    // covers and which a build in between refreshes anyway
    ...inDir("static", "").filter((file) => !file.includes(".bundle.js")),
    ...inDir("templates", ""),
    join(REPO_ROOT, "package-lock.json"),
  ];
}

function checkSiteAge(): void {
  readSiteFile("index.html");
  const built = statSync(join(SITE_DIR, "index.html")).mtimeMs;
  const newer = generatorSources().filter(
    (file) => statSync(file).mtimeMs > built,
  );
  if (newer.length > 0) {
    const names = newer.map((file) => file.slice(REPO_ROOT.length + 1));
    throw new Error(`docs/ is older than ${names.join(", ")}; ${REBUILD_HINT}`);
  }
}

function checkApiKeys(): void {
  const expected = process.env["E2E_API_KEYS"];
  if (expected === undefined) return;
  if (expected !== "dummy" && expected !== "none") {
    throw new Error(
      `E2E_API_KEYS must be "dummy" or "none", not "${expected}"`,
    );
  }

  const sandbox: {
    window: { MAP_CONFIG?: { cartoApiKey?: string } };
  } = { window: {} };
  runInNewContext(readSiteFile("map_config.js"), sandbox);
  const present = !!sandbox.window.MAP_CONFIG?.cartoApiKey;
  if (present !== (expected === "dummy")) {
    throw new Error(
      `E2E_API_KEYS=${expected}, but docs/map_config.js ${present ? "carries" : "lacks"} cartoApiKey`,
    );
  }
}

export default function globalSetup(): void {
  checkBuildHash();
  checkSiteAge();
  checkApiKeys();
}

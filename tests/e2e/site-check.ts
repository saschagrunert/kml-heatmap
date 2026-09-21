/**
 * Refuse to test a site that does not match the checkout.
 *
 * The specs run against docs/ or visual-site/ (see sites.ts), which
 * Playwright never builds itself. A site generated before the last change
 * used to fail (or pass) locally for reasons unrelated to the change at
 * hand. build.js stamps the hash of the frontend
 * sources into the first line of the bundle, so a mismatch with the sources
 * on disk is caught here, before any spec drives it. The stylesheet, the page
 * template and the generator are not part of the bundle; a site older than
 * any of them is refused too.
 *
 * CI builds one site with a dummy tile API key and one without, and says
 * which through E2E_API_KEYS ("dummy" or "none"). A build that lost its key
 * fails here instead of quietly skipping the specs that need one.
 *
 * The check runs from a worker fixture (fixtures.ts), once per worker and
 * for the site of that worker's project. A global setup sees every project
 * of the config, not the ones selected, so it would ask the visual job for
 * docs/ and the functional ones for visual-site/. Setup projects that the
 * others depend on get that right, but Playwright's UI mode and the editor
 * extensions skip dependencies by default and `--no-deps` always does, and
 * somebody who changed a source and went straight to the UI is who this is
 * for. The price is that a stale site fails every test with the same
 * message instead of stopping the run once.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  BANNER_PATTERN,
  computeSourceHash,
  REPO_ROOT,
} from "../../scripts/source-hash.js";
import { type Site, type SiteName, SITES } from "./sites";

function rebuildHint(site: Site): string {
  return `rebuild it with \`${site.rebuild}\``;
}

/** A file of the site; one that is missing says how to build the site */
export function readSiteBytes(site: Site, name: string): Buffer {
  try {
    return readFileSync(join(REPO_ROOT, site.dir, name));
  } catch {
    throw new Error(`${site.dir}/${name} is missing; ${rebuildHint(site)}`);
  }
}

export function readSiteFile(site: Site, name: string): string {
  return readSiteBytes(site, name).toString("utf8");
}

function checkBuildHash(site: Site): void {
  const bundle = readSiteFile(site, "mapApp.bundle.js");
  const built = BANNER_PATTERN.exec(bundle)?.[1];
  const current = computeSourceHash();
  if (built !== current) {
    throw new Error(
      `${site.dir}/ was built from other frontend sources (bundle ${built ?? "without a build hash"}, ` +
        `sources ${current}); ${rebuildHint(site)}`,
    );
  }
}

/**
 * Files the generator copies or renders into the site, besides the bundle,
 * and the dependency lock: a bumped MapLibre or esbuild changes what the
 * site serves and what the bundle contains
 */
function generatorSources(site: Site): string[] {
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
    ...siteInputs(site),
  ];
}

/**
 * What only the fixture site is made of. data/ is left out on purpose: the
 * functional specs hold for any set of flights, the snapshots only for the
 * flights they were taken with.
 */
function siteInputs(site: Site): string[] {
  if (site !== SITES.visual) return [];
  const fixtureDir = join(REPO_ROOT, "tests", "fixtures", "visual");
  return [
    // The directory itself as well: deleting or renaming a flight leaves no
    // file behind that is newer than the site, but it touches the directory
    fixtureDir,
    ...readdirSync(fixtureDir).map((name) => join(fixtureDir, name)),
    join(REPO_ROOT, "tests", "fixtures", "airports.csv"),
    join(REPO_ROOT, "scripts", "build_visual_site.py"),
  ];
}

function checkSiteAge(site: Site): void {
  readSiteFile(site, "index.html");
  const built = statSync(join(REPO_ROOT, site.dir, "index.html")).mtimeMs;
  const newer = generatorSources(site).filter(
    (file) => statSync(file).mtimeMs > built,
  );
  if (newer.length > 0) {
    const names = newer.map((file) => file.slice(REPO_ROOT.length + 1));
    throw new Error(
      `${site.dir}/ is older than ${names.join(", ")}; ${rebuildHint(site)}`,
    );
  }
}

/** Only docs/ is built with and without keys; the fixture site never has any */
function checkApiKeys(site: Site): void {
  if (site !== SITES.docs) return;
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
  runInNewContext(readSiteFile(site, "map_config.js"), sandbox);
  const present = !!sandbox.window.MAP_CONFIG?.cartoApiKey;
  if (present !== (expected === "dummy")) {
    throw new Error(
      `E2E_API_KEYS=${expected}, but ${site.dir}/map_config.js ${present ? "carries" : "lacks"} cartoApiKey`,
    );
  }
}

export function checkSite(name: SiteName): void {
  const site = SITES[name];
  checkBuildHash(site);
  checkSiteAge(site);
  checkApiKeys(site);
}

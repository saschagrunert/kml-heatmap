/**
 * Refuse to test a site that does not match the checkout.
 *
 * The specs run against docs/ or visual-site/ (see sites.ts), which
 * Playwright never builds itself. A site generated before the last change
 * used to fail (or pass) locally for reasons unrelated to the change at
 * hand. build.js stamps the hash of the frontend
 * sources into the first line of the bundle, so a mismatch with the sources
 * on disk is caught here, before any spec drives it. The page template, the
 * icons and the generator are not part of the bundle: map_config.js carries
 * the hash of those ("generator"), and the fixture site the hash of its
 * flights and databases (fixture.sha1). Hashes rather than modification
 * times, which the build sets to the build day (and the fixture site to a
 * day of 2025) on purpose: a site built in the morning was refused after a
 * source edit in the afternoon, and the fixture site on every local run.
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  BANNER_PATTERN,
  computeFixtureHash,
  computeGeneratorHash,
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

/** The window.MAP_CONFIG that the site's map_config.js sets */
function readMapConfig(site: Site): Record<string, unknown> {
  const sandbox: { window: { MAP_CONFIG?: Record<string, unknown> } } = {
    window: {},
  };
  runInNewContext(readSiteFile(site, "map_config.js"), sandbox);
  return sandbox.window.MAP_CONFIG ?? {};
}

/**
 * The generator the site was built with: the Python package, its templates
 * and the files of its static directory besides the bundles, which
 * checkBuildHash covers along with the packages a build pins
 */
function checkGenerator(site: Site): void {
  const built = readMapConfig(site)["generator"];
  const current = computeGeneratorHash();
  if (built !== current) {
    const shown =
      typeof built === "string" && built ? built : "without a generator hash";
    throw new Error(
      `${site.dir}/ was built by another generator (site ${shown}, ` +
        `checkout ${current}); ${rebuildHint(site)}`,
    );
  }
}

/**
 * What only the fixture site is made of (computeFixtureHash), which
 * scripts/build_visual_site.py hashes into fixture.sha1 after a build.
 * data/ is left out on purpose: the functional specs hold for any set of
 * flights, the snapshots only for the flights they were taken with.
 */
function checkSiteInputs(site: Site): void {
  if (site !== SITES.visual) return;
  const current = computeFixtureHash();
  const built = readSiteFile(site, "fixture.sha1").trim();
  if (built !== current) {
    throw new Error(
      `${site.dir}/ was built from another fixture (site ${built || "without a hash"}, ` +
        `checkout ${current}); ${rebuildHint(site)}`,
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

  const present = !!readMapConfig(site)["cartoApiKey"];
  if (present !== (expected === "dummy")) {
    throw new Error(
      `E2E_API_KEYS=${expected}, but ${site.dir}/map_config.js ${present ? "carries" : "lacks"} cartoApiKey`,
    );
  }
}

export function checkSite(name: SiteName): void {
  const site = SITES[name];
  checkBuildHash(site);
  checkGenerator(site);
  checkSiteInputs(site);
  checkApiKeys(site);
}

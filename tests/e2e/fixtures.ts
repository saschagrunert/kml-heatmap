/**
 * Hermetic Playwright test fixture.
 *
 * The generated page loads Leaflet, leaflet.heat and dom-to-image from CDNs
 * and its base map from the CARTO and OpenAIP tile servers. An outage of any
 * of them used to fail the whole suite, and a slow tile server made timings
 * unpredictable. The `hermetic` fixture answers those requests locally: the
 * CDN files come from the identically versioned npm packages in
 * node_modules (the same bytes, so the subresource integrity hashes in the
 * template still match) and every tile is a transparent pixel.
 *
 * Every spec imports `test` and `expect` from here instead of
 * "@playwright/test" so the fixture is active everywhere.
 */
import { test as base, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import type { BrowserContext, Route } from "@playwright/test";

const require = createRequire(import.meta.url);

/** Version pins of the packages the template loads, from package.json */
const PACKAGE_VERSIONS: Record<string, string> = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { devDependencies: Record<string, string> }
).devDependencies;

/** A 1x1 transparent PNG, served for every map tile */
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Root directory of an installed npm package */
function packageRoot(name: string): string {
  const manifest = require.resolve(`${name}/package.json`);
  return dirname(manifest);
}

/**
 * Map a CDN URL such as
 *   https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
 *   https://cdn.jsdelivr.net/npm/dom-to-image@2.6.0/dist/dom-to-image.min.js
 * to the same file inside node_modules. Returns null for anything that is
 * not a pinned package file, so the request fails loudly instead of quietly
 * going to the network.
 */
function localFileForCdnUrl(url: URL): string | null {
  const path = url.pathname.replace(/^\/npm\//, "/");
  const match = /^\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.+)$/.exec(path);
  if (!match) return null;
  const [name, version, file] = match.slice(1) as [string, string, string];
  if (PACKAGE_VERSIONS[name] !== version) {
    throw new Error(
      `${url.href} asks for ${name}@${version} but package.json pins ` +
        `${PACKAGE_VERSIONS[name] ?? "nothing"}; keep the template and the ` +
        "devDependencies in step",
    );
  }
  const root = packageRoot(name);
  const candidate = resolve(root, file);
  // Stay inside the package directory
  if (!candidate.startsWith(root + sep)) return null;
  return existsSync(candidate) ? candidate : null;
}

async function serveFromNodeModules(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const file = localFileForCdnUrl(url);
  if (!file) {
    await route.abort("blockedbyclient");
    return;
  }
  const extension = file.slice(file.lastIndexOf("."));
  await route.fulfill({
    path: file,
    contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
    // The template loads the scripts with crossorigin="anonymous"
    headers: { "access-control-allow-origin": "*" },
  });
}

async function serveTransparentTile(route: Route): Promise<void> {
  await route.fulfill({ body: TRANSPARENT_PNG, contentType: "image/png" });
}

/** Install the routes on a browser context */
export async function installHermeticRoutes(
  context: BrowserContext,
): Promise<void> {
  await context.route(/^https:\/\/unpkg\.com\//, serveFromNodeModules);
  await context.route(
    /^https:\/\/cdn\.jsdelivr\.net\/npm\//,
    serveFromNodeModules,
  );
  await context.route(
    /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\//,
    serveTransparentTile,
  );
  await context.route(
    /^https:\/\/[a-z]\.api\.tiles\.openaip\.net\//,
    serveTransparentTile,
  );
}

export const test = base.extend<{ hermetic: void }>({
  hermetic: [
    async ({ context }, use) => {
      await installHermeticRoutes(context);
      await use();
    },
    { auto: true },
  ],
});

export { expect };
export type { BrowserContext, Locator, Page } from "@playwright/test";

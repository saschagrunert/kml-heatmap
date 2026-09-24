/**
 * Hermetic Playwright test fixture.
 *
 * The page carries its own JavaScript and CSS (see scripts/vendor.js), so
 * the only third parties left are CARTO, for the base map, the open
 * flightmaps tile server, AWS for the elevation tiles of the 3D view's
 * relief, and EOX for the satellite imagery. An outage of any used to fail
 * the whole suite and a slow one made timings unpredictable, so none is
 * ever reached: the base style is
 * answered with one that draws a background and asks for nothing else,
 * every elevation tile with flat ground (TERRAIN_ELEVATION_M), or a slope
 * for a spec that asks for one (`terrain`), and every other tile with a
 * transparent pixel.
 *
 * Any other cross-origin request fails the test that made it. The page is
 * meant to need nothing but its own host; a dependency that creeps back
 * onto a CDN would otherwise only show up as a blank map for visitors.
 *
 * Every spec imports `test` and `expect` from here instead of
 * "@playwright/test" so the fixture is active everywhere. For the same
 * reason this is where a stale site is refused (see site-check.ts).
 */
import { crc32, deflateSync } from "node:zlib";
import { test as base, expect } from "@playwright/test";
import type { BrowserContext, Page, Route } from "@playwright/test";
import { checkSite } from "./site-check";
import type { SiteOptions } from "./sites";

/**
 * A 1x1 transparent PNG, served for every map tile. A well-formed one: the
 * map decodes its tiles with createImageBitmap, which refuses a file whose
 * checksums are off where an <img> would still draw it.
 */
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  "base64",
);

/**
 * The ground every elevation tile has: flat, so the relief draws the same
 * on every run, and above sea level, so a spec can tell the relief is
 * there by the flights standing on it
 */
export const TERRAIN_ELEVATION_M = 500;

/**
 * The ground the elevation tiles answer with: flat, the default, or the
 * slope of slopeElevationM, for a spec where the relief is the point
 */
export type TerrainFixture = "flat" | "slope";

/** How far apart the ridges of the slope are, in degrees of longitude */
const SLOPE_PERIOD_DEG = 1;
/** How high the ridges rise above the valleys of the slope */
const SLOPE_RISE_M = 1000;

/**
 * The ground of the slope at a longitude, in metres: it rises by the same
 * gradient eastwards from TERRAIN_ELEVATION_M at every whole degree to
 * SLOPE_RISE_M more half a degree on, and falls back as much to the next
 * whole degree. A ramp across the whole world would leave the range the
 * tiles can hold; this one repeats, and like a ramp it does not depend on
 * where the flights of data/ are. It depends on the longitude alone, so it
 * is the same on both sides of a tile border and at every tile level:
 * the map samples the tiles bilinearly, and gets it back between the
 * ridges to a metre or two.
 */
export function slopeElevationM(lng: number): number {
  const phase = (((lng / SLOPE_PERIOD_DEG) % 1) + 1) % 1;
  return TERRAIN_ELEVATION_M + SLOPE_RISE_M * (1 - Math.abs(1 - 2 * phase));
}

/**
 * A Terrarium tile (256 pixels square, RGB) with `elevationM` of the
 * longitude of each column: red * 256 + green + blue / 256 - 32768 metres.
 * A transparent pixel would decode to -32768 m, and a tile of another size
 * is refused.
 */
function terrariumTile(
  z: number,
  x: number,
  elevationM: (lng: number) => number,
): Buffer {
  const size = 256;
  // A pixel stands for the ground at its centre, as the map reads it
  const pixels = Array.from({ length: size }, (_, column) => {
    const lng = ((x + (column + 0.5) / size) / 2 ** z) * 360 - 180;
    const value = elevationM(lng) + 32768;
    return [
      Math.floor(value / 256),
      Math.floor(value) % 256,
      Math.floor((value % 1) * 256),
    ];
  });
  // Every line starts with its filter type, 0 for none
  const line = Buffer.from([0, ...pixels.flat()]);
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(size).fill(line)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const FLAT_TERRAIN_TILE = terrariumTile(0, 0, () => TERRAIN_ELEVATION_M);

/** The tile of the slope at `url`, a Terrarium tile's /{z}/{x}/{y}.png */
function slopeTerrainTile(url: string): Buffer {
  const match = /\/(\d+)\/(\d+)\/\d+\.png$/.exec(url);
  if (!match) throw new Error(`not an elevation tile: ${url}`);
  return terrariumTile(Number(match[1]), Number(match[2]), slopeElevationM);
}

/** The label layer of the style `holdBaseStyle` answers with */
export const BASE_STYLE_LABELS = "place-labels";

/**
 * The base style the page gets in place of CARTO's: a background and one
 * raster layer whose tiles the fixture answers itself. Without glyphs or a
 * sprite the map is ready after this one answer. The raster source is there
 * for its credit: the map shows the attribution of the sources it draws, so
 * a style without one would leave the tile credit, which the specs check,
 * empty. The colour is the one of the real style's background, so
 * screenshots keep their dark map.
 */
const STUB_STYLE = {
  version: 8,
  name: "hermetic",
  sources: {
    base: {
      type: "raster",
      tiles: ["https://tiles.basemaps.cartocdn.com/stub/{z}/{x}/{y}.png"],
      tileSize: 512,
      attribution:
        '&copy; <a href="https://carto.com/about-carto/">CARTO</a>, &copy; <a href="http://www.openstreetmap.org/about/">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#0e0e0e" },
    },
    { id: "base", type: "raster", source: "base" },
  ],
};

/**
 * The stub with a label layer on top, which the real style has and the data
 * layers have to stay below. The layer draws nothing (no text, no icon), so
 * it asks for no glyphs and no sprite either.
 */
const LABELLED_STUB_STYLE = {
  ...STUB_STYLE,
  sources: {
    ...STUB_STYLE.sources,
    places: {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    },
  },
  layers: [
    ...STUB_STYLE.layers,
    { id: BASE_STYLE_LABELS, type: "symbol", source: "places" },
  ],
};

/** The origins the page is allowed to reach */
const CARTO_STYLE_HOST = "basemaps.cartocdn.com";
const TILE_HOSTS = [
  // Vector tiles come from tiles-a to tiles-d, glyphs and the sprite from
  // tiles; the stub style asks for none of them, but a request that does
  // get out is answered rather than failing the test for CARTO's layout
  /^tiles(-[a-d])?\.basemaps\.cartocdn\.com$/,
  /^nwy-tiles-api\.prod\.newaydata\.com$/,
  /^s3\.amazonaws\.com$/,
  // The satellite imagery: JPEG tiles, but the map decodes the stub's PNG
  // by its content, not by the name
  /^tiles\.maps\.eox\.at$/,
];

/** The site under test, served by the webServer in playwright.config.ts */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isBaseStyle(url: URL): boolean {
  return (
    url.hostname === CARTO_STYLE_HOST &&
    url.pathname.endsWith("/dark-matter-gl-style/style.json")
  );
}

function isTile(url: URL): boolean {
  return TILE_HOSTS.some((host) => host.test(url.hostname));
}

function isSite(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname);
}

async function serveTile(route: Route, ground: TerrainFixture): Promise<void> {
  const url = route.request().url();
  let body: Buffer = TRANSPARENT_PNG;
  if (url.includes("/terrarium/")) {
    body = ground === "slope" ? slopeTerrainTile(url) : FLAT_TERRAIN_TILE;
  }
  await route.fulfill({
    body,
    contentType: "image/png",
    // MapLibre fetches its tiles, so they are subject to CORS
    headers: { "access-control-allow-origin": "*" },
  });
}

async function serveStubStyle(route: Route): Promise<void> {
  await route.fulfill({
    json: STUB_STYLE,
    headers: { "access-control-allow-origin": "*" },
  });
}

/**
 * Keep the base style from arriving until the returned function is called,
 * which answers with the labelled stub. For a page that has not been opened
 * yet; a route of the page goes before the one of the context.
 */
export async function holdBaseStyle(page: Page): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(isBaseStyle, async (route) => {
    await held;
    await route.fulfill({
      json: LABELLED_STUB_STYLE,
      headers: { "access-control-allow-origin": "*" },
    });
  });
  return release;
}

/** Fail every request for the base style, the way a dead network does */
export async function failBaseStyle(page: Page): Promise<void> {
  await page.route(isBaseStyle, (route) => route.abort("failed"));
}

/**
 * Install the routes on a browser context.
 *
 * Returns the list that collects forbidden requests, so a caller can assert
 * on it; the fixture below fails the test when it is not empty. The
 * predicates are mutually exclusive, so it does not matter in which order
 * Playwright matches them.
 */
async function installHermeticRoutes(
  context: BrowserContext,
  ground: TerrainFixture,
): Promise<string[]> {
  const offSite: string[] = [];
  await context.route(isBaseStyle, serveStubStyle);
  await context.route(isTile, (route) => serveTile(route, ground));
  await context.route(
    (url) => !isSite(url) && !isTile(url) && !isBaseStyle(url),
    async (route) => {
      offSite.push(route.request().url());
      await route.abort("blockedbyclient");
    },
  );
  return offSite;
}

export const test = base.extend<
  { hermetic: void; terrain: TerrainFixture },
  SiteOptions & { currentSite: void }
>({
  // The ground of the elevation tiles, for `test.use` in a spec
  terrain: ["flat", { option: true }],
  // Which generated site the project drives; playwright.config.ts sets it
  // for the projects that do not use docs/
  site: ["docs", { option: true, scope: "worker" }],
  currentSite: [
    async ({ site }, use) => {
      checkSite(site);
      await use();
    },
    { auto: true, scope: "worker" },
  ],
  hermetic: [
    async ({ context, terrain }, use) => {
      const offSite = await installHermeticRoutes(context, terrain);
      await use();
      expect(
        offSite,
        "the page requested a third-party URL; it is meant to carry its " +
          "own assets and work offline",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
export type { Locator, Page } from "@playwright/test";

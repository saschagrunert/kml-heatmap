/**
 * The data the page opens on is preloaded, and fetched once.
 *
 * The template asks for the two index files and the latest year before
 * Leaflet and the bundle have run. The loader's fetch() then has to take
 * those responses instead of downloading the largest file of the page a
 * second time, which it only does when the preload and the fetch agree on
 * the URL and on the request mode (the `crossorigin` on the link).
 */
import { test, expect } from "./fixtures";
import { waitForPathData } from "./helpers";

test("the first data files are preloaded and fetched once", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => {
    const file = request.url().split("/data/")[1];
    if (file?.endsWith(".json")) requested.push(file);
  });

  await page.goto("/index.html");
  await waitForPathData(page);

  const latest = await page.evaluate(() =>
    Math.max(...window.KML_METADATA!.available_years),
  );
  const preloaded = await page
    .locator('link[rel="preload"][as="fetch"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(preloaded).toEqual([
    "data/metadata.json",
    "data/airports.json",
    `data/${latest}/data.json`,
  ]);
  expect(requested.sort()).toEqual(
    [`${latest}/data.json`, "airports.json", "metadata.json"].sort(),
  );
});

test("the modules the app imports are preloaded", async ({ page }) => {
  await page.goto("/index.html");

  // The chunk the bundle shares with the lazy ones, and the map library with
  // the module it imports in turn: all three are needed before anything
  // draws, and none is discovered until the one before it has been parsed
  const preloaded = await page
    .locator('link[rel="modulepreload"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(preloaded).toEqual([
    "./shared.bundle.js",
    "./vendor/maplibre-gl.mjs",
    "./vendor/maplibre-gl-shared.mjs",
  ]);
});

/**
 * Opening the generated index.html straight from disk.
 *
 * The README promises that file:// works as well as serving the site, and
 * that is why the bundle is an IIFE and the data files are scripts rather
 * than JSON. Every other spec goes through the web server, so this one
 * loads the same docs/ from disk.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "./fixtures";
import { SITE_DIR } from "./global-setup";
import {
  attachErrorCollectors,
  relevantConsoleErrors,
  waitForAppReady,
  waitForPathData,
} from "./helpers";

test("the site works when opened from disk", async ({ page }) => {
  const errors = await attachErrorCollectors(page);

  await page.goto(pathToFileURL(join(SITE_DIR, "index.html")).href);
  await waitForAppReady(page);

  expect(page.url()).toMatch(/^file:/);
  await expect(page.locator(".airport-marker").first()).toBeAttached();
  expect(
    await page.evaluate(() => window.KML_METADATA?.available_years.length),
  ).toBeGreaterThan(0);
  // The per-year path data is loaded on demand, from disk as well
  await waitForPathData(page);

  expect(errors.pageErrors).toEqual([]);
  expect(errors.cspViolations).toEqual([]);
  expect(relevantConsoleErrors(errors)).toEqual([]);
});

for (const origin of ["disk", "server"] as const) {
  test(`the latest year is preloaded and fetched once (${origin})`, async ({
    page,
  }) => {
    // The page asks for the year it opens on before Leaflet and the bundle
    // have run; the loader's script tag then has to take that response
    // instead of downloading the largest file of the page a second time
    const requested: string[] = [];
    page.on("request", (request) => {
      if (/\/data\/\d{4}\/data\.js$/.test(request.url())) {
        requested.push(request.url().split("/data/")[1]!);
      }
    });

    await page.goto(
      origin === "disk"
        ? pathToFileURL(join(SITE_DIR, "index.html")).href
        : "/index.html",
    );
    await waitForPathData(page);

    const latest = await page.evaluate(() =>
      Math.max(...window.KML_METADATA!.available_years),
    );
    await expect(
      page.locator('link[rel="preload"][as="script"]'),
    ).toHaveAttribute("href", `data/${latest}/data.js`);
    expect(requested).toEqual([`${latest}/data.js`]);
  });
}

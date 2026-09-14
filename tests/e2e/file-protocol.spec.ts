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

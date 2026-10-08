/**
 * The search of airports and places (ui/locationSearch.ts) in the page:
 * its own bundle and stylesheet, the airports of the site found as one
 * types, the places of Photon after a pause, and what a pick does.
 *
 * Photon never sees these tests: every request to it is answered here
 * (page.route, ahead of the fixture's routes, which would fail the test on
 * a request that leaves the site). Its answers are counted, so a request
 * for every keystroke, or one the page should have kept, fails.
 */
import { test, expect, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { mapPopup } from "./map";

/** Photon's answer to any text: one city with its extent */
const ANSWER = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [9.18, 48.78] },
      properties: {
        name: "Stuttgart",
        type: "city",
        osm_value: "city",
        state: "Baden-Württemberg",
        country: "Germany",
        extent: [9.03, 48.87, 9.32, 48.69],
      },
    },
  ],
};

/**
 * Answer Photon with ANSWER, or fail its requests, and return the texts
 * it was asked for
 */
async function stubPhoton(page: Page, fail = false): Promise<string[]> {
  const asked: string[] = [];
  await page.route(
    (url) => url.hostname === "photon.komoot.io",
    async (route) => {
      asked.push(new URL(route.request().url()).searchParams.get("q") ?? "");
      if (fail) await route.abort("failed");
      else await route.fulfill({ json: ANSWER });
    },
  );
  return asked;
}

/** The first airport of the site that has an ICAO code */
async function anAirport(page: Page): Promise<{ name: string; code: string }> {
  const airport = await page.evaluate(() =>
    window.mapApp!.siteData.airports!.find((a) => a.code),
  );
  expect(airport, "the site has an airport with a code").toBeTruthy();
  return { name: airport!.name, code: airport!.code! };
}

const panel = (page: Page) => page.locator("#location-search");
const field = (page: Page) => page.getByRole("combobox", { name: /search/i });
const option = (page: Page, name: string | RegExp) =>
  page.getByRole("option", { name });

test.describe("the search @desktop", () => {
  test("is not fetched by a visit that does not search", async ({ page }) => {
    const fetched: string[] = [];
    page.on("request", (request) => {
      if (/\/search\.(bundle\.js|css)/.test(request.url())) {
        fetched.push(request.url());
      }
    });
    await gotoApp(page);

    expect(fetched).toEqual([]);
  });

  test("opens with /, and finds an airport without asking Photon", async ({
    page,
  }) => {
    const asked = await stubPhoton(page);
    await gotoApp(page);
    const airport = await anAirport(page);

    await page.locator("body").press("/");

    await expect(panel(page)).toBeVisible();
    await expect(field(page)).toBeFocused();
    await expect(page.locator("#search-btn")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(panel(page)).toContainText(
      "Search by Photon, data © OpenStreetMap",
    );

    // Two letters are not sent anywhere. The list holds the best five, and
    // many codes may start with the same two letters, so this airport need
    // not be among them: some airport is
    await field(page).fill(airport.code.slice(0, 2));
    await expect(
      page.getByRole("group", { name: "Airports" }).getByRole("option").first(),
    ).toBeVisible();
    await field(page).press("ArrowDown");
    await expect(field(page)).toHaveAttribute(
      "aria-activedescendant",
      /location-search-results-\d+/,
    );
    await field(page).press("Escape");
    await expect(panel(page)).toBeHidden();
    expect(asked).toEqual([]);
  });

  test("flies to an airport and opens its popup, selecting nothing", async ({
    page,
  }) => {
    await stubPhoton(page);
    await gotoApp(page);
    const airport = await anAirport(page);

    await page.locator("#search-btn").click();
    await field(page).fill(airport.code);
    await option(page, airport.name).click();

    await expect(panel(page)).toBeHidden();
    await expect(mapPopup(page)).toBeVisible({ timeout: 15000 });
    await expect(mapPopup(page)).toContainText(airport.name);
    expect(await page.evaluate(() => window.mapApp!.selectedPathIds.size)).toBe(
      0,
    );
  });

  test("asks Photon once after a pause, and marks the place it picks", async ({
    page,
  }) => {
    const asked = await stubPhoton(page);
    await gotoApp(page);

    await page.locator("#search-btn").click();
    await field(page).pressSequentially("Stuttgart", { delay: 20 });

    await expect(option(page, /^Stuttgart/)).toBeVisible();
    expect(asked).toEqual(["stuttgart"]);
    await expect(option(page, /^Stuttgart/)).toContainText(
      "City · Baden-Württemberg, Germany",
    );

    // The same text again is answered from what the page kept
    await field(page).fill("Stuttgar");
    await field(page).fill("Stuttgart");
    await expect(option(page, /^Stuttgart/)).toBeVisible();
    expect(asked).toEqual(["stuttgart"]);

    await option(page, /^Stuttgart/).click();
    await expect(panel(page)).toBeHidden();
    const pin = page.locator(".location-search-pin");
    await expect(pin).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const center = window.mapApp!.map!.getCenter();
          return (
            Math.abs(center.lng - 9.18) < 0.2 &&
            Math.abs(center.lat - 48.78) < 0.2
          );
        }),
      )
      .toBe(true);

    await page.locator("body").press("Escape");
    await expect(pin).toHaveCount(0);
  });

  test("says quietly when Photon cannot be reached", async ({ page }) => {
    await stubPhoton(page, true);
    await gotoApp(page);
    const airport = await anAirport(page);

    await page.locator("#search-btn").click();
    await field(page).fill(airport.code);
    await field(page).press("Enter");

    // Enter took the airport listed first, without waiting for Photon
    await expect(panel(page)).toBeHidden();

    await page.locator("#search-btn").click();
    await field(page).fill("Nowhere");
    await field(page).press("Enter");
    await expect(page.locator(".location-search-status")).toHaveText(
      /could not be searched/,
    );
  });
});

test.describe("the search on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("opens from the More sheet, across the top of the map", async ({
    page,
  }) => {
    await stubPhoton(page);
    await gotoApp(page);

    await page.locator("#mobile-tab-more").click();
    await page.locator('.sheet-row[data-row="search"]').click();

    await expect(panel(page)).toBeVisible();
    await expect(page.locator("#mobile-sheet")).toBeHidden();
    await expect(field(page)).toBeFocused();
    const box = (await panel(page).boundingBox())!;
    expect(box.y).toBeLessThan(40);
    expect(box.width).toBeGreaterThan(300);
  });
});

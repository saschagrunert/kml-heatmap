/**
 * The map and its dialogs worked by keyboard alone.
 *
 * A keyboard cannot click a path, and a click on a path used to be the only
 * way to select a single flight, so replay was out of its reach. These specs
 * walk the airport popup, the replay timeline and the year in review the way
 * a keyboard user does.
 */
import { test, expect, type Page } from "./fixtures";
import {
  activateReplay,
  gotoApp,
  openWrapped,
  waitForAppReady,
  waitForPathData,
} from "./helpers";

/**
 * Centre the map on the airport with the most flights and focus its marker.
 * Returns the airport and how many flights it lists.
 */
async function focusBusiestAirport(
  page: Page,
): Promise<{ name: string; flights: number }> {
  await waitForPathData(page);
  return page.evaluate(() => {
    const app = window.mapApp!;
    const [name, ids] = Object.entries(app.airportToPaths).sort(
      (a, b) => b[1].size - a[1].size,
    )[0]!;
    const marker = app.airportMarkers[name]!;
    app.map!.setView(marker.getLatLng(), 10, { animate: false });
    marker.getElement()!.focus();
    return { name, flights: ids.size };
  });
}

function markerIsFocused(page: Page, name: string): Promise<boolean> {
  return page.evaluate(
    (airport) =>
      document.activeElement ===
      window.mapApp!.airportMarkers[airport]!.getElement(),
    name,
  );
}

test.describe("Keyboard", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("an airport popup lists its flights and selects a single one", async ({
    page,
  }) => {
    const airport = await focusBusiestAirport(page);
    await page.keyboard.press("Enter");

    // Opened from the keyboard, the popup takes focus
    const popup = page.locator(".leaflet-popup");
    await expect(popup).toBeVisible();
    await expect(popup.locator(".kh-popup-airport")).toBeFocused();

    const flights = popup.locator(".kh-popup-flight");
    await expect(flights).toHaveCount(airport.flights);
    // Route, aircraft and year; never a date or a time of day
    for (const label of await flights.allTextContents()) {
      expect(label).toMatch(/→/);
      expect(label).not.toMatch(/\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}/);
    }

    // Enter on the marker selected every flight of the airport
    await expect(flights.first()).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#replay-btn")).toHaveAttribute(
      "aria-disabled",
      airport.flights === 1 ? "false" : "true",
    );

    await flights.first().focus();
    await page.keyboard.press("Enter");

    await expect
      .poll(() => page.evaluate(() => window.mapApp!.selectedPathIds.size))
      .toBe(1);
    await expect(
      popup.locator('.kh-popup-flight[aria-pressed="true"]'),
    ).toHaveCount(1);
    // Exactly one flight: replay is now within reach
    await expect(page.locator("#replay-btn")).toHaveAttribute(
      "aria-disabled",
      "false",
    );

    // Escape from inside the popup closes it and focus goes back to the
    // marker instead of the page
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    expect(await markerIsFocused(page, airport.name)).toBe(true);
  });

  test("Escape on a focused marker closes its popup", async ({ page }) => {
    const airport = await focusBusiestAirport(page);
    await page.evaluate((name) => {
      window.mapApp!.airportMarkers[name]!.openPopup();
    }, airport.name);
    await expect(page.locator(".leaflet-popup")).toBeVisible();

    await page.evaluate((name) => {
      window.mapApp!.airportMarkers[name]!.getElement()!.focus();
    }, airport.name);
    await page.keyboard.press("Escape");

    await expect(page.locator(".leaflet-popup")).toHaveCount(0);
    expect(await markerIsFocused(page, airport.name)).toBe(true);
  });

  test("a popup opened with the mouse leaves focus alone", async ({ page }) => {
    await focusBusiestAirport(page);
    const marker = await page.evaluate(() => {
      const box = (
        document.activeElement as HTMLElement
      ).getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(marker.x, marker.y);

    await expect(page.locator(".kh-popup-flight").first()).toBeVisible();
    await expect(page.locator(".kh-popup-airport")).not.toBeFocused();
  });

  test("Isolate says it is unavailable without a selection", async ({
    page,
  }) => {
    const isolate = page.locator("#isolate-btn");
    await expect(isolate).toHaveAttribute("aria-disabled", "true");
    // Still focusable, unlike a disabled button
    await isolate.focus();
    await expect(isolate).toBeFocused();

    await focusBusiestAirport(page);
    await page.keyboard.press("Enter");
    await expect(isolate).toHaveAttribute("aria-disabled", "false");
  });

  test("an arrow key moves the replay a hundredth of the flight", async ({
    page,
  }) => {
    await activateReplay(page);
    const slider = page.locator("#replay-slider");
    const max = Number(await slider.getAttribute("max"));
    const step = Math.max(1, Math.round(max / 100));
    const page10 = Math.max(1, Math.round(max / 10));

    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveValue(String(step));
    await page.keyboard.press("PageUp");
    await expect(slider).toHaveValue(String(step + page10));
    await page.keyboard.press("ArrowLeft");
    await expect(slider).toHaveValue(String(page10));
    await expect(slider).toHaveAttribute("aria-valuetext", /^\d.* of \d/);

    // Never past either end
    await page.keyboard.press("PageDown");
    await page.keyboard.press("PageDown");
    await expect(slider).toHaveValue("0");
  });

  test("the airport markers leave the tab order while Wrapped is open", async ({
    page,
  }) => {
    await waitForPathData(page);
    const modal = await openWrapped(page);
    await expect(modal.locator("#map")).toBeAttached();

    const pane = page.locator("#map .leaflet-marker-pane");
    await expect(pane).toHaveAttribute("inert", "");

    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    await expect(pane).not.toHaveAttribute("inert", "");
    await expect(page.locator("#wrapped-btn")).toBeFocused();
  });
});

test.describe("Keyboard, Wrapped from a link", () => {
  test("closing it puts focus on the control that opens it", async ({
    page,
  }) => {
    // The seventh visibility flag restores the dialog
    await page.goto("/?v=000000100");
    await waitForAppReady(page);
    const modal = page.locator("#wrapped-modal");
    await expect(modal).toBeVisible({ timeout: 10000 });

    await page.keyboard.press("Escape");

    await expect(modal).toBeHidden();
    await expect(page.locator("#wrapped-btn")).toBeFocused();
  });
});

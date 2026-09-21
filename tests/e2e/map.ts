/**
 * Everything the specs know about the map library.
 *
 * The specs say what they want from the map (zoom there, is the heatmap on,
 * how many paths are drawn, where is the popup) and this file says how the
 * library answers: its class names, its layer objects, its methods. A spec
 * that reaches into `window.mapApp.map` or names a `.leaflet-*` class itself
 * has to be rewritten with the library; one that goes through here does not.
 */
/// <reference types="leaflet" />
import { expect, type Locator, type Page } from "@playwright/test";
// Type-only import so the window.mapApp / MAP_CONFIG globals are declared
import type {} from "../../kml_heatmap/frontend/globals";

/* ==========================================================================
   Locators
   ========================================================================== */

/** The map container once the library has taken it over */
const MAP_READY_SELECTOR = "#map.leaflet-container";

/** What holds the base map and the overlay tiles */
export function tileLayers(page: Page): Locator {
  return page.locator(".leaflet-tile-pane");
}

/** Base map tiles that are on the map */
export function baseMapTiles(page: Page): Locator {
  return tileLayers(page).locator('img[src*=".basemaps.cartocdn.com/"]');
}

/** Tiles of the open flightmaps aviation overlay that are on the map */
export function aviationTiles(page: Page): Locator {
  return tileLayers(page).locator(
    'img[src*="//nwy-tiles-api.prod.newaydata.com/"]',
  );
}

/** The library's own zoom buttons, which the page does not use */
export function zoomControl(page: Page): Locator {
  return page.locator(".leaflet-control-zoom");
}

/** The tile credit */
export function attributionControl(page: Page): Locator {
  return page.locator(".leaflet-control-attribution");
}

/** Every marker on the map: the airports, and the airplane during a replay */
export function mapMarkers(page: Page): Locator {
  return page.locator(".leaflet-marker-icon");
}

/** What holds the markers, and is made inert while a dialog covers the map */
export function markerContainer(page: Page): Locator {
  return page.locator("#map .leaflet-marker-pane");
}

/** An open popup, frame and all */
export function mapPopup(page: Page): Locator {
  return page.locator(".leaflet-popup");
}

/** The content of an open popup */
export function mapPopupContent(page: Page): Locator {
  return page.locator(".leaflet-popup-content");
}

/** The details of a segment: a tooltip under a mouse, a popup under a finger */
export function segmentDetails(page: Page): Locator {
  return page.locator(".segment-tooltip, .leaflet-popup-content");
}

const HEATMAP_SURFACE = "canvas.leaflet-heatmap-layer";

/** What the heatmap is painted on, which the emphasis class lands on */
export function heatmapSurface(page: Page): Locator {
  return page.locator(HEATMAP_SURFACE);
}

/* ==========================================================================
   Readiness and view
   ========================================================================== */

/**
 * Wait until the library has set the map up and it is at rest. Leaflet
 * ignores setZoom/setView while a zoom animation is running, so the map must
 * be idle as well. The specs run with reduced motion, which turns the map's
 * animations off; the check keeps a spec that turns it back on safe.
 */
export async function waitForMapReady(page: Page): Promise<void> {
  await page.waitForSelector(MAP_READY_SELECTOR, { timeout: 15000 });
  await page.waitForFunction(
    () => {
      const map = window.mapApp?.map as
        { _animatingZoom?: boolean } | null | undefined;
      return !!map && map._animatingZoom !== true;
    },
    { timeout: 20000 },
  );
}

export function getZoom(page: Page): Promise<number> {
  return page.evaluate(() => window.mapApp!.map!.getZoom());
}

export function getCenter(page: Page): Promise<{ lat: number; lng: number }> {
  return page.evaluate(() => {
    const { lat, lng } = window.mapApp!.map!.getCenter();
    return { lat, lng };
  });
}

/** Zoom around the centre without animating, and wait until the map is there */
export async function setZoom(page: Page, zoom: number): Promise<void> {
  await page.evaluate((z) => {
    window.mapApp!.map!.setZoom(z, { animate: false });
  }, zoom);
  await expect.poll(() => getZoom(page)).toBe(zoom);
}

/** Move the map to a coordinate without animating, and wait until it is there */
export async function setView(
  page: Page,
  [lat, lng]: readonly [number, number],
  zoom: number,
): Promise<void> {
  await page.evaluate(
    (view) => {
      window.mapApp!.map!.setView(L.latLng(view.lat, view.lng), view.zoom, {
        animate: false,
      });
    },
    { lat, lng, zoom },
  );
  // Arrived means drawn in the middle of the map, to the pixel. Comparing
  // coordinates does not work: Leaflet can report a centre snapped to the
  // pixel grid, which at zoom 13 is off by more than any tolerance that
  // would still mean something at zoom 3.
  await page.waitForFunction(
    (view) => {
      const map = window.mapApp!.map!;
      if (map.getZoom() !== view.zoom) return false;
      const size = map.getSize();
      const point = map.latLngToContainerPoint(L.latLng(view.lat, view.lng));
      return (
        Math.abs(point.x - size.x / 2) <= 1 &&
        Math.abs(point.y - size.y / 2) <= 1
      );
    },
    { lat, lng, zoom },
    { timeout: 5000 },
  );
}

/** Where a coordinate is drawn, in CSS pixels from the map's top left corner */
export function containerPoint(
  page: Page,
  [lat, lng]: readonly [number, number],
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    (at) => {
      const point = window.mapApp!.map!.latLngToContainerPoint(
        L.latLng(at.lat, at.lng),
      );
      return { x: point.x, y: point.y };
    },
    { lat, lng },
  );
}

/**
 * Take the map's own drawing out of the picture, tiles, paths and markers
 * alike, and leave the page's chrome. Masking them is not an option, because
 * every Leaflet pane fills the viewport, so a mask over one covers the
 * controls as well. The map keeps its own background, so the layout below it
 * is unchanged.
 *
 * Through a constructed stylesheet rather than a <style> tag: the page's CSP
 * allows no inline style, and CSSOM stylesheets are not inline.
 */
export async function hideMapData(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(".leaflet-pane { visibility: hidden !important; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
}

/* ==========================================================================
   Airports
   ========================================================================== */

/** Where an airport's marker stands */
export function airportPosition(
  page: Page,
  name: string,
): Promise<[number, number]> {
  return page.evaluate((airport) => {
    const { lat, lng } = window.mapApp!.airportMarkers[airport]!.getLatLng();
    return [lat, lng] as [number, number];
  }, name);
}

/** Centre the map on an airport's marker */
export async function centerOnAirport(
  page: Page,
  name: string,
  zoom: number,
): Promise<void> {
  await setView(page, await airportPosition(page, name), zoom);
}

/** Give an airport's marker the keyboard focus */
export function focusAirportMarker(page: Page, name: string): Promise<void> {
  return page.evaluate((airport) => {
    window.mapApp!.airportMarkers[airport]!.getElement()!.focus();
  }, name);
}

export function airportMarkerIsFocused(
  page: Page,
  name: string,
): Promise<boolean> {
  return page.evaluate(
    (airport) =>
      document.activeElement ===
      window.mapApp!.airportMarkers[airport]!.getElement(),
    name,
  );
}

/** The middle of an airport's marker, in viewport coordinates */
export function airportMarkerCenter(
  page: Page,
  name: string,
): Promise<{ x: number; y: number }> {
  return page.evaluate((airport) => {
    const box = window
      .mapApp!.airportMarkers[airport]!.getElement()!
      .getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, name);
}

/** Open an airport's popup the way the app does, without a pointer */
export function openAirportPopup(page: Page, name: string): Promise<void> {
  return page.evaluate((airport) => {
    window.mapApp!.airportMarkers[airport]!.openPopup();
  }, name);
}

/* ==========================================================================
   Layers
   ========================================================================== */

export type ColorLayer = "altitude" | "airspeed";

/** How many pieces of path a colour layer has drawn */
export function pathCount(page: Page, layer: ColorLayer): Promise<number> {
  return page.evaluate(
    (mode) => window.mapApp![`${mode}Layer`].getLayers().length,
    layer,
  );
}

/** Stroke colour of every piece of path in a colour layer, in drawing order */
export function pathColors(page: Page, layer: ColorLayer): Promise<string[]> {
  return page.evaluate(
    (mode) =>
      window
        .mapApp![`${mode}Layer`].getLayers()
        .map((polyline) => String((polyline as L.Polyline).options.color)),
    layer,
  );
}

/** Stroke width of every piece of path in a colour layer, in drawing order */
export function pathWeights(page: Page, layer: ColorLayer): Promise<number[]> {
  return page.evaluate(
    (mode) =>
      window
        .mapApp![`${mode}Layer`].getLayers()
        .map((polyline) => (polyline as L.Polyline).options.weight ?? 0),
    layer,
  );
}

/** Whether the heatmap is on the map right now */
export function heatmapOnMap(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const app = window.mapApp!;
    return !!app.heatmapLayer && app.map!.hasLayer(app.heatmapLayer);
  });
}

/** Whether the airport markers are on the map right now */
export function airportsOnMap(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const app = window.mapApp!;
    return app.map!.hasLayer(app.airportLayer);
  });
}

/** The heatmap is on the map and has a surface with a size to paint into */
export async function expectHeatmapPainted(page: Page): Promise<void> {
  expect(await heatmapOnMap(page)).toBe(true);
  // Read at once rather than through the locator, which would wait out the
  // test's timeout for a surface that is not there instead of saying so
  const size = await page.evaluate((selector) => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector);
    return { width: canvas?.width ?? 0, height: canvas?.height ?? 0 };
  }, HEATMAP_SURFACE);
  expect(size.width).toBeGreaterThan(0);
  expect(size.height).toBeGreaterThan(0);
}

/**
 * The heat canvas and the canvas the coloured paths are drawn on share the
 * overlay pane. Whichever was appended last would paint on top, so the
 * stylesheet pins the heat canvas underneath; this reads the result.
 */
export async function expectHeatUnderPaths(page: Page): Promise<void> {
  const pane = page.locator(".leaflet-overlay-pane");
  await expect(pane.locator("canvas.leaflet-heatmap-layer")).toHaveCount(1);
  await expect(pane.locator("canvas:not(.leaflet-heatmap-layer)")).toHaveCount(
    1,
  );
  const order = await pane.evaluate((el) => {
    const zIndex = (selector: string): number =>
      Number(getComputedStyle(el.querySelector(selector)!).zIndex);
    return {
      heat: zIndex("canvas.leaflet-heatmap-layer"),
      paths: zIndex("canvas:not(.leaflet-heatmap-layer)"),
    };
  });
  expect(order.heat, "the heat canvas paints over the paths").toBeLessThan(
    order.paths,
  );
}

/**
 * Zoom in far enough for the aviation overlay, which starts at zoom 7, and
 * wait for its tiles. They have to ask for the aeronautical layer of the
 * current AIRAC cycle.
 */
export async function expectAviationTiles(page: Page): Promise<void> {
  await setZoom(page, 8);
  const tile = aviationTiles(page).first();
  await expect(tile).toBeAttached();
  const src = new URL((await tile.getAttribute("src"))!);
  expect(src.searchParams.get("path")).toBe("latest/aero/latest");
}

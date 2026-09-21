/**
 * Map utility helpers
 * The places where the app's conventions meet MapLibre's: coordinate order,
 * zoom units, style readiness and the few things Leaflet did by itself
 */
import type { LngLatBoundsLike, Map as MapLibreMap, Popup } from "maplibre-gl";
import { ZOOM_OFFSET } from "./constants";

/** A position the way the data files carry it: latitude first */
export type LatLon = readonly [lat: number, lon: number, ...rest: number[]];

/** A position the way MapLibre and GeoJSON want it: longitude first */
export type LngLatTuple = [lng: number, lat: number];

/**
 * Turn a `[lat, lon]` pair of the data files into MapLibre's `[lng, lat]`.
 * The data stays latitude first, so every position crosses here on its way
 * to the map; an altitude behind the pair is dropped.
 */
export function toLngLat(latLon: LatLon): LngLatTuple {
  return [latLon[1], latLon[0]];
}

/** Turn a position MapLibre reports back into the data's `[lat, lon]` */
export function fromLngLat(lngLat: {
  lng: number;
  lat: number;
}): [lat: number, lon: number] {
  return [lngLat.lat, lngLat.lng];
}

/**
 * Turn `[[minLat, minLon], [maxLat, maxLon]]`, the bounds of the page
 * configuration, into MapLibre's south-west and north-east corners.
 */
export function toBounds(
  bounds: readonly [LatLon, LatLon],
): [LngLatTuple, LngLatTuple] & LngLatBoundsLike {
  return [toLngLat(bounds[0]), toLngLat(bounds[1])];
}

/** A zoom of saved state or a link (legacy units) as a zoom of the map */
export function stateZoomToMap(zoom: number): number {
  return zoom - ZOOM_OFFSET;
}

/** A zoom of the map as the zoom saved state and links carry */
export function mapZoomToState(zoom: number): number {
  return zoom + ZOOM_OFFSET;
}

/**
 * Resolve with the map once it has a style to add sources and layers to.
 *
 * `isStyleLoaded()` is no test for that: it turns false again after every
 * `setData` until the worker has answered. `style.load` fires once per style,
 * so a map that already saw it is told apart by its style object instead.
 * A style that fails to load never fires it; the caller owns that case (see
 * MapApp, which swaps in a style that needs no network).
 */
export function whenStyleReady(map: MapLibreMap): Promise<MapLibreMap> {
  return new Promise((resolve) => {
    if (map.style?._loaded) {
      resolve(map);
      return;
    }
    void map.once("style.load", () => resolve(map));
  });
}

/**
 * Id of the lowest label layer of the style, the one data layers are
 * inserted below so place names stay readable on top of them. Undefined for
 * a style without labels, which makes `addLayer` put the layer on top.
 */
export function firstSymbolLayerId(map: MapLibreMap): string | undefined {
  return map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
}

/**
 * Resize the map after a CSS transition completes on the given element.
 * MapLibre follows its container through a ResizeObserver, but a container
 * that is mid-transition reports every size on the way; this settles on the
 * final one. Falls back to a timeout matching --duration-base (300ms) when no
 * element is provided or the transitionend event does not fire.
 */
export function resizeMapAfterTransition(
  map: MapLibreMap | null,
  transitionTarget?: HTMLElement | null,
): void {
  if (!map) return;

  const FALLBACK_MS = 350;

  if (transitionTarget) {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      transitionTarget.removeEventListener("transitionend", onEnd);
      map.resize();
    };
    const onEnd = (e: TransitionEvent): void => {
      if (e.target === transitionTarget) done();
    };
    transitionTarget.addEventListener("transitionend", onEnd);
    setTimeout(done, FALLBACK_MS);
  } else {
    setTimeout(() => map.resize(), FALLBACK_MS);
  }
}

/**
 * Pan the map just far enough that an open popup is inside it, `padding`
 * pixels clear of every edge. Leaflet did this by itself (autoPan); MapLibre
 * opens a popup wherever its anchor is, half outside the map if need be.
 * A popup larger than the map is aligned at its top left, where it starts
 * to read.
 */
export function panPopupIntoView(
  map: MapLibreMap,
  popup: Popup,
  padding = 16,
  animate = true,
): void {
  if (!popup.isOpen()) return;
  const box = popup.getElement().getBoundingClientRect();
  const frame = map.getContainer().getBoundingClientRect();

  const overflow = (before: number, after: number): number => {
    // The near edge wins when both are out, so the content's start shows
    if (before < 0) return before;
    return after > 0 ? after : 0;
  };
  const dx = overflow(
    box.left - (frame.left + padding),
    box.right - (frame.right - padding),
  );
  const dy = overflow(
    box.top - (frame.top + padding),
    box.bottom - (frame.bottom - padding),
  );
  if (dx === 0 && dy === 0) return;
  map.panBy([dx, dy], { animate });
}

/**
 * Run `fn` while the map shows a still image of itself in place of its
 * canvas, and put the canvas back afterwards.
 *
 * html-to-image copies DOM, and a WebGL canvas copied that way is blank: the
 * drawing buffer is cleared once a frame has been presented. It can only be
 * read inside the frame that drew it, so the still is taken in a `render`
 * handler after asking for a repaint. `preserveDrawingBuffer` would make the
 * canvas readable at any time, at a cost every frame pays. Markers and popups
 * are DOM next to the canvas and need no help.
 */
export async function withMapStill<T>(
  map: MapLibreMap,
  fn: () => Promise<T> | T,
): Promise<T> {
  const canvas = map.getCanvas();
  const dataUrl = await new Promise<string>((resolve) => {
    void map.once("render", () => resolve(canvas.toDataURL("image/png")));
    map.triggerRepaint();
  });

  const still = document.createElement("img");
  still.className = canvas.className;
  still.alt = "";
  // The canvas is sized in CSS pixels by MapLibre; its width and height
  // attributes are device pixels and would blow the image up
  still.width = canvas.clientWidth;
  still.height = canvas.clientHeight;
  still.src = dataUrl;
  // Decoded before the swap, so the capture never sees an empty image. A
  // failure to decode leaves a blank map in the export, which is what there
  // was to show anyway; the swap back below must still happen.
  await still.decode().catch(() => undefined);

  canvas.replaceWith(still);
  try {
    return await fn();
  } finally {
    still.replaceWith(canvas);
  }
}

/**
 * Value of a CSS custom property on the root element, trimmed. Paint
 * properties of map layers cannot read `var()`, so the tokens of the
 * stylesheet reach the map through here. Empty when the token is not set.
 */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

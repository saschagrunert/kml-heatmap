/**
 * Map utility helpers
 * The places where the app's conventions meet MapLibre's: coordinate order,
 * zoom units, style readiness and the few things Leaflet did by itself
 */
import type {
  LngLatBoundsLike,
  Map as MapLibreMap,
  MapMouseEvent,
  MapTouchEvent,
  Popup,
} from "maplibre-gl";
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
 * Call it in the same turn the map is created in: it waits for `style.load`,
 * which fires once per style, and a map that already saw it would wait for
 * good. `isStyleLoaded()` cannot stand in for the event: it turns false
 * again after every `setData` until the worker has answered. A style that
 * fails to load never fires it; the caller owns that case (see MapApp, which
 * swaps in a style that needs no network).
 */
export function whenStyleReady(map: MapLibreMap): Promise<MapLibreMap> {
  return new Promise((resolve) => {
    void map.once("style.load", () => resolve(map));
  });
}

/**
 * Whether an event of the map was aimed at a marker. MapLibre listens on
 * the container the markers sit in and does not ask: a pointer over a marker
 * moves over the map as well, and a click on one is a click on the map. The
 * app's own map handlers ask here, so no marker has to opt out of them.
 */
export function isOnMarker(e: { originalEvent?: Event | undefined }): boolean {
  const target = e.originalEvent?.target;
  return target instanceof Element && !!target.closest(".maplibregl-marker");
}

/**
 * Keep a click on a marker's element from reaching the map. `isOnMarker`
 * cannot do this part: a popup that closes on a click on the map listens to
 * the map by itself, and would close in the click that opened it. Nothing
 * else is stopped. The press and the touch move the map when a drag starts
 * on a marker, as they always have.
 */
export function keepMarkerClickFromMap(element: HTMLElement): void {
  element.addEventListener("click", (event) => event.stopPropagation());
}

/**
 * Keep a double click and a double tap on a marker from zooming the map,
 * for every marker there is or will be. Returns what takes it back.
 *
 * A `dblclick` of the map can be prevented, which skips the zoom. A double
 * tap has no event to prevent: the zoom is recognised from `touchstart` and
 * `touchend`, and preventing the map's `touchstart` would skip the pan with
 * it, so a drag that starts on a marker would not move the map. Switched
 * off for the length of the touch instead, the recogniser never sees a tap
 * on a marker begin, and the pan is left alone. The map's events come before
 * its gesture handlers see the same DOM event, so both switches are in time.
 */
export function keepMarkerTapsFromZoom(map: MapLibreMap): () => void {
  let switchedOff = false;
  const onDoubleClick = (e: MapMouseEvent): void => {
    if (isOnMarker(e)) e.preventDefault();
  };
  const onTouchStart = (e: MapTouchEvent): void => {
    if (!isOnMarker(e) || !map.doubleClickZoom.isEnabled()) return;
    map.doubleClickZoom.disable();
    switchedOff = true;
  };
  const onTouchEnd = (): void => {
    if (!switchedOff) return;
    switchedOff = false;
    map.doubleClickZoom.enable();
  };
  map.on("dblclick", onDoubleClick);
  map.on("touchstart", onTouchStart);
  map.on("touchend", onTouchEnd);
  map.on("touchcancel", onTouchEnd);
  return () => {
    onTouchEnd();
    map.off("dblclick", onDoubleClick);
    map.off("touchstart", onTouchStart);
    map.off("touchend", onTouchEnd);
    map.off("touchcancel", onTouchEnd);
  };
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
 * How long `withMapStill` waits for the frame it asked for (ms). A map draws
 * within a frame or two; one that has lost its WebGL context never does.
 */
export const MAP_STILL_TIMEOUT_MS = 3000;

/**
 * The frame the map draws next, as a PNG data URL. Rejects when no frame
 * comes in time or the canvas cannot be read: a promise that never settled
 * would leave the caller's busy state on for good.
 */
function nextFrameAsDataUrl(map: MapLibreMap): Promise<string> {
  const canvas = map.getCanvas();
  return new Promise<string>((resolve, reject) => {
    const onRender = (): void => {
      map.off("render", onRender);
      clearTimeout(timer);
      try {
        resolve(canvas.toDataURL("image/png"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const timer = setTimeout(() => {
      map.off("render", onRender);
      reject(new Error("the map did not draw in time"));
    }, MAP_STILL_TIMEOUT_MS);
    map.on("render", onRender);
    map.triggerRepaint();
  });
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
  const dataUrl = await nextFrameAsDataUrl(map);

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

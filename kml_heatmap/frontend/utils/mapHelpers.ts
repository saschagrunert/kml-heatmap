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
import { withTimeout } from "./withTimeout";

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
 * starts on a style that needs no network and swaps the real one in later).
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
 * app's own map handlers ask here, so no marker has to opt out of them, and
 * none stops its events: the press and the touch move the map when a drag
 * starts on a marker, as they always have.
 */
export function isOnMarker(e: { originalEvent?: Event | undefined }): boolean {
  return isInMarker(e.originalEvent?.target);
}

/** Longest gap between the taps of a double tap, in milliseconds */
export const DOUBLE_TAP_MS = 400;

/**
 * Tell a marker's own activations apart from the later clicks of a double
 * click or a double tap, which would close the popup the first one opened.
 * Returns a filter for the marker's clicks, true for an activation.
 *
 * `detail` counts the clicks of a burst, but WebKit reports every tap as a
 * click with a `detail` of 1. A click that follows the last one within the
 * double tap time counts as part of its burst as well. A key reports a
 * `detail` of 0 and is always an activation.
 */
export function createActivationFilter(): (event: MouseEvent) => boolean {
  let lastClickAt = -Infinity;
  return ({ detail, timeStamp }) => {
    if (!detail) return true;
    const isFirst = detail < 2 && timeStamp - lastClickAt >= DOUBLE_TAP_MS;
    lastClickAt = timeStamp;
    return isFirst;
  };
}

/** Whether an element, or whatever else an event was aimed at, is part of a marker */
export function isInMarker(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && !!target.closest(".maplibregl-marker");
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
 * Only a zoom this switched off is switched on again, once the last finger
 * has left.
 *
 * Left as it is: a tap followed by a press and a drag, MapLibre's zoom with
 * one finger. Its only switch is `touchZoomRotate`, which is the pinch as
 * well, and a pinch with a finger on a marker has to go on working. The
 * gesture is a deliberate one and zooms where the marker is.
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
  const switchBackOn = (): void => {
    if (!switchedOff) return;
    switchedOff = false;
    map.doubleClickZoom.enable();
  };
  const onTouchEnd = (e: MapTouchEvent): void => {
    // With a second finger still down the recogniser would come back in
    // the middle of a gesture
    if (e.originalEvent.touches.length === 0) switchBackOn();
  };
  map.on("dblclick", onDoubleClick);
  map.on("touchstart", onTouchStart);
  map.on("touchend", onTouchEnd);
  map.on("touchcancel", onTouchEnd);
  return () => {
    switchBackOn();
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
  if (map.getPitch() === 0 && map.getProjection()?.type !== "globe") {
    map.panBy([dx, dy], { animate });
    return;
  }
  // `panBy` moves the centre by the pixels it is given, and only on a flat
  // map does everything else move as far: tilted by 60 degrees, a popup at
  // the top of the map came down 44 of the 200 pixels asked for. So the
  // place that is now drawn where the popup's own has to go takes the
  // measure: the map moves by what lies between the two.
  const place = popup.getLngLat();
  const at = map.project(place);
  const target = map.unproject([at.x - dx, at.y - dy]);
  const center = map.getCenter();
  map.panTo(
    [
      center.lng + place.lng - target.lng,
      Math.max(-85, Math.min(85, center.lat + place.lat - target.lat)),
    ],
    { animate },
  );
}

/** How far off a place may come back from the round trip of `isBehindGlobe` */
const GLOBE_ROUND_TRIP_DEGREES = 0.01;

/**
 * Whether a place is on the far side of the globe. MapLibre knows, and
 * tells nobody: `project` answers for such a place with a point inside the
 * disc, where the near side is drawn. Asked what is at that point, the map
 * names the place on the near side, so a place that does not come back from
 * the round trip is behind the globe. Measured against MapLibre's own
 * verdict: a place in view on the near side comes back within a hundred
 * thousandth of a degree, and of the places behind, only those within a
 * hundredth of a degree of the rim do. A place far outside the map may be
 * called behind when it is not; it is out of sight either way.
 */
export function isBehindGlobe(
  map: MapLibreMap,
  place: { lng: number; lat: number },
): boolean {
  if (map.getProjection()?.type !== "globe") return false;
  const back = map.unproject(map.project([place.lng, place.lat]));
  const turn = Math.abs(back.lng - place.lng) % 360;
  return (
    Math.abs(back.lat - place.lat) > GLOBE_ROUND_TRIP_DEGREES ||
    Math.min(turn, 360 - turn) > GLOBE_ROUND_TRIP_DEGREES
  );
}

/**
 * Close a popup once the place it points at has gone behind the globe.
 * MapLibre leaves it open at the point the place projects to, over another
 * part of the world, with its buttons working.
 */
export function closeWhenBehindGlobe(map: MapLibreMap, popup: Popup): void {
  const check = (): void => {
    if (isBehindGlobe(map, popup.getLngLat())) popup.remove();
  };
  popup.on("open", () => map.on("move", check));
  popup.on("close", () => map.off("move", check));
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
  let onRender!: () => void;
  const frame = new Promise<string>((resolve, reject) => {
    onRender = (): void => {
      try {
        resolve(canvas.toDataURL("image/png"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    map.on("render", onRender);
    map.triggerRepaint();
  });
  return withTimeout(
    frame,
    MAP_STILL_TIMEOUT_MS,
    "the map did not draw in time",
  ).finally(() => map.off("render", onRender));
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
 *
 * With `pixelRatio` the still is drawn at that many device pixels per CSS
 * pixel, so an image exported at 2x from a 1x screen gets a map as sharp as
 * the page around it instead of an enlarged one. The ratio is only ever
 * raised: a screen denser than the export already has the better frame, and
 * a smaller canvas would cost a redraw to make the image softer. MapLibre
 * keeps the canvas within `maxCanvasSize` and what the GPU allocates by
 * lowering the ratio itself, and the still keeps the canvas's CSS size, so
 * a ratio that was not met in full needs no handling here.
 *
 * Changing the ratio resizes the canvas, which clears it. Nothing blank is
 * presented: the frame asked for is drawn before the browser paints again.
 * No tile is loaded for it (tiles do not depend on the ratio), so that one
 * frame is complete and there is no `idle` to wait for. A resize is not free
 * of side effects, though: MapLibre stops the camera, which resets a gesture
 * that is just beginning, and fires `movestart`, `move` and `moveend`
 * without a camera change, once on the way up and once on the way back. The
 * listeners of this app take that in their stride (a saved view is written
 * again, unchanged). That is the reason not to raise a ratio for nothing.
 */
export async function withMapStill<T>(
  map: MapLibreMap,
  fn: () => Promise<T> | T,
  pixelRatio?: number,
): Promise<T> {
  const canvas = map.getCanvas();
  const screenRatio = map.getPixelRatio();
  // Asked now and not when the ratio goes back: a browser zoom or a move to
  // another monitor during the capture changes devicePixelRatio, and the
  // comparison would then pin a map that had been following the screen
  const followsScreen = screenRatio === window.devicePixelRatio;
  // What MapLibre asks for and what the canvas has differ once the canvas
  // hit `maxCanvasSize` or the GPU's limit. A canvas that is already held
  // below the ratio it has cannot get any larger, and raising it would cost
  // two resizes to take the same still.
  const applied =
    canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : screenRatio;
  const clamped = applied < screenRatio * 0.99;
  const raised =
    pixelRatio !== undefined && pixelRatio > screenRatio && !clamped;
  let still: HTMLImageElement | null = null;
  try {
    if (raised) map.setPixelRatio(pixelRatio);
    const dataUrl = await nextFrameAsDataUrl(map);

    still = document.createElement("img");
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
    return await fn();
  } finally {
    // The ratio goes back while the still is showing, so the canvas returns
    // at the size it had. A map that followed the screen's ratio follows it
    // again (null lifts the override, which the typings leave out): a number
    // would pin it, and the map would stay soft after a browser zoom.
    try {
      if (raised) {
        map.setPixelRatio(
          followsScreen ? (null as unknown as number) : screenRatio,
        );
      }
    } finally {
      // Whatever happened above: a map that was removed during the capture
      // throws on the resize, and the page must not be left showing a still.
      // Does nothing for a still that never made it into the page.
      still?.replaceWith(canvas);
      // A 2x frame of a large monitor is tens of megabytes once decoded
      still?.removeAttribute("src");
    }
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

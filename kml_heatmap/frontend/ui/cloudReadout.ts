/**
 * The readout of the heat cloud under the pointer - how much time was
 * spent there, by how many flights, and at what height
 *
 * While the 3D view draws the heat cloud, resting the pointer on it (or a
 * tap on it) shows a small box beside the pointer: "About 42 min within
 * 1 km" over "17 flights · mostly 800 to 1,200 ft AGL". It says what the
 * cloud there is made of: the flights the cloud draws (the filters,
 * Isolate) at the heights it draws them (the band of ui/heightBand.ts),
 * weighed as it weighs them (Routes, Airborne), along the line of sight
 * through the pointer (see calculations/cloudReadout.ts). It speaks of
 * time, or with Routes of the distance flown ("About 12 km flown within
 * 1 km"), never of the brightness, which the exposure of the cloud scales,
 * and of no date or hour.
 *
 * With a colour layer on, the 3D view draws the flights as ribbons, which
 * run all over a busy field: over a ribbon the values of its
 * segment show as well (ui/pathHover.ts), and the box goes where it leaves
 * them in sight, on the other side of the pointer or beside them. It steps
 * aside over a marker, while the map is dragged or turned, and after
 * Escape until the pointer moves on. A tap or a click on a marker or an
 * airport's code is theirs. One on the map, a flight included (which it
 * selects, and a tap opens its values), shows the readout by it, above a
 * finger, and reads it out once to a screen reader, unless it selected a
 * flight or cleared the selection, which the app reads out. A hover is not
 * read out, which would speak at every move. The box takes no pointer
 * events, so the map under it keeps its hover, clicks and drags.
 *
 * Nothing of it runs while the 3D view is off or the cloud is not drawn:
 * the map's pointer events are only listened to while it is, and what it
 * keeps (the seconds, heights and grids of a dataset) goes with the 3D
 * view. It comes with the feature bundle, with the cloud (see
 * ui/heatCloud.ts). The flat heatmap has no readout: its code would have
 * to come with the first visit, or this bundle with every one.
 */
import type { LngLat, MapMouseEvent, MapTouchEvent, Point } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { StoreState } from "../state/store";
import { datasetIndex } from "../calculations/datasetIndex";
import { heightBandEdgesFt, parseHeightBand } from "../calculations/heightBand";
import { heatWeight } from "../calculations/heatLines";
import { airplaneLiftPx, liftExaggeration } from "../calculations/lift";
import {
  readoutAt,
  readoutData,
  readoutRadiusM,
  readoutText,
  releaseReadoutData,
  segmentGrid,
  sightLine,
  type CloudReadout,
} from "../calculations/cloudReadout";
import { frameCoalescer } from "../utils/frameCoalescer";
import { DEGREES_TO_RADIANS, metresPerPixel } from "../utils/geometry";
import { announceStatus } from "../utils/toast";
import { cloudReachPx } from "./heatCloudLayer";

/** The class of the box, styled in features.css */
const READOUT_CLASS = "cloud-readout";

/** Pixels between the pointer and the box, and a finger and the box */
const POINTER_GAP_PX = 14;
const FINGER_GAP_PX = 28;

/** Pixels between the box and the values of a flight or a panel beside it */
const CLEAR_GAP_PX = 4;

/**
 * The panels over the map the box keeps clear of where it can: the control
 * columns, the selection chip, the profile of a flight, the phone's bar,
 * the colour legends, and on a phone the band of heights and the compass
 * that float over the top of the map
 */
const MAP_PANELS_SELECTOR = [
  "#left-buttons",
  "#right-buttons",
  "#selection-chip",
  "#flight-profile",
  "#mobile-bar",
  ".color-legend",
  "#height-band",
  "#compass-float-btn",
].join(", ");

/** Pixels the pointer has to move after Escape to bring the box back */
const ESCAPE_SLACK_PX = 8;

/**
 * Milliseconds after a touch in which a click or a move of the mouse is
 * the browser's for the tap, not one of a mouse
 */
const TAP_MS = 1000;

/** What the readout follows */
const READOUT_KEYS: readonly (keyof StoreState)[] = [
  "threeDVisible",
  "heatCloud",
  "heatmapVisible",
  "forcedHeatCloud",
  "heightBand",
  "replayActive",
  "wrappedVisible",
  "currentData",
  "selectedYear",
  "selectedAircraft",
  "selectedPathIds",
  "isolateSelection",
  "terrainActive",
  "reliefLevel",
  "routeWeighting",
  "airborneOnly",
];

/** The edges of a box on the map, in its pixels */
interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const followed = new WeakSet<MapApp>();

/**
 * Show the readout of the heat cloud under the pointer whenever the 3D view
 * draws the cloud, from now on, for as long as the app lives. A second call
 * for the same app does nothing.
 */
export function followCloudReadout(app: MapApp): void {
  const map = app.map;
  if (!map || followed.has(app)) return;
  followed.add(app);
  const container = map.getContainer();

  /**
   * Whether the cloud of the 3D view is drawn. Wrapped's intro draws it
   * too (forcedHeatCloud), but there the map is only looked at.
   */
  const active = (): boolean =>
    app.threeDVisible &&
    app.heatCloud &&
    app.heatmapVisible &&
    !app.forcedHeatCloud &&
    !app.replayActive &&
    !app.wrappedVisible;

  let box: HTMLElement | null = null;
  /** The pointer of the last move over the map, null off it */
  let pointer: Point | null = null;
  /** Where the pointer was as Escape put the box away */
  let dismissedAt: Point | null = null;
  /**
   * The place of the last tap, while its box stands: a move of the map by
   * the app (the profile of the flight it selected opening under the map)
   * takes the box along with it
   */
  let tapped: LngLat | null = null;
  /** When the map was last touched, by the clock of its events */
  let touchedAt = -Infinity;
  /** How often the selection changed, and how often as a button went down */
  let selectionChanges = 0;
  let changesAtPress = 0;
  /** Which flights the cloud draws, as the store last said */
  let keep: ((pathId: number) => boolean) | null = null;

  /** Where the box was last put, for placing it again */
  let shownAt: { point: Point; finger: boolean } | null = null;

  const hide = (): void => {
    shownAt = null;
    if (box) box.hidden = true;
  };

  /**
   * The boxes of `elements` on the map, in its pixels and widened by
   * CLEAR_GAP_PX, of those that are shown
   */
  const boxesOf = (elements: Iterable<Element>): Edges[] => {
    const origin = container.getBoundingClientRect();
    const boxes: Edges[] = [];
    for (const element of elements) {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      if (right <= left || bottom <= top) continue;
      boxes.push({
        left: left - origin.left - CLEAR_GAP_PX,
        top: top - origin.top - CLEAR_GAP_PX,
        right: right - origin.left + CLEAR_GAP_PX,
        bottom: bottom - origin.top + CLEAR_GAP_PX,
      });
    }
    return boxes;
  };

  /**
   * Put the box beside the pointer at `point`: below and to the right of
   * it, or on another side where the map ends, the values of a flight
   * (the hover's tooltip, a tap's popup) are or a panel lies over the map,
   * or beside those values; above a finger, which covers what is below it
   */
  const place = (point: Point, finger: boolean): void => {
    if (!box) return;
    shownAt = { point, finger };
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const right = container.clientWidth - width;
    const bottom = container.clientHeight - height;
    const values = boxesOf(
      container.querySelectorAll(
        ":scope > .segment-tooltip, :scope > .segment-popup",
      ),
    );
    const covered = [
      ...values,
      ...boxesOf(document.querySelectorAll(MAP_PANELS_SELECTOR)),
    ];
    const gap = finger ? FINGER_GAP_PX : POINTER_GAP_PX;
    const above = point.y - gap - height;
    const below = point.y + gap;
    const middle = Math.max(0, Math.min(point.x - width / 2, right));
    const spots: [number, number][] = finger
      ? [
          [middle, above],
          [middle, below],
        ]
      : [
          [point.x + gap, below],
          [point.x - gap - width, below],
          [point.x + gap, above],
          [point.x - gap - width, above],
        ];
    for (const { left, right: end, top } of values) {
      spots.push([end, top], [left - width, top]);
    }
    const fits = ([x, y]: [number, number]): boolean =>
      x >= 0 && x <= right && y >= 0 && y <= bottom;
    const clear = ([x, y]: [number, number]): boolean =>
      covered.every(
        (other) =>
          x >= other.right ||
          x + width <= other.left ||
          y >= other.bottom ||
          y + height <= other.top,
      );
    let [x, y] =
      spots.find((spot) => fits(spot) && clear(spot)) ??
      spots.find(fits) ??
      spots[0]!;
    x = Math.max(0, Math.min(x, right));
    y = Math.max(0, Math.min(y, bottom));
    box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  /** Show `readout` beside the pointer at `point`, or above a finger */
  const show = (readout: CloudReadout, point: Point, finger: boolean): void => {
    if (!box) {
      box = document.createElement("div");
      box.className = READOUT_CLASS;
      // For the eyes: a click or a tap is read out once (see onClick)
      box.setAttribute("aria-hidden", "true");
      box.append(document.createElement("b"), document.createElement("div"));
      container.append(box);
    }
    const { time, detail } = readoutText(readout, app.routeWeighting);
    box.firstChild!.textContent = time;
    box.lastChild!.textContent = detail;
    box.hidden = false;
    place(point, finger);
  };

  /** The readout of the cloud under the point `point` of the map */
  const readoutUnder = (point: Point): CloudReadout | null => {
    const data = app.currentData;
    if (!data || !keep) return null;
    const zoom = map.getZoom();
    const lat = map.getCenter().lat;
    const pixelM = metresPerPixel(zoom) * Math.cos(lat * DEGREES_TO_RADIANS);
    const radiusM = readoutRadiusM(pixelM, cloudReachPx(zoom));
    const radiusPx = radiusM / pixelM;
    const segments = data.path_segments;
    const prepared = readoutData(
      segments,
      app.terrainActive,
      app.reliefLevel,
      heatWeight(app.routeWeighting, app.airborneOnly),
    );
    // Lifted as the cloud is (ui/heatCloud.ts), and taken down the screen
    // by as much as a ribbon under the pointer is (PathHover.nearest)
    const exaggeration =
      map.getTerrain()?.exaggeration ?? liftExaggeration(app.reliefLevel);
    const sight = sightLine(
      point.x,
      point.y,
      prepared.topFt,
      airplaneLiftPx(map, lat, 1, exaggeration, zoom),
      radiusPx,
      radiusM,
      (x, y) => {
        // MapLibre answers the sky of a tilted map with ground behind the
        // camera, and the space beside the globe with its rim: ground that
        // is not drawn at the point, and does not come back to it. The
        // cloud is drawn in the world copy of the flights only, whose
        // longitudes are those of the flights.
        const at = map.unproject([x, y]);
        const back = map.project(at);
        return Math.abs(at.lng) <= 180 &&
          Math.hypot(back.x - x, back.y - y) <= radiusPx / 2
          ? [at.lat, at.lng]
          : null;
      },
    );
    if (!sight) return null;
    return readoutAt(
      prepared,
      segmentGrid(segments, radiusM),
      sight,
      radiusM,
      keep,
      heightBandEdgesFt(parseHeightBand(app.heightBand)),
    );
  };

  /** Whether an event is on the map itself, not on a marker over it */
  const onCanvas = (e: MapMouseEvent): boolean =>
    e.originalEvent.target === map.getCanvas();

  const hover = frameCoalescer<{ point: Point; finger: boolean }>(
    ({ point, finger }) => {
      const readout = active() && !dismissedAt ? readoutUnder(point) : null;
      if (readout) show(readout, point, finger);
      else hide();
    },
  );

  /**
   * Look again under the resting pointer, or at the place tapped last
   * where it still is on the map
   */
  const retell = (): void => {
    if (pointer) {
      hover.schedule({ point: pointer, finger: false });
    } else if (tapped) {
      const point = map.project(tapped);
      if (
        point.x >= 0 &&
        point.y >= 0 &&
        point.x <= container.clientWidth &&
        point.y <= container.clientHeight
      ) {
        hover.schedule({ point, finger: true });
      }
    }
  };

  const leave = (): void => {
    pointer = null;
    dismissedAt = null;
    tapped = null;
    hover.cancel();
    hide();
  };

  const onMove = (e: MapMouseEvent): void => {
    // The browser's own move for a tap; a click follows (onClick)
    if (e.originalEvent.timeStamp - touchedAt < TAP_MS) return;
    // A drag moves the map, and a marker lies on top of the cloud
    if (e.originalEvent.buttons || !onCanvas(e)) return leave();
    if (
      dismissedAt &&
      Math.hypot(e.point.x - dismissedAt.x, e.point.y - dismissedAt.y) >
        ESCAPE_SLACK_PX
    ) {
      dismissedAt = null;
    }
    pointer = e.point;
    tapped = null;
    hover.schedule({ point: e.point, finger: false });
  };

  const onMoveStart = (): void => {
    hover.cancel();
    hide();
  };

  // A zoom by the wheel moves the map from under a pointer that rests,
  // and the app from under a tap
  const onMoveEnd = (): void => retell();

  const onPress = (): void => {
    changesAtPress = selectionChanges;
  };

  const onTouch = (e: MapTouchEvent): void => {
    touchedAt = e.originalEvent.timeStamp;
    tapped = null;
    onPress();
    onMoveStart();
  };

  /**
   * A click or a tap on the map beside a marker and an airport's code,
   * which the app's click handler (registered before) has answered: on a
   * flight it selected it, and a tap opened its values in a popup, which
   * the box stands clear of. Read out unless the click selected a flight
   * or cleared the selection, which the app reads out itself (the last
   * word in the page's status region is the one heard).
   */
  const onClick = (e: MapMouseEvent): void => {
    const readout =
      active() &&
      onCanvas(e) &&
      app.airportManager.airportLabelAt(e.point) === null
        ? readoutUnder(e.point)
        : null;
    if (!readout) {
      tapped = null;
      return hide();
    }
    const finger = e.originalEvent.timeStamp - touchedAt < TAP_MS;
    dismissedAt = null;
    tapped = finger ? e.lngLat : null;
    show(readout, e.point, finger);
    if (selectionChanges !== changesAtPress) return;
    const { time, detail } = readoutText(readout, app.routeWeighting);
    announceStatus(`${time}: ${detail.replace(" · ", ", ")}`);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !box || box.hidden) return;
    hide();
    dismissedAt = pointer;
    tapped = null;
  };

  // The values of a flight can show or go after the readout did: after a
  // look once the map is idle (PathHover.rehoverOnIdle). The popups are
  // children of the map's container, and few come and go.
  const popups = new MutationObserver(() => {
    if (shownAt) place(shownAt.point, shownAt.finger);
  });

  let listening = false;
  const listen = (on: boolean): void => {
    if (on === listening) return;
    listening = on;
    if (on) {
      map.on("mousemove", onMove);
      map.on("mouseout", leave);
      map.on("movestart", onMoveStart);
      map.on("moveend", onMoveEnd);
      map.on("touchstart", onTouch);
      map.on("mousedown", onPress);
      map.on("click", onClick);
      document.addEventListener("keydown", onKey);
      popups.observe(container, { childList: true });
    } else {
      map.off("mousemove", onMove);
      map.off("mouseout", leave);
      map.off("movestart", onMoveStart);
      map.off("moveend", onMoveEnd);
      map.off("touchstart", onTouch);
      map.off("mousedown", onPress);
      map.off("click", onClick);
      document.removeEventListener("keydown", onKey);
      popups.disconnect();
      leave();
    }
  };

  /** What the readout was last worked out from, see sync */
  let made: unknown[] = [];

  const sync = (): void => {
    const on = active();
    if (!app.threeDVisible) releaseReadoutData();
    const isolated =
      app.isolateSelection && app.selectedPathIds.size > 0
        ? app.selectedPathIds
        : null;
    const inputs = [
      on,
      app.currentData,
      app.selectedYear,
      app.selectedAircraft,
      isolated && [...isolated].sort((a, b) => a - b).join(),
      app.terrainActive,
      app.reliefLevel,
      app.heightBand,
      app.routeWeighting,
      app.airborneOnly,
    ];
    // A selection that is not isolated changes nothing the readout says:
    // the click that clears one keeps the readout it showed
    if (inputs.some((value, i) => value !== made[i])) {
      made = inputs;
      hide();
      const data = app.currentData;
      const kept =
        data &&
        datasetIndex(data).filter(app.selectedYear, app.selectedAircraft)
          .pathIds;
      keep =
        kept &&
        ((pathId) => kept.has(pathId) && (!isolated || isolated.has(pathId)));
      // A resting pointer is told anew: the relief coming in as the 3D
      // view starts changes the heights under it
      if (on) retell();
    }
    listen(on);
  };

  void app.mapReady.then(() => {
    const signal = app.signal;
    if (signal.aborted) return;
    const unsubscribe = app.store.subscribeKeys(READOUT_KEYS, sync);
    const unsubscribeSelection = app.store.subscribe("selectedPathIds", () => {
      selectionChanges++;
    });
    signal.addEventListener("abort", () => {
      unsubscribe();
      unsubscribeSelection();
      listen(false);
      box?.remove();
    });
    sync();
  });
}

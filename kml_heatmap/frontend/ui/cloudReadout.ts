/**
 * The readout of the heat cloud under the pointer - how much time was
 * spent there, by how many flights, and at what height
 *
 * While the 3D view draws the heat cloud, resting the pointer on it (or a
 * tap on it) shows a small box beside the pointer: "About 42 min within
 * 1 km" over "17 flights · mostly 800 to 1,200 ft AGL". It says what the
 * cloud there is made of: the flights the cloud draws (the filters,
 * Isolate) at the heights it draws them (the band of ui/heightBand.ts),
 * along the line of sight through the pointer (see
 * calculations/cloudReadout.ts). It speaks of time, never of the
 * brightness, which the exposure of the cloud scales, and of no date or
 * hour.
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
 * The pointer's frames do little: a move of a few pixels keeps what was
 * worked out (READOUT_SLACK_PX), nothing is worked out while the map moves,
 * and what a readout at a zoom is worked out from (the seconds, heights and
 * grid of calculations/cloudReadout.ts) is made once the page has a moment
 * after the map comes to rest, ahead of the pointer. A hover that finds it
 * missing waits for it; a click or a tap, which wants its answer, makes it.
 *
 * Nothing of it runs while the 3D view is off, the cloud is not drawn or
 * the hotspot tour holds the map: the map's pointer events are only
 * listened to while it is, and what it keeps (the seconds, heights and
 * grids of a dataset) goes with the 3D view. It comes with the feature
 * bundle, with the cloud (see ui/heatCloud.ts). The flat heatmap has no
 * readout: its code would have to come with the first visit, or this
 * bundle with every one.
 */
import type { LngLat, MapMouseEvent, MapTouchEvent, Point } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { StoreState } from "../state/store";
import type { PathSegment } from "../types";
import { datasetIndex } from "../calculations/datasetIndex";
import { heightBandEdgesFt, parseHeightBand } from "../calculations/heightBand";
import { heatWeight } from "../calculations/heatLines";
import { airplaneLiftPx, liftExaggeration } from "../calculations/lift";
import {
  readoutAt,
  readoutData,
  readoutKept,
  readoutRadiusM,
  readoutText,
  releaseReadoutData,
  segmentGrid,
  sightLine,
  type CloudReadout,
  type ReadoutData,
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
 * Pixels the pointer may move from where the readout was last worked out
 * and keep it: the box follows, the words stay. Working one out takes up to
 * 49 looks from the screen to the ground and back along the line of sight
 * (see sightLine), each a read of the relief's depth in the 3D view, and a
 * radius is some tens of pixels, which a few pixels hardly change.
 */
const READOUT_SLACK_PX = 3;

/**
 * Longest what a readout needs at a new zoom waits for the page to have a
 * moment (whenIdle)
 */
const PREPARE_IDLE_MS = 500;

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
  "tourView",
];

/**
 * Run `work` in a task of its own once the page has a moment, as far as
 * the browser tells (requestIdleCallback, which Safari lacks), and not in
 * the task of the event that asked for it; as Wrapped's intro does (see
 * ui/wrappedIntro.ts), whose bundle this one does not share
 */
function whenIdle(work: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(work, { timeout: PREPARE_IDLE_MS });
  } else {
    setTimeout(work, 0);
  }
}

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
   * Whether the cloud of the 3D view is drawn, and the map is the user's.
   * Wrapped's intro draws it too (forcedHeatCloud), but there the map is
   * only looked at, and so it is while the hotspot tour flies over it.
   */
  const active = (): boolean =>
    app.threeDVisible &&
    app.heatCloud &&
    app.heatmapVisible &&
    !app.forcedHeatCloud &&
    !app.replayActive &&
    !app.wrappedVisible &&
    !app.tourView;

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
  /**
   * Where the pointer's frames last worked a readout out, and what it was,
   * for the moves of a few pixels after it (READOUT_SLACK_PX); null once
   * the map, the pointer or what the readout is of has moved on
   */
  let worked: { point: Point; readout: CloudReadout | null } | null = null;

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
    const { time, detail } = readoutText(readout);
    box.firstChild!.textContent = time;
    box.lastChild!.textContent = detail;
    box.hidden = false;
    place(point, finger);
  };

  /**
   * The radius of a readout at the map's zoom, in metres and in pixels, and
   * the zoom and the latitude of the middle of the map it is for
   */
  const radiusNow = () => {
    const zoom = map.getZoom();
    const lat = map.getCenter().lat;
    const pixelM = metresPerPixel(zoom) * Math.cos(lat * DEGREES_TO_RADIANS);
    const radiusM = readoutRadiusM(pixelM, cloudReachPx(zoom));
    return { radiusM, radiusPx: radiusM / pixelM, zoom, lat };
  };

  /**
   * Whether what a readout of `radiusM` of the dataset `segments` is worked
   * out from is kept (see readoutKept)
   */
  const ready = (segments: readonly PathSegment[], radiusM: number): boolean =>
    readoutKept(
      segments,
      app.terrainActive,
      app.reliefLevel,
      heatWeight,
      radiusM,
    );

  /** The seconds and heights of the dataset `segments` (see readoutData) */
  const dataOf = (segments: readonly PathSegment[]): ReadoutData =>
    readoutData(segments, app.terrainActive, app.reliefLevel);

  /** Whether prepare's task is on its way */
  let preparing = false;

  /**
   * Make what a readout at the map's zoom is worked out from where it is
   * not kept, once the page has a moment (whenIdle), and look again under
   * the pointer then. A zoom across a step of the radius needs another
   * grid, and a dataset or a relief level its seconds and heights the
   * first time: each took some tens of milliseconds on a desktop and
   * hundreds on a phone, in the frame of the next hover or in the tap. Not
   * while the map moves: it is asked for again where the map comes to rest.
   */
  const prepare = (): void => {
    const data = app.currentData;
    if (preparing || !data || ready(data.path_segments, radiusNow().radiusM)) {
      return;
    }
    preparing = true;
    whenIdle(() => {
      preparing = false;
      const data = app.currentData;
      if (!listening || !data || map.isMoving()) return;
      const segments = data.path_segments;
      const { radiusM } = radiusNow();
      if (ready(segments, radiusM)) return;
      dataOf(segments);
      segmentGrid(segments, radiusM);
      retell();
    });
  };

  /**
   * The readout of the cloud under the point `point` of the map. With
   * `waits`, as the pointer's frames ask, undefined where what it is worked
   * out from is still to be made: prepare makes it and looks again.
   */
  const readoutUnder = (
    point: Point,
    waits = false,
  ): CloudReadout | null | undefined => {
    const data = app.currentData;
    if (!data || !keep) return null;
    const { radiusM, radiusPx, zoom, lat } = radiusNow();
    const segments = data.path_segments;
    if (waits && !ready(segments, radiusM)) {
      prepare();
      return undefined;
    }
    const prepared = dataOf(segments);
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
      // Nothing is worked out while the map moves under the pointer (a
      // zoom by the wheel, a move of the app's): a zoom across the steps
      // of the radius made a grid for each on the way. It is looked at
      // again where the map comes to rest.
      if (!active() || dismissedAt || map.isMoving()) return hide();
      if (
        !worked ||
        Math.hypot(point.x - worked.point.x, point.y - worked.point.y) >
          READOUT_SLACK_PX
      ) {
        const readout = readoutUnder(point, true);
        // What it is worked out from is on its way (prepare)
        if (readout === undefined) return hide();
        worked = { point, readout };
      }
      if (worked.readout) show(worked.readout, point, finger);
      else hide();
    },
  );

  /**
   * Look again under the resting pointer, or at the place tapped last
   * where it still is on the map
   */
  const retell = (): void => {
    worked = null;
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
    worked = null;
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
    worked = null;
    hover.cancel();
    hide();
  };

  // A zoom by the wheel moves the map from under a pointer that rests,
  // and the app from under a tap; and a zoom may need another radius,
  // whose grid is made before a tap or a hover asks for it
  const onMoveEnd = (): void => {
    retell();
    prepare();
  };

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
    const { time, detail } = readoutText(readout);
    announceStatus(`${time}: ${detail.replace(" · ", ", ")}`);
  };

  /**
   * Before the page's own Escapes (it listens as the event comes down),
   * which leave one it took alone: the phone's statistics sheet closed
   * with it
   */
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !box || box.hidden) return;
    e.preventDefault();
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
      document.addEventListener("keydown", onKey, true);
      popups.observe(container, { childList: true });
    } else {
      map.off("mousemove", onMove);
      map.off("mouseout", leave);
      map.off("movestart", onMoveStart);
      map.off("moveend", onMoveEnd);
      map.off("touchstart", onTouch);
      map.off("mousedown", onPress);
      map.off("click", onClick);
      document.removeEventListener("keydown", onKey, true);
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
    // Ahead of a tap, which has no resting pointer to look again under
    if (on) prepare();
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

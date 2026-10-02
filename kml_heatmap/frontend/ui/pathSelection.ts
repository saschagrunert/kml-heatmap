/**
 * Path Selection - Handles path selection logic
 */
import type { Map as MapLibreMap, PaddingOptions, Point } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { segmentsForPathIds } from "../calculations/statistics";
import { loadFeatures } from "../services/featureLoader";
import { applyToggleButtonState, setUnavailable } from "../utils/buttonState";
import { isPhoneLayout } from "../utils/device";
import { NO_SELECTION_MESSAGE } from "./actions";
import { AUTO_ZOOM_FOLLOW } from "../utils/constants";
import { domCache } from "../utils/domCache";
import { segmentBounds } from "../utils/geometry";
import { pluralFlights } from "../utils/htmlGenerators";
import { toBounds, unwrapLng } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { announceStatus } from "../utils/toast";

/** What Isolate does, its title in the template */
const ISOLATE_LABEL = "Isolate selected paths";

/** The control columns, which the phone's bar replaces */
export const CONTROL_COLUMNS = "#left-buttons, #right-buttons";

/** What floats over the map along its edges and would cover a framed flight */
const MAP_CHROME_SELECTOR = [
  CONTROL_COLUMNS,
  "#selection-chip",
  "#flight-profile",
  "#cross-section",
  "#mobile-bar",
  ".color-legend",
].join(", ");

/**
 * How far from an edge something may sit and still count as standing at it.
 * On a phone the profile of a flight and the legend stand above the bar and
 * the map's credit, 81 px from the bottom and more with a home indicator:
 * at 48 px the profile, as wide as the map, counted at the left edge, and a
 * flight framed with it ended up beside it rather than above it.
 */
const EDGE_REACH_PX = 128;

/** Room kept between the framed flights and the edge or a panel (px) */
const FRAME_MARGIN_PX = 24;

/**
 * How much of the map between the panels a flight picked on its own spans
 * at least, across or down, for the view to stay where it is
 */
const SEEN_SPAN = 0.25;

/** Time the view takes to frame the isolated flights (ms) */
const FRAME_MS = 800;

type Edge = "top" | "right" | "bottom" | "left";

/**
 * Resolves after the next layout and the ResizeObservers that follow it,
 * which run after a frame's callbacks: two frames on
 */
function afterLayout(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * The padding a fit of the map needs to keep what it frames clear of the
 * panels over it: the control columns at the sides, the selection chip at
 * the top, the legend and the phone's bar at the bottom. Each panel counts
 * at the edge it stands at from which it reaches in least, and no edge
 * takes more than a third of the map. `margin` is the room left beyond,
 * and `chrome` the panels that count.
 */
export function mapChromePadding(
  map: Pick<MapLibreMap, "getContainer">,
  margin = FRAME_MARGIN_PX,
  chrome = MAP_CHROME_SELECTOR,
): Required<PaddingOptions> {
  const box = map.getContainer().getBoundingClientRect();
  const padding: Record<Edge, number> = {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };
  // On a phone the bar stands in for the columns, which the start view
  // is measured ahead of (the bar mounts after the map)
  const phone = isPhoneLayout();
  for (const element of document.querySelectorAll<HTMLElement>(chrome)) {
    if (element.hidden || (phone && element.matches(CONTROL_COLUMNS))) {
      continue;
    }
    const r = element.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // [how far it is from the edge, how far it reaches in from it]
    const edges: [Edge, number, number][] = [
      ["top", r.top - box.top, r.bottom - box.top],
      ["bottom", box.bottom - r.bottom, box.bottom - r.top],
      ["left", r.left - box.left, r.right - box.left],
      ["right", box.right - r.right, box.right - r.left],
    ];
    let edge: Edge | null = null;
    let depth = Infinity;
    for (const [side, distance, reach] of edges) {
      if (distance >= -1 && distance <= EDGE_REACH_PX && reach < depth) {
        edge = side;
        depth = reach;
      }
    }
    if (edge) padding[edge] = Math.max(padding[edge], depth);
  }
  const limit = (edge: Edge, size: number): number =>
    Math.min(padding[edge], size / 3) + margin;
  return {
    top: limit("top", box.height),
    bottom: limit("bottom", box.height),
    left: limit("left", box.width),
    right: limit("right", box.width),
  };
}

export class PathSelection {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;

    // The isolate button reads two keys, so it cannot use syncToggleButton;
    // this is its only writer
    const refresh = (): void => {
      this.updateIsolateButton();
      this.updateSelectionChip();
    };
    app.store.subscribeKeys(["selectedPathIds", "isolateSelection"], refresh);
    refresh();

    domCache.get("selection-clear-btn")?.addEventListener(
      "click",
      () => {
        // The chip hides with the selection, and would drop the focus on
        // its Clear to <body>; the map is what the selection was on
        if (!app.replayActive) app.map?.getCanvas().focus();
        this.clearSelection();
      },
      { signal: app.signal },
    );
  }

  togglePathSelection(pathId: number): void {
    // Both changes land in one flush so no listener sees a selection that is
    // empty while isolate mode is still on
    this.app.store.batch(() => {
      if (this.app.selectedPathIds.has(pathId)) {
        this.app.selectedPathIds.delete(pathId);
      } else {
        this.app.selectedPathIds.add(pathId);
      }
      this.app.store.notifyMutation("selectedPathIds");

      // If no paths remain selected, disable isolate mode
      if (this.app.selectedPathIds.size === 0 && this.app.isolateSelection) {
        this.app.isolateSelection = false;
      }
    });
  }

  /**
   * A flight picked from a list (the airport popup's, the flight list):
   * select just this flight, or nothing when it already is the whole
   * selection. Opening an airport's popup with a click or Enter selected
   * every flight of the airport, so a plain toggle would leave the others
   * selected. With `add` (Ctrl or Shift on the flight list) it is added to
   * the selection, or taken out of it. Ignored while replay runs.
   *
   * One flush for the clear and the pick: two had the chip announce
   * "Selection cleared" before every flight and drew the paths and the
   * statistics of the empty selection in between.
   */
  selectFlight(pathId: number, add = false): void {
    if (this.app.replayActive) return;
    const selected = this.app.selectedPathIds;
    const alone = selected.size === 1 && selected.has(pathId);
    this.app.store.batch(() => {
      if (!add) this.clearSelection();
      if (add || !alone) this.togglePathSelection(pathId);
    });
    if (add || alone) return;
    // On a phone the statistics sheet or an airport's popup it was picked
    // from covers the map it is to be seen on, the popup together with the
    // profile strip that opens under it
    if (this.app.mobileBar?.isVisible()) {
      this.app.statsPanelVisible = false;
      this.app.airportManager.closePopup();
    }
    this.bringIntoView(pathId);
  }

  /**
   * A flight picked on its own from a list can be anywhere: off the screen,
   * or under the profile of the flight that opens with it at the bottom of
   * the map. That profile is drawn by the feature bundle, which the
   * selection fetches (MapApp.followFlightProfile), so the view waits for
   * it and for the layout after it, where a legend that stands on the
   * profile has moved up (its height is measured then), and then frames
   * the flight clear of the panels unless all of it is in view already. A
   * flight clicked on the map is where the user is looking, and that path
   * does not come here; nor is the map taken back from a user who moved it
   * meanwhile, or from the hotspot tour or Wrapped, which fly it.
   */
  private bringIntoView(pathId: number): void {
    const map = this.app.map;
    if (!map) return;
    let moved = false;
    const onMoveStart = (event: { originalEvent?: unknown }): void => {
      if (event.originalEvent) moved = true;
    };
    map.on("movestart", onMoveStart);
    void loadFeatures()
      .then(afterLayout)
      .then(() => {
        map.off("movestart", onMoveStart);
        const app = this.app;
        // Unless the selection moved on while the bundle loaded
        const selected = app.selectedPathIds;
        const still = selected.size === 1 && selected.has(pathId);
        const busy = app.replayActive || app.wrappedVisible || app.tourView;
        if (still && !moved && !busy) this.frameSelection(true);
      });
  }

  /** Mark the listed flights' buttons that are part of the selection */
  markSelected(buttons: Iterable<HTMLElement>): void {
    for (const button of buttons) {
      const selected = this.app.selectedPathIds.has(
        Number(button.dataset["pathId"]),
      );
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  selectPathsByAirport(airportName: string): void {
    const pathIds = this.app.airportToPaths[airportName];
    if (pathIds) {
      pathIds.forEach((pathId) => {
        this.app.selectedPathIds.add(pathId);
      });
      this.app.store.notifyMutation("selectedPathIds");
    }
  }

  /**
   * Clearing and Isolate leave the selection alone while replay runs: it
   * plays the one selected flight, and a change dimmed the replay's own
   * Stop button and switched the statistics to another view mid-flight.
   * Their controls are disabled then as well.
   */
  clearSelection(): void {
    if (this.app.replayActive) return;

    this.app.store.batch(() => {
      this.app.selectedPathIds.clear();
      this.app.store.notifyMutation("selectedPathIds");

      // Disable isolate mode when selection is cleared
      if (this.app.isolateSelection) {
        this.app.isolateSelection = false;
      }
    });
  }

  toggleIsolateSelection(): void {
    if (this.app.replayActive || this.app.selectedPathIds.size === 0) {
      return;
    }

    this.app.isolateSelection = !this.app.isolateSelection;
    if (this.app.isolateSelection) this.frameSelection();
  }

  /**
   * Bring the selected flights into view, clear of the panels: isolated,
   * they are all the map shows, and one could stay half off the screen or
   * under the chip that says it is selected. The map keeps its bearing.
   * With `unlessInView` the map stays where it is when every point of them
   * is on it and clear of the panels already, and they span a quarter of
   * the map between the panels either way: a circuit round the home field
   * was a speck in the middle of the heat, and on a phone none at all. No
   * closer than a replay follows a flight: a few fixes on a field were
   * framed at the map's deepest zoom.
   */
  private frameSelection(unlessInView = false): void {
    const map = this.app.map;
    const data = this.app.currentData;
    if (!map || !data) return;
    const segments = segmentsForPathIds(
      data.path_segments,
      this.app.selectedPathIds,
    );
    const bounds = segmentBounds(segments);
    if (!bounds) return;
    const padding = mapChromePadding(map);
    if (unlessInView) {
      const { width, height } = map.getContainer().getBoundingClientRect();
      // Each point on the world copy the map shows: across the
      // antimeridian the other side of a flight is a world away otherwise
      const centre = map.getCenter().lng;
      const clear = segments.every((segment) =>
        segment.coords.every(([lat, lng]) => {
          const { x, y } = map.project([unwrapLng(lng, centre), lat]);
          return (
            x >= padding.left &&
            x <= width - padding.right &&
            y >= padding.top &&
            y <= height - padding.bottom
          );
        }),
      );
      // How far apart the corners of their bounds are on the map
      const [a, b] = toBounds(bounds).map((corner) => map.project(corner)) as [
        Point,
        Point,
      ];
      const seen = Math.max(
        Math.abs(b.x - a.x) / (width - padding.left - padding.right),
        Math.abs(b.y - a.y) / (height - padding.top - padding.bottom),
      );
      if (clear && seen > SEEN_SPAN) return;
    }
    map.fitBounds(toBounds(bounds), {
      padding,
      maxZoom: AUTO_ZOOM_FOLLOW,
      bearing: map.getBearing(),
      duration: FRAME_MS,
      animate: !prefersReducedMotion(),
    });
  }

  /**
   * Say what is selected, and offer the way out.
   *
   * The selection is drawn on the paths, and the paths are only drawn once
   * the map is zoomed in far enough for them, so at the zoom levels that
   * show the heat bloom alone a selection was invisible. It is also what
   * Isolate, Replay and a shared link all act on, and none of them said how
   * much that was.
   */
  private updateSelectionChip(): void {
    const chip = domCache.get("selection-chip");
    const count = domCache.get("selection-chip-count");
    if (!chip || !count) return;

    const selected = this.app.selectedPathIds.size;
    const text = selected > 0 ? pluralFlights(selected) + " selected" : "";
    const changed = count.textContent !== text;
    count.textContent = text;
    chip.hidden = selected === 0;

    // The polite region rather than a live chip: the count changes on every
    // click on a path, and a live region that replaces its own text is read
    // once things settle rather than once per click. The chip going away
    // is said too; with the Clear that had the focus gone, nothing did.
    if (changed) announceStatus(selected > 0 ? text : "Selection cleared");
  }

  /**
   * Isolate is a toggle that also needs a selection: `active` carries the
   * mode, aria-disabled "nothing to isolate yet", which the stylesheet dims.
   */
  updateIsolateButton(): void {
    const btn = domCache.get("isolate-btn");
    if (!btn) return;

    applyToggleButtonState(btn, this.app.isolateSelection);
    // Still focusable, like the replay button, but announced as unavailable,
    // and saying why where the phone's sheet already did
    const none = this.app.selectedPathIds.size === 0;
    setUnavailable(btn, none, none ? NO_SELECTION_MESSAGE : ISOLATE_LABEL);
  }
}

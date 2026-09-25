/**
 * Path Selection - Handles path selection logic
 */
import type { Map as MapLibreMap, PaddingOptions } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { segmentsForPathIds } from "../calculations/statistics";
import { applyToggleButtonState } from "../utils/buttonState";
import { domCache } from "../utils/domCache";
import { segmentBounds } from "../utils/geometry";
import { pluralFlights } from "../utils/htmlGenerators";
import { resizeMapAfterTransition, toBounds } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { announceStatus } from "../utils/toast";

/** What floats over the map along its edges and would cover a framed flight */
const MAP_CHROME_SELECTOR = [
  "#left-buttons",
  "#right-buttons",
  "#selection-chip",
  "#mobile-bar",
  ".color-legend",
].join(", ");

/** How far from an edge something may sit and still count as standing at it */
const EDGE_REACH_PX = 48;

/** Room kept between the framed flights and the edge or a panel (px) */
const FRAME_MARGIN_PX = 24;

/** Time the view takes to frame the isolated flights (ms) */
const FRAME_MS = 800;

type Edge = "top" | "right" | "bottom" | "left";

/**
 * The padding a fit of the map needs to keep what it frames clear of the
 * panels over it: the control columns at the sides, the selection chip at
 * the top, the legend and the phone's bar at the bottom. Each panel counts
 * at the edge it stands at from which it reaches in least, and no edge
 * takes more than a third of the map.
 */
export function mapChromePadding(map: MapLibreMap): PaddingOptions {
  const box = map.getContainer().getBoundingClientRect();
  const padding: Record<Edge, number> = {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };
  for (const element of document.querySelectorAll<HTMLElement>(
    MAP_CHROME_SELECTOR,
  )) {
    if (element.hidden) continue;
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
    Math.min(padding[edge], size / 3) + FRAME_MARGIN_PX;
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

    this.afterSelectionChange();
  }

  selectPathsByAirport(airportName: string): void {
    const pathIds = this.app.airportToPaths[airportName];
    if (pathIds) {
      pathIds.forEach((pathId) => {
        this.app.selectedPathIds.add(pathId);
      });
      this.app.store.notifyMutation("selectedPathIds");
    }

    this.afterSelectionChange();
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

    this.afterSelectionChange();
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
   */
  private frameSelection(): void {
    const map = this.app.map;
    const data = this.app.currentData;
    if (!map || !data) return;
    const bounds = segmentBounds(
      segmentsForPathIds(data.path_segments, this.app.selectedPathIds),
    );
    if (!bounds) return;
    map.fitBounds(toBounds(bounds), {
      padding: mapChromePadding(map),
      bearing: map.getBearing(),
      duration: FRAME_MS,
      animate: !prefersReducedMotion(),
    });
  }

  /**
   * The drawn paths, the statistics, airport visibility and the replay
   * button follow the store on their own (DataManager rebuilds or restyles
   * the paths); what is left is the map's size.
   */
  private afterSelectionChange(): void {
    if (this.app.altitudeVisible || this.app.airspeedVisible) {
      resizeMapAfterTransition(this.app.map);
    }
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
    // Still focusable, like the replay button, but announced as unavailable
    btn.setAttribute(
      "aria-disabled",
      String(this.app.selectedPathIds.size === 0),
    );
  }
}

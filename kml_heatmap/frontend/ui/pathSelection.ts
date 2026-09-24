/**
 * Path Selection - Handles path selection logic
 */
import type { MapApp } from "../mapApp";
import { applyToggleButtonState } from "../utils/buttonState";
import { domCache } from "../utils/domCache";
import { pluralFlights } from "../utils/htmlGenerators";
import { resizeMapAfterTransition } from "../utils/mapHelpers";
import { announceStatus } from "../utils/toast";

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
    app.store.subscribe("selectedPathIds", refresh);
    app.store.subscribe("isolateSelection", refresh);
    refresh();

    domCache
      .get("selection-clear-btn")
      ?.addEventListener("click", () => this.clearSelection(), {
        signal: app.signal,
      });
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
    // once things settle rather than once per click
    if (changed && selected > 0) announceStatus(text);
  }

  /**
   * Isolate is a toggle that also needs a selection: `active` carries the
   * mode, the dimmed state carries "nothing to isolate yet". Colours belong
   * to the stylesheet, so only the opacity is set here.
   */
  updateIsolateButton(): void {
    const btn = domCache.get("isolate-btn");
    if (!btn) return;

    applyToggleButtonState(btn, this.app.isolateSelection);
    const empty = this.app.selectedPathIds.size === 0;
    // Still focusable, like the replay button, but announced as unavailable
    btn.setAttribute("aria-disabled", String(empty));
    if (!this.app.isolateSelection) {
      btn.style.opacity = empty ? "0.5" : "1.0";
    }
  }
}

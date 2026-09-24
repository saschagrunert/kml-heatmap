import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFERRED_WHILE_INITIALIZING,
  bindActions,
} from "../../../../kml_heatmap/frontend/ui/actions";
import { createMockApp, asMapApp, type MockApp } from "../../testHelpers";

const loggerMock = vi.hoisted(() => ({ logError: vi.fn(), logDebug: vi.fn() }));
vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => loggerMock);

const BUTTON_ACTIONS = [
  "toggleHeatmap",
  "toggleStats",
  "toggleAltitude",
  "toggleAirspeed",
  "toggleAirports",
  "toggleAviation",
  "toggleGlobe",
  "resetNorth",
  "resetView",
  "toggleReplay",
  "exportMap",
  "shareLink",
  "showWrapped",
  "closeWrapped",
  "toggleIsolateSelection",
  "playReplay",
  "pauseReplay",
  "stopReplay",
  "toggleAutoZoom",
  "unknownAction",
];

describe("bindActions", () => {
  let app: MockApp;
  let elements: Record<string, HTMLElement>;

  beforeEach(() => {
    vi.clearAllMocks();
    elements = {};
    for (const action of BUTTON_ACTIONS) {
      const btn = document.createElement("button");
      btn.dataset["action"] = action;
      document.body.appendChild(btn);
      elements[action] = btn;
    }

    const yearSelect = document.createElement("select");
    yearSelect.dataset["action"] = "filterByYear";
    document.body.appendChild(yearSelect);
    elements["filterByYear"] = yearSelect;

    const aircraftSelect = document.createElement("select");
    aircraftSelect.dataset["action"] = "filterByAircraft";
    document.body.appendChild(aircraftSelect);
    elements["filterByAircraft"] = aircraftSelect;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.dataset["action"] = "seekReplay";
    slider.value = "50";
    document.body.appendChild(slider);
    elements["seekReplay"] = slider;

    const speedSelect = document.createElement("select");
    speedSelect.dataset["action"] = "changeReplaySpeed";
    document.body.appendChild(speedSelect);
    elements["changeReplaySpeed"] = speedSelect;

    app = createMockApp();
    bindActions(asMapApp(app));
  });

  afterEach(() => {
    Object.values(elements).forEach((element) => element.remove());
  });

  it("binds the layer and export toggles", () => {
    elements["toggleHeatmap"]!.click();
    elements["toggleAltitude"]!.click();
    elements["toggleAirspeed"]!.click();
    elements["toggleAirports"]!.click();
    elements["toggleAviation"]!.click();
    elements["exportMap"]!.click();

    expect(app.uiToggles.toggleHeatmap).toHaveBeenCalledTimes(1);
    expect(app.uiToggles.toggleAltitude).toHaveBeenCalledTimes(1);
    expect(app.uiToggles.toggleAirspeed).toHaveBeenCalledTimes(1);
    expect(app.uiToggles.toggleAirports).toHaveBeenCalledTimes(1);
    expect(app.uiToggles.toggleAviation).toHaveBeenCalledTimes(1);
    expect(app.uiToggles.exportMap).toHaveBeenCalledTimes(1);
  });

  it("binds the globe switch and the compass, which need no data", () => {
    app.isInitializing = true;

    elements["toggleGlobe"]!.click();
    elements["resetNorth"]!.click();

    expect(app.mapOrientation.toggleGlobe).toHaveBeenCalledTimes(1);
    expect(app.mapOrientation.resetNorth).toHaveBeenCalledTimes(1);
  });

  it("unbinds every control once the app is gone", () => {
    const lifetime = new AbortController();
    const ended = createMockApp({ signal: lifetime.signal });
    bindActions(asMapApp(ended));

    lifetime.abort();
    elements["toggleHeatmap"]!.click();
    elements["filterByYear"]!.dispatchEvent(new Event("change"));

    expect(ended.uiToggles.toggleHeatmap).not.toHaveBeenCalled();
    expect(ended.filterManager.filterByYear).not.toHaveBeenCalled();
    // The app bound in beforeEach still lives
    expect(app.uiToggles.toggleHeatmap).toHaveBeenCalledTimes(1);
  });

  it("binds the share button like every other control", () => {
    elements["shareLink"]!.click();

    expect(app.uiToggles.shareLink).toHaveBeenCalledTimes(1);
  });

  it("binds the statistics toggle", () => {
    elements["toggleStats"]!.click();

    expect(app.statsManager.toggleStats).toHaveBeenCalledTimes(1);
  });

  it("binds the replay transport", async () => {
    elements["toggleReplay"]!.click();
    elements["playReplay"]!.click();
    elements["pauseReplay"]!.click();
    elements["stopReplay"]!.click();
    elements["seekReplay"]!.dispatchEvent(new Event("input"));
    elements["changeReplaySpeed"]!.dispatchEvent(new Event("change"));
    elements["toggleAutoZoom"]!.click();

    // Replay comes from the lazily loaded feature bundle, so the first
    // click reaches the manager a microtask later
    await vi.waitFor(() =>
      expect(app.replayManager.toggleReplay).toHaveBeenCalledTimes(1),
    );
    expect(app.replayManager.playReplay).toHaveBeenCalledTimes(1);
    expect(app.replayManager.pauseReplay).toHaveBeenCalledTimes(1);
    expect(app.replayManager.stopReplay).toHaveBeenCalledTimes(1);
    expect(app.replayManager.seekReplay).toHaveBeenCalledWith("50");
    expect(app.replayManager.changeReplaySpeed).toHaveBeenCalledTimes(1);
    expect(app.replayManager.toggleAutoZoom).toHaveBeenCalledTimes(1);
  });

  it("binds the filters to the change event", () => {
    elements["filterByYear"]!.dispatchEvent(new Event("change"));
    elements["filterByAircraft"]!.dispatchEvent(new Event("change"));

    expect(app.filterManager.filterByYear).toHaveBeenCalledTimes(1);
    expect(app.filterManager.filterByAircraft).toHaveBeenCalledTimes(1);
  });

  it("binds the Wrapped dialog", async () => {
    elements["showWrapped"]!.click();
    elements["closeWrapped"]!.click();

    await vi.waitFor(() =>
      expect(app.wrappedManager.showWrapped).toHaveBeenCalledTimes(1),
    );
    expect(app.wrappedManager.closeWrapped).toHaveBeenCalledTimes(1);
  });

  it("binds the isolate toggle", () => {
    elements["toggleIsolateSelection"]!.click();

    expect(app.pathSelection.toggleIsolateSelection).toHaveBeenCalledTimes(1);
  });

  it("ignores unknown actions", () => {
    expect(() => elements["unknownAction"]!.click()).not.toThrow();
  });

  it("binds Reset view, which waits for the data like the filters", () => {
    elements["resetView"]!.click();
    expect(app.resetView).toHaveBeenCalledTimes(1);

    app.isInitializing = true;
    elements["resetView"]!.click();
    expect(app.resetView).toHaveBeenCalledTimes(1);
  });

  it("logs a Reset view that failed instead of throwing", async () => {
    const error = new Error("reset failed");
    app.resetView.mockRejectedValueOnce(error);

    elements["resetView"]!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(loggerMock.logError).toHaveBeenCalledWith(error);
  });

  it("ignores data-dependent actions while initializing but keeps UI toggles", () => {
    app.isInitializing = true;

    for (const action of DEFERRED_WHILE_INITIALIZING) {
      const element = elements[action];
      if (!element) continue;
      const event =
        element.tagName === "SELECT"
          ? "change"
          : element.tagName === "INPUT"
            ? "input"
            : "click";
      element.dispatchEvent(new Event(event));
    }
    elements["toggleHeatmap"]!.click();
    elements["toggleAltitude"]!.click();
    elements["toggleStats"]!.click();

    expect(app.filterManager.filterByYear).not.toHaveBeenCalled();
    expect(app.filterManager.filterByAircraft).not.toHaveBeenCalled();
    expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();
    expect(app.wrappedManager.showWrapped).not.toHaveBeenCalled();
    expect(app.uiToggles.exportMap).not.toHaveBeenCalled();
    expect(app.pathSelection.toggleIsolateSelection).not.toHaveBeenCalled();
    expect(app.uiToggles.toggleHeatmap).toHaveBeenCalledTimes(1);
    expect(app.uiToggles.toggleAltitude).toHaveBeenCalledTimes(1);
    expect(app.statsManager.toggleStats).toHaveBeenCalledTimes(1);
  });

  it("logs rejected filter promises instead of throwing", async () => {
    const error = new Error("filter failed");
    app.filterManager.filterByYear.mockRejectedValueOnce(error);

    elements["filterByYear"]!.dispatchEvent(new Event("change"));
    await Promise.resolve();
    await Promise.resolve();

    expect(loggerMock.logError).toHaveBeenCalledWith(error);
  });
});

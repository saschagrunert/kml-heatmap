import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as L from "leaflet";
import {
  createAirportMarkers,
  dropUnknownPathIds,
  loadInitialData,
  resolveYearSelection,
} from "../../../../kml_heatmap/frontend/appInitializer";
import type {
  Airport,
  KMLDataset,
  Metadata,
} from "../../../../kml_heatmap/frontend/types";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  syncControlsWithStore,
  type MockApp,
} from "../../testHelpers";
import type { MockMarker } from "../../../mocks/leaflet";

const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../../../../kml_heatmap/frontend/utils/toast", () => toastMock);

function setupDOM(): void {
  document.body.innerHTML = `
    <select id="year-select"><option value="all">All Years</option></select>
    <button id="airspeed-btn"></button>
    <div id="altitude-legend"></div>
    <div id="airspeed-legend"></div>
  `;
}

function yearSelect(): HTMLSelectElement {
  return document.getElementById("year-select") as HTMLSelectElement;
}

const airports: Airport[] = [
  { name: "Frankfurt EDDF", lat: 50.1, lon: 8.67 },
  { name: "Munich EDDM", lat: 48.35, lon: 11.78 },
];

const metadata: Metadata = {
  available_years: [2024, 2025],
  year_file_bytes: {},
  min_groundspeed_knots: 10,
  max_groundspeed_knots: 150,
  aircraft_models: { "D-ABCD": "Diamond DA40" },
};

describe("appInitializer", () => {
  let app: MockApp;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDOM();
    app = createMockApp({ isInitializing: true });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("resolveYearSelection", () => {
    it("populates the select and defaults to the latest year", () => {
      resolveYearSelection(asMapApp(app), [2023, 2024]);

      expect([...yearSelect().options].map((o) => o.value)).toEqual([
        "all",
        "2023",
        "2024",
      ]);
      expect(app.selectedYear).toBe("2024");
      expect(yearSelect().value).toBe("2024");
    });

    it("keeps a restored 'all'", () => {
      app.restoredYearFromState = true;

      resolveYearSelection(asMapApp(app), [2023, 2024]);

      expect(app.selectedYear).toBe("all");
      expect(yearSelect().value).toBe("all");
    });

    it("keeps an available restored year", () => {
      app.selectedYear = "2023";

      resolveYearSelection(asMapApp(app), [2023, 2024]);

      expect(app.selectedYear).toBe("2023");
      expect(yearSelect().value).toBe("2023");
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("falls back to the latest year with a toast for an unavailable year", () => {
      app.selectedYear = "1999";

      resolveYearSelection(asMapApp(app), [2023, 2024]);

      expect(app.selectedYear).toBe("2024");
      expect(yearSelect().value).toBe("2024");
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Year 1999 is not available, showing 2024",
        "info",
      );
    });

    it("falls back to 'all' when no years exist", () => {
      app.selectedYear = "1999";

      resolveYearSelection(asMapApp(app), []);

      expect(app.selectedYear).toBe("all");
      expect(yearSelect().value).toBe("all");
    });

    it("works without a year select element", () => {
      yearSelect().remove();

      expect(() => resolveYearSelection(asMapApp(app), [2024])).not.toThrow();
      expect(app.selectedYear).toBe("2024");
    });
  });

  describe("createAirportMarkers", () => {
    it("creates one marker per airport with an icon and no popup yet", () => {
      createAirportMarkers(asMapApp(app), airports);

      expect(L.marker).toHaveBeenCalledTimes(2);
      expect(vi.mocked(L.marker).mock.calls[0]![0]).toEqual([50.1, 8.67]);
      const marker = vi.mocked(L.marker).mock.results[0]!
        .value as unknown as MockMarker;
      // The popup is bound by AirportManager.updateAirportPopups() once the
      // path data is loaded, so no marker ever shows a stale flight count
      expect(marker.bindPopup).not.toHaveBeenCalled();
      expect(vi.mocked(L.marker).mock.calls[0]![1]).toMatchObject({
        title: "Frankfurt EDDF",
        alt: "Frankfurt EDDF",
      });
      expect(marker.addTo).toHaveBeenCalledWith(app.airportLayer);
      expect(app.airportLayer.hasLayer(marker)).toBe(true);
      expect(Object.keys(app.airportMarkers)).toEqual([
        "Frankfurt EDDF",
        "Munich EDDM",
      ]);
    });

    it("does not pre-assign the home base (the airport manager does)", () => {
      createAirportMarkers(asMapApp(app), airports);

      const htmls = vi
        .mocked(L.divIcon)
        .mock.calls.map((c) => c[0]!.html as string);
      expect(htmls.every((h) => !h.includes("airport-marker-home"))).toBe(true);
    });

    it("selects the airport's paths on click unless replay is active", () => {
      createAirportMarkers(asMapApp(app), airports);
      const marker = vi.mocked(L.marker).mock.results[0]!
        .value as unknown as MockMarker;
      const click = marker.on.mock.calls.find((c) => c[0] === "click")![1] as (
        e: unknown,
      ) => void;

      click({});
      expect(app.pathSelection.selectPathsByAirport).toHaveBeenCalledWith(
        "Frankfurt EDDF",
      );

      app.replayManager.state.active = true;
      click({});
      expect(app.pathSelection.selectPathsByAirport).toHaveBeenCalledTimes(1);
    });

    it("handles an empty list and missing names", () => {
      createAirportMarkers(asMapApp(app), []);
      expect(L.marker).not.toHaveBeenCalled();

      createAirportMarkers(asMapApp(app), [{ name: "", lat: 1, lon: 2 }]);
      expect(L.marker).toHaveBeenCalledTimes(1);
      expect(Object.keys(app.airportMarkers)).toEqual([""]);
    });

    it("rejects invalid coordinates (mock validation)", () => {
      expect(() =>
        createAirportMarkers(asMapApp(app), [{ name: "X", lat: 91, lon: 0 }]),
      ).toThrow(/latitude/);
    });
  });

  describe("loadInitialData", () => {
    const data: KMLDataset = createDataset(
      [{ id: 1, year: 2025, aircraft_registration: "D-ABCD" }],
      [createSegment({ path_id: 1 })],
      10,
    );

    beforeEach(() => {
      app.dataManager.loadAirports.mockResolvedValue(airports);
      app.dataManager.loadMetadata.mockResolvedValue(metadata);
      app.dataManager.loadData.mockResolvedValue(data);
    });

    it("loads everything in order and stores the results", async () => {
      const order: string[] = [];
      for (const [name, fn] of [
        ["loadAirports", app.dataManager.loadAirports],
        ["loadMetadata", app.dataManager.loadMetadata],
        ["loadData", app.dataManager.loadData],
        ["updateLayers", app.dataManager.updateLayers],
      ] as const) {
        const original = fn.getMockImplementation();
        fn.mockImplementation((...args: unknown[]) => {
          order.push(name);
          return original ? (original(...args) as unknown) : Promise.resolve();
        });
      }
      app.filterManager.updateAircraftDropdown.mockImplementation(() =>
        order.push("dropdown"),
      );
      app.airportManager.updateAirportMarkerSizes.mockImplementation(() =>
        order.push("markerSizes"),
      );

      await loadInitialData(asMapApp(app));

      expect(order).toEqual([
        "loadAirports",
        "loadMetadata",
        "loadData",
        "dropdown",
        "updateLayers",
        "markerSizes",
      ]);
      expect(app.allAirportsData).toBe(airports);
      expect(app.aircraftModels).toBe(metadata.aircraft_models);
      expect(app.hasTimingData).toBe(true);
      expect(app.selectedYear).toBe("2025");
      expect(app.dataManager.loadData).toHaveBeenCalledWith("2025");
      expect(app.currentData).toBe(data);
      expect(Object.keys(app.airportMarkers)).toHaveLength(2);
      expect(app.airspeedRange).toEqual({ min: 10, max: 150 });
      expect(app.layerManager.updateAirspeedLegend).toHaveBeenCalledWith(
        10,
        150,
      );
    });

    it("falls back to no models for metadata from an older export", async () => {
      const { aircraft_models: _, ...older } = metadata;
      app.dataManager.loadMetadata.mockResolvedValue(older);

      await loadInitialData(asMapApp(app));

      expect(app.aircraftModels).toEqual({});
    });

    it("publishes the dataset after the markers exist, so their popups can follow it", async () => {
      const markersAtPublish: string[][] = [];
      app.store.subscribe("currentData", () => {
        markersAtPublish.push(Object.keys(app.airportMarkers));
      });

      await loadInitialData(asMapApp(app));

      expect(markersAtPublish).toEqual([["Frankfurt EDDF", "Munich EDDM"]]);
    });

    it("enables the airspeed button with timing data and leaves its look to the store", async () => {
      syncControlsWithStore(app.store);

      await loadInitialData(asMapApp(app));

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      expect(btn.style.opacity).toBe("0.5");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    });

    it("keeps the airspeed button lit when airspeed is visible", async () => {
      app.airspeedVisible = true;
      syncControlsWithStore(app.store);

      await loadInitialData(asMapApp(app));

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.style.opacity).toBe("1");
      expect(app.map!.addLayer).toHaveBeenCalledWith(app.airspeedLayer);
      expect(document.getElementById("airspeed-legend")!.style.display).toBe(
        "block",
      );
    });

    it("disables the airspeed button without timing data", async () => {
      app.dataManager.loadMetadata.mockResolvedValue({
        ...metadata,
        max_groundspeed_knots: 0,
      });

      await loadInitialData(asMapApp(app));

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(app.airspeedRange).toEqual({ min: 0, max: 200 });
    });

    it("tolerates a missing airspeed button", async () => {
      document.getElementById("airspeed-btn")!.remove();
      await expect(loadInitialData(asMapApp(app))).resolves.toBeUndefined();
    });

    it("restores the altitude layer", async () => {
      app.altitudeVisible = true;

      await loadInitialData(asMapApp(app));

      expect(app.map!.addLayer).toHaveBeenCalledWith(app.altitudeLayer);
      expect(app.map!.addLayer).not.toHaveBeenCalledWith(app.airspeedLayer);
    });

    it("adds the aviation layer when configured and visible", async () => {
      const layer = { addTo: vi.fn() };
      app.config.openaipApiKey = "key";
      app.openaipLayers["Aviation Data"] = layer as never;
      app.aviationVisible = true;

      await loadInitialData(asMapApp(app));

      expect(app.map!.addLayer).toHaveBeenCalledWith(layer);
    });

    it("skips layer restoration without a map", async () => {
      app.map = null;

      await expect(loadInitialData(asMapApp(app))).resolves.toBeUndefined();
      expect(app.airportManager.updateAirportMarkerSizes).toHaveBeenCalled();
    });

    it("restores the stats panel through the stats manager", async () => {
      app.savedState = { statsPanelVisible: true };

      await loadInitialData(asMapApp(app));

      expect(app.statsManager.setStatsPanelVisible).toHaveBeenCalledWith(true);
    });

    it("handles null metadata and data", async () => {
      app.dataManager.loadMetadata.mockResolvedValue(null);
      app.dataManager.loadData.mockResolvedValue(null);

      await loadInitialData(asMapApp(app));

      expect(app.aircraftModels).toEqual({});
      expect(app.hasTimingData).toBe(false);
      expect(app.currentData).toBeNull();
      expect(app.selectedYear).toBe("all");
      expect(app.dataManager.loadData).toHaveBeenCalledWith("all");
      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(app.dataManager.updateLayers).toHaveBeenCalled();
    });

    it("builds the layers from the dataset it loaded (regression)", async () => {
      await loadInitialData(asMapApp(app));

      expect(app.dataManager.updateLayers).toHaveBeenCalledWith(data);
    });

    it("does not load a year that failed a second time for the layers (regression)", async () => {
      app.dataManager.loadData.mockResolvedValue(null);

      await loadInitialData(asMapApp(app));

      // updateLayers() without the result would fetch and report it again
      expect(app.dataManager.loadData).toHaveBeenCalledTimes(1);
      expect(app.dataManager.updateLayers).toHaveBeenCalledWith(null);
    });

    it("keeps created markers accessible for the airport manager", async () => {
      await loadInitialData(asMapApp(app));

      const marker = app.airportMarkers[
        "Frankfurt EDDF"
      ] as unknown as MockMarker;
      expect(marker.latlng).toEqual({ lat: 50.1, lng: 8.67 });
    });

    it("keeps no restored path the dataset does not have", async () => {
      app.selectedPathIds = new Set([1, 99]);
      const selections: number[][] = [];
      app.store.subscribe("currentData", () => {
        selections.push([...app.selectedPathIds]);
      });

      await loadInitialData(asMapApp(app));

      // Nobody sees the new dataset with the stale id still selected
      expect(selections).toEqual([[1]]);
    });
  });

  describe("dropUnknownPathIds", () => {
    const data = createDataset([
      { id: 840108108563, year: 2025 },
      { id: 7, year: 2025 },
    ]);

    it("keeps a selection the dataset knows untouched", () => {
      const selected = new Set([7, 840108108563]);
      app.selectedPathIds = selected;
      app.isolateSelection = true;
      const listener = vi.fn();
      app.store.subscribe("selectedPathIds", listener);

      dropUnknownPathIds(asMapApp(app), data);

      expect(app.selectedPathIds).toBe(selected);
      expect([...selected]).toEqual([7, 840108108563]);
      expect(app.isolateSelection).toBe(true);
      expect(listener).not.toHaveBeenCalled();
    });

    it("drops unknown ids and keeps isolating the rest", () => {
      app.selectedPathIds = new Set([3, 7, 12]);
      app.isolateSelection = true;
      const listener = vi.fn();
      app.store.subscribe("selectedPathIds", listener);

      dropUnknownPathIds(asMapApp(app), data);

      expect([...app.selectedPathIds]).toEqual([7]);
      expect(app.isolateSelection).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("turns isolation off when no selected id is left", () => {
      app.selectedPathIds = new Set([3]);
      app.isolateSelection = true;
      const seen: [number, boolean][] = [];
      app.store.subscribe("selectedPathIds", () => {
        seen.push([app.selectedPathIds.size, app.isolateSelection]);
      });

      dropUnknownPathIds(asMapApp(app), data);

      expect(app.selectedPathIds.size).toBe(0);
      expect(app.isolateSelection).toBe(false);
      // Both changes arrive together: never an empty isolated selection
      expect(seen).toEqual([[0, false]]);
    });

    it("keeps the ids when a year of the dataset failed to load", () => {
      app.selectedPathIds = new Set([7, 99]);
      app.isolateSelection = true;

      dropUnknownPathIds(asMapApp(app), { ...data, incomplete: true });

      expect([...app.selectedPathIds]).toEqual([7, 99]);
      expect(app.isolateSelection).toBe(true);
    });

    it("does nothing without a selection", () => {
      app.isolateSelection = false;
      const listener = vi.fn();
      app.store.subscribe("selectedPathIds", listener);

      dropUnknownPathIds(asMapApp(app), data);

      expect(listener).not.toHaveBeenCalled();
    });
  });
});

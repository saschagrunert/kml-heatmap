import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as L from "leaflet";
import {
  createAirportIcon,
  createAirportMarkers,
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
  type MockApp,
} from "../../testHelpers";
import type { MockMarker } from "../../../mocks/leaflet";

const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../../../../kml_heatmap/frontend/utils/toast", () => toastMock);

function setupDOM(): void {
  document.body.innerHTML = `
    <select id="year-select"><option value="all">All Years</option></select>
    <button id="airspeed-btn"></button>
    <div id="altitude-legend" style="display:none"></div>
    <div id="airspeed-legend" style="display:none"></div>
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
  stats: {
    total_points: 1,
    num_paths: 1,
    num_airports: 1,
    airport_names: [],
    num_aircraft: 1,
    aircraft_list: [],
    total_distance_km: 1,
    total_distance_nm: 1,
    max_groundspeed_knots: 150,
  },
  min_groundspeed_knots: 10,
  max_groundspeed_knots: 150,
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

  describe("createAirportIcon", () => {
    it("extracts the ICAO code and marks the home base", () => {
      createAirportIcon("Frankfurt EDDF", true);

      const options = vi.mocked(L.divIcon).mock.calls[0]![0]!;
      const html = options.html as string;
      expect(html).toContain(">EDDF<");
      expect(html).toContain("airport-marker airport-marker-home");
      expect(html).toContain("airport-label airport-label-home");
      expect(options).toMatchObject({
        iconSize: [12, 12],
        iconAnchor: [6, 6],
        popupAnchor: [0, -6],
        className: "",
      });
    });

    it("falls back to APT without an ICAO code and omits home classes", () => {
      createAirportIcon("Small Airfield 123", false);

      const html = vi.mocked(L.divIcon).mock.calls[0]![0]!.html as string;
      expect(html).toContain(">APT<");
      expect(html).not.toContain("airport-marker-home");
      expect(html).not.toContain("airport-label-home");
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
      app.airportManager.updateAirportPopups.mockImplementation(() =>
        order.push("popups"),
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
        "popups",
        "updateLayers",
        "markerSizes",
      ]);
      expect(app.allAirportsData).toBe(airports);
      expect(app.fullStats).toBe(metadata.stats);
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

    it("enables the airspeed button with timing data", async () => {
      await loadInitialData(asMapApp(app));

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      expect(btn.style.opacity).toBe("0.5");
    });

    it("lights the airspeed button when airspeed is visible", async () => {
      app.airspeedVisible = true;

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
      expect(btn.style.opacity).toBe("0.3");
      expect(app.airspeedRange).toEqual({ min: 0, max: 200 });
    });

    it("tolerates a missing airspeed button", async () => {
      document.getElementById("airspeed-btn")!.remove();
      await expect(loadInitialData(asMapApp(app))).resolves.toBeUndefined();
    });

    it("restores the altitude layer and legend", async () => {
      app.altitudeVisible = true;

      await loadInitialData(asMapApp(app));

      expect(app.map!.addLayer).toHaveBeenCalledWith(app.altitudeLayer);
      expect(document.getElementById("altitude-legend")!.style.display).toBe(
        "block",
      );
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

    it("updates the replay button when paths were restored", async () => {
      app.selectedPathIds.add(1);

      await loadInitialData(asMapApp(app));

      expect(app.replayManager.updateReplayButtonState).toHaveBeenCalledTimes(
        1,
      );
    });

    it("restores the stats panel without saving state", async () => {
      app.savedState = { statsPanelVisible: true };

      await loadInitialData(asMapApp(app));

      expect(app.statsManager.setStatsPanelVisible).toHaveBeenCalledWith(
        true,
        false,
      );
    });

    it("handles null metadata and data", async () => {
      app.dataManager.loadMetadata.mockResolvedValue(null);
      app.dataManager.loadData.mockResolvedValue(null);

      await loadInitialData(asMapApp(app));

      expect(app.fullStats).toBeNull();
      expect(app.currentData).toBeNull();
      expect(app.selectedYear).toBe("all");
      expect(app.dataManager.loadData).toHaveBeenCalledWith("all");
      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(app.dataManager.updateLayers).toHaveBeenCalled();
    });

    it("keeps created markers accessible for the airport manager", async () => {
      await loadInitialData(asMapApp(app));

      const marker = app.airportMarkers[
        "Frankfurt EDDF"
      ] as unknown as MockMarker;
      expect(marker.latlng).toEqual({ lat: 50.1, lng: 8.67 });
    });
  });
});

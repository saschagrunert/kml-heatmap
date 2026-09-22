import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  colorSegmentPopups,
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
import { Marker as MockMarker } from "../../../mocks/maplibre-gl";

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
    function create(list: Airport[] = airports): void {
      createAirportMarkers(asMapApp(app), list);
    }

    function eddf(): MockApp["airportMarkers"][string] {
      return app.airportMarkers["Frankfurt EDDF"]!;
    }

    it("creates one marker per airport, on the map and with no popup of its own", () => {
      create();

      expect(Object.keys(app.airportMarkers)).toEqual([
        "Frankfurt EDDF",
        "Munich EDDM",
      ]);
      const marker = eddf().marker as unknown as MockMarker;
      expect(marker).toBeInstanceOf(MockMarker);
      expect(marker.options).toEqual({
        element: eddf().getElement(),
        anchor: "center",
      });
      // Longitude first for the map, latitude first for the app
      expect(marker.setLngLat).toHaveBeenCalledWith([8.67, 50.1]);
      expect(eddf().getLatLng()).toEqual({ lat: 50.1, lng: 8.67 });
      expect(marker.addTo).toHaveBeenCalledWith(app.map);
      expect(app.map!.getCanvasContainer().contains(eddf().getElement())).toBe(
        true,
      );
      // The popup is AirportManager's, shared and opened by the app;
      // `setPopup` would toggle it a second time on the same click
      expect(marker.setPopup).not.toHaveBeenCalled();
    });

    it("makes each marker a button named after its airport", () => {
      create();
      const element = eddf().getElement();

      expect(element).toBeInstanceOf(HTMLButtonElement);
      expect(element.type).toBe("button");
      expect(element.classList.contains("airport-marker-root")).toBe(true);
      expect(element.title).toBe("Frankfurt EDDF");
      expect(element.getAttribute("aria-label")).toBe("Frankfurt EDDF");
      // It opens a popup, which starts out closed
      expect(element.getAttribute("aria-expanded")).toBe("false");
      // The code is a label of the map (see ui/airportLabels.ts)
      expect(element.querySelector(".airport-label")).toBeNull();
    });

    it("does not pre-assign the home base (the airport manager does)", () => {
      create();

      for (const marker of Object.values(app.airportMarkers)) {
        expect(
          marker.getElement().querySelector(".airport-marker-home"),
        ).toBeNull();
      }
    });

    it("switches the home-base styling on the same element", () => {
      create();
      const element = eddf().getElement();

      eddf().setHome(true);
      expect(element.querySelector(".airport-marker-home")).not.toBeNull();

      eddf().setHome(false);
      expect(element.querySelector(".airport-marker-home")).toBeNull();
      expect(eddf().getElement()).toBe(element);
    });

    it("hides a marker without taking it off the map", () => {
      create();

      eddf().setVisible(false);
      expect(eddf().getElement().hidden).toBe(true);
      expect(eddf().marker.remove).not.toHaveBeenCalled();

      eddf().setVisible(true);
      expect(eddf().getElement().hidden).toBe(false);
    });

    it("drives the shared popup of the airport manager", () => {
      create();
      app.airportManager.isPopupOpen.mockReturnValue(true);

      eddf().openPopup();
      eddf().closePopup();

      expect(app.airportManager.openPopup).toHaveBeenCalledWith(
        "Frankfurt EDDF",
      );
      expect(app.airportManager.closePopup).toHaveBeenCalledWith(
        "Frankfurt EDDF",
      );
      expect(eddf().isPopupOpen()).toBe(true);
      expect(app.airportManager.isPopupOpen).toHaveBeenCalledWith(
        "Frankfurt EDDF",
      );
    });

    it("activates its airport on a click, which the airport manager acts on", () => {
      create();

      eddf().getElement().click();

      expect(app.airportManager.activateAirport).toHaveBeenCalledWith(
        "Frankfurt EDDF",
      );
    });

    it("ignores the later clicks of a double click or a double tap", () => {
      create();
      const element = eddf().getElement();

      element.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 2 }),
      );

      expect(app.airportManager.activateAirport).not.toHaveBeenCalled();
    });

    it("ignores a second tap that WebKit reports as a single click", () => {
      create();
      const element = eddf().getElement();

      for (let tap = 0; tap < 2; tap++) {
        element.dispatchEvent(
          new MouseEvent("click", { bubbles: true, detail: 1 }),
        );
      }

      expect(app.airportManager.activateAirport).toHaveBeenCalledTimes(1);
    });

    it("stops none of its events on their way to the map", () => {
      // A press goes through so a drag that starts on a marker moves the
      // map; the map's own handlers tell a marker by the event's target
      create();
      const onMap = vi.fn();
      const container = app.map!.getCanvasContainer();
      const types = ["click", "mousemove", "dblclick", "mousedown"];
      for (const type of types) container.addEventListener(type, onMap);

      for (const type of types) {
        eddf()
          .getElement()
          .dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }

      expect(onMap).toHaveBeenCalledTimes(types.length);
    });

    it("acts on a click alone, which is also Enter and Space on a button", () => {
      const listen = vi.spyOn(HTMLButtonElement.prototype, "addEventListener");

      create([airports[0]!]);

      // The only key is Escape; the pointer's coming and going lights the
      // label up
      expect(listen.mock.calls.map(([type]) => type).sort()).toEqual([
        "click",
        "keydown",
        "mouseenter",
        "mouseleave",
      ]);
      listen.mockRestore();

      // The keys arrive as the click the browser makes of them, and not a
      // second time through a key listener
      eddf()
        .getElement()
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      expect(app.airportManager.activateAirport).not.toHaveBeenCalled();
    });

    it("lights its label up while the pointer is on the dot", () => {
      create();
      const element = eddf().getElement();

      element.dispatchEvent(new MouseEvent("mouseenter"));
      expect(app.map!.setFeatureState).toHaveBeenLastCalledWith(
        { source: "airport-labels", id: "Frankfurt EDDF" },
        { hover: true },
      );

      element.dispatchEvent(new MouseEvent("mouseleave"));
      expect(app.map!.setFeatureState).toHaveBeenLastCalledWith(
        { source: "airport-labels", id: "Frankfurt EDDF" },
        { hover: false },
      );
    });

    it("closes its popup on Escape from the focused marker", () => {
      create();
      const element = eddf().getElement();

      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
      expect(app.airportManager.closePopup).not.toHaveBeenCalled();

      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      expect(app.airportManager.closePopup).toHaveBeenCalledWith(
        "Frankfurt EDDF",
      );
    });

    it("handles an empty list and missing names", () => {
      create([]);
      expect(app.airportMarkers).toEqual({});

      create([{ name: "", lat: 1, lon: 2 }]);
      expect(Object.keys(app.airportMarkers)).toEqual([""]);
    });

    it("creates nothing without a map", () => {
      app.map = null;

      create();

      expect(app.airportMarkers).toEqual({});
    });

    it("rejects invalid coordinates (mock validation)", () => {
      expect(() => create([{ name: "X", lat: 91, lon: 0 }])).toThrow(/lat/i);
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
      expect(app.airspeedLayer.setVisible).toHaveBeenCalledWith(true);
      expect(document.getElementById("airspeed-legend")!.hidden).toBe(false);
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

      expect(app.altitudeLayer.setVisible).toHaveBeenCalledWith(true);
      expect(app.airspeedLayer.setVisible).toHaveBeenCalledWith(false);
    });

    it("shows the aviation layer when visible", async () => {
      app.aviationVisible = true;

      await loadInitialData(asMapApp(app));

      expect(app.aviationLayer.setVisible).toHaveBeenCalledWith(true);
      expect(app.aviationLayer.isVisible()).toBe(true);
    });

    it("restores the layers without a map: the handles remember", async () => {
      app.map = null;
      app.altitudeVisible = true;

      await expect(loadInitialData(asMapApp(app))).resolves.toBeUndefined();
      expect(app.airportManager.updateAirportMarkerSizes).toHaveBeenCalled();
      expect(app.altitudeLayer.setVisible).toHaveBeenCalledWith(true);
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

      const marker = app.airportMarkers["Frankfurt EDDF"]!;
      expect(marker.getLatLng()).toEqual({ lat: 50.1, lng: 8.67 });
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
  describe("colorSegmentPopups", () => {
    it("colours a metric as it is written into a popup", async () => {
      const map = document.createElement("div");
      map.id = "map";
      map.innerHTML = '<div class="maplibregl-popup"></div>';
      document.body.appendChild(map);

      colorSegmentPopups();
      const content = document.createElement("div");
      content.innerHTML =
        '<div class="kh-popup-metric-colored" data-metric-color="rgb(1, 2, 3)"></div>';
      map.firstElementChild!.appendChild(content);
      await Promise.resolve();

      const metric = content.firstElementChild as HTMLElement;
      expect(metric.style.getPropertyValue("--kh-metric-color")).toBe(
        "rgb(1, 2, 3)",
      );
      map.remove();
    });

    it("does nothing without a map", () => {
      expect(() => colorSegmentPopups()).not.toThrow();
    });
  });
});

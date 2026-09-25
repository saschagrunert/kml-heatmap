import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  colorSegmentPopups,
  createAirportMarkers,
  dropUnknownPathIds,
  loadInitialData,
  NO_YEAR_LABEL,
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

const toastMock = vi.hoisted(() => ({
  showToast: vi.fn(),
  announceStatus: vi.fn(),
  dismissToast: vi.fn(),
}));
vi.mock("../../../../kml_heatmap/frontend/utils/toast", () => toastMock);

function setupDOM(): void {
  document.body.innerHTML = `
    <select id="year-select"><option value="all">All Years</option></select>
    <button id="airspeed-btn"></button>
    <div id="altitude-legend"></div>
    <div id="airspeed-legend"></div>
    <div id="map-empty" hidden><button id="map-empty-retry"></button></div>
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

    it("remembers the year a first visit opens on, whatever was restored", () => {
      // Reset view goes back to it (MapApp.resetView)
      app.selectedYear = "2023";

      resolveYearSelection(asMapApp(app), [2024, 2023]);

      expect(app.selectedYear).toBe("2023");
      expect(app.defaultYear).toBe("2024");
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
        "markerSizes",
      ]);
      expect(app.aircraftModels).toBe(metadata.aircraft_models);
      expect(app.hasTimingData).toBe(true);
      expect(app.selectedYear).toBe("2025");
      expect(app.dataManager.loadData).toHaveBeenCalledWith("2025");
      expect(app.currentData).toBe(data);
      expect(Object.keys(app.airportMarkers)).toHaveLength(2);
      expect(app.airspeedRange).toEqual({ min: 10, max: 150 });
    });

    it("says which year it shows once the flights are there", async () => {
      await loadInitialData(asMapApp(app));

      // The loading indicator's region went quiet after a load (regression)
      expect(toastMock.announceStatus).toHaveBeenCalledWith("Showing 2025");
    });

    it("settles the speed range before the dataset draws the layers", async () => {
      // Publishing the dataset is what draws the layers (DataManager
      // follows the store), so what they are drawn with comes first
      const atPublish: unknown[] = [];
      app.store.subscribe("currentData", () =>
        atPublish.push({ ...app.airspeedRange }, app.hasTimingData),
      );

      await loadInitialData(asMapApp(app));

      expect(atPublish).toEqual([{ min: 10, max: 150 }, true]);
    });

    it("publishes the dataset and the aircraft list in one update", async () => {
      app.filterManager.updateAircraftDropdown.mockImplementation(() => {
        app.selectedAircraft = "all";
      });
      app.selectedAircraft = "D-GONE";
      const listener = vi.fn();
      app.store.subscribeKeys(["currentData", "selectedAircraft"], listener);

      await loadInitialData(asMapApp(app));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(app.currentData).toBe(data);
      expect(app.selectedAircraft).toBe("all");
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
      syncControlsWithStore(app);

      await loadInitialData(asMapApp(app));

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      // Off, and available: no style of its own, the stylesheet draws it
      expect(btn.style.opacity).toBe("");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    });

    it("keeps the airspeed button lit when airspeed is visible", async () => {
      app.airspeedVisible = true;
      syncControlsWithStore(app);

      await loadInitialData(asMapApp(app));

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.classList.contains("active")).toBe(true);
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

    it("gets through without a map", async () => {
      app.map = null;

      await expect(loadInitialData(asMapApp(app))).resolves.toBeUndefined();
      expect(app.airportManager.updateAirportMarkerSizes).toHaveBeenCalled();
    });

    it("restores the stats panel through the store key the rail follows", async () => {
      app.savedState = { statsPanelVisible: true };

      await loadInitialData(asMapApp(app));

      expect(app.store.get("statsPanelVisible")).toBe(true);
    });

    it("handles null metadata and data", async () => {
      app.dataManager.loadMetadata.mockResolvedValue(null);
      app.dataManager.loadData.mockResolvedValue(null);

      await loadInitialData(asMapApp(app));

      expect(app.aircraftModels).toEqual({});
      expect(app.hasTimingData).toBe(false);
      expect(app.currentData).toBeNull();
      expect(app.selectedYear).toBe("all");
      // No Retry on the toast: the panel on the map has the one
      expect(app.dataManager.loadData).toHaveBeenCalledWith("all");
      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      // The aircraft list is still settled
      expect(app.filterManager.updateAircraftDropdown).toHaveBeenCalled();
    });

    it("does not load a year that failed a second time for the layers (regression)", async () => {
      app.dataManager.loadData.mockResolvedValue(null);

      await loadInitialData(asMapApp(app));

      expect(app.dataManager.loadData).toHaveBeenCalledTimes(1);
      expect(app.dataManager.updateLayers).not.toHaveBeenCalled();
    });

    it("keeps created markers accessible for the airport manager", async () => {
      await loadInitialData(asMapApp(app));

      const marker = app.airportMarkers["Frankfurt EDDF"]!;
      expect(marker.getLatLng()).toEqual({ lat: 50.1, lng: 8.67 });
    });

    it("stretches the speed scale over the speeds of the dataset", async () => {
      const segments = Array.from({ length: 101 }, (_, i) =>
        createSegment({ path_id: 1, groundspeed_knots: 40 + i }),
      );
      app.dataManager.loadData.mockResolvedValue(
        createDataset(
          [{ id: 1, year: 2025, aircraft_registration: "D-ABCD" }],
          segments,
        ),
      );

      await loadInitialData(asMapApp(app));

      // The 5th and the 95th of 40 to 140 kt, not the metadata's 10 to 150
      expect(app.airspeedRange).toMatchObject({ min: 45, max: 135 });
    });

    it("drops its dataset when the year was switched while it loaded", async () => {
      // A Reset view from the phone's bar went ahead during the first load,
      // and its year was then covered by this one's dataset
      const newer = createDataset([{ id: 2, year: 2024 }]);
      app.dataManager.loadData.mockImplementation(() => {
        app.store.batch(() => {
          app.selectedYear = "2024";
          app.currentData = newer;
        });
        return Promise.resolve(data);
      });

      await loadInitialData(asMapApp(app));

      expect(app.selectedYear).toBe("2024");
      expect(app.currentData).toBe(newer);
    });

    it("writes the dropdown before the store announces the year", async () => {
      // The Filter sheet mirrors the dropdown when the store says the year
      // changed, and read the one of before
      const seen: string[] = [];
      app.store.subscribe("selectedYear", () => seen.push(yearSelect().value));

      await loadInitialData(asMapApp(app));

      expect(seen).toEqual(["2025"]);
    });

    describe("when the year fails to load", () => {
      beforeEach(() => {
        app.dataManager.loadData.mockResolvedValue(null);
      });

      it("shows no year in the dropdown, so picking it again asks again", async () => {
        await loadInitialData(asMapApp(app));

        expect(app.selectedYear).toBe("2025");
        // A placeholder that cannot be picked, where no selection at all
        // left the control without text (regression)
        const shown = yearSelect().selectedOptions[0]!;
        expect(shown.value).toBe("");
        expect(shown.textContent).toBe(NO_YEAR_LABEL);
        expect(shown.disabled).toBe(true);
        expect(yearSelect().value).toBe("");
      });

      it("says nothing loaded, where a load that worked says which year", async () => {
        await loadInitialData(asMapApp(app));

        expect(toastMock.announceStatus).not.toHaveBeenCalled();
      });

      it("hides every airport, which no flights say to show", async () => {
        await loadInitialData(asMapApp(app));

        expect(app.airportManager.updateAirportOpacity).toHaveBeenCalled();
      });

      it("has an open Filter sheet read the dropdown again", async () => {
        // The store did not change, and the sheet kept showing the year
        const refresh = vi.fn();
        app.mobileBar = {
          sheet: { refresh },
        } as unknown as MockApp["mobileBar"];

        await loadInitialData(asMapApp(app));

        expect(refresh).toHaveBeenCalled();
      });

      it("keeps a year someone picked during the load", async () => {
        app.dataManager.loadData.mockImplementation(() => {
          yearSelect().value = "2024";
          return Promise.resolve(null);
        });

        await loadInitialData(asMapApp(app));

        // Applied once the load is over (MapApp.applyPendingFilterChanges)
        expect(yearSelect().value).toBe("2024");
      });

      it("says so on the map, and loads the year again from there", async () => {
        const panel = document.getElementById("map-empty")!;
        const loaded = createDataset([{ id: 1, year: 2025 }]);
        app.filterManager.retryLoad.mockImplementation(() => {
          // Hidden while it loads: the loading indicator takes its place
          expect(panel.hidden).toBe(true);
          app.currentData = loaded;
          return Promise.resolve(true);
        });

        await loadInitialData(asMapApp(app));
        expect(panel.hidden).toBe(false);

        document.getElementById("map-empty-retry")!.click();

        expect(app.filterManager.retryLoad).toHaveBeenCalledTimes(1);
        // The failures of loads it said are being acted on, and no other
        // error on screen is taken with them (regression)
        expect(app.dataManager.dismissFailures).toHaveBeenCalled();
        expect(toastMock.dismissToast).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(panel.hidden).toBe(true));
      });

      it("offers no second Retry on the toast of the failure", async () => {
        await loadInitialData(asMapApp(app));

        // The panel's Retry is the one; two of them at once, styled apart,
        // were two ways of doing one thing
        expect(app.dataManager.loadData).toHaveBeenCalledWith("2025");
      });

      it("takes the keyboard to its Retry as it appears", async () => {
        await loadInitialData(asMapApp(app));

        expect(document.activeElement).toBe(
          document.getElementById("map-empty-retry"),
        );
      });

      it("leaves the focus where someone put it meanwhile", async () => {
        const elsewhere = document.createElement("button");
        document.body.append(elsewhere);
        app.dataManager.loadData.mockImplementation(() => {
          elsewhere.focus();
          return Promise.resolve(null);
        });

        await loadInitialData(asMapApp(app));

        expect(document.activeElement).toBe(elsewhere);
        elsewhere.remove();
      });

      it("shows the panel again when the retry fails too", async () => {
        const panel = document.getElementById("map-empty")!;
        app.filterManager.retryLoad.mockResolvedValue(false);
        await loadInitialData(asMapApp(app));

        document.getElementById("map-empty-retry")!.click();

        expect(panel.hidden).toBe(true);
        await vi.waitFor(() => expect(panel.hidden).toBe(false));
      });

      it("hands the focus of its Retry to the map as it hides", async () => {
        document.body.append(app.map!.getCanvas());
        app.map!.getCanvas().tabIndex = 0;
        await loadInitialData(asMapApp(app));
        const retry = document.getElementById("map-empty-retry")!;
        retry.focus();

        retry.click();

        expect(document.activeElement).toBe(app.map!.getCanvas());
      });
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

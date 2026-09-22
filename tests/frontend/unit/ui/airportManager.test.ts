import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AirportManager } from "../../../../kml_heatmap/frontend/ui/airportManager";
import { createAirportMarkers } from "../../../../kml_heatmap/frontend/appInitializer";
import {
  DOUBLE_TAP_MS,
  panPopupIntoView,
} from "../../../../kml_heatmap/frontend/utils/mapHelpers";
import * as motion from "../../../../kml_heatmap/frontend/utils/motion";
import type {
  AirportMarker,
  PathInfo,
} from "../../../../kml_heatmap/frontend/types";
import {
  MAP_LAYERS,
  MAP_SOURCES,
} from "../../../../kml_heatmap/frontend/utils/constants";
import {
  createMockApp,
  createDataset,
  asMapApp,
  type MockApp,
} from "../../testHelpers";
import type { Popup as MockPopup } from "../../../mocks/maplibre-gl";
import type { Point } from "maplibre-gl";

const { loadFeatures, listFlights } = vi.hoisted(() => {
  const listFlights = vi.fn();
  return {
    listFlights,
    loadFeatures: vi.fn(() => Promise.resolve({ listFlights })),
  };
});
vi.mock("../../../../kml_heatmap/frontend/services/featureLoader", () => ({
  loadFeatures,
}));
vi.mock(
  "../../../../kml_heatmap/frontend/utils/mapHelpers",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../kml_heatmap/frontend/utils/mapHelpers")
    >()),
    panPopupIntoView: vi.fn(),
  }),
);

/** The count the popup shows, as its markup */
function countHtml(count: number): string {
  return `<span class="popup-metric-value kh-popup-accent">${count}</span>`;
}

/** Let the feature bundle "load" */
async function featuresLoaded(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** jsdom does not track how focus arrived; say it here */
function focusVisible(element: HTMLElement, visible: boolean): void {
  Object.defineProperty(element, "matches", {
    configurable: true,
    value: (selector: string) => visible && selector === ":focus-visible",
  });
}

describe("AirportManager", () => {
  let airportManager: AirportManager;
  let mockApp: MockApp;
  let markers: Record<string, AirportMarker>;
  let mapContainer: HTMLElement;
  /** The popup the manager shares between the airports */
  let popup: MockPopup;

  const pathInfo: PathInfo[] = [
    {
      id: 1,
      year: 2025,
      aircraft_registration: "D-ABCD",
      start_airport: "EDDF",
      end_airport: "EDDM",
    },
    {
      id: 2,
      year: 2025,
      aircraft_registration: "D-EFGH",
      start_airport: "EDDM",
      end_airport: "EDDF",
    },
    {
      id: 3,
      year: 2024,
      aircraft_registration: "D-ABCD",
      start_airport: "EDDF",
      end_airport: "EDDK",
    },
  ];

  const airports = [
    { name: "EDDF", lat: 50.1, lon: 8.67 },
    { name: "EDDM", lat: 48.35, lon: 11.78 },
    { name: "EDDK", lat: 50.87, lon: 7.14 },
    { name: "LOWW", lat: 48.11, lon: 16.57 },
  ];

  function isHome(name: string): boolean {
    return (
      markers[name]!.getElement().querySelector(".airport-marker-home") !== null
    );
  }

  beforeEach(() => {
    // In the document, so that the markers and the popup can take focus
    mapContainer = document.createElement("div");
    mapContainer.id = "map";
    document.body.appendChild(mapContainer);

    mockApp = createMockApp({
      currentData: createDataset(pathInfo),
      allAirportsData: airports.map((airport) => ({ ...airport })),
    });
    airportManager = new AirportManager(asMapApp(mockApp));
    // The markers are the app's own, wired to this manager like the app's
    (mockApp as unknown as { airportManager: AirportManager }).airportManager =
      airportManager;
    createAirportMarkers(asMapApp(mockApp), mockApp.allAirportsData);
    markers = mockApp.airportMarkers;
    popup = (airportManager as unknown as { popup: MockPopup }).popup;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    listFlights.mockReset();
    loadFeatures.mockClear();
    vi.mocked(panPopupIntoView).mockClear();
  });

  describe("the shared popup", () => {
    it("is one popup that leaves focus and width to the app", () => {
      expect(popup.options).toEqual({
        focusAfterOpen: false,
        maxWidth: "none",
        offset: 12,
        // MapLibre would close it in the click on the marker that opened
        // it; MapApp's click dispatcher closes it instead
        closeOnClick: false,
      });
      // `setPopup` brings click and key handling that would toggle twice
      for (const marker of Object.values(markers)) {
        expect(marker.marker.getPopup()).toBeNull();
      }
    });

    it("opens on the marker with the counts of the current filter", () => {
      markers["EDDF"]!.openPopup();

      expect(popup.isOpen()).toBe(true);
      expect(popup.map).toBe(mockApp.map);
      expect(popup.getLngLat()).toMatchObject({ lng: 8.67, lat: 50.1 });
      const html = popup.getElement().innerHTML;
      expect(html).toContain("EDDF");
      expect(html).toContain(countHtml(3));
      expect(html).toContain("https://www.google.com/maps?q=50.1,8.67");
      expect(html).toContain("HOME");
      expect(markers["EDDF"]!.isPopupOpen()).toBe(true);
      expect(markers["EDDM"]!.isPopupOpen()).toBe(false);
      expect(airportManager.isPopupOpen()).toBe(true);
    });

    it("closes once the globe has turned its airport away", () => {
      mockApp.map!.setProjection({ type: "globe" });
      markers["EDDF"]!.openPopup();

      mockApp.map!.jumpTo({ center: [60, 40] });
      mockApp.map!.emit("move");
      expect(popup.isOpen()).toBe(true);

      mockApp.map!.jumpTo({ center: [-160, 40] });
      mockApp.map!.emit("move");
      expect(popup.isOpen()).toBe(false);
      expect(airportManager.isPopupOpen()).toBe(false);
    });

    it("writes the content when it opens, not before", () => {
      airportManager.updateAirportPopups();

      expect(popup.setHTML).not.toHaveBeenCalled();
    });

    it("moves to another airport without closing in between", () => {
      const closed = vi.fn();
      popup.on("close", closed);
      markers["EDDF"]!.openPopup();
      markers["EDDF"]!.getElement().focus();

      markers["EDDM"]!.openPopup();

      expect(popup.addTo).toHaveBeenCalledTimes(1);
      expect(closed).not.toHaveBeenCalled();
      expect(popup.getLngLat()).toMatchObject({ lng: 11.78, lat: 48.35 });
      expect(popup.getElement().innerHTML).toContain("EDDM");
      expect(popup.getElement().innerHTML).not.toContain("HOME");
      expect(markers["EDDF"]!.isPopupOpen()).toBe(false);
      expect(markers["EDDM"]!.isPopupOpen()).toBe(true);
    });

    it("shows zero flights for airports outside the filter", () => {
      markers["LOWW"]!.openPopup();

      expect(popup.getElement().innerHTML).toContain(countHtml(0));
    });

    it("rewrites the open popup when the filter changes", () => {
      markers["EDDF"]!.openPopup();
      // The filter change reaches the manager through the store
      mockApp.selectedAircraft = "D-EFGH";

      expect(popup.setHTML).toHaveBeenCalledTimes(2);
      expect(popup.addTo).toHaveBeenCalledTimes(1);
      expect(popup.getElement().innerHTML).toContain(countHtml(1));
    });

    it("leaves a closed popup alone when the filter changes", () => {
      markers["EDDF"]!.openPopup();
      markers["EDDF"]!.closePopup();
      popup.setHTML.mockClear();

      mockApp.selectedAircraft = "D-EFGH";

      expect(popup.setHTML).not.toHaveBeenCalled();
    });

    it("closes only for the airport it is open for", () => {
      markers["EDDF"]!.openPopup();

      markers["EDDM"]!.closePopup();
      expect(popup.isOpen()).toBe(true);

      markers["EDDF"]!.closePopup();
      expect(popup.isOpen()).toBe(false);
      expect(markers["EDDF"]!.isPopupOpen()).toBe(false);
      expect(airportManager.isPopupOpen()).toBe(false);
    });

    it("does nothing for an unknown airport or without a map", () => {
      airportManager.openPopup("NOPE");
      expect(popup.isOpen()).toBe(false);

      mockApp.map = null;
      airportManager.openPopup("EDDF");
      expect(popup.isOpen()).toBe(false);
    });

    it("recounts when the dataset is replaced, even at the same size", () => {
      markers["EDDF"]!.openPopup();
      expect(popup.getElement().innerHTML).toContain(countHtml(3));

      // Same year, same aircraft filter and the same number of paths, but a
      // different dataset: counts keyed on the size alone would go stale
      mockApp.currentData = createDataset([
        { id: 1, year: 2025, start_airport: "EDDM", end_airport: "EDDK" },
        { id: 2, year: 2025, start_airport: "EDDM", end_airport: "EDDK" },
        { id: 3, year: 2025, start_airport: "EDDM", end_airport: "EDDK" },
      ]);

      expect(popup.getElement().innerHTML).toContain(countHtml(0));
      markers["EDDM"]!.openPopup();
      expect(popup.getElement().innerHTML).toContain(countHtml(3));
    });
  });

  describe("the flight list and the pan into view", () => {
    it("lists the flights after the content is written, then pans", async () => {
      const order: string[] = [];
      popup.setHTML.mockImplementationOnce((html: string) => {
        order.push("setHTML");
        popup
          .getElement()
          .querySelector(".maplibregl-popup-content")!.innerHTML = html;
        return popup;
      });
      listFlights.mockImplementation(() => order.push("listFlights"));
      vi.mocked(panPopupIntoView).mockImplementation(() => {
        order.push("pan");
      });

      markers["EDDF"]!.openPopup();
      popup.setLngLat.mockClear();
      await featuresLoaded();

      expect(loadFeatures).toHaveBeenCalled();
      expect(listFlights).toHaveBeenCalledWith(mockApp, popup, "EDDF");
      expect(order).toEqual(["setHTML", "listFlights", "pan"]);
      // Laid out again for the height the list added, where it stood
      expect(popup.setLngLat).toHaveBeenCalledTimes(1);
      expect(popup.getLngLat()).toMatchObject({ lng: 8.67, lat: 50.1 });
      expect(panPopupIntoView).toHaveBeenCalledWith(
        mockApp.map,
        popup,
        50,
        true,
      );
    });

    it("lists them again whenever the content is rewritten", async () => {
      markers["EDDF"]!.openPopup();
      await featuresLoaded();
      mockApp.selectedAircraft = "D-EFGH";
      await featuresLoaded();

      expect(listFlights).toHaveBeenCalledTimes(2);
      expect(panPopupIntoView).toHaveBeenCalledTimes(2);
    });

    it("pans without the list when the bundle failed to load", async () => {
      loadFeatures.mockResolvedValueOnce(
        null as unknown as { listFlights: typeof listFlights },
      );

      markers["EDDF"]!.openPopup();
      await featuresLoaded();

      expect(listFlights).not.toHaveBeenCalled();
      expect(panPopupIntoView).toHaveBeenCalledTimes(1);
    });

    it("pans without animation under reduced motion", async () => {
      const reduced = vi
        .spyOn(motion, "prefersReducedMotion")
        .mockReturnValue(true);

      markers["EDDF"]!.openPopup();
      await featuresLoaded();
      reduced.mockRestore();

      expect(panPopupIntoView).toHaveBeenCalledWith(
        mockApp.map,
        popup,
        50,
        false,
      );
    });

    it("drops the list of a popup that closed while the bundle loaded", async () => {
      markers["EDDF"]!.openPopup();
      markers["EDDF"]!.closePopup();
      await featuresLoaded();

      expect(listFlights).not.toHaveBeenCalled();
      expect(panPopupIntoView).not.toHaveBeenCalled();
    });

    it("drops the list of an airport the popup has left", async () => {
      markers["EDDF"]!.openPopup();
      markers["EDDM"]!.openPopup();
      await featuresLoaded();

      expect(listFlights).toHaveBeenCalledTimes(1);
      expect(listFlights).toHaveBeenCalledWith(mockApp, popup, "EDDM");
    });
  });

  describe("a second activation of a marker", () => {
    let clickAt = 0;

    /**
     * A click as the browser reports it: `detail` counts a burst of them.
     * Each comes later than a double tap would, so only `detail` makes one.
     */
    function click(name: string, detail = 1): void {
      const event = new MouseEvent("click", { bubbles: true, detail });
      clickAt += DOUBLE_TAP_MS;
      Object.defineProperty(event, "timeStamp", { value: clickAt });
      markers[name]!.getElement().dispatchEvent(event);
    }

    function expanded(name: string): string | null {
      return markers[name]!.getElement().getAttribute("aria-expanded");
    }

    it("closes the popup it opened, as the airplane's does", () => {
      expect(expanded("EDDF")).toBe("false");

      click("EDDF");
      expect(popup.isOpen()).toBe(true);
      expect(expanded("EDDF")).toBe("true");

      click("EDDF");
      expect(popup.isOpen()).toBe(false);
      expect(expanded("EDDF")).toBe("false");
      // Closing selects nothing a second time
      expect(mockApp.pathSelection.selectPathsByAirport).toHaveBeenCalledTimes(
        1,
      );
    });

    it("moves the popup to another airport without closing it", () => {
      const closed = vi.fn();
      popup.on("close", closed);
      click("EDDF");

      click("EDDM");

      expect(closed).not.toHaveBeenCalled();
      expect(popup.addTo).toHaveBeenCalledTimes(1);
      expect(markers["EDDM"]!.isPopupOpen()).toBe(true);
      expect(expanded("EDDF")).toBe("false");
      expect(expanded("EDDM")).toBe("true");
    });

    it("keeps the popup open through a double click or a double tap", () => {
      click("EDDF", 1);
      click("EDDF", 2);
      click("EDDF", 3);

      expect(popup.isOpen()).toBe(true);
      expect(expanded("EDDF")).toBe("true");
    });

    it("closes from the keyboard and leaves focus on the marker", () => {
      const element = markers["EDDF"]!.getElement();
      element.focus();
      // Enter and Space reach a button as a click with a `detail` of 0
      click("EDDF", 0);
      expect(popup.isOpen()).toBe(true);

      element.focus();
      click("EDDF", 0);

      expect(popup.isOpen()).toBe(false);
      expect(document.activeElement).toBe(element);
      expect(expanded("EDDF")).toBe("false");
    });

    it("reports a popup closed by its button or the map as closed", () => {
      click("EDDF");

      // The close button and a click on the map both end in `remove`
      popup.remove();

      expect(expanded("EDDF")).toBe("false");
    });
  });

  describe("popup keyboard access", () => {
    it("moves focus into a popup opened from the keyboard", () => {
      const element = markers["EDDF"]!.getElement();
      element.focus();
      focusVisible(element, true);

      markers["EDDF"]!.openPopup();

      const container = popup.getElement().querySelector(".popup-container");
      expect(container).not.toBeNull();
      expect(document.activeElement).toBe(container);
    });

    it("leaves focus alone when a pointer opened the popup", () => {
      const element = markers["EDDF"]!.getElement();
      element.focus();
      focusVisible(element, false);

      markers["EDDF"]!.openPopup();

      expect(document.activeElement).toBe(element);
    });

    it("puts focus back on the marker when the popup had it", () => {
      markers["EDDF"]!.openPopup();
      popup
        .getElement()
        .querySelector<HTMLElement>(".popup-container")!
        .focus();

      // Closing takes the popup, and the focus in it, out of the document
      popup.remove();

      expect(document.activeElement).toBe(markers["EDDF"]!.getElement());
    });

    it("puts focus back on the marker rather than on the page", () => {
      markers["EDDF"]!.openPopup();
      (document.activeElement as HTMLElement | null)?.blur();

      markers["EDDF"]!.closePopup();

      expect(document.activeElement).toBe(markers["EDDF"]!.getElement());
    });

    it("does not take focus from wherever the user went", () => {
      markers["EDDF"]!.openPopup();
      const elsewhere = document.createElement("button");
      document.body.append(elsewhere);
      elsewhere.focus();

      markers["EDDF"]!.closePopup();

      expect(document.activeElement).toBe(elsewhere);
    });

    it("leaves focus alone when nothing was open", () => {
      airportManager.closePopup();

      expect(document.activeElement).toBe(document.body);
    });

    it("closes the popup on Escape from the marker", () => {
      const element = markers["EDDF"]!.getElement();
      markers["EDDF"]!.openPopup();

      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
      expect(popup.isOpen()).toBe(true);

      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      expect(popup.isOpen()).toBe(false);
    });

    it("keeps another airport's popup on Escape", () => {
      markers["EDDM"]!.openPopup();

      markers["EDDF"]!.getElement().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

      expect(popup.isOpen()).toBe(true);
    });
  });

  describe("updateAirportPopups", () => {
    it("marks the home base on its marker", () => {
      airportManager.updateAirportPopups();

      expect(isHome("EDDF")).toBe(true);
      for (const name of ["EDDM", "EDDK", "LOWW"]) {
        expect(isHome(name)).toBe(false);
      }
    });

    it("moves the home base when the filter changes, on the same elements", () => {
      airportManager.updateAirportPopups();
      const eddf = markers["EDDF"]!.getElement();

      // Only path 2 (EDDM -> EDDF) matches: tie, first wins (EDDM)
      mockApp.selectedAircraft = "D-EFGH";

      expect(isHome("EDDF")).toBe(false);
      expect(isHome("EDDM")).toBe(true);
      expect(markers["EDDF"]!.getElement()).toBe(eddf);
    });

    it("skips airports without markers", () => {
      mockApp.allAirportsData.push({ name: "NEW", lat: 1, lon: 1 });
      expect(() => airportManager.updateAirportPopups()).not.toThrow();
    });
  });

  describe("updateAirportOpacity", () => {
    function hidden(): string[] {
      return Object.keys(markers).filter(
        (name) => markers[name]!.getElement().hidden,
      );
    }

    it("shows all airports when no filters or selection", () => {
      for (const marker of Object.values(markers)) marker.setVisible(false);

      airportManager.updateAirportOpacity();

      expect(hidden()).toEqual([]);
    });

    it("shows only airports matching the year filter", () => {
      mockApp.selectedYear = "2024";

      expect(hidden()).toEqual(["EDDM", "LOWW"]);
    });

    it("shows only airports matching the aircraft filter", () => {
      mockApp.selectedAircraft = "D-EFGH";

      expect(hidden()).toEqual(["EDDK", "LOWW"]);
    });

    it("adds airports of selected paths to the filter's airports", () => {
      mockApp.selectedYear = "2025";
      // Path 3 flew in 2024, to EDDK
      mockApp.selectedPathIds.add(3);

      airportManager.updateAirportOpacity();

      expect(hidden()).toEqual(["LOWW"]);
    });

    it("keeps every airport for a selection without a filter (regression)", () => {
      mockApp.selectedPathIds.add(3);

      airportManager.updateAirportOpacity();

      expect(hidden()).toEqual([]);
    });

    it("only shows airports of selected paths in isolate mode", () => {
      mockApp.selectedYear = "2025";
      mockApp.selectedPathIds.add(3);
      mockApp.isolateSelection = true;

      expect(hidden()).toEqual(["EDDM", "LOWW"]);
    });

    it("shows hidden markers that become visible again", () => {
      mockApp.selectedYear = "2024";
      expect(hidden()).toEqual(["EDDM", "LOWW"]);

      mockApp.selectedYear = "all";

      expect(hidden()).toEqual([]);
    });

    it("never takes a marker off the map", () => {
      mockApp.selectedYear = "2024";

      for (const marker of Object.values(markers)) {
        expect(marker.marker.remove).not.toHaveBeenCalled();
      }
    });

    it("closes the popup of a marker that gets hidden", () => {
      markers["EDDM"]!.openPopup();

      mockApp.selectedYear = "2024";

      expect(popup.isOpen()).toBe(false);
    });

    it("keeps the popup of a marker that stays", () => {
      markers["EDDF"]!.openPopup();

      mockApp.selectedYear = "2024";

      expect(popup.isOpen()).toBe(true);
      expect(markers["EDDF"]!.isPopupOpen()).toBe(true);
    });
  });

  describe("updateAirportMarkerSizes", () => {
    it("does nothing if map is not initialized", () => {
      mockApp.map = null;
      airportManager.updateAirportMarkerSizes();
      expect(mapContainer.dataset["zoomSize"]).toBeUndefined();
    });

    // Map units: one below the Leaflet zooms the sizes were tuned at
    it.each([
      [13, "xlarge"],
      [12.9, "large"],
      [11, "large"],
      [9, "medium"],
      [7, "medium-small"],
      [5, "small"],
      [4.9, ""],
      [2, ""],
    ])("sets data-zoom-size for zoom %s", (zoom, expected) => {
      mockApp.map!.getZoom.mockReturnValue(zoom);

      airportManager.updateAirportMarkerSizes();

      expect(mapContainer.dataset["zoomSize"]).toBe(expected);
    });

    it("does nothing without a map container", () => {
      mapContainer.remove();
      expect(() => airportManager.updateAirportMarkerSizes()).not.toThrow();
    });
  });

  describe("activateAirport", () => {
    it("selects the airport's paths, then opens its popup", () => {
      const order: string[] = [];
      mockApp.pathSelection.selectPathsByAirport.mockImplementation(() =>
        order.push("select"),
      );
      const open = vi
        .spyOn(airportManager, "openPopup")
        .mockImplementation(() => order.push("open"));

      airportManager.activateAirport("EDDF");

      expect(mockApp.pathSelection.selectPathsByAirport).toHaveBeenCalledWith(
        "EDDF",
      );
      expect(open).toHaveBeenCalledWith("EDDF");
      expect(order).toEqual(["select", "open"]);
    });

    it("closes the popup it has open and selects nothing", () => {
      airportManager.openPopup("EDDF");
      mockApp.pathSelection.selectPathsByAirport.mockClear();

      airportManager.activateAirport("EDDF");

      expect(popup.isOpen()).toBe(false);
      expect(mockApp.pathSelection.selectPathsByAirport).not.toHaveBeenCalled();
    });

    it("moves the popup to another airport", () => {
      airportManager.openPopup("EDDF");

      airportManager.activateAirport("EDDM");

      expect(airportManager.isPopupOpen("EDDM")).toBe(true);
    });

    it("opens the popup but leaves the selection alone while replay runs", () => {
      mockApp.replayState.active = true;

      airportManager.activateAirport("EDDF");

      expect(mockApp.pathSelection.selectPathsByAirport).not.toHaveBeenCalled();
      expect(airportManager.isPopupOpen("EDDF")).toBe(true);
    });
  });

  describe("airport labels", () => {
    type Label = GeoJSON.Feature<GeoJSON.Point, Record<string, unknown>>;
    const labels = (): Label[] =>
      (
        mockApp.map!.source(MAP_SOURCES.airportLabels)
          .data as GeoJSON.FeatureCollection<GeoJSON.Point>
      ).features as Label[];
    const label = (name: string): Label | undefined =>
      labels().find((feature) => feature.properties["name"] === name);

    it("hands the label layer every airport, with its flights and the home base", () => {
      airportManager.updateAirportPopups();

      expect(labels().map((feature) => feature.properties["name"])).toEqual(
        airports.map((airport) => airport.name),
      );
      expect(label("EDDF")!.properties).toMatchObject({
        icao: "EDDF",
        count: 3,
        home: true,
      });
      expect(label("EDDM")!.properties).toMatchObject({
        count: 2,
        home: false,
      });
      expect(label("LOWW")!.properties["count"]).toBe(0);
      expect(label("EDDK")!.geometry.coordinates).toEqual([7.14, 50.87]);
    });

    it("leaves out the airports towards the horizon of a steeply tilted map", async () => {
      await mockApp.mapReady;
      await Promise.resolve();
      const map = mockApp.map!;
      Object.defineProperty(map.getContainer(), "clientHeight", {
        value: 800,
      });
      const names = (): unknown[] =>
        labels().map((feature) => feature.properties["name"]);
      airportManager.updateAirportOpacity();

      // Looking north over EDDF: EDDK is up at the horizon, three times as
      // far from the camera as EDDF; the others are to the south, near
      map.jumpTo({ center: [8.67, 50.1], pitch: 80 });
      map.emit("move");

      expect(markers["EDDK"]!.getElement().hidden).toBe(true);
      expect(markers["EDDF"]!.getElement().hidden).toBe(false);
      expect(names()).toEqual(["EDDF", "EDDM", "LOWW"]);

      // Flatter, it is back, marker and label
      map.jumpTo({ pitch: 45 });
      map.emit("move");

      expect(markers["EDDK"]!.getElement().hidden).toBe(false);
      expect(names()).toEqual(airports.map((airport) => airport.name));
    });

    it("keeps the airport the keyboard is on, however far it is", async () => {
      await mockApp.mapReady;
      await Promise.resolve();
      const map = mockApp.map!;
      Object.defineProperty(map.getContainer(), "clientHeight", {
        value: 800,
      });
      markers["EDDK"]!.getElement().focus();

      map.jumpTo({ center: [8.67, 50.1], pitch: 80 });
      map.emit("move");

      expect(markers["EDDK"]!.getElement().hidden).toBe(false);
      expect(document.activeElement).toBe(markers["EDDK"]!.getElement());
    });

    it("keeps an airport the filter hides hidden as it comes back from the horizon", async () => {
      await mockApp.mapReady;
      await Promise.resolve();
      const map = mockApp.map!;
      Object.defineProperty(map.getContainer(), "clientHeight", {
        value: 800,
      });
      map.jumpTo({ center: [8.67, 50.1], pitch: 80 });
      map.emit("move");
      // 2024 has no flight to LOWW
      mockApp.selectedYear = "2024";

      map.jumpTo({ pitch: 0 });
      map.emit("move");

      expect(markers["LOWW"]!.getElement().hidden).toBe(true);
      expect(markers["EDDK"]!.getElement().hidden).toBe(false);
    });

    it("leaves out the airports the filter hides, like their markers", () => {
      mockApp.selectedYear = "2024";

      expect(labels().map((feature) => feature.properties["name"])).toEqual([
        "EDDF",
        "EDDK",
      ]);
      // Counted under the filter: EDDF has one flight in 2024
      expect(label("EDDF")!.properties["count"]).toBe(1);
    });

    it("finds the airport whose label the map placed at a point", () => {
      const map = mockApp.map!;
      map.renderedFeatures = [
        { layer: { id: "paths-altitude" }, properties: { pathId: 1 } },
        {
          layer: { id: MAP_LAYERS.airportLabels },
          properties: { name: "EDDM" },
        },
      ];

      const point = { x: 10, y: 20 } as Point;
      expect(airportManager.airportLabelAt(point)).toBe("EDDM");
      // A few pixels around the click, which lands on whole pixels
      const [box, options] = map.queryRenderedFeatures.mock.calls[0] as [
        [[number, number], [number, number]],
        unknown,
      ];
      const [[left, top], [right, bottom]] = box;
      expect(options).toEqual({ layers: [MAP_LAYERS.airportLabels] });
      expect(10 - left).toBeGreaterThan(0);
      expect(right - 10).toBe(10 - left);
      expect(20 - top).toBe(10 - left);
      expect(bottom - 20).toBe(10 - left);

      map.renderedFeatures = [
        { layer: { id: "paths-altitude" }, properties: { pathId: 1 } },
      ];
      expect(
        airportManager.airportLabelAt({ x: 10, y: 20 } as Point),
      ).toBeNull();
    });

    it("lights a hovered label up, and the dot of its marker with it", async () => {
      await mockApp.mapReady;
      await Promise.resolve();
      const map = mockApp.map!;
      const hover = (name: string): boolean =>
        markers[name]!.getElement().classList.contains("is-label-hovered");
      const pointOn = (name: string): void =>
        map.emit(`mousemove:${MAP_LAYERS.airportLabels}`, {
          features: [{ properties: { name } }],
        });

      pointOn("EDDF");
      expect(hover("EDDF")).toBe(true);
      expect(map.featureStates.get("airport-labels:EDDF")).toEqual({
        hover: true,
      });
      expect(map.getCanvas().style.cursor).toBe("pointer");

      // Straight on to the next label
      pointOn("EDDM");
      expect(hover("EDDF")).toBe(false);
      expect(map.featureStates.get("airport-labels:EDDF")).toEqual({
        hover: false,
      });
      expect(hover("EDDM")).toBe(true);

      map.emit(`mouseleave:${MAP_LAYERS.airportLabels}`);
      expect(hover("EDDM")).toBe(false);
      expect(map.featureStates.get("airport-labels:EDDM")).toEqual({
        hover: false,
      });
      expect(map.getCanvas().style.cursor).toBe("");
    });

    it("finds no label before the map has its layers", () => {
      mockApp.map!.removeLayer(MAP_LAYERS.airportLabels);

      expect(
        airportManager.airportLabelAt({ x: 10, y: 20 } as Point),
      ).toBeNull();
    });
  });

  describe("store subscriptions", () => {
    it("refreshes each once for an update that changes several keys (regression)", () => {
      const popups = vi.spyOn(airportManager, "updateAirportPopups");
      const opacity = vi.spyOn(airportManager, "updateAirportOpacity");

      // What a year switch publishes
      mockApp.selectedPathIds.add(1);
      mockApp.store.batch(() => {
        mockApp.selectedYear = "2024";
        mockApp.currentData = createDataset(pathInfo.slice(2));
        mockApp.selectedAircraft = "D-ABCD";
        mockApp.selectedPathIds.clear();
        mockApp.store.notifyMutation("selectedPathIds");
      });

      expect(popups).toHaveBeenCalledTimes(1);
      expect(opacity).toHaveBeenCalledTimes(1);
    });

    it("closes the popup when the airports are hidden", () => {
      markers["EDDF"]!.openPopup();

      mockApp.airportsVisible = false;

      expect(popup.isOpen()).toBe(false);
    });

    it("refreshes the popups and the visibility when the filter changes", () => {
      const popups = vi.spyOn(airportManager, "updateAirportPopups");
      const opacity = vi.spyOn(airportManager, "updateAirportOpacity");

      mockApp.selectedYear = "2024";

      expect(popups).toHaveBeenCalledTimes(1);
      expect(opacity).toHaveBeenCalledTimes(1);

      mockApp.selectedAircraft = "D-ABCD";

      expect(popups).toHaveBeenCalledTimes(2);
      expect(opacity).toHaveBeenCalledTimes(2);
    });

    it("refreshes only the visibility for a selection change", () => {
      const popups = vi.spyOn(airportManager, "updateAirportPopups");
      const opacity = vi.spyOn(airportManager, "updateAirportOpacity");

      mockApp.selectedPathIds.add(3);
      mockApp.store.notifyMutation("selectedPathIds");
      mockApp.isolateSelection = true;

      expect(popups).not.toHaveBeenCalled();
      expect(opacity).toHaveBeenCalledTimes(2);
    });

    it("marks the home base and hides the markers as soon as a dataset arrives", () => {
      mockApp.selectedYear = "2024";

      mockApp.currentData = createDataset(pathInfo.slice(2));

      expect(isHome("EDDF")).toBe(true);
      expect(markers["EDDM"]!.getElement().hidden).toBe(true);
    });
  });
});

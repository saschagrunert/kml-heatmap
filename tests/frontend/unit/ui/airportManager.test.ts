import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AirportManager } from "../../../../kml_heatmap/frontend/ui/airportManager";
import { createAirportMarkers } from "../../../../kml_heatmap/frontend/appInitializer";
import { panPopupIntoView } from "../../../../kml_heatmap/frontend/utils/mapHelpers";
import * as motion from "../../../../kml_heatmap/frontend/utils/motion";
import type {
  AirportMarker,
  PathInfo,
} from "../../../../kml_heatmap/frontend/types";
import {
  createMockApp,
  createDataset,
  asMapApp,
  type MockApp,
} from "../../testHelpers";
import type { Popup as MockPopup } from "../../../mocks/maplibre-gl";

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
      expect(
        markers["EDDF"]!.getElement().querySelector(".airport-label-home"),
      ).not.toBeNull();
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

    it("toggles zoom-hide-labels below zoom 4", () => {
      mockApp.map!.getZoom.mockReturnValue(3.9);
      airportManager.updateAirportMarkerSizes();
      expect(mapContainer.classList.contains("zoom-hide-labels")).toBe(true);

      mockApp.map!.getZoom.mockReturnValue(4);
      airportManager.updateAirportMarkerSizes();
      expect(mapContainer.classList.contains("zoom-hide-labels")).toBe(false);
    });

    it("declutters the labels for the new size", () => {
      const declutter = vi.spyOn(airportManager, "declutterLabels");

      airportManager.updateAirportMarkerSizes();

      expect(declutter).toHaveBeenCalledTimes(1);
    });

    it("does nothing without a map container", () => {
      mapContainer.remove();
      expect(() => airportManager.updateAirportMarkerSizes()).not.toThrow();
    });
  });

  describe("declutterLabels", () => {
    /** Give a marker a label element whose box the test controls */
    function withLabel(
      name: string,
      rect: { left: number; top: number; width: number; height: number },
    ): HTMLElement {
      const label =
        markers[name]!.getElement().querySelector<HTMLElement>(
          ".airport-label",
        )!;
      label.getBoundingClientRect = () => ({
        left: rect.left,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        width: rect.width,
        height: rect.height,
        x: rect.left,
        y: rect.top,
        toJSON: () => ({}),
      });
      return label;
    }

    it("hides the label that would be drawn over a busier one", () => {
      // EDDF has three flights, EDDM two, and the two boxes overlap
      const eddf = withLabel("EDDF", {
        left: 100,
        top: 100,
        width: 40,
        height: 14,
      });
      const eddm = withLabel("EDDM", {
        left: 120,
        top: 104,
        width: 40,
        height: 14,
      });

      airportManager.declutterLabels();

      expect(eddf.classList.contains("airport-label-crowded")).toBe(false);
      expect(eddm.classList.contains("airport-label-crowded")).toBe(true);
    });

    it("keeps both labels when they do not overlap", () => {
      const eddf = withLabel("EDDF", {
        left: 0,
        top: 0,
        width: 40,
        height: 14,
      });
      const eddm = withLabel("EDDM", {
        left: 300,
        top: 300,
        width: 40,
        height: 14,
      });

      airportManager.declutterLabels();

      expect(eddf.classList.contains("airport-label-crowded")).toBe(false);
      expect(eddm.classList.contains("airport-label-crowded")).toBe(false);
    });

    it("reconsiders a label that was hidden before", () => {
      const eddf = withLabel("EDDF", {
        left: 100,
        top: 100,
        width: 40,
        height: 14,
      });
      const eddm = withLabel("EDDM", {
        left: 120,
        top: 104,
        width: 40,
        height: 14,
      });
      airportManager.declutterLabels();
      expect(eddm.classList.contains("airport-label-crowded")).toBe(true);

      // The map moved and they no longer overlap
      eddm.getBoundingClientRect = () => ({
        left: 400,
        top: 400,
        right: 440,
        bottom: 414,
        width: 40,
        height: 14,
        x: 400,
        y: 400,
        toJSON: () => ({}),
      });
      airportManager.declutterLabels();

      expect(eddf.classList.contains("airport-label-crowded")).toBe(false);
      expect(eddm.classList.contains("airport-label-crowded")).toBe(false);
    });

    it("skips markers that have no layout", () => {
      // A hidden marker, and every marker in jsdom, measures as empty
      const eddf = withLabel("EDDF", { left: 0, top: 0, width: 0, height: 0 });
      const eddm = withLabel("EDDM", {
        left: 0,
        top: 0,
        width: 40,
        height: 14,
      });

      airportManager.declutterLabels();

      expect(eddf.classList.contains("airport-label-crowded")).toBe(false);
      expect(eddm.classList.contains("airport-label-crowded")).toBe(false);
    });

    it("counts the attribution as taken space", () => {
      const attribution = document.createElement("div");
      attribution.className = "maplibregl-ctrl-attrib";
      attribution.getBoundingClientRect = () => ({
        left: 500,
        top: 580,
        right: 800,
        bottom: 600,
        width: 300,
        height: 20,
        x: 500,
        y: 580,
        toJSON: () => ({}),
      });
      mapContainer.appendChild(attribution);

      const covered = withLabel("EDDF", {
        left: 600,
        top: 575,
        width: 40,
        height: 14,
      });

      airportManager.declutterLabels();

      expect(covered.classList.contains("airport-label-crowded")).toBe(true);
    });

    it("hides a label that would sit under the control column", () => {
      // The panels are over the map, and a label that slid under one used
      // to stay visible, half covered by its edge
      const panel = document.createElement("div");
      panel.id = "left-buttons";
      panel.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 250,
        bottom: 400,
        width: 250,
        height: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      document.body.appendChild(panel);

      const covered = withLabel("EDDF", {
        left: 200,
        top: 100,
        width: 40,
        height: 14,
      });
      const clear = withLabel("EDDM", {
        left: 600,
        top: 100,
        width: 40,
        height: 14,
      });

      airportManager.declutterLabels();

      expect(covered.classList.contains("airport-label-crowded")).toBe(true);
      expect(clear.classList.contains("airport-label-crowded")).toBe(false);

      panel.remove();
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

    it("declutters the labels again when the airports are shown (regression)", () => {
      mockApp.airportsVisible = false;
      const declutter = vi.spyOn(airportManager, "declutterLabels");

      // Hidden labels have no box, so nothing was decided while they were
      mockApp.airportsVisible = true;

      expect(declutter).toHaveBeenCalledTimes(1);
    });

    it("does not declutter when the airports are hidden", () => {
      const declutter = vi.spyOn(airportManager, "declutterLabels");

      mockApp.airportsVisible = false;

      expect(declutter).not.toHaveBeenCalled();
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

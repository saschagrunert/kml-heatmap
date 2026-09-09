import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as L from "leaflet";
import { AirportManager } from "../../../../kml_heatmap/frontend/ui/airportManager";
import type { PathInfo } from "../../../../kml_heatmap/frontend/types";
import {
  createMockApp,
  createDataset,
  asMapApp,
  type MockApp,
} from "../../testHelpers";
import { marker as mockMarker, type MockMarker } from "../../../mocks/leaflet";

describe("AirportManager", () => {
  let airportManager: AirportManager;
  let mockApp: MockApp;
  let markers: Record<string, MockMarker>;

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

  beforeEach(() => {
    vi.mocked(L.divIcon).mockClear();
    markers = {
      EDDF: mockMarker([50.1, 8.67]),
      EDDM: mockMarker([48.35, 11.78]),
      EDDK: mockMarker([50.87, 7.14]),
      LOWW: mockMarker([48.11, 16.57]),
    };
    mockApp = createMockApp({
      currentData: createDataset(pathInfo),
      allAirportsData: [
        { name: "EDDF", lat: 50.1, lon: 8.67 },
        { name: "EDDM", lat: 48.35, lon: 11.78 },
        { name: "EDDK", lat: 50.87, lon: 7.14 },
        { name: "LOWW", lat: 48.11, lon: 16.57 },
      ],
      airportMarkers: markers as unknown as MockApp["airportMarkers"],
    });
    mockApp.layerManager.getPathInfoMap.mockImplementation(
      () => new Map(pathInfo.map((p) => [p.id, p])),
    );
    mockApp.airportLayer.hasLayer.mockReturnValue(true);

    airportManager = new AirportManager(asMapApp(mockApp));
  });

  describe("calculateAirportFlightCounts", () => {
    it("counts flights per airport for the current filter", () => {
      expect(airportManager.calculateAirportFlightCounts()).toEqual({
        EDDF: 3,
        EDDM: 2,
        EDDK: 1,
      });

      mockApp.selectedYear = "2024";
      expect(airportManager.calculateAirportFlightCounts()).toEqual({
        EDDF: 1,
        EDDK: 1,
      });
    });

    it("returns empty counts without data", () => {
      mockApp.currentData = null;
      expect(airportManager.calculateAirportFlightCounts()).toEqual({});
    });
  });

  describe("updateAirportPopups", () => {
    it("updates popup content for every marker", () => {
      airportManager.updateAirportPopups();

      for (const marker of Object.values(markers)) {
        expect(marker.setPopupContent).toHaveBeenCalledTimes(1);
      }
      const eddf = String(markers["EDDF"]!.setPopupContent.mock.calls[0]![0]);
      expect(eddf).toContain("EDDF");
      expect(eddf).toContain(
        '<span class="popup-metric-value kh-popup-accent">3</span>',
      );
      expect(eddf).toContain("https://www.google.com/maps?q=50.1,8.67");
      expect(eddf).toContain("N");
      expect(eddf).toContain("E");
    });

    it("marks the home base with the badge and the marker class", () => {
      airportManager.updateAirportPopups();

      expect(
        String(markers["EDDF"]!.setPopupContent.mock.calls[0]![0]),
      ).toContain("HOME");
      expect(
        String(markers["EDDM"]!.setPopupContent.mock.calls[0]![0]),
      ).not.toContain("HOME");
      expect(markers["EDDF"]!.setIcon).toHaveBeenCalledTimes(1);
      const iconHtml = vi.mocked(L.divIcon).mock.calls.at(-1)![0]!
        .html as string;
      expect(iconHtml).toContain("airport-marker-home");
      expect(iconHtml).toContain("airport-label-home");
      // Non-home markers keep their initial (non-home) icon
      expect(markers["EDDM"]!.setIcon).not.toHaveBeenCalled();
    });

    it("moves the home base when the filter changes", () => {
      airportManager.updateAirportPopups();
      vi.mocked(L.divIcon).mockClear();

      // Only path 2 (EDDM -> EDDF) matches: tie, first wins (EDDM)
      mockApp.selectedAircraft = "D-EFGH";
      airportManager.updateAirportPopups();

      expect(markers["EDDF"]!.setIcon).toHaveBeenCalledTimes(2);
      expect(markers["EDDM"]!.setIcon).toHaveBeenCalledTimes(1);
      const htmls = vi
        .mocked(L.divIcon)
        .mock.calls.map((c) => c[0]!.html as string);
      expect(htmls.some((h) => h.includes("airport-marker-home"))).toBe(true);
      expect(htmls.some((h) => !h.includes("airport-marker-home"))).toBe(true);
    });

    it("shows zero flights for airports outside the filter", () => {
      airportManager.updateAirportPopups();

      const loww = String(markers["LOWW"]!.setPopupContent.mock.calls[0]![0]);
      expect(loww).toContain(
        '<span class="popup-metric-value kh-popup-accent">0</span>',
      );
    });

    it("skips airports without markers", () => {
      mockApp.allAirportsData.push({ name: "NEW", lat: 1, lon: 1 });
      expect(() => airportManager.updateAirportPopups()).not.toThrow();
    });
  });

  describe("updateAirportOpacity", () => {
    it("shows all airports when no filters or selection", () => {
      mockApp.airportLayer.hasLayer.mockReturnValue(false);

      airportManager.updateAirportOpacity();

      for (const marker of Object.values(markers)) {
        expect(marker.setOpacity).toHaveBeenCalledWith(1.0);
        expect(marker.addTo).toHaveBeenCalledWith(mockApp.airportLayer);
      }
      expect(mockApp.airportLayer.removeLayer).not.toHaveBeenCalled();
    });

    it("shows only airports matching the year filter", () => {
      mockApp.selectedYear = "2024";

      airportManager.updateAirportOpacity();

      expect(markers["EDDF"]!.setOpacity).toHaveBeenCalledWith(1.0);
      expect(markers["EDDK"]!.setOpacity).toHaveBeenCalledWith(1.0);
      expect(mockApp.airportLayer.removeLayer).toHaveBeenCalledWith(
        markers["EDDM"],
      );
      expect(mockApp.airportLayer.removeLayer).toHaveBeenCalledWith(
        markers["LOWW"],
      );
    });

    it("shows only airports matching the aircraft filter", () => {
      mockApp.selectedAircraft = "D-EFGH";

      airportManager.updateAirportOpacity();

      expect(markers["EDDF"]!.setOpacity).toHaveBeenCalledWith(1.0);
      expect(markers["EDDM"]!.setOpacity).toHaveBeenCalledWith(1.0);
      expect(mockApp.airportLayer.removeLayer).toHaveBeenCalledWith(
        markers["EDDK"],
      );
    });

    it("adds airports of selected paths using the path info map", () => {
      mockApp.selectedPathIds.add(3);

      airportManager.updateAirportOpacity();

      expect(mockApp.layerManager.getPathInfoMap).toHaveBeenCalled();
      expect(markers["EDDF"]!.setOpacity).toHaveBeenCalledWith(1.0);
      expect(markers["EDDK"]!.setOpacity).toHaveBeenCalledWith(1.0);
      expect(mockApp.airportLayer.removeLayer).toHaveBeenCalledWith(
        markers["EDDM"],
      );
    });

    it("only shows airports of selected paths in isolate mode", () => {
      mockApp.selectedYear = "2025";
      mockApp.selectedPathIds.add(3);
      mockApp.isolateSelection = true;

      airportManager.updateAirportOpacity();

      expect(markers["EDDF"]!.setOpacity).toHaveBeenCalledWith(1.0);
      expect(markers["EDDK"]!.setOpacity).toHaveBeenCalledWith(1.0);
      expect(mockApp.airportLayer.removeLayer).toHaveBeenCalledWith(
        markers["EDDM"],
      );
    });

    it("re-adds hidden markers that become visible", () => {
      mockApp.selectedYear = "2024";
      mockApp.airportLayer.hasLayer.mockReturnValue(false);

      airportManager.updateAirportOpacity();

      expect(markers["EDDF"]!.addTo).toHaveBeenCalledWith(mockApp.airportLayer);
      expect(markers["EDDM"]!.addTo).not.toHaveBeenCalled();
      expect(mockApp.airportLayer.removeLayer).not.toHaveBeenCalled();
    });

    it("does not re-add markers already on the layer", () => {
      airportManager.updateAirportOpacity();

      for (const marker of Object.values(markers)) {
        expect(marker.addTo).not.toHaveBeenCalled();
      }
    });
  });

  describe("updateAirportMarkerSizes", () => {
    let mapContainer: HTMLElement;

    beforeEach(() => {
      mapContainer = document.createElement("div");
      mapContainer.id = "map";
      document.body.appendChild(mapContainer);
    });

    afterEach(() => {
      mapContainer.remove();
    });

    it("does nothing if map is not initialized", () => {
      mockApp.map = null;
      airportManager.updateAirportMarkerSizes();
      expect(mapContainer.dataset["zoomSize"]).toBeUndefined();
    });

    it.each([
      [14, "xlarge"],
      [12, "large"],
      [10, "medium"],
      [8, "medium-small"],
      [6, "small"],
      [3, ""],
    ])("sets data-zoom-size for zoom %s", (zoom, expected) => {
      mockApp.map!.getZoom.mockReturnValue(zoom);

      airportManager.updateAirportMarkerSizes();

      expect(mapContainer.dataset["zoomSize"]).toBe(expected);
    });

    it("toggles zoom-hide-labels below zoom 5", () => {
      mockApp.map!.getZoom.mockReturnValue(4);
      airportManager.updateAirportMarkerSizes();
      expect(mapContainer.classList.contains("zoom-hide-labels")).toBe(true);

      mockApp.map!.getZoom.mockReturnValue(5);
      airportManager.updateAirportMarkerSizes();
      expect(mapContainer.classList.contains("zoom-hide-labels")).toBe(false);
    });

    it("does nothing without a map container", () => {
      mapContainer.remove();
      expect(() => airportManager.updateAirportMarkerSizes()).not.toThrow();
    });
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { AirportManager } from "../../../../kml_heatmap/frontend/ui/airportManager";
import type { MockMapApp, MockMarker } from "../../testHelpers";

describe("AirportManager", () => {
  let airportManager: AirportManager;
  let mockApp: MockMapApp;
  let mockMarker1: MockMarker;
  let mockMarker2: MockMarker;
  let mockMarker3: MockMarker;

  beforeEach(() => {
    // Mock window.KMLHeatmap
    window.KMLHeatmap = {
      calculateAirportFlightCounts: vi.fn(() => ({
        EDDF: 20,
        EDDM: 15,
        EDDK: 5,
      })),
      ddToDms: vi.fn((coord: number, isLat: boolean) => {
        if (isLat) return "50°06'00\"N";
        return "008°40'00\"E";
      }),
    } as typeof window.KMLHeatmap;

    // Create mock markers
    mockMarker1 = {
      setPopupContent: vi.fn(),
      setOpacity: vi.fn(),
      addTo: vi.fn(),
    };
    mockMarker2 = {
      setPopupContent: vi.fn(),
      setOpacity: vi.fn(),
      addTo: vi.fn(),
    };
    mockMarker3 = {
      setPopupContent: vi.fn(),
      setOpacity: vi.fn(),
      addTo: vi.fn(),
    };

    // Create mock app
    mockApp = {
      selectedYear: "all",
      selectedAircraft: "all",
      selectedPathIds: new Set<number>(),
      fullPathInfo: [
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
      ],
      allAirportsData: [
        { name: "EDDF", lat: 50.1, lon: 8.67 },
        { name: "EDDM", lat: 48.35, lon: 11.78 },
        { name: "EDDK", lat: 50.87, lon: 7.14 },
      ],
      airportMarkers: {
        EDDF: mockMarker1,
        EDDM: mockMarker2,
        EDDK: mockMarker3,
      },
      airportLayer: {
        hasLayer: vi.fn().mockReturnValue(true),
        removeLayer: vi.fn(),
      },
      pathToAirports: {
        1: { start: "EDDF", end: "EDDM" },
        2: { start: "EDDM", end: "EDDF" },
      },
      map: {
        getZoom: vi.fn().mockReturnValue(10),
      },
    };

    airportManager = new AirportManager(mockApp);
  });

  describe("calculateAirportFlightCounts", () => {
    it("delegates to KMLHeatmap library", () => {
      const result = airportManager.calculateAirportFlightCounts();

      expect(
        window.KMLHeatmap.calculateAirportFlightCounts
      ).toHaveBeenCalledWith(
        mockApp.fullPathInfo,
        mockApp.selectedYear,
        mockApp.selectedAircraft
      );
      expect(result).toEqual({
        EDDF: 20,
        EDDM: 15,
        EDDK: 5,
      });
    });
  });

  describe("updateAirportPopups", () => {
    it("does nothing if allAirportsData is not set", () => {
      mockApp.allAirportsData = null;

      expect(() => airportManager.updateAirportPopups()).not.toThrow();
      expect(mockMarker1.setPopupContent).not.toHaveBeenCalled();
    });

    it("does nothing if airportMarkers is not set", () => {
      mockApp.airportMarkers = null;

      expect(() => airportManager.updateAirportPopups()).not.toThrow();
    });

    it("updates popup content for all airport markers", () => {
      airportManager.updateAirportPopups();

      expect(mockMarker1.setPopupContent).toHaveBeenCalled();
      expect(mockMarker2.setPopupContent).toHaveBeenCalled();
      expect(mockMarker3.setPopupContent).toHaveBeenCalled();
    });

    it("includes airport name in popup", () => {
      airportManager.updateAirportPopups();

      const popup = mockMarker1.setPopupContent.mock.calls[0][0];
      expect(popup).toContain("EDDF");
    });

    it("includes flight count in popup", () => {
      airportManager.updateAirportPopups();

      const popup = mockMarker1.setPopupContent.mock.calls[0][0];
      expect(popup).toContain("20"); // Flight count for EDDF
    });

    it("includes coordinates with DMS conversion", () => {
      airportManager.updateAirportPopups();

      expect((window as any).KMLHeatmap.ddToDms).toHaveBeenCalledWith(
        50.1,
        true
      );
      expect((window as any).KMLHeatmap.ddToDms).toHaveBeenCalledWith(
        8.67,
        false
      );

      const popup = mockMarker1.setPopupContent.mock.calls[0][0];
      expect(popup).toContain("50°06'00\"N");
      expect(popup).toContain("008°40'00\"E");
    });

    it("includes Google Maps link", () => {
      airportManager.updateAirportPopups();

      const popup = mockMarker1.setPopupContent.mock.calls[0][0];
      expect(popup).toContain("https://www.google.com/maps?q=50.1,8.67");
    });

    it("marks home base with most flights", () => {
      airportManager.updateAirportPopups();

      const eddfPopup = mockMarker1.setPopupContent.mock.calls[0][0];
      const eddmPopup = mockMarker2.setPopupContent.mock.calls[0][0];

      expect(eddfPopup).toContain("HOME"); // EDDF has 20 flights
      expect(eddmPopup).not.toContain("HOME"); // EDDM has 15 flights
    });

    it("handles airports with no flights", () => {
      (window as any).KMLHeatmap.calculateAirportFlightCounts.mockReturnValue({
        EDDF: 10,
        EDDM: 5,
        // EDDK has 0 flights
      });

      airportManager.updateAirportPopups();

      const popup = mockMarker3.setPopupContent.mock.calls[0][0];
      expect(popup).toContain("0"); // Should show 0 flights
    });

    it("handles airport with unknown name", () => {
      // Add a marker with null key for testing
      mockApp.airportMarkers[null] = mockMarker1;
      mockApp.allAirportsData[0].name = null;

      // Update mock to include null airport
      (
        window as any
      ).KMLHeatmap.calculateAirportFlightCounts.mockReturnValueOnce({
        null: 5,
        EDDM: 15,
        EDDK: 5,
      });

      airportManager.updateAirportPopups();

      const popup = mockMarker1.setPopupContent.mock.calls[0][0];
      expect(popup).toContain("Unknown");
    });

    it("skips markers that don't exist", () => {
      mockApp.airportMarkers.EDDF = null;

      expect(() => airportManager.updateAirportPopups()).not.toThrow();
      expect(mockMarker1.setPopupContent).not.toHaveBeenCalled();
      expect(mockMarker2.setPopupContent).toHaveBeenCalled();
    });
  });

  describe("updateAirportOpacity", () => {
    it("shows all airports when no filters or selection", () => {
      mockApp.selectedYear = "all";
      mockApp.selectedAircraft = "all";
      mockApp.selectedPathIds.clear();
      mockApp.airportLayer.hasLayer.mockReturnValue(false);

      airportManager.updateAirportOpacity();

      expect(mockMarker1.setOpacity).toHaveBeenCalledWith(1.0);
      expect(mockMarker2.setOpacity).toHaveBeenCalledWith(1.0);
      expect(mockMarker3.setOpacity).toHaveBeenCalledWith(1.0);
      expect(mockMarker1.addTo).toHaveBeenCalledWith(mockApp.airportLayer);
    });

    it("shows only airports matching year filter", () => {
      mockApp.selectedYear = "2025";
      mockApp.selectedAircraft = "all";
      mockApp.selectedPathIds.clear();

      airportManager.updateAirportOpacity();

      // EDDF and EDDM should be visible (from filtered paths)
      expect(mockMarker1.setOpacity).toHaveBeenCalledWith(1.0);
      expect(mockMarker2.setOpacity).toHaveBeenCalledWith(1.0);
      // EDDK should be hidden (no paths)
      expect(mockApp.airportLayer.removeLayer).toHaveBeenCalledWith(
        mockMarker3
      );
    });

    it("shows only airports matching aircraft filter", () => {
      mockApp.selectedYear = "all";
      mockApp.selectedAircraft = "D-ABCD";
      mockApp.selectedPathIds.clear();

      airportManager.updateAirportOpacity();

      // EDDF and EDDM should be visible (from path1)
      expect(mockMarker1.setOpacity).toHaveBeenCalledWith(1.0);
      expect(mockMarker2.setOpacity).toHaveBeenCalledWith(1.0);
    });

    it("shows only airports from selected paths", () => {
      mockApp.selectedYear = "all";
      mockApp.selectedAircraft = "all";
      mockApp.selectedPathIds.add(1);

      airportManager.updateAirportOpacity();

      // EDDF and EDDM should be visible (from path1)
      expect(mockMarker1.setOpacity).toHaveBeenCalledWith(1.0);
      expect(mockMarker2.setOpacity).toHaveBeenCalledWith(1.0);
      // EDDK should be hidden
      expect(mockApp.airportLayer.removeLayer).toHaveBeenCalledWith(
        mockMarker3
      );
    });

    it("uses pathToAirports fallback when fullPathInfo not available", () => {
      mockApp.fullPathInfo = null;
      mockApp.selectedPathIds.add(1);

      airportManager.updateAirportOpacity();

      // Should use pathToAirports mapping
      expect(mockMarker1.setOpacity).toHaveBeenCalledWith(1.0);
      expect(mockMarker2.setOpacity).toHaveBeenCalledWith(1.0);
    });

    it("adds marker to layer if not already present", () => {
      mockApp.airportLayer.hasLayer.mockReturnValue(false);
      mockApp.selectedPathIds.add(1);

      airportManager.updateAirportOpacity();

      expect(mockMarker1.addTo).toHaveBeenCalledWith(mockApp.airportLayer);
    });

    it("does not add marker if already in layer", () => {
      mockApp.airportLayer.hasLayer.mockReturnValue(true);
      mockApp.selectedPathIds.add(1);

      airportManager.updateAirportOpacity();

      expect(mockMarker1.addTo).not.toHaveBeenCalled();
    });

    it("removes hidden markers from layer", () => {
      mockApp.airportLayer.hasLayer.mockReturnValue(true);
      mockApp.selectedPathIds.add(1);

      airportManager.updateAirportOpacity();

      // EDDK should be removed
      expect(mockApp.airportLayer.removeLayer).toHaveBeenCalledWith(
        mockMarker3
      );
    });

    it("handles both year and aircraft filters together", () => {
      mockApp.selectedYear = "2025";
      mockApp.selectedAircraft = "D-ABCD";
      mockApp.selectedPathIds.clear();

      airportManager.updateAirportOpacity();

      // Only path1 matches both filters
      expect(mockMarker1.setOpacity).toHaveBeenCalledWith(1.0);
      expect(mockMarker2.setOpacity).toHaveBeenCalledWith(1.0);
    });

    it("selection overrides filters", () => {
      // Set filters that would show EDDF/EDDM
      mockApp.selectedYear = "2025";
      // But select only path2
      mockApp.selectedPathIds.add(2);

      airportManager.updateAirportOpacity();

      // Should show airports from path2 (EDDM and EDDF)
      expect(mockMarker1.setOpacity).toHaveBeenCalledWith(1.0);
      expect(mockMarker2.setOpacity).toHaveBeenCalledWith(1.0);
    });

    it("skips null markers", () => {
      mockApp.airportMarkers.EDDF = null;

      expect(() => airportManager.updateAirportOpacity()).not.toThrow();
    });
  });

  describe("updateAirportMarkerSizes", () => {
    let container1: HTMLElement;
    let marker1: HTMLElement;
    let label1: HTMLElement;

    beforeEach(() => {
      // Create DOM elements
      container1 = document.createElement("div");
      container1.className = "airport-marker-container";
      marker1 = document.createElement("div");
      marker1.className = "airport-marker";
      label1 = document.createElement("div");
      label1.className = "airport-label";
      container1.appendChild(marker1);
      container1.appendChild(label1);
      document.body.appendChild(container1);
    });

    afterEach(() => {
      if (container1.parentNode) {
        document.body.removeChild(container1);
      }
    });

    it("does nothing if map is not initialized", () => {
      mockApp.map = null;

      expect(() => airportManager.updateAirportMarkerSizes()).not.toThrow();
    });

    it("applies xlarge size at zoom 14+", () => {
      mockApp.map.getZoom.mockReturnValue(14);

      airportManager.updateAirportMarkerSizes();

      expect(
        container1.classList.contains("airport-marker-container-xlarge")
      ).toBe(true);
      expect(marker1.classList.contains("airport-marker-xlarge")).toBe(true);
      expect(label1.classList.contains("airport-label-xlarge")).toBe(true);
    });

    it("applies large size at zoom 12-13", () => {
      mockApp.map.getZoom.mockReturnValue(12);

      airportManager.updateAirportMarkerSizes();

      expect(
        container1.classList.contains("airport-marker-container-large")
      ).toBe(true);
      expect(marker1.classList.contains("airport-marker-large")).toBe(true);
      expect(label1.classList.contains("airport-label-large")).toBe(true);
    });

    it("applies medium size at zoom 10-11", () => {
      mockApp.map.getZoom.mockReturnValue(10);

      airportManager.updateAirportMarkerSizes();

      expect(
        container1.classList.contains("airport-marker-container-medium")
      ).toBe(true);
      expect(marker1.classList.contains("airport-marker-medium")).toBe(true);
      expect(label1.classList.contains("airport-label-medium")).toBe(true);
    });

    it("applies medium-small size at zoom 8-9", () => {
      mockApp.map.getZoom.mockReturnValue(8);

      airportManager.updateAirportMarkerSizes();

      expect(
        container1.classList.contains("airport-marker-container-medium-small")
      ).toBe(true);
      expect(marker1.classList.contains("airport-marker-medium-small")).toBe(
        true
      );
      expect(label1.classList.contains("airport-label-medium-small")).toBe(
        true
      );
    });

    it("applies small size at zoom 6-7", () => {
      mockApp.map.getZoom.mockReturnValue(6);

      airportManager.updateAirportMarkerSizes();

      expect(
        container1.classList.contains("airport-marker-container-small")
      ).toBe(true);
      expect(marker1.classList.contains("airport-marker-small")).toBe(true);
      expect(label1.classList.contains("airport-label-small")).toBe(true);
    });

    it("hides labels below zoom 5", () => {
      mockApp.map.getZoom.mockReturnValue(4);

      airportManager.updateAirportMarkerSizes();

      expect(label1.style.display).toBe("none");
    });

    it("shows labels at zoom 5+", () => {
      label1.style.display = "none";
      mockApp.map.getZoom.mockReturnValue(5);

      airportManager.updateAirportMarkerSizes();

      expect(label1.style.display).toBe("");
    });

    it("removes old size classes before applying new ones", () => {
      container1.classList.add("airport-marker-container-small");
      marker1.classList.add("airport-marker-small");
      label1.classList.add("airport-label-small");

      mockApp.map.getZoom.mockReturnValue(14);

      airportManager.updateAirportMarkerSizes();

      expect(
        container1.classList.contains("airport-marker-container-small")
      ).toBe(false);
      expect(
        container1.classList.contains("airport-marker-container-xlarge")
      ).toBe(true);
    });

    it("handles missing marker or label elements", () => {
      const container2 = document.createElement("div");
      container2.className = "airport-marker-container";
      document.body.appendChild(container2);

      expect(() => airportManager.updateAirportMarkerSizes()).not.toThrow();

      document.body.removeChild(container2);
    });

    it("applies no size class at very low zoom", () => {
      mockApp.map.getZoom.mockReturnValue(2);

      airportManager.updateAirportMarkerSizes();

      // Should have no size classes
      expect(container1.className).toBe("airport-marker-container");
      expect(marker1.className).toBe("airport-marker");
      expect(label1.className).toBe("airport-label");
    });
  });
});

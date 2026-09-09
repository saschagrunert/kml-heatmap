import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WrappedManager } from "../../../../kml_heatmap/frontend/ui/wrappedManager";
import type { MapApp } from "../../../../kml_heatmap/frontend/mapApp";
import type {
  FilteredStatistics,
  PathInfo,
  PathSegment,
  YearStats,
} from "../../../../kml_heatmap/frontend/types";
import * as wrappedFeature from "../../../../kml_heatmap/frontend/features/wrapped";
import * as statistics from "../../../../kml_heatmap/frontend/calculations/statistics";
import * as airports from "../../../../kml_heatmap/frontend/features/airports";
import {
  generateStatsHtml,
  generateFunFactsHtml,
  generateAircraftFleetHtml,
  generateHomeBaseHtml,
  generateDestinationsHtml,
} from "../../../../kml_heatmap/frontend/utils/htmlGenerators";
import {
  hideControls,
  restoreControls,
} from "../../../../kml_heatmap/frontend/utils/domCache";

// Generated markup is stubbed; the generators are covered by their own tests
vi.mock("../../../../kml_heatmap/frontend/utils/htmlGenerators", () => ({
  generateStatsHtml: vi.fn(() => '<div class="stat-card">stats</div>'),
  generateFunFactsHtml: vi.fn(
    () => '<div class="fun-facts-title">fun facts</div>',
  ),
  generateAircraftFleetHtml: vi.fn(
    () => '<div class="aircraft-fleet-title">fleet</div>',
  ),
  generateHomeBaseHtml: vi.fn(
    () => '<div class="top-airports-title">home base</div>',
  ),
  generateDestinationsHtml: vi.fn(
    () => '<div class="airports-grid-title">destinations</div>',
  ),
}));

// Keep the real control hiding but observe the calls
vi.mock(
  "../../../../kml_heatmap/frontend/utils/domCache",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../kml_heatmap/frontend/utils/domCache")
      >();
    return {
      ...actual,
      hideControls: vi.fn(actual.hideControls),
      restoreControls: vi.fn(actual.restoreControls),
    };
  },
);

type AnyMock = ReturnType<typeof vi.fn>;

interface WrappedMockApp {
  selectedYear: string;
  selectedAircraft: string;
  selectedPathIds: Set<number>;
  fullPathInfo: PathInfo[];
  fullPathSegments: PathSegment[];
  fullStats: FilteredStatistics | null;
  currentData: { original_points: number } | null;
  map: { fitBounds: AnyMock; invalidateSize: AnyMock } | null;
  config: {
    bounds: [[number, number], [number, number]];
    center: [number, number];
    dataDir: string;
    openaipApiKey?: string;
  };
  stateManager: { saveMapState: AnyMock } | undefined;
  store: { set: AnyMock; get: AnyMock };
}

const defaultFilteredStats: FilteredStatistics = {
  total_points: 100,
  num_paths: 10,
  num_airports: 5,
  airport_names: [],
  num_aircraft: 1,
  aircraft_list: [],
  total_distance_km: 1000,
  total_distance_nm: 540,
  max_groundspeed_knots: 150,
  max_altitude_m: 3000,
};

const defaultYearStats: YearStats = {
  total_flights: 10,
  num_airports: 5,
  total_distance_nm: 1000,
  flight_time: "10h 0m",
  aircraft_list: [],
  airport_names: [],
};

function el(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing test element #${id}`);
  return element;
}

describe("WrappedManager", () => {
  let wrappedManager: WrappedManager;
  let mockApp: WrappedMockApp;
  let calculateYearStatsSpy: ReturnType<typeof vi.spyOn>;
  let calculateFilteredStatisticsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();

    document.body.innerHTML = `
      <div id="app-container">
        <div id="map"></div>
      </div>
      <div id="left-buttons">
        <button id="stats-btn"></button>
        <button id="export-btn"></button>
        <button id="share-btn"></button>
        <button id="wrapped-btn"></button>
      </div>
      <div id="right-buttons">
        <button id="heatmap-btn"></button>
        <button id="airports-btn"></button>
        <button id="altitude-btn"></button>
        <button id="airspeed-btn"></button>
        <button id="aviation-btn"></button>
        <div id="year-filter"></div>
        <div id="aircraft-filter"></div>
      </div>
      <div id="stats-panel"></div>
      <div id="altitude-legend"></div>
      <div id="airspeed-legend"></div>
      <div id="loading"></div>
      <div class="leaflet-control-zoom"></div>
      <div id="wrapped-modal">
        <button class="close-btn">Close</button>
        <div id="wrapped-title"></div>
        <div id="wrapped-year"></div>
        <div id="wrapped-stats"></div>
        <div id="wrapped-fun-facts"></div>
        <div id="wrapped-aircraft-fleet"></div>
        <div id="wrapped-top-airports"></div>
        <div id="wrapped-airports-grid"></div>
        <div id="wrapped-map-container"></div>
      </div>
      <div id="github-footer"></div>
    `;

    mockApp = {
      selectedYear: "2024",
      selectedAircraft: "all",
      selectedPathIds: new Set<number>(),
      fullPathInfo: [],
      fullPathSegments: [],
      fullStats: null,
      currentData: { original_points: 100 },
      map: {
        fitBounds: vi.fn(),
        invalidateSize: vi.fn(),
      },
      config: {
        bounds: [
          [50, 8],
          [52, 10],
        ],
        center: [51, 9],
        dataDir: "/data",
      },
      stateManager: {
        saveMapState: vi.fn(),
      },
      store: { set: vi.fn(), get: vi.fn().mockReturnValue(true) },
    };

    vi.mocked(generateStatsHtml).mockClear();
    vi.mocked(generateFunFactsHtml).mockClear();
    vi.mocked(generateAircraftFleetHtml).mockClear();
    vi.mocked(generateHomeBaseHtml).mockClear();
    vi.mocked(generateDestinationsHtml).mockClear();
    vi.mocked(hideControls).mockClear();
    vi.mocked(restoreControls).mockClear();

    calculateYearStatsSpy = vi
      .spyOn(wrappedFeature, "calculateYearStats")
      .mockReturnValue({ ...defaultYearStats });
    calculateFilteredStatisticsSpy = vi
      .spyOn(statistics, "calculateFilteredStatistics")
      .mockReturnValue({ ...defaultFilteredStats });
    vi.spyOn(wrappedFeature, "generateFunFacts").mockReturnValue([
      { category: "distance", icon: "📏", text: "You flew far!", priority: 5 },
    ]);

    wrappedManager = new WrappedManager(mockApp as unknown as MapApp);
  });

  afterEach(() => {
    // Close any dialog left open so its Escape handler is removed
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  describe("showWrapped", () => {
    it("returns early when map is null", () => {
      mockApp.map = null;

      wrappedManager.showWrapped();

      expect(calculateYearStatsSpy).not.toHaveBeenCalled();
      expect(el("wrapped-modal").style.display).toBe("");
    });

    it("uses selectedYear for stats calculation", () => {
      mockApp.selectedYear = "2023";

      wrappedManager.showWrapped();

      expect(calculateYearStatsSpy).toHaveBeenCalledWith(
        mockApp.fullPathInfo,
        mockApp.fullPathSegments,
        "2023",
        mockApp.fullStats,
        "all",
        expect.objectContaining({ paths: expect.any(Array) }),
      );
    });

    it("uses 'all' year for stats calculation when selectedYear is all", () => {
      mockApp.selectedYear = "all";

      wrappedManager.showWrapped();

      expect(calculateYearStatsSpy).toHaveBeenCalledWith(
        mockApp.fullPathInfo,
        mockApp.fullPathSegments,
        "all",
        mockApp.fullStats,
        "all",
        expect.objectContaining({ paths: expect.any(Array) }),
      );
    });

    it("passes selectedAircraft to calculateYearStats and calculateFilteredStatistics", () => {
      mockApp.selectedYear = "2024";
      mockApp.selectedAircraft = "D-ABCD";

      wrappedManager.showWrapped();

      expect(calculateYearStatsSpy).toHaveBeenCalledWith(
        mockApp.fullPathInfo,
        mockApp.fullPathSegments,
        "2024",
        mockApp.fullStats,
        "D-ABCD",
        expect.objectContaining({ paths: expect.any(Array) }),
      );
      expect(calculateFilteredStatisticsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          aircraft: "D-ABCD",
          coordinateCount: 100,
        }),
      );
    });

    it("pre-filters paths and segments once and shares them", () => {
      mockApp.selectedYear = "all";
      mockApp.selectedAircraft = "D-ABCD";
      mockApp.fullPathInfo = [
        { id: 1, year: 2024, aircraft_registration: "D-ABCD" },
        { id: 2, year: 2024, aircraft_registration: "D-EFGH" },
      ];
      mockApp.fullPathSegments = [
        { path_id: 1, time: 0 },
        { path_id: 2, time: 0 },
      ];

      wrappedManager.showWrapped();

      const preFiltered = {
        paths: [mockApp.fullPathInfo[0]],
        segments: [mockApp.fullPathSegments[0]],
      };
      expect(calculateYearStatsSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "all",
        null,
        "D-ABCD",
        preFiltered,
      );
      expect(calculateFilteredStatisticsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ preFiltered }),
      );
    });

    it("filters airport pathInfo by aircraft when aircraft is selected", () => {
      mockApp.selectedYear = "all";
      mockApp.selectedAircraft = "D-ABCD";
      mockApp.fullPathInfo = [
        {
          id: 1,
          year: 2024,
          aircraft_registration: "D-ABCD",
          start_airport: "EDDF",
          end_airport: "EDDM",
        },
        {
          id: 2,
          year: 2024,
          aircraft_registration: "D-EFGH",
          start_airport: "EDDF",
          end_airport: "EDDL",
        },
      ];
      calculateYearStatsSpy.mockReturnValue({
        ...defaultYearStats,
        total_flights: 1,
        num_airports: 2,
        aircraft_list: [{ registration: "D-ABCD", type: "C172", flights: 1 }],
        airport_names: ["EDDF", "EDDM"],
      });

      wrappedManager.showWrapped();

      // Only the D-ABCD flight counts: EDDF and EDDM once each
      expect(generateHomeBaseHtml).toHaveBeenCalledWith({
        name: "EDDF",
        flight_count: 1,
      });
    });

    it('sets "Your Flight History" title when year is "all"', () => {
      mockApp.selectedYear = "all";

      wrappedManager.showWrapped();

      expect(el("wrapped-title").textContent).toBe("✨ Your Flight History");
      expect(el("wrapped-year").textContent).toBe("All Years");
    });

    it('sets "Your Year in Flight" title for specific year', () => {
      mockApp.selectedYear = "2024";

      wrappedManager.showWrapped();

      expect(el("wrapped-title").textContent).toBe("✨ Your Year in Flight");
      expect(el("wrapped-year").textContent).toBe("2024");
    });

    it("calls generateStatsHtml with hasTimingData=true when timing data available", () => {
      const stats = { ...defaultFilteredStats, max_groundspeed_knots: 150 };
      calculateFilteredStatisticsSpy.mockReturnValue(stats);

      wrappedManager.showWrapped();

      expect(generateStatsHtml).toHaveBeenCalledWith(
        expect.anything(),
        stats,
        true,
      );
    });

    it("calls generateStatsHtml with hasTimingData=false when max_groundspeed_knots is 0", () => {
      const stats = { ...defaultFilteredStats, max_groundspeed_knots: 0 };
      calculateFilteredStatisticsSpy.mockReturnValue(stats);

      wrappedManager.showWrapped();

      expect(generateStatsHtml).toHaveBeenCalledWith(
        expect.anything(),
        stats,
        false,
      );
    });

    it("calls generateStatsHtml with hasTimingData=false when max_groundspeed_knots is undefined", () => {
      const stats = {
        ...defaultFilteredStats,
        max_groundspeed_knots: undefined,
      };
      calculateFilteredStatisticsSpy.mockReturnValue(stats);

      wrappedManager.showWrapped();

      expect(generateStatsHtml).toHaveBeenCalledWith(
        expect.anything(),
        stats,
        false,
      );
    });

    it("calls generateStatsHtml with filtered stats even when fullStats is null", () => {
      mockApp.fullStats = null;
      const stats = { ...defaultFilteredStats };
      calculateFilteredStatisticsSpy.mockReturnValue(stats);

      wrappedManager.showWrapped();

      expect(generateStatsHtml).toHaveBeenCalledWith(
        expect.anything(),
        stats,
        true,
      );
    });

    it("sets stats HTML", () => {
      wrappedManager.showWrapped();

      expect(el("wrapped-stats").innerHTML).toBe(
        '<div class="stat-card">stats</div>',
      );
    });

    it("calls generateFunFacts and sets fun facts HTML", () => {
      const mockFunFacts = [
        {
          category: "distance",
          icon: "📏",
          text: "You flew far!",
          priority: 5,
        },
      ];
      vi.spyOn(wrappedFeature, "generateFunFacts").mockReturnValue(
        mockFunFacts,
      );

      wrappedManager.showWrapped();

      expect(wrappedFeature.generateFunFacts).toHaveBeenCalledWith(
        expect.objectContaining({ total_flights: 10 }),
        expect.objectContaining({ max_groundspeed_knots: 150 }),
      );
      expect(generateFunFactsHtml).toHaveBeenCalledWith(mockFunFacts);
      expect(el("wrapped-fun-facts").innerHTML).toBe(
        '<div class="fun-facts-title">fun facts</div>',
      );
    });

    it("generates aircraft fleet section when aircraft_list is available", () => {
      const yearStats = {
        ...defaultYearStats,
        aircraft_list: [{ registration: "D-ABCD", type: "C172", flights: 5 }],
      };
      calculateYearStatsSpy.mockReturnValue(yearStats);

      wrappedManager.showWrapped();

      expect(generateAircraftFleetHtml).toHaveBeenCalledWith(yearStats);
      expect(el("wrapped-aircraft-fleet").innerHTML).toBe(
        '<div class="aircraft-fleet-title">fleet</div>',
      );
    });

    it("skips aircraft fleet section when aircraft_list is empty", () => {
      calculateYearStatsSpy.mockReturnValue({
        ...defaultYearStats,
        aircraft_list: [],
      });

      wrappedManager.showWrapped();

      expect(generateAircraftFleetHtml).not.toHaveBeenCalled();
      expect(el("wrapped-aircraft-fleet").innerHTML).toBe("");
    });

    it("filters pathInfo by year for airport counts when year is not 'all'", () => {
      mockApp.selectedYear = "2024";
      mockApp.fullPathInfo = [
        { id: 1, year: 2024, start_airport: "EDDF", end_airport: "EDDM" },
        { id: 2, year: 2023, start_airport: "EDDF", end_airport: "EDDL" },
        { id: 3, year: 2024, start_airport: "EDDM", end_airport: "EDDF" },
      ];
      calculateYearStatsSpy.mockReturnValue({
        ...defaultYearStats,
        total_flights: 2,
        num_airports: 2,
        airport_names: ["EDDF", "EDDM"],
      });

      wrappedManager.showWrapped();

      // Only the 2024 flights count: EDDF and EDDM appear twice each
      expect(generateHomeBaseHtml).toHaveBeenCalledWith(
        expect.objectContaining({ flight_count: 2 }),
      );
    });

    it("uses all pathInfo when year is 'all'", () => {
      mockApp.selectedYear = "all";
      mockApp.fullPathInfo = [
        { id: 1, year: 2024, start_airport: "EDDF", end_airport: "EDDM" },
        { id: 2, year: 2023, start_airport: "EDDF", end_airport: "EDDL" },
      ];
      calculateYearStatsSpy.mockReturnValue({
        ...defaultYearStats,
        total_flights: 2,
        num_airports: 3,
        airport_names: ["EDDF", "EDDM", "EDDL"],
      });

      wrappedManager.showWrapped();

      expect(generateHomeBaseHtml).toHaveBeenCalledWith({
        name: "EDDF",
        flight_count: 2,
      });
    });

    it("finds the home base with the most flights", () => {
      mockApp.selectedYear = "all";
      mockApp.fullPathInfo = [
        { id: 1, year: 2024, start_airport: "EDDM", end_airport: "EDDF" },
        { id: 2, year: 2024, start_airport: "EDDM", end_airport: "EDDF" },
        { id: 3, year: 2024, start_airport: "EDDM", end_airport: "EDDL" },
      ];
      calculateYearStatsSpy.mockReturnValue({
        ...defaultYearStats,
        total_flights: 3,
        num_airports: 3,
        airport_names: ["EDDF", "EDDM", "EDDL"],
      });

      wrappedManager.showWrapped();

      expect(generateHomeBaseHtml).toHaveBeenCalledWith({
        name: "EDDM",
        flight_count: 3,
      });
      expect(el("wrapped-top-airports").innerHTML).toBe(
        '<div class="top-airports-title">home base</div>',
      );
    });

    it("generates destinations grouped by country excluding the home base", () => {
      mockApp.selectedYear = "all";
      mockApp.fullPathInfo = [
        { id: 1, year: 2024, start_airport: "EDDF", end_airport: "LOWW" },
        { id: 2, year: 2024, start_airport: "EDDF", end_airport: "LSZH" },
      ];
      calculateYearStatsSpy.mockReturnValue({
        ...defaultYearStats,
        total_flights: 2,
        num_airports: 3,
        airport_names: ["EDDF", "LOWW", "LSZH"],
      });
      const groupSpy = vi.spyOn(airports, "groupByCountry");

      wrappedManager.showWrapped();

      expect(groupSpy).toHaveBeenCalledWith(["LOWW", "LSZH"]);
      expect(generateDestinationsHtml).toHaveBeenCalledWith(
        expect.any(Map),
        airports.countryDisplayName,
        airports.countryFlag,
      );
      expect(el("wrapped-airports-grid").innerHTML).toBe(
        '<div class="airports-grid-title">destinations</div>',
      );
    });

    it("skips airport sections when airport_names is empty", () => {
      calculateYearStatsSpy.mockReturnValue({
        ...defaultYearStats,
        num_airports: 0,
        airport_names: [],
      });

      wrappedManager.showWrapped();

      expect(generateHomeBaseHtml).not.toHaveBeenCalled();
      expect(generateDestinationsHtml).not.toHaveBeenCalled();
    });

    it("skips airport sections when no home base can be determined", () => {
      mockApp.fullPathInfo = [];
      calculateYearStatsSpy.mockReturnValue({
        ...defaultYearStats,
        airport_names: ["EDDF"],
      });

      wrappedManager.showWrapped();

      expect(generateHomeBaseHtml).not.toHaveBeenCalled();
      expect(generateDestinationsHtml).not.toHaveBeenCalled();
    });

    it("moves map to wrapped container after timeout", () => {
      wrappedManager.showWrapped();

      vi.advanceTimersByTime(50);

      expect(el("wrapped-map-container").contains(el("map"))).toBe(true);
    });

    it("stores original map parent and index", () => {
      const mapEl = el("map");
      const originalParent = mapEl.parentElement;

      wrappedManager.showWrapped();
      vi.advanceTimersByTime(50);
      expect(el("wrapped-map-container").contains(mapEl)).toBe(true);

      wrappedManager.closeWrapped();

      expect(originalParent?.contains(mapEl)).toBe(true);
    });

    it("hides control elements during wrapped view", () => {
      wrappedManager.showWrapped();

      expect(hideControls).toHaveBeenCalledWith();
      expect(el("stats-btn").style.display).toBe("none");
      expect(el("share-btn").style.display).toBe("none");
      expect(
        document.querySelector<HTMLElement>(".leaflet-control-zoom")?.style
          .display,
      ).toBe("none");
    });

    it("does not open twice while already open", () => {
      wrappedManager.showWrapped();
      vi.mocked(hideControls).mockClear();

      wrappedManager.showWrapped();

      expect(hideControls).not.toHaveBeenCalled();
      expect(calculateYearStatsSpy).toHaveBeenCalledTimes(1);
    });

    it("shows modal with display flex and records it in the store", () => {
      wrappedManager.showWrapped();

      expect(el("wrapped-modal").style.display).toBe("flex");
      expect(mockApp.store.set).toHaveBeenCalledWith("wrappedVisible", true);
    });

    it("focuses the close button and makes the page behind inert", () => {
      el("wrapped-btn").focus();

      wrappedManager.showWrapped();

      expect(document.activeElement).toBe(
        el("wrapped-modal").querySelector(".close-btn"),
      );
      expect(el("left-buttons").hasAttribute("inert")).toBe(true);
      expect(el("right-buttons").hasAttribute("inert")).toBe(true);
      expect(el("github-footer").hasAttribute("inert")).toBe(true);
      expect(el("app-container").hasAttribute("inert")).toBe(true);
      expect(el("wrapped-modal").hasAttribute("inert")).toBe(false);
    });

    it("keeps the map interactive because it moves into the dialog", () => {
      document.body.appendChild(el("map"));

      wrappedManager.showWrapped();
      vi.advanceTimersByTime(50);

      expect(el("map").hasAttribute("inert")).toBe(false);
    });

    it("sets map container styling after moving", () => {
      wrappedManager.showWrapped();

      vi.advanceTimersByTime(50);

      const mapEl = el("map");
      expect(mapEl.style.width).toBe("100%");
      expect(mapEl.style.height).toBe("100%");
      expect(mapEl.style.borderRadius).toBe("12px");
      expect(mapEl.style.overflow).toBe("hidden");
    });

    it("invalidates map size and fits bounds after moving", () => {
      wrappedManager.showWrapped();
      expect(mockApp.map!.fitBounds).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(150);

      expect(mockApp.map!.invalidateSize).toHaveBeenCalled();
      expect(mockApp.map!.fitBounds).toHaveBeenCalledTimes(2);
      expect(mockApp.map!.fitBounds).toHaveBeenCalledWith(
        mockApp.config.bounds,
        { padding: [80, 80] },
      );
    });

    it("calls saveMapState after wrapped panel is shown", () => {
      wrappedManager.showWrapped();

      vi.advanceTimersByTime(150);

      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("skips saving state when the map disappears before the timeout", () => {
      wrappedManager.showWrapped();
      vi.advanceTimersByTime(50);
      mockApp.map = null;

      vi.advanceTimersByTime(100);

      expect(mockApp.stateManager!.saveMapState).not.toHaveBeenCalled();
    });

    it("still moves the map when stateManager is undefined", () => {
      mockApp.stateManager = undefined;

      wrappedManager.showWrapped();
      expect(() => vi.advanceTimersByTime(150)).not.toThrow();

      expect(el("wrapped-map-container").contains(el("map"))).toBe(true);
      expect(mockApp.map!.invalidateSize).toHaveBeenCalled();
    });

    it("returns early if map container element is missing", () => {
      el("map").remove();

      wrappedManager.showWrapped();

      expect(el("wrapped-modal").style.display).toBe("");
      expect(hideControls).not.toHaveBeenCalled();
    });

    it("returns early if wrapped-map-container element is missing", () => {
      el("wrapped-map-container").remove();

      wrappedManager.showWrapped();

      expect(el("wrapped-modal").style.display).toBe("");
      expect(mockApp.store.set).not.toHaveBeenCalled();
    });
  });

  describe("closeWrapped", () => {
    function openWrapped(): void {
      wrappedManager.showWrapped();
      vi.advanceTimersByTime(50);
    }

    it("moves map back to original position", () => {
      const mapEl = el("map");
      const originalParent = mapEl.parentElement!;

      openWrapped();
      expect(el("wrapped-map-container").contains(mapEl)).toBe(true);

      wrappedManager.closeWrapped();

      expect(originalParent.contains(mapEl)).toBe(true);
    });

    it("restores map styling", () => {
      openWrapped();
      const mapEl = el("map");
      expect(mapEl.style.width).toBe("100%");

      wrappedManager.closeWrapped();

      expect(mapEl.style.width).toBe("");
      expect(mapEl.style.height).toBe("");
      expect(mapEl.style.borderRadius).toBe("");
      expect(mapEl.style.overflow).toBe("");
    });

    it("restores control elements via restoreControls", () => {
      openWrapped();

      wrappedManager.closeWrapped();

      expect(restoreControls).toHaveBeenCalled();
      expect(el("stats-btn").style.display).toBe("");
      expect(
        document.querySelector<HTMLElement>(".leaflet-control-zoom")?.style
          .display,
      ).toBe("");
    });

    it("restores the aviation button to its previous visible state", () => {
      mockApp.config.openaipApiKey = "test-api-key";
      el("aviation-btn").style.display = "block";

      openWrapped();
      expect(el("aviation-btn").style.display).toBe("none");

      wrappedManager.closeWrapped();

      expect(el("aviation-btn").style.display).toBe("block");
    });

    it("keeps the aviation button hidden when it was hidden before", () => {
      mockApp.config.openaipApiKey = "";
      el("aviation-btn").style.display = "none";

      openWrapped();
      wrappedManager.closeWrapped();

      expect(el("aviation-btn").style.display).toBe("none");
    });

    it("hides modal and records it in the store", () => {
      openWrapped();

      wrappedManager.closeWrapped();

      expect(el("wrapped-modal").style.display).toBe("none");
      expect(mockApp.store.set).toHaveBeenLastCalledWith(
        "wrappedVisible",
        false,
      );
    });

    it("releases inert siblings and restores focus to the opener", () => {
      el("wrapped-btn").focus();
      openWrapped();
      expect(el("left-buttons").hasAttribute("inert")).toBe(true);

      wrappedManager.closeWrapped();

      expect(el("left-buttons").hasAttribute("inert")).toBe(false);
      expect(el("right-buttons").hasAttribute("inert")).toBe(false);
      expect(el("github-footer").hasAttribute("inert")).toBe(false);
      expect(document.activeElement).toBe(el("wrapped-btn"));
    });

    it("does not restore focus to an opener that left the document", () => {
      el("wrapped-btn").focus();
      openWrapped();
      el("wrapped-btn").remove();

      expect(() => wrappedManager.closeWrapped()).not.toThrow();
      expect(document.activeElement).toBe(document.body);
    });

    it("invalidates map size after restoring", () => {
      openWrapped();
      mockApp.map!.invalidateSize.mockClear();

      wrappedManager.closeWrapped();
      vi.advanceTimersByTime(100);

      expect(mockApp.map!.invalidateSize).toHaveBeenCalled();
    });

    it("calls saveMapState after restoring", () => {
      openWrapped();
      mockApp.stateManager!.saveMapState.mockClear();

      wrappedManager.closeWrapped();
      vi.advanceTimersByTime(100);

      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("does nothing when event target is not wrapped-modal", () => {
      openWrapped();
      mockApp.map!.invalidateSize.mockClear();
      const innerElement = document.createElement("div");
      innerElement.id = "some-inner-element";

      wrappedManager.closeWrapped({
        target: innerElement,
      } as unknown as MouseEvent);

      expect(el("wrapped-modal").style.display).toBe("flex");
      expect(el("wrapped-map-container").contains(el("map"))).toBe(true);
      expect(restoreControls).not.toHaveBeenCalled();
    });

    it("closes when event target is wrapped-modal", () => {
      openWrapped();

      wrappedManager.closeWrapped({
        target: el("wrapped-modal"),
      } as unknown as MouseEvent);

      expect(el("wrapped-modal").style.display).toBe("none");
    });

    it("works when called without event (close button click)", () => {
      openWrapped();

      wrappedManager.closeWrapped();

      expect(el("wrapped-modal").style.display).toBe("none");
    });

    it("leaves the dialog open when the map container is missing", () => {
      openWrapped();
      el("map").remove();

      wrappedManager.closeWrapped();

      expect(el("wrapped-modal").style.display).toBe("flex");
      expect(restoreControls).not.toHaveBeenCalled();
      expect(el("left-buttons").hasAttribute("inert")).toBe(true);
    });

    it("handles case where originalMapIndex is beyond children length", () => {
      const mapEl = el("map");
      const originalParent = mapEl.parentElement!;

      openWrapped();
      while (originalParent.firstChild) {
        originalParent.removeChild(originalParent.firstChild);
      }

      wrappedManager.closeWrapped();

      expect(originalParent.contains(mapEl)).toBe(true);
      expect(originalParent.lastElementChild).toBe(mapEl);
    });

    it("does not invalidate map size if map is null during timeout", () => {
      openWrapped();
      vi.advanceTimersByTime(150);
      const invalidateSize = mockApp.map!.invalidateSize;
      invalidateSize.mockClear();

      wrappedManager.closeWrapped();
      mockApp.map = null;

      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
      expect(invalidateSize).not.toHaveBeenCalled();
    });

    it("does not call saveMapState when stateManager is undefined during close", () => {
      openWrapped();
      const saveMapState = mockApp.stateManager!.saveMapState;
      saveMapState.mockClear();

      wrappedManager.closeWrapped();
      mockApp.stateManager = undefined;

      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
      expect(saveMapState).not.toHaveBeenCalled();
      expect(mockApp.map!.invalidateSize).toHaveBeenCalled();
    });

    it("removes Escape key handler on close", () => {
      const removeSpy = vi.spyOn(document, "removeEventListener");

      openWrapped();
      wrappedManager.closeWrapped();

      expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    });

    it("closes modal when Escape key is pressed", () => {
      openWrapped();
      expect(el("wrapped-modal").style.display).toBe("flex");

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(el("wrapped-modal").style.display).toBe("none");
    });

    it("does not close modal on non-Escape key press", () => {
      openWrapped();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

      expect(el("wrapped-modal").style.display).toBe("flex");
    });

    it("ignores Escape after the dialog was closed", () => {
      openWrapped();
      wrappedManager.closeWrapped();
      vi.mocked(restoreControls).mockClear();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(restoreControls).not.toHaveBeenCalled();
    });
  });
});

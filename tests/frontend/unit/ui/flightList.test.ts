/**
 * The flight list: the Flights tab of the statistics rail.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COLUMNS,
  FlightList,
  flightRows,
  nextSort,
  searchRows,
  sortRows,
} from "../../../../kml_heatmap/frontend/ui/flightList";
import type { PathInfo } from "../../../../kml_heatmap/frontend/types";
import {
  resetSiteData,
  siteData,
} from "../../../../kml_heatmap/frontend/state/siteData";
import {
  asMapApp,
  createDataset,
  createMockApp,
  createSegment,
  type MockApp,
} from "../../testHelpers";

const pathInfo: PathInfo[] = [
  {
    id: 11,
    year: 2025,
    aircraft_registration: "D-EAGJ",
    aircraft_type: "DA20",
    start_airport: "EDAQ Halle-Oppin",
    end_airport: "EDDP Leipzig",
    max_altitude_ft: 3500,
  },
  {
    id: 12,
    year: 2024,
    aircraft_registration: "D-ESST",
    aircraft_type: "C172",
    start_airport: "EDDP Leipzig",
    end_airport: "EDAQ Halle-Oppin",
    max_altitude_ft: 5200,
  },
  {
    id: 13,
    year: 2025,
    start_airport: "EDDP Leipzig",
    end_airport: "Somewhere <b>odd</b>",
  },
];

/** Flight 11 flies 20 min, 12 has no times, 13 no segments at all */
const segments = [
  createSegment({
    path_id: 11,
    time: 0,
    coords: [
      [51.55, 12.05],
      [51.42, 12.24],
    ],
  }),
  createSegment({
    path_id: 11,
    time: 1200,
    coords: [
      [51.42, 12.24],
      [51.42, 12.24],
    ],
  }),
  createSegment({
    path_id: 12,
    coords: [
      [51.42, 12.24],
      [51.0, 13.0],
    ],
  }),
];

const RAIL = `
  <h2 id="stats-rail-title"><span class="kh-stats-title-text">Flight Statistics</span></h2>
  <div id="stats-rail-tabs" role="tablist" hidden>
    <button id="stats-tab" role="tab" aria-selected="true">Statistics</button>
    <button id="flights-tab" role="tab" aria-selected="false" tabindex="-1">Flights</button>
  </div>
  <div id="stats-panel" role="tabpanel"></div>
  <div id="flight-list-panel" role="tabpanel" hidden></div>
`;

describe("FlightList", () => {
  let mockApp: MockApp;
  let list: FlightList;

  const panel = (): HTMLElement =>
    document.getElementById("flight-list-panel")!;
  const rows = (): HTMLTableRowElement[] => [
    ...panel().querySelectorAll<HTMLTableRowElement>("tbody tr"),
  ];
  const cells = (): string[][] =>
    rows().map((row) =>
      [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
    );
  const routes = (): string[] => cells().map((row) => row[0]!);
  const header = (key: string): HTMLElement =>
    panel().querySelector<HTMLElement>(`th[data-sort="${key}"]`)!;
  const search = (query: string): void => {
    const input = panel().querySelector("input")!;
    input.value = query;
    input.dispatchEvent(new Event("input"));
  };
  const count = (): string =>
    panel().querySelector(".kh-flights-count")!.textContent;
  const title = (): string =>
    document.querySelector("#stats-rail-title")!.textContent;

  beforeEach(() => {
    siteData.airports = [
      { name: "EDAQ Halle-Oppin", lat: 51.55, lon: 12.05, code: "EDAQ" },
      { name: "EDDP Leipzig", lat: 51.42, lon: 12.24, code: "EDDP" },
      { name: "Somewhere <b>odd</b>", lat: 51, lon: 13 },
    ];
    document.body.innerHTML = RAIL;
    mockApp = createMockApp({
      currentData: createDataset(pathInfo, segments),
      selectedYear: "all",
      statsPanelVisible: true,
      flightListVisible: true,
    });
    list = new FlightList(asMapApp(mockApp));
  });

  afterEach(() => {
    list.destroy();
    resetSiteData();
    document.body.innerHTML = "";
  });

  it("lists every flight of the filter in file order, year only", () => {
    expect(cells()).toEqual([
      ["EDAQ → EDDP", "D-EAGJ", "2025", "0:20", "11", "3,500"],
      ["EDDP → EDAQ", "D-ESST", "2024", "—", "38", "5,200"],
      // No code, no aircraft, no segments: the stand-ins, and escaped
      ["EDDP → Somewhere <b>odd</b>", "—", "2025", "—", "—", "—"],
    ]);
    expect(panel().querySelector("tbody b")).toBeNull();
    expect(count()).toBe("3 flights");

    mockApp.selectedYear = "2025";

    expect(routes()).toEqual(["EDAQ → EDDP", "EDDP → Somewhere <b>odd</b>"]);
    expect(count()).toBe("2 flights");
  });

  it("has a column header with a sort button for every column", () => {
    const headers = [...panel().querySelectorAll("thead th")];

    expect(headers.map((th) => th.getAttribute("data-sort"))).toEqual(
      COLUMNS.map((column) => column.key),
    );
    for (const th of headers) {
      expect(th.getAttribute("scope")).toBe("col");
      expect(th.querySelector("button")).not.toBeNull();
      expect(th.hasAttribute("aria-sort")).toBe(false);
    }
  });

  it("sorts up, down and back to file order, with aria-sort", () => {
    const button = header("altitude").querySelector("button")!;

    button.click();
    expect(header("altitude").getAttribute("aria-sort")).toBe("ascending");
    // A flight without the figure goes last either way
    expect(routes()[0]).toBe("EDAQ → EDDP");
    expect(routes()[2]).toBe("EDDP → Somewhere <b>odd</b>");

    button.click();
    expect(header("altitude").getAttribute("aria-sort")).toBe("descending");
    expect(routes()[0]).toBe("EDDP → EDAQ");
    expect(routes()[2]).toBe("EDDP → Somewhere <b>odd</b>");

    button.click();
    expect(header("altitude").hasAttribute("aria-sort")).toBe(false);
    expect(routes()[0]).toBe("EDAQ → EDDP");
  });

  it("keeps one sorted column", () => {
    header("year").querySelector("button")!.click();
    header("route").querySelector("button")!.click();

    expect(header("year").hasAttribute("aria-sort")).toBe(false);
    expect(header("route").getAttribute("aria-sort")).toBe("ascending");
  });

  it("searches codes, airport names, registrations and types", () => {
    search("edaq");
    expect(routes()).toEqual(["EDAQ → EDDP", "EDDP → EDAQ"]);
    expect(count()).toBe("2 of 3 flights");

    search("  c172 ");
    expect(routes()).toEqual(["EDDP → EDAQ"]);

    search("leipzig d-eagj");
    expect(routes()).toEqual(["EDAQ → EDDP"]);

    search("LZIB");
    expect(cells()).toEqual([["No flight matches"]]);
    expect(count()).toBe("0 of 3 flights");

    search("");
    expect(rows()).toHaveLength(3);
  });

  it("keeps the search and the sort through a filter change", () => {
    header("time").querySelector("button")!.click();
    search("edd");

    mockApp.selectedAircraft = "D-ESST";

    expect(routes()).toEqual(["EDDP → EDAQ"]);
    expect(header("time").getAttribute("aria-sort")).toBe("ascending");
  });

  it("selects the flight of a row alone, or adds it with Ctrl or Shift", () => {
    const [first, second, third] = rows();
    const select = mockApp.pathSelection.selectFlight;

    first!.querySelector("button")!.click();
    second!.querySelector("td")!.click();
    third!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, ctrlKey: true }),
    );
    first!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, shiftKey: true }),
    );

    expect(select.mock.calls).toEqual([
      [11, false],
      [12, false],
      [13, true],
      [11, true],
    ]);
  });

  it("marks the selected flights and follows the selection", () => {
    const pressed = (): (string | null)[] =>
      rows().map((row) =>
        row.querySelector("button")!.getAttribute("aria-pressed"),
      );
    expect(pressed()).toEqual(["false", "false", "false"]);

    mockApp.selectedPathIds = new Set([12, 13]);
    expect(pressed()).toEqual(["false", "true", "true"]);

    // And on rows written again
    search("edd");
    expect(pressed()).toEqual(["false", "true", "true"]);
  });

  it("writes nothing while its tab or the rail is closed", () => {
    list.destroy();
    document.body.innerHTML = RAIL;
    mockApp = createMockApp({
      currentData: createDataset(pathInfo, segments),
      selectedYear: "all",
      statsPanelVisible: true,
    });
    list = new FlightList(asMapApp(mockApp));
    expect(rows()).toHaveLength(0);

    mockApp.flightListVisible = true;
    expect(rows()).toHaveLength(3);

    mockApp.statsPanelVisible = false;
    mockApp.selectedYear = "2024";
    expect(rows()).toHaveLength(3);

    mockApp.statsPanelVisible = true;
    expect(rows()).toHaveLength(1);
  });

  describe("tabs", () => {
    const tab = (id: string): HTMLElement => document.getElementById(id)!;

    it("shows the tab the store says, and titles the rail for it", () => {
      // Hidden in the page until the code that runs them is there
      expect(tab("stats-rail-tabs").hidden).toBe(false);
      expect(tab("flights-tab").getAttribute("aria-selected")).toBe("true");
      expect(tab("flights-tab").getAttribute("tabindex")).toBe("0");
      expect(tab("stats-tab").getAttribute("aria-selected")).toBe("false");
      expect(tab("stats-tab").getAttribute("tabindex")).toBe("-1");
      expect(panel().hidden).toBe(false);
      expect(tab("stats-panel").hidden).toBe(true);
      expect(title()).toBe("Flights");

      mockApp.selectedPathIds = new Set([11]);
      mockApp.flightListVisible = false;

      expect(tab("stats-tab").getAttribute("aria-selected")).toBe("true");
      expect(panel().hidden).toBe(true);
      expect(tab("stats-panel").hidden).toBe(false);
      expect(title()).toBe("Selected Paths Statistics");
    });

    it("switches on a click", () => {
      tab("stats-tab").click();
      expect(mockApp.flightListVisible).toBe(false);

      tab("flights-tab").click();
      expect(mockApp.flightListVisible).toBe(true);
    });

    it("switches and moves the focus with the arrow keys, Home and End", () => {
      const key = (id: string, name: string): void => {
        tab(id).dispatchEvent(
          new KeyboardEvent("keydown", { key: name, bubbles: true }),
        );
      };

      key("flights-tab", "ArrowLeft");
      expect(mockApp.flightListVisible).toBe(false);
      expect(document.activeElement).toBe(tab("stats-tab"));

      key("stats-tab", "End");
      expect(mockApp.flightListVisible).toBe(true);
      expect(document.activeElement).toBe(tab("flights-tab"));

      key("flights-tab", "Home");
      key("stats-tab", "ArrowRight");
      expect(mockApp.flightListVisible).toBe(true);

      // Past either end, the arrows wrap around to the other tab
      key("flights-tab", "ArrowRight");
      expect(mockApp.flightListVisible).toBe(false);
      expect(document.activeElement).toBe(tab("stats-tab"));
      key("stats-tab", "ArrowLeft");
      expect(mockApp.flightListVisible).toBe(true);
      expect(document.activeElement).toBe(tab("flights-tab"));

      key("flights-tab", "Enter");
      expect(mockApp.flightListVisible).toBe(true);
    });
  });

  it("stops following the store and the page once destroyed", () => {
    list.destroy();

    mockApp.selectedYear = "2024";
    tab("stats-tab").click();

    expect(rows()).toHaveLength(3);
    expect(mockApp.flightListVisible).toBe(true);

    function tab(id: string): HTMLElement {
      return document.getElementById(id)!;
    }
  });
});

describe("the list's rows", () => {
  const paths: PathInfo[] = [
    { id: 1, aircraft_registration: "D-B", max_altitude_ft: 2000 },
    { id: 2, aircraft_registration: "D-a", max_altitude_ft: 900 },
    { id: 3, max_altitude_ft: 2000 },
    { id: 4, aircraft_registration: "D-10", aircraft_type: "C172" },
  ];
  const all = flightRows(paths, new Map([[1, { km: 5 }]]));
  const ids = (rows: typeof all): number[] => rows.map((row) => row.path.id);

  it("start in file order with their totals", () => {
    expect(ids(all)).toEqual([1, 2, 3, 4]);
    expect(all[0]!.totals).toEqual({ km: 5 });
    expect(all[1]!.totals).toBeUndefined();
  });

  it("sort stably, in either direction, with the missing ones last", () => {
    expect(ids(sortRows(all, { key: "altitude", descending: false }))).toEqual([
      2, 1, 3, 4,
    ]);
    expect(ids(sortRows(all, { key: "altitude", descending: true }))).toEqual([
      1, 3, 2, 4,
    ]);
    // Text case-insensitively, digits by their value
    expect(ids(sortRows(all, { key: "aircraft", descending: false }))).toEqual([
      4, 2, 1, 3,
    ]);
    expect(sortRows(all, null)).toBe(all);
    expect(sortRows(all, { key: "nothing", descending: false })).toBe(all);
  });

  it("match every word of a search", () => {
    expect(ids(searchRows(all, "d-10 c172"))).toEqual([4]);
    expect(ids(searchRows(all, "d-1 c150"))).toEqual([]);
    expect(searchRows(all, "   ")).toBe(all);
  });

  it("sort up, then down, then in file order again", () => {
    const up = nextSort(null, "year");
    expect(up).toEqual({ key: "year", descending: false });
    const down = nextSort(up, "year");
    expect(down).toEqual({ key: "year", descending: true });
    expect(nextSort(down, "year")).toBeNull();
    expect(nextSort(down, "time")).toEqual({ key: "time", descending: false });
  });
});

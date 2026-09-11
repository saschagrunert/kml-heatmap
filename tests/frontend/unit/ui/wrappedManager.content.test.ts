/**
 * WrappedManager: the content of the year in review, rendered by the real
 * generators from a small flight history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WrappedManager } from "../../../../kml_heatmap/frontend/ui/wrappedManager";
import { createDataset, asMapApp, type MockApp } from "../../testHelpers";
import {
  createWrappedMockApp,
  el,
  installAirports,
  mountWrappedDom,
} from "./wrappedTestSetup";

/** Text of every stat card, keyed by its label */
function statCards(): Record<string, string> {
  const cards: Record<string, string> = {};
  for (const card of el("wrapped-stats").querySelectorAll(".stat-card")) {
    const label = card.querySelector(".stat-label")!.textContent;
    cards[label] = card.querySelector(".stat-value")!.textContent.trim();
  }
  return cards;
}

describe("WrappedManager content", () => {
  let wrappedManager: WrappedManager;
  let mockApp: MockApp;

  beforeEach(() => {
    vi.useFakeTimers();
    installAirports();
    mountWrappedDom();
    mockApp = createWrappedMockApp();
    wrappedManager = new WrappedManager(asMapApp(mockApp));
  });

  afterEach(() => {
    wrappedManager.destroy();
    vi.useRealTimers();
    document.body.innerHTML = "";
    delete window.KML_AIRPORTS;
  });

  it("returns early when the map is null", () => {
    mockApp.map = null;

    wrappedManager.showWrapped();

    expect(el("wrapped-modal").style.display).toBe("");
    expect(el("wrapped-stats").innerHTML).toBe("");
  });

  it("titles a single year as the year in flight", () => {
    wrappedManager.showWrapped();

    expect(el("wrapped-title").textContent).toBe("✨ Your Year in Flight");
    expect(el("wrapped-year").textContent).toBe("2024");
  });

  it("titles all years as the flight history", () => {
    mockApp.selectedYear = "all";

    wrappedManager.showWrapped();

    expect(el("wrapped-title").textContent).toBe("✨ Your Flight History");
    expect(el("wrapped-year").textContent).toBe("All Years");
  });

  it("counts the flights and airports of the selected year", () => {
    wrappedManager.showWrapped();

    const cards = statCards();
    expect(cards["Flights"]).toBe("3");
    expect(cards["Airports"]).toBe("3");
    expect(cards["Flight Time"]).toBe("3h 0m");
    expect(cards["Max Groundspeed"]).toBe("120 kt");
    expect(cards["Distance"]).toMatch(/^\d[\d,]*\.\d nm$/);
  });

  it("counts every year when all years are selected", () => {
    mockApp.selectedYear = "all";

    wrappedManager.showWrapped();

    const cards = statCards();
    expect(cards["Flights"]).toBe("4");
    expect(cards["Airports"]).toBe("4");
  });

  it("respects the aircraft filter", () => {
    mockApp.selectedAircraft = "D-EFGH";

    wrappedManager.showWrapped();

    expect(statCards()["Flights"]).toBe("1");
    const fleet = [
      ...el("wrapped-aircraft-fleet").querySelectorAll(
        ".fleet-aircraft-registration",
      ),
    ].map((node) => node.textContent);
    expect(fleet).toEqual(["D-EFGH"]);
  });

  it("omits the timing cards when the data carries no groundspeed", () => {
    mockApp.currentData = createDataset(
      mockApp.currentData!.path_info,
      mockApp.currentData!.path_segments.map((segment) => ({
        ...segment,
        groundspeed_knots: 0,
        time: undefined,
      })),
    );

    wrappedManager.showWrapped();

    const cards = statCards();
    expect(cards["Flights"]).toBe("3");
    expect(cards["Flight Time"]).toBeUndefined();
    expect(cards["Max Groundspeed"]).toBeUndefined();
  });

  it("renders the fun facts from the year's statistics", () => {
    wrappedManager.showWrapped();

    const facts = [...el("wrapped-fun-facts").querySelectorAll(".fun-fact")];
    expect(facts.length).toBeGreaterThanOrEqual(2);
    const texts = facts.map((fact) => fact.textContent);
    // Two aircraft and two countries in 2024
    expect(texts.some((t) => t.includes("2 different aircraft"))).toBe(true);
    expect(texts.some((t) => t.includes("2 countries"))).toBe(true);
  });

  it("lists the fleet busiest first with the model from the full statistics", () => {
    wrappedManager.showWrapped();

    const entries = [
      ...el("wrapped-aircraft-fleet").querySelectorAll(".fleet-aircraft"),
    ].map((entry) => ({
      registration: entry.querySelector(".fleet-aircraft-registration")!
        .textContent,
      model: entry.querySelector(".fleet-aircraft-model")!.textContent,
      flights: entry.querySelector(".fleet-aircraft-flights")!.textContent,
    }));
    expect(entries).toEqual([
      { registration: "D-ABCD", model: "Diamond DA40", flights: "2 flights" },
      { registration: "D-EFGH", model: "Cessna 172", flights: "1 flight" },
    ]);
  });

  it("names the home base with its flight count", () => {
    wrappedManager.showWrapped();

    const home = el("wrapped-top-airports");
    expect(home.querySelector(".top-airport-code")!.textContent).toBe("EDDF");
    expect(home.querySelector(".top-airport-place")!.textContent).toBe(
      "Frankfurt",
    );
    // Every 2024 flight touched Frankfurt
    expect(home.querySelector(".top-airport-count")!.textContent).toBe(
      "3 flights",
    );
  });

  it("counts the home base flights of the selected year only", () => {
    mockApp.selectedYear = "all";

    wrappedManager.showWrapped();

    expect(
      el("wrapped-top-airports").querySelector(".top-airport-count")!
        .textContent,
    ).toBe("4 flights");
  });

  it("groups the destinations by country and accents home and furthest", () => {
    wrappedManager.showWrapped();

    const grid = el("wrapped-airports-grid");
    const groups = [...grid.querySelectorAll(".country-group")].map(
      (group) => ({
        name: group.querySelector(".country-name")!.textContent,
        count: group.querySelector(".country-count")!.textContent,
        airports: [...group.querySelectorAll(".destination")].map((row) => [
          row.querySelector(".destination-code")!.textContent,
          row.querySelector(".destination-tag")?.textContent ?? "",
        ]),
      }),
    );
    expect(groups).toEqual([
      {
        name: "Germany",
        count: "2",
        airports: [
          ["EDDF", "Home"],
          ["EDDM", ""],
        ],
      },
      { name: "Austria", count: "1", airports: [["LOWW", "Furthest"]] },
    ]);
  });

  it("marks no destination as furthest without airport coordinates", () => {
    delete window.KML_AIRPORTS;

    wrappedManager.showWrapped();

    expect(el("wrapped-airports-grid").textContent).not.toContain("Furthest");
    expect(el("wrapped-airports-grid").textContent).toContain("Home");
  });

  it("clears the conditional sections of the previous year", () => {
    wrappedManager.showWrapped();
    expect(el("wrapped-aircraft-fleet").innerHTML).not.toBe("");
    expect(el("wrapped-top-airports").innerHTML).not.toBe("");
    expect(el("wrapped-airports-grid").innerHTML).not.toBe("");
    wrappedManager.closeWrapped();

    // A year without flights must not keep showing the previous one
    mockApp.selectedYear = "2019";
    wrappedManager.showWrapped();

    expect(statCards()["Flights"]).toBe("0");
    expect(el("wrapped-aircraft-fleet").innerHTML).toBe("");
    expect(el("wrapped-top-airports").innerHTML).toBe("");
    expect(el("wrapped-airports-grid").innerHTML).toBe("");
  });

  it("skips the airport sections when no flight has an airport", () => {
    mockApp.currentData = createDataset(
      [{ id: 1, year: 2024, aircraft_registration: "D-ABCD" }],
      mockApp.currentData!.path_segments.slice(0, 2),
    );

    wrappedManager.showWrapped();

    expect(statCards()["Flights"]).toBe("1");
    expect(el("wrapped-top-airports").innerHTML).toBe("");
    expect(el("wrapped-airports-grid").innerHTML).toBe("");
  });
});

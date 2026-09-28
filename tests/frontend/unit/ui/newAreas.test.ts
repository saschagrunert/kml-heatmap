/**
 * The places new in a year: drawn in their own warm layer while the switch
 * is on (Wrapped counts them with the data manager, see dataManager.test.ts)
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import { drawNewAreas } from "../../../../kml_heatmap/frontend/ui/newAreas";
import type { Heat } from "../../../../kml_heatmap/frontend/ui/dataManager";
import { heatWeight } from "../../../../kml_heatmap/frontend/calculations/heatLines";
import { MAP_LAYERS } from "../../../../kml_heatmap/frontend/utils/constants";
import type { KMLDataset } from "../../../../kml_heatmap/frontend/types";
import {
  asMapApp,
  createDataset,
  createMockApp,
  createSegment,
  type MockApp,
} from "../../testHelpers";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";

const toastMock = vi.hoisted(() => ({
  showToast: vi.fn(),
  announceStatus: vi.fn(),
  dismissToast: vi.fn(),
}));
vi.mock("../../../../kml_heatmap/frontend/utils/toast", () => toastMock);

/** A flight along the latitude `lat`, a segment of about 700 m a fix */
function flightAt(lat: number, pathId = 1): KMLDataset["path_segments"] {
  return Array.from({ length: 4 }, (_, i) =>
    createSegment({
      path_id: pathId,
      coords: [
        [lat, 12 + i * 0.01],
        [lat, 12 + (i + 1) * 0.01],
      ],
    }),
  );
}

/** The heat the heatmap draws of `segments`, a heat of 1 per point */
function heatOf(segments: KMLDataset["path_segments"]): Heat {
  return {
    points: segments.map((segment) => segment.coords[0]),
    weights: segments.map(() => 1),
    exposure: 1,
    segments,
    keep: () => true,
    weigh: heatWeight(false, false),
  };
}

type NewAreasApp = MockApp & {
  dataManager: MockApp["dataManager"] & {
    heat: Heat | null;
    showNewAreas: Mock<(heat: Heat, fresh?: Uint8Array) => void>;
    loadOtherYear: Mock<(year: string) => Promise<KMLDataset | null>>;
  };
};

describe("places new in a year", () => {
  let app: NewAreasApp;
  /** The flights of each year the data manager loads */
  let years: Record<string, KMLDataset>;
  /** The years of this test, apart from those of the others: kept a session */
  let year = 2030;

  beforeEach(() => {
    year += 10;
    const before = String(year - 1);
    years = { [before]: createDataset([], flightAt(51)) };
    app = createMockApp() as NewAreasApp;
    Object.assign(app.dataManager, {
      heat: null,
      showNewAreas: vi.fn((heat: Heat, fresh?: Uint8Array) => {
        heat.fresh = fresh;
      }),
      loadOtherYear: vi.fn((known: string) =>
        Promise.resolve(years[known] ?? null),
      ),
    });
    app.dataManager.loadMetadata.mockResolvedValue({
      available_years: [year - 1, year],
    });
    app.selectedYear = String(year);
    toastMock.showToast.mockClear();
    toastMock.dismissToast.mockClear();
  });

  afterEach(() => {
    resetMapLibreMock();
  });

  it("draws the points in places no earlier flight passed in a layer of their own, and the heatmap the rest", async () => {
    // The first half of the year's flight retraces the year before's
    const heat = heatOf([...flightAt(51).slice(0, 2), ...flightAt(52)]);
    app.dataManager.heat = heat;
    app.newAreasVisible = true;

    await drawNewAreas(asMapApp(app));

    // Loaded aside, leaving the page's own loads and their failures alone
    expect(app.dataManager.loadOtherYear).toHaveBeenCalledWith(
      String(year - 1),
    );
    expect(app.dataManager.loadData).not.toHaveBeenCalled();
    expect(app.dataManager.showNewAreas.mock.lastCall![0]).toBe(heat);
    expect(Array.from(app.dataManager.showNewAreas.mock.lastCall![1]!)).toEqual(
      [0, 0, 1, 1, 1, 1],
    );
    // Under the heatmap, as it hides with it
    const order = app.map!.getLayersOrder();
    expect(order.indexOf(MAP_LAYERS.heatNew)).toBe(
      order.indexOf(MAP_LAYERS.heat) - 1,
    );
    expect(app.map!.layer(MAP_LAYERS.heatNew).paint["heatmap-color"]).toEqual(
      expect.arrayContaining(["rgba(255, 170, 50, 0.7)"]),
    );
  });

  it("puts every point back into the heatmap once the switch is off", async () => {
    app.dataManager.heat = heatOf(flightAt(52));
    app.newAreasVisible = true;
    await drawNewAreas(asMapApp(app));

    app.newAreasVisible = false;
    await drawNewAreas(asMapApp(app));

    expect(app.dataManager.showNewAreas).toHaveBeenLastCalledWith(
      app.dataManager.heat,
      undefined,
    );
  });

  it("draws nothing once switched off while the earlier years load", async () => {
    const heat = heatOf(flightAt(52));
    app.dataManager.heat = heat;
    app.newAreasVisible = true;
    const drawing = drawNewAreas(asMapApp(app));
    // The data manager asks no more: nothing is drawn to take off
    app.newAreasVisible = false;

    await drawing;

    expect(app.dataManager.showNewAreas).not.toHaveBeenCalled();
    expect(heat.fresh).toBeUndefined();
    // Switched on again, they are drawn
    app.newAreasVisible = true;
    await drawNewAreas(asMapApp(app));
    expect(app.dataManager.showNewAreas).toHaveBeenCalledWith(
      heat,
      expect.any(Uint8Array),
    );
  });

  it("takes the places the data manager found already", async () => {
    const heat = heatOf(flightAt(52));
    const found = Uint8Array.from([1, 1, 1, 1]);
    heat.fresh = found;
    app.dataManager.heat = heat;
    app.newAreasVisible = true;

    await drawNewAreas(asMapApp(app));

    expect(app.dataManager.showNewAreas).toHaveBeenCalledWith(heat, found);
  });

  it("leaves what a newer heat replaced before its earlier years came", async () => {
    const first = heatOf(flightAt(52));
    app.dataManager.heat = first;
    app.newAreasVisible = true;
    const drawing = drawNewAreas(asMapApp(app));
    // The heat is weighed anew while the year before loads
    app.dataManager.heat = heatOf(flightAt(53));

    await drawing;

    expect(app.dataManager.showNewAreas).not.toHaveBeenCalled();
    expect(first.fresh).toBeUndefined();
    await drawNewAreas(asMapApp(app));
    expect(app.dataManager.showNewAreas).toHaveBeenCalledWith(
      app.dataManager.heat,
      expect.any(Uint8Array),
    );
  });

  it("says once that the first year and all years have none", async () => {
    app.dataManager.heat = heatOf(flightAt(52));
    app.newAreasVisible = true;
    app.selectedYear = String(year - 1);

    await drawNewAreas(asMapApp(app));
    app.dataManager.heat = heatOf(flightAt(53));
    await drawNewAreas(asMapApp(app));

    expect(toastMock.showToast).toHaveBeenCalledTimes(1);
    expect(app.dataManager.showNewAreas).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Uint8Array),
    );
    expect(app.dataManager.loadOtherYear).not.toHaveBeenCalled();

    // Switched off and on again, it says so again
    app.newAreasVisible = false;
    await drawNewAreas(asMapApp(app));
    app.newAreasVisible = true;
    await drawNewAreas(asMapApp(app));
    expect(toastMock.showToast).toHaveBeenCalledTimes(2);
  });

  it("works nothing out again for the heat it drew", async () => {
    app.dataManager.heat = heatOf(flightAt(52));
    app.newAreasVisible = true;
    await drawNewAreas(asMapApp(app));
    const calls = app.dataManager.showNewAreas.mock.calls.length;

    await drawNewAreas(asMapApp(app));

    expect(app.dataManager.showNewAreas).toHaveBeenCalledTimes(calls);
  });

  it("says that an earlier year failed, and draws them on Retry", async () => {
    app.dataManager.heat = heatOf(flightAt(52));
    app.newAreasVisible = true;
    app.dataManager.loadOtherYear.mockResolvedValueOnce(null);

    await drawNewAreas(asMapApp(app));

    expect(app.dataManager.showNewAreas).not.toHaveBeenCalled();
    expect(toastMock.showToast).toHaveBeenCalledOnce();
    const [message, type, action] = toastMock.showToast.mock.lastCall as [
      string,
      string,
      { label: string; run: () => void },
    ];
    expect(message).toContain(String(year));
    expect(type).toBe("error");
    expect(action.label).toBe("Retry");

    action.run();
    await vi.waitFor(() =>
      expect(app.dataManager.showNewAreas).toHaveBeenCalledWith(
        app.dataManager.heat,
        expect.any(Uint8Array),
      ),
    );
    expect(toastMock.dismissToast).toHaveBeenCalledWith(message);
  });

  it("says nothing of a failure once switched off", async () => {
    app.dataManager.heat = heatOf(flightAt(52));
    app.newAreasVisible = true;
    app.dataManager.loadOtherYear.mockResolvedValueOnce(null);
    const drawing = drawNewAreas(asMapApp(app));
    app.newAreasVisible = false;

    await drawing;

    expect(toastMock.showToast).not.toHaveBeenCalled();
  });
});

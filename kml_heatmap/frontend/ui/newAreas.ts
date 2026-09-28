/**
 * The places new in a year: where its flights went that no flight of an
 * earlier year did (see calculations/newAreas.ts). While the New areas
 * switch is on, the heatmap's points in those places are drawn by a layer
 * of their own in warm colours, and the heatmap draws the rest
 * (DataManager.showNewAreas). Wrapped names their area from the same cells
 * (DataManager.newAreaKm2), without this module or the feature bundle.
 *
 * It takes the flights of every earlier year, which a year's view has not
 * loaded, so this comes with the feature bundle and loads them the first
 * time it is asked, through the data manager: they are its cached years
 * from then on (which Wrapped counts with), and the loading indicator says
 * what it waits for. A year that fails says so here, with a Retry, and
 * leaves the page's own loads and their failures alone. The view of all
 * years, and the first year, have no earlier flights and so no new places. An isolated selection draws none
 * either: its heatmap is another, and the places are kept for when it ends
 * (see DataManager.applyHeatmapEmphasis).
 */
import type { ExpressionSpecification } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { datasetCells, freshPoints } from "../calculations/newAreas";
import { MAP_LAYERS } from "../utils/constants";
import { dismissToast, showToast } from "../utils/toast";
import type { Heat } from "./dataManager";
import { HEATMAP_GRADIENT } from "./heatmapPaint";

/**
 * The colours of the places new in a year, one for each stop of the
 * heatmap's gradient: the same steps of lightness in amber, warm against
 * the blue of the places flown before
 */
const NEW_AREA_COLOURS = [
  "120, 35, 10",
  "190, 70, 20",
  "235, 120, 30",
  "255, 170, 50",
  "255, 210, 120",
  "255, 238, 200",
  "255, 255, 255",
];

/**
 * The cells the flights of each of the years before each year passed over
 * (see datasetCells), or null for a year with none before it. A load that
 * failed is not kept, so the next time asks again.
 */
const earlier = new Map<string, Promise<Set<number>[] | null>>();

/** The heat whose new places each app draws, or is working out */
const drawn = new WeakMap<MapApp, Heat | null>();

/** The year that was last told it has nothing to compare with */
let told = "";

function earlierCells(
  app: MapApp,
  year: string,
): Promise<Set<number>[] | null> {
  let cells = earlier.get(year);
  if (!cells) {
    cells = (async () => {
      const metadata = await app.dataManager.loadMetadata();
      const years = (metadata?.available_years ?? []).filter(
        (known) => known < Number(year),
      );
      // None before the first year, nor before "all"
      if (years.length === 0) return null;
      const datasets = await Promise.all(
        years.map((known) => app.dataManager.loadOtherYear(String(known))),
      );
      return datasets.map((data) => {
        if (!data) throw new Error("An earlier year failed to load");
        return datasetCells(data);
      });
    })();
    earlier.set(year, cells);
    cells.catch(() => earlier.delete(year));
  }
  return cells;
}

/** The heatmap's colours in amber, see NEW_AREA_COLOURS */
function newAreaColor(): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["heatmap-density"],
    ...HEATMAP_GRADIENT.flatMap(([density, , alpha], index) => [
      density,
      `rgba(${NEW_AREA_COLOURS[index]}, ${alpha})`,
    ]),
  ] as ExpressionSpecification;
}

/**
 * Draw the places new in the year of the heat the heatmap shows while the
 * switch is on, and take them off once it is not. The data manager calls
 * this whenever what it draws changes (DataManager.followStore), and
 * writes their source with the heat (DataManager.showNewAreas).
 *
 * Their layer lies under the heatmap: where a place new in the year and one
 * flown before lie within the reach of a point, zoomed out, the one flown
 * before is drawn over it.
 */
export async function drawNewAreas(app: MapApp): Promise<void> {
  const manager = app.dataManager;
  const heat = manager.heat;
  const shown = app.newAreasVisible ? heat : null;
  const map = app.map;
  if (!map?.getLayer(MAP_LAYERS.heatNew)) return;
  if (shown === (drawn.get(app) ?? null)) return;
  map.setPaintProperty(MAP_LAYERS.heatNew, "heatmap-color", newAreaColor());
  drawn.set(app, shown);
  const year = app.selectedYear;
  let failed = false;
  const cells = shown
    ? await earlierCells(app, year).catch(() => {
        failed = true;
        return null;
      })
    : null;
  // Another heat came meanwhile, and another call draws it
  if (drawn.get(app) !== shown || manager.heat !== heat) return;
  const failure =
    "Failed to load the flights before " + year + " for New areas";
  // Switched off while the years before loaded: that change found nothing
  // drawn to take off, and none is drawn now. A load that failed is tried
  // again by the next change, or by the Retry.
  if (failed || (shown && !app.newAreasVisible)) {
    drawn.delete(app);
    if (failed && app.newAreasVisible) {
      showToast(failure, "error", {
        label: "Retry",
        run: () => {
          void drawNewAreas(app);
        },
      });
    }
    return;
  }
  if (cells) dismissToast(failure);
  if (shown && !cells && told !== year) {
    showToast("New areas show in a year with flights in the years before it");
  }
  // Once per year shown without them, again after the switch was off
  told = shown && !cells ? year : "";
  // The heat source keeps the rest, and their own source takes the new
  // places; the data manager may have found them already, from the years
  // before that it holds (see DataManager.drawHeatmap)
  const fresh =
    shown && cells
      ? (shown.fresh ?? freshPoints(shown.points, cells))
      : undefined;
  if (heat) manager.showNewAreas(heat, fresh);
}

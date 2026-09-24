/**
 * Selection highlight - The selected flights as thin lines over the heatmap
 *
 * The colour layers draw a selection on layers of their own. With neither
 * of them on, the heatmap is all there is, and it does not follow the
 * selection on purpose (only Isolate narrows it), so a selected flight was
 * nowhere to be seen. These lines mark it instead. Whether they show is
 * worked out with the other layers (see ui/layerVisibility.ts); this module
 * keeps their data in step with the selection and the dataset.
 */
import type { GeoJSONSource } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { PathSegment } from "../types";
import { segmentsForPathIds } from "../calculations/statistics";
import { MAP_SOURCES } from "../utils/constants";
import {
  toLngLat,
  toLngLatAfter,
  whenContextRestored,
  type LngLatTuple,
} from "../utils/mapHelpers";

/**
 * The given segments as lines, one per path: the segments of a path are one
 * chain (see services/yearDataset.ts). Each point is taken into the copy of
 * the world of the point before, so a flight across the antimeridian does
 * not go round the world.
 */
export function selectionLines(
  segments: readonly PathSegment[],
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  let line: LngLatTuple[] = [];
  let pathId: number | undefined;
  // A segment without coordinates breaks the chain: the next one starts
  // where it does, not where the line got to
  let gap = false;
  for (const { path_id, coords } of segments) {
    if (!coords) {
      gap = true;
      continue;
    }
    if (path_id !== pathId) {
      pathId = path_id;
      line = [toLngLat(coords[0])];
      features.push({
        type: "Feature",
        properties: null,
        geometry: { type: "LineString", coordinates: line },
      });
    } else if (gap) {
      line.push(toLngLatAfter(coords[0], line[line.length - 1]));
    }
    gap = false;
    line.push(toLngLatAfter(coords[1], line[line.length - 1]));
  }
  return { type: "FeatureCollection", features };
}

/**
 * Keep the lines on the selected flights of the dataset on the map. The
 * year and aircraft filter need not be asked: a change of either clears
 * the selection, and a click selects only flights it keeps. The lines are
 * worked out for every change, shown or not, which costs the size of the
 * selection rather than of the dataset. After a lost WebGL context the
 * source is back with the data of the moment of the loss, and gets them
 * again.
 */
export function followSelectionHighlight(app: MapApp): void {
  let lines = selectionLines([]);
  const write = (): void => {
    void app.map
      ?.getSource<GeoJSONSource>(MAP_SOURCES.selectionHighlight)
      ?.setData(lines);
  };
  const update = (): void => {
    const data = app.currentData;
    const selected = app.selectedPathIds;
    // Nothing selected, and nothing drawn to take away
    if (selected.size === 0 && lines.features.length === 0) return;
    lines = selectionLines(
      data ? segmentsForPathIds(data.path_segments, selected) : [],
    );
    write();
  };
  app.store.subscribeKeys(["currentData", "selectedPathIds"], update);
  update();
  void app.mapReady.then(
    (map) => {
      write();
      whenContextRestored(map, write);
    },
    () => {},
  );
}

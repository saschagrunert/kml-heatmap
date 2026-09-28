/**
 * The content of the heat sources, written as GeoJSON text by the year
 * worker (services/yearWorker.ts).
 *
 * The heatmap draws a point per fix, 135,000 of them for all years of the
 * sample flights. Handed to MapLibre as objects, a feature each, they cost
 * the main thread about 120 ms on a desktop (in Chrome: 70 ms for
 * MapLibre's own copy of them and 45 ms for the structured clone to its
 * worker) and three to four times that with the CPU slowed down as for a
 * phone, on every change of the year, the aircraft or the weighing, on top
 * of the objects themselves and the exposure (see DEVELOPMENT.md). A source
 * that is given a URL instead is loaded, parsed and cut into tiles by
 * MapLibre's worker alone (two fixes of scripts/vendor.js see to that:
 * without them MapLibre fetches a Blob URL on the main thread, and sends
 * back what it parsed). So the page packs the heat into one column of
 * numbers (heatColumns), the worker works out how it is drawn and writes
 * the text into a Blob, and the page gives the source a URL of that Blob.
 *
 * The text is the one JSON.stringify writes for the same features, so the
 * map is given exactly what it was before. The heat lines the heatmap
 * hands over to take the same way, packed by flatLines.
 *
 * Like everything else in yearWorker.bundle.js this is no part of what a
 * first visit downloads. The packing runs on the page, from the same bundle
 * (services/yearDecoder.ts), which also writes the text there when the
 * worker cannot be used.
 */
import { exposedHeat } from "../calculations/heatExposure";

/** How the heatmap draws a heat, see drawHeat */
export interface DrawnHeat {
  /** What the heat is scaled by, see heatExposure */
  exposure: number;
  /**
   * The GeoJSON of the heat source: a Point per point, its heat as `w`,
   * scaled by `exposure` and rolled off (see exposedHeat)
   */
  source: Blob;
}

/** The content of the heat line source (see heatLineFeatures) */
export type HeatLines = GeoJSON.FeatureCollection<
  GeoJSON.LineString,
  { heat: number }
>;

/** The lines of HeatLines as columns, which are handed over as a copy */
export interface FlatLines {
  /** `[lng, lat]` of every position of every line, one line after another */
  coordinates: Float64Array;
  /** Where each line ends in `coordinates`, counted in positions */
  ends: Uint32Array;
  /** The heat of each line */
  heats: Float64Array;
}

/** The lines of `lines` as columns, see FlatLines */
export function flatLines(lines: HeatLines): FlatLines {
  const { features } = lines;
  let positions = 0;
  for (const feature of features) {
    positions += feature.geometry.coordinates.length;
  }
  const coordinates = new Float64Array(positions * 2);
  const ends = new Uint32Array(features.length);
  const heats = new Float64Array(features.length);
  let at = 0;
  features.forEach((feature, index) => {
    for (const [lng, lat] of feature.geometry.coordinates) {
      coordinates[at++] = lng!;
      coordinates[at++] = lat!;
    }
    ends[index] = at / 2;
    heats[index] = feature.properties.heat;
  });
  return { coordinates, ends, heats };
}

/**
 * Features written into one string before the next is begun. A Blob of a
 * few hundred parts is made as fast as of one, without a string of 16 MB
 * for all years that would have to be put together first.
 */
const FEATURES_PER_PART = 1024;

/** A number as JSON.stringify writes it: null for one that is not finite */
function json(value: number): string {
  return Number.isFinite(value) ? String(value) : "null";
}

/** A Blob of the text of a FeatureCollection of `count` features */
function collection(count: number, feature: (index: number) => string): Blob {
  const parts = ['{"type":"FeatureCollection","features":['];
  for (let start = 0; start < count; start += FEATURES_PER_PART) {
    const end = Math.min(start + FEATURES_PER_PART, count);
    let part = start > 0 ? "," : "";
    for (let index = start; index < end; index++) {
      part += (index > start ? "," : "") + feature(index);
    }
    parts.push(part);
  }
  parts.push("]}");
  return new Blob(parts, { type: "application/json" });
}

/**
 * The heat of the points of `heat` (see heatColumns in
 * calculations/heatExposure.ts) as the heatmap draws it (see exposedHeat),
 * and the content of its source: one Point per point, `[lng, lat]`, with
 * its heat as `w`. A MultiPoint of all of them would be shorter, but the
 * source can only merge features into clusters, not the points of one
 * feature (see HEATMAP_CLUSTER).
 */
export function drawHeat(heat: Float64Array): DrawnHeat {
  const { exposure, weights } = exposedHeat(heat);
  const source = collection(
    weights.length,
    (index) =>
      '{"type":"Feature","properties":{"w":' +
      json(weights[index]!) +
      '},"geometry":{"type":"Point","coordinates":[' +
      json(heat[3 * index + 1]!) +
      "," +
      json(heat[3 * index]!) +
      "]}}",
  );
  return { exposure, source };
}

/**
 * The content of the heat line source, from the lines as flatLines packed
 * them: a LineString per line, with its heat as `heat`
 */
export function linesSource(lines: FlatLines): Blob {
  const { coordinates, ends, heats } = lines;
  return collection(heats.length, (index) => {
    let line = "";
    for (let at = index > 0 ? ends[index - 1]! : 0; at < ends[index]!; at++) {
      line +=
        (line ? ",[" : "[") +
        json(coordinates[2 * at]!) +
        "," +
        json(coordinates[2 * at + 1]!) +
        "]";
    }
    return (
      '{"type":"Feature","properties":{"heat":' +
      json(heats[index]!) +
      '},"geometry":{"type":"LineString","coordinates":[' +
      line +
      "]}}"
    );
  });
}

/**
 * The height band of the 3D view's heat cloud: the heights above the
 * ground whose heat the cloud shows, so the circuits and the climbs out of
 * a field can be told from the cruise above them, which a view from the
 * side shows only in part. Heat outside the band fades out over a little
 * more height (see heightBandEdgesFt), so a climb through an edge dims
 * softly rather than being cut off.
 *
 * The heights are above the ground (AGL), the ones the cloud is lifted by
 * (see calculations/heatCloud.ts): above the relief the build sampled
 * under a flight, as coarse as the relief level the cloud is cut for, and
 * without the relief above the line between the fields it flew from and
 * to (see groundProfileFt), so every flight has them. A band of altitude
 * (MSL) would put a circuit over a field at 1,500 ft in another band than
 * one over a field by the sea, and the band is how a circuit is told from
 * a cruise.
 *
 * The band is kept in the store and in a link as text, `500-3000`, with
 * the top left out for a band without one (`1000-`) and the whole of it
 * left out for every height (see state/urlState.ts); this module reads and
 * writes that text.
 */
import { HEIGHT_BAND_STOPS_FT, HEIGHT_BAND_TEXT } from "../state/urlState";
import { formatNumber } from "../utils/formatters";

/** The stop of a band without a top: one past the last of the stops */
export const OPEN_TOP = HEIGHT_BAND_STOPS_FT.length;

/** A band, as the stops of its bottom and its top (see OPEN_TOP) */
export interface HeightBand {
  low: number;
  high: number;
}

/** Every height: the band of a first visit */
export const FULL_BAND: HeightBand = { low: 0, high: OPEN_TOP };

/**
 * How far past an edge of the band the heat fades out, as a part of the
 * height of that edge, and at least HEIGHT_BAND_MIN_FADE_FT: a fixed
 * height would be a hard cut at 8,000 ft and wider than the band at 100
 */
const HEIGHT_BAND_FADE = 0.15;
const HEIGHT_BAND_MIN_FADE_FT = 50;

/** A height above every flight, for the edges of a band without a top */
const NO_TOP_FT = 1e6;

/**
 * The band of the text `text` (see the header). Its heights are two of the
 * stops, the bottom below the top, which the control writes; anything else,
 * such as a link edited by hand, is every height.
 */
export function parseHeightBand(text: string): HeightBand {
  const match = HEIGHT_BAND_TEXT.exec(text);
  const low = match ? HEIGHT_BAND_STOPS_FT.indexOf(Number(match[1])) : -1;
  const high =
    match?.[2] === ""
      ? OPEN_TOP
      : HEIGHT_BAND_STOPS_FT.indexOf(Number(match?.[2]));
  return low >= 0 && high > low ? { low, high } : FULL_BAND;
}

/** The text of the band `band` (see the header): "" for every height */
export function heightBandText({ low, high }: HeightBand): string {
  if (low === 0 && high === OPEN_TOP) return "";
  const top = high === OPEN_TOP ? "" : String(HEIGHT_BAND_STOPS_FT[high]);
  return `${HEIGHT_BAND_STOPS_FT[low]}-${top}`;
}

/** How far past the edge `feet` the heat fades out (see HEIGHT_BAND_FADE) */
function fadeFt(feet: number): number {
  return Math.max(feet * HEIGHT_BAND_FADE, HEIGHT_BAND_MIN_FADE_FT);
}

/**
 * The heights, in feet above ground, from which the heat of the band
 * `band` fades in, up to which it does, from which it fades out and up to
 * which it does: the part of a pixel's heat the cloud draws (see
 * ui/heatCloudLayer.ts) is `smoothstep(a, b, h) * (1 - smoothstep(c, d,
 * h))` at its height `h`. A band from the ground has all of it at the
 * ground, whose height is 0, and one without a top all of it above.
 */
export function heightBandEdgesFt({
  low,
  high,
}: HeightBand): [number, number, number, number] {
  const bottom = HEIGHT_BAND_STOPS_FT[low]!;
  const top = HEIGHT_BAND_STOPS_FT[high];
  return [
    low === 0 ? -2 : bottom - fadeFt(bottom),
    low === 0 ? -1 : bottom,
    top === undefined ? NO_TOP_FT : top,
    top === undefined ? 2 * NO_TOP_FT : top + fadeFt(top),
  ];
}

/** The height of the stop `stop`, as the control reads it out */
export function heightStopLabel(stop: number): string {
  const feet = HEIGHT_BAND_STOPS_FT[stop];
  return feet === undefined ? "No limit" : `${formatNumber(feet)} ft`;
}

/** The band `band`, as the control shows it */
export function heightBandLabel({ low, high }: HeightBand): string {
  if (high === OPEN_TOP) {
    return low === 0 ? "All heights" : `Above ${heightStopLabel(low)}`;
  }
  if (low === 0) return `Up to ${heightStopLabel(high)}`;
  return `${formatNumber(HEIGHT_BAND_STOPS_FT[low]!)} to ${heightStopLabel(high)}`;
}

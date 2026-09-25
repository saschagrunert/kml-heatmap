/**
 * Lifting the flights to their altitude: the 3D view
 *
 * MapLibre cannot lift a line off the ground, so a lifted flight is drawn
 * as a ribbon of `fill-extrusion`: a thin quad along every segment, raised
 * to the height of the segment above the ground of its flight and given a
 * band of height of its own, so it shows edge on as well. The heights are
 * above ground (AGL): without terrain the map is at sea level everywhere,
 * and a traffic pattern at 1,000 ft over a field at 1,500 ft belongs 1,000
 * ft up, not 2,500. The ground of a flight is the one the build sampled
 * under it from an elevation model, anchored to the fields it left and
 * landed on (kml_heatmap/terrain.py), and without it the line from the one
 * field to the other (see groundProfileFt); either way a flight taxis on
 * the map at both ends. Off the globe the map draws the relief under the
 * flights, and the ribbons stand on it.
 *
 * The heights are exaggerated, and the relief as much, more the further
 * out the map is: at true scale a circuit is a hair above the ground at
 * any zoom where the airfield is more than a dot.
 *
 * This module is the policy: from which zoom the flights are drawn flat,
 * the relief level a zoom is drawn for, how much each level exaggerates,
 * and how high a point is drawn on the screen. The curve through the
 * fixes is smoothing.ts, the ground of a flight groundProfile.ts, the
 * ribbons cut along the curve ribbons.ts, and the paint that lifts them
 * ribbonPaint.ts.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  DEGREES_TO_RADIANS,
  EARTH_CIRCUMFERENCE_M,
  metresPerPixel,
} from "../utils/geometry";
import { FEET_TO_METERS } from "../utils/constants";

/**
 * A sloping ribbon is cut into pieces this many feet apart; a piece is one
 * feature. At zoom 13 it is about a pixel, so a climb shows as a slope and
 * not as a staircase.
 */
export const LIFT_STEP_FT = 20;

/**
 * The map zoom from which the flights are drawn flat again, as lines, in
 * the 3D view. Zoomed in that far the camera is a few hundred metres up,
 * lower than a circuit even at true scale: the flights around it would
 * stand as walls in front of it, fill the screen from above, or be behind
 * it, and only the taxiing on the ground would be left to see.
 */
export const LIFT_MAX_ZOOM = 17;

/**
 * The deepest level of the elevation tiles, the one the build samples the
 * ground at (TERRAIN_ZOOM in terrain.py); the map stretches it beyond.
 */
export const TERRAIN_TILE_MAX_ZOOM = 10;

/** The pixels an elevation tile spans (see ui/terrain.ts) */
export const TERRAIN_TILE_SIZE_PX = 256;

/**
 * The whole level the relief and the heights of the flights are drawn for
 * at the map zoom `zoom`: the level the ribbons are cut for (see
 * ribbonWidthZoom), up to the one whose ribbons stand on the deepest
 * elevation tiles (see reliefPixelM), from where neither the exaggeration
 * nor the ground changes any more.
 */
export function reliefLevel(zoom: number): number {
  return Math.min(Math.max(ribbonWidthZoom(zoom), 0), RELIEF_MAX_LEVEL);
}

/** The last relief level, see reliefLevel */
export const RELIEF_MAX_LEVEL = TERRAIN_TILE_MAX_ZOOM + 1;

/**
 * The relief levels, counted from the one the flights are cut for, whose
 * ground a ribbon carries as well. MapLibre lifts a ribbon by the relief of
 * the level of the tile it is drawn in, and not every tile is of the level
 * the flights are cut for: while a zoom goes on, the tiles of the next
 * level in or out take over before the zoom ends and the flights are cut
 * for it, and in the distance of a tilted view the tiles are a level or two
 * further out. The paint takes the ground of the tile's own level (see
 * ribbonHeights), so a ribbon stands on the relief under it at every one of
 * these; a level further away takes the ground of the nearest of them.
 */
export const GROUND_LEVELS: readonly number[] = [-2, -1, 1];

/**
 * The feature property that carries the ground of the level `step` levels
 * from the one a ribbon was cut for (see GROUND_LEVELS)
 */
export function groundKey(step: number): `o${number}` {
  return `o${step}`;
}

/**
 * How much the relief and the heights of the flights are exaggerated, by
 * relief level from 0 on, the last for every level beyond. Further out
 * than 10x the Alps stand as a wall across the map, and a level flight
 * saws up and down over the ridges: the ground it is measured against
 * follows the relief the map draws only to within about 100 m there (see
 * groundProfileFt), which the exaggeration multiplies, and at 10x that is
 * under a pixel. The flights are lifted as much, so the lift ramps down
 * from there as it did, to twice their height closer in.
 */
export const EXAGGERATION_BY_LEVEL: readonly number[] = [
  10, 10, 10, 10, 10, 10, 10, 7, 4, 2,
];

/**
 * How much the relief and the heights of the flights are exaggerated at
 * the relief level `level` (see reliefLevel). The map adds the relief's
 * exaggerated elevation to a ribbon's own height, so a flight only stays
 * at its height over the ground it flew over where the two factors are
 * the same: the map takes one number for the relief, so both are one per
 * level, and switch together (see LayerManager.syncTerrain).
 */
export function liftExaggeration(level: number): number {
  const last = EXAGGERATION_BY_LEVEL.length - 1;
  return EXAGGERATION_BY_LEVEL[Math.min(Math.max(level, 0), last)]!;
}

/**
 * Whether the ribbons cut for the relief level `level` are known to the map
 * by an id (see ribbonId): those of a level next to one with another
 * exaggeration, which a zoom across one level switches them to (see
 * ribbonHeights). Every feature the map knows so costs the map a few bytes
 * in every tile it is in, and the flights zoomed out, the most of them, are
 * left out.
 */
export function switchesExaggeration(level: number): boolean {
  const own = liftExaggeration(level);
  return (
    liftExaggeration(level - 1) !== own || liftExaggeration(level + 1) !== own
  );
}

/**
 * Whether the ribbons cut for the relief level `cut` stay on the relief the
 * map draws for the level `level` until they are cut for it: with the same
 * exaggeration, or one they switch to (switchesExaggeration). Their ground
 * is that of the nearest level they carry (see GROUND_LEVELS).
 */
export function followsLevel(cut: number, level: number): boolean {
  return (
    liftExaggeration(cut) === liftExaggeration(level) ||
    switchesExaggeration(cut)
  );
}

/**
 * The id the map knows the ribbons cut for the relief level `level` by, in
 * the `epoch`-th visit of a level (ReliefState.epoch): a feature
 * state for it reaches all of them, and them only (see ui/terrain.ts).
 * MapLibre keeps an entry for every id it was given a state for, and works
 * out the paint of every feature of such an id anew in each tile it loads,
 * which for a whole cut takes seconds on a slow machine; a cut of a later
 * visit has an id no state has been given.
 */
export function ribbonId(level: number, epoch: number): number {
  return level + (RELIEF_MAX_LEVEL + 1) * epoch;
}

/** Whether the 3D view lifts the flights at the map zoom `zoom` */
export function isLiftedAt(zoom: number): boolean {
  return zoom < LIFT_MAX_ZOOM;
}

/**
 * The zoom a ribbon's width is worked out for at the map zoom `zoom`: the
 * whole level it is in. A change of it is what cuts the flights again, and
 * what hands them to the lines at LIFT_MAX_ZOOM.
 */
export function ribbonWidthZoom(zoom: number): number {
  return Math.floor(zoom);
}

/** A segment's altitude as feet above its flight's ground, never below */
export function liftFt(altitudeFt: number, groundFt: number): number {
  return Math.max(altitudeFt - groundFt, 0);
}

/**
 * The levels whose ground a ribbon stands on, counted from the one it was
 * cut for, in order: the ones of GROUND_LEVELS, and that one itself, whose
 * ground is the one its height is above
 */
export const STANDING_LEVELS = [...GROUND_LEVELS, 0].sort((a, b) => a - b);

/**
 * Which level's ground stands for the level `step` levels from the one cut
 * for: the first of STANDING_LEVELS at or above it, the last above them
 * all. The paint picks them alike (see ribbonHeights).
 */
function standingLevel(step: number): number {
  return (
    STANDING_LEVELS.find((level) => level >= step) ??
    STANDING_LEVELS[STANDING_LEVELS.length - 1]!
  );
}

/**
 * Of the ground offsets `offsets` of a point cut for the relief level
 * `cutLevel` (see GROUND_LEVELS), the one of the relief under a tile of the
 * map zoom `zoom`
 */
export function groundOffsetFt(
  offsets: ArrayLike<number> | undefined,
  cutLevel: number,
  zoom: number,
): number {
  const index = GROUND_LEVELS.indexOf(
    standingLevel(reliefLevel(zoom) - cutLevel),
  );
  return offsets && index >= 0 ? offsets[index]! : 0;
}

/**
 * The feet above the relief under a tile of the map zoom `zoom` of a point
 * `heightFt` above the ground of the relief level `cutLevel`, with the
 * ground offsets there (see groundOffsetFt), never below
 */
export function heightOnReliefFt(
  heightFt: number,
  offsets: ArrayLike<number> | undefined,
  cutLevel: number,
  zoom: number,
): number {
  return Math.max(heightFt + groundOffsetFt(offsets, cutLevel, zoom), 0);
}

/**
 * A point's feet above the ground of the relief level `level`, and the
 * ground of the levels around it there (see groundOffsetFt); a height of
 * null is none, where the flights are not lifted
 */
export interface GroundedHeight {
  heightFt: number | null;
  offsetsFt?: readonly number[] | undefined;
  level?: number | undefined;
}

/**
 * The feet above the relief under a tile of the map zoom `zoom` of a point
 * lifted as `point` says (see heightOnReliefFt), or null for none
 */
export function heightAtZoomFt(
  point: GroundedHeight,
  zoom: number,
): number | null {
  return point.heightFt === null
    ? null
    : heightOnReliefFt(
        point.heightFt,
        point.offsetsFt,
        point.level ?? reliefLevel(zoom),
        zoom,
      );
}

/**
 * The metres a pixel spans at `lat` of the elevation tiles the ribbons of
 * the relief level `level` stand on. MapLibre raises a ribbon by the
 * relief under it from the tiles one level coarser than its own (a
 * raster-dem source's tiles are drawn at twice their size), so the ground
 * sampled at TERRAIN_TILE_MAX_ZOOM is theirs only from a level beyond.
 */
export function reliefPixelM(level: number, lat: number): number {
  const zoom = Math.min(level - 1, TERRAIN_TILE_MAX_ZOOM);
  return (
    (EARTH_CIRCUMFERENCE_M / (TERRAIN_TILE_SIZE_PX * 2 ** zoom)) *
    Math.cos(lat * DEGREES_TO_RADIANS)
  );
}

/**
 * How far up the screen a point `heightFt` above the ground is drawn, in
 * pixels: the height as the ribbons have it, exaggerated by `exaggeration`
 * (the one of the level the map is drawn for, see liftMetres), over the
 * metres a pixel spans at `zoom`, foreshortened by the tilt. Flat, a height
 * takes no room on the screen. MapLibre scales every extrusion by the
 * metres of a pixel at the map's centre, wherever the extrusion stands, so
 * `lat` is the centre's latitude (for a camera move, the one it ends at),
 * not the point's. An
 * approximation that leaves the perspective out, close enough to put the
 * airplane on its ribbon and to rank what is under the pointer.
 */
export function liftOffsetPx(
  map: MapLibreMap,
  lat: number,
  heightFt: number,
  exaggeration: number,
  zoom = map.getZoom(),
): number {
  const pitch = map.getPitch() * DEGREES_TO_RADIANS;
  const metresPerPx = metresPerPixel(zoom) * Math.cos(lat * DEGREES_TO_RADIANS);
  return (liftMetres(heightFt, exaggeration) / metresPerPx) * Math.sin(pitch);
}

/**
 * How high a point `heightFt` above the ground is drawn, in metres over
 * the ground under it: its height, exaggerated by `exaggeration` like the
 * ribbons' (see liftExaggeration). That is the one of the level the map
 * is drawn for (reliefLevel in the store), not of the zoom: while a zoom
 * crosses a level the ribbons and the relief keep the exaggeration of the
 * level before until it ends (see ribbonHeights).
 */
export function liftMetres(heightFt: number, exaggeration: number): number {
  return heightFt * FEET_TO_METERS * exaggeration;
}

/**
 * How far up the screen the replay's airplane is drawn at `zoom`: at its
 * height, on its trail, where the trail is lifted (see isLiftedAt).
 * `heightFt` is null while the trail is flat.
 */
export function airplaneLiftPx(
  map: MapLibreMap,
  lat: number,
  heightFt: number | null,
  exaggeration: number,
  zoom = map.getZoom(),
): number {
  return heightFt === null || !isLiftedAt(zoom)
    ? 0
    : liftOffsetPx(map, lat, heightFt, exaggeration, zoom);
}

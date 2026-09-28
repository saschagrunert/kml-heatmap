/**
 * The directions of the flights of the heat cloud in cells on the ground,
 * for how strongly each stretch (see cloudPoints in
 * calculations/heatCloud.ts) may draw the marks that show the way the
 * flights went while the pulses of the layer do not run (see
 * CLOUD_MARK_SPACING_PX in ui/heatCloudLayer.ts).
 *
 * A mark points the way its own flight was flown. Where flights overlap
 * in both directions, a runway used both ways, a circuit flown left for
 * one runway and right for the other, or a route flown out and back,
 * marks of both would point either way at the same places and say
 * nothing: a stretch draws them only where the flights around it go its
 * way. The directions of the stretches in a cell are added up weighed by
 * their heat, the seconds spent there as the heatmap weighs them, and a
 * stretch takes of the cells it passes how far the flights along its own
 * axis go its way rather than the other (agreement). Flights across it
 * count for neither, so a crossing of two routes keeps the marks of both.
 * The heat alone takes nothing away: the flights along a track draw their
 * marks at the same places, so a busy one draws one row of them, not a
 * haze.
 */

/**
 * Of the flights along a stretch's axis in its cells, how far those going
 * its way must outweigh those going the other for it to draw any marks,
 * and to draw them in full, from -1 (all the other way) to 1 (all its way)
 */
const MARK_AGREEMENT_RANGE = [0.3, 0.8] as const;

/**
 * The floats of a cell: the sum of its directions and the sum of their
 * outer products (east, south; east², east·south, south²), each weighed
 * by its heat
 */
const CELL_FLOATS = 5;

/**
 * The most places along a stretch it is added to its cells at: two a cell
 * it crosses, up to this many for a stretch across many
 */
const MOST_SAMPLES = 16;

/** The slot of a cell's column and row in a table of `mask` + 1 slots */
function slotOf(column: number, row: number, mask: number): number {
  return (Math.imul(column, 0x9e3779b1) ^ Math.imul(row, 0x85ebca77)) & mask;
}

/**
 * The agreement of a stretch of the direction `(dx, dy)` (a unit vector)
 * with the cell whose sums start at `at` in `sums`: the heat along its
 * axis going its way less that going the other, over all of it, where
 * each stretch in the cell counts by how far it runs along that axis. In
 * vectors, (d . S) / (d . T d) for the sum S of the cell's directions and
 * the sum T of their outer products: 1 for a cell of flights all going
 * its way, whatever crosses them, -1 for all going the other, 0 for as
 * many each way. Clamped to -1 and 1, since a flight at an angle to the
 * axis counts for more in S than in T.
 */
export function agreement(
  sums: ArrayLike<number>,
  at: number,
  dx: number,
  dy: number,
): number {
  const along = dx * sums[at]! + dy * sums[at + 1]!;
  const axial =
    dx * dx * sums[at + 2]! +
    2 * dx * dy * sums[at + 3]! +
    dy * dy * sums[at + 4]!;
  if (!(axial > 0)) return 0;
  return Math.min(Math.max(along / axial, -1), 1);
}

/**
 * The cells of `cell` Mercator units, found by their column and row in a
 * table of typed arrays kept at most half full, the one found last first,
 * since the next place is in it more often than not
 */
function cellTable(): {
  /** Where the sums of the cell at `x` and `y` start, made if need be */
  at(x: number, y: number, cell: number): number;
  sums: () => Float64Array;
} {
  // Which cell a slot holds, from 1 (0 for none), and the column and the
  // row of each cell, and its sums
  let slots = new Int32Array(1 << 10);
  let places = new Int32Array(slots.length);
  let sums = new Float64Array((CELL_FLOATS * slots.length) / 2);
  let made = 0;
  let lastColumn = 0;
  let lastRow = 0;
  let last = -1;
  return {
    at(x, y, cell) {
      const column = Math.floor(x / cell);
      const row = Math.floor(y / cell);
      if (last >= 0 && column === lastColumn && row === lastRow) return last;
      let mask = slots.length - 1;
      let slot = slotOf(column, row, mask);
      let held = slots[slot]!;
      while (
        held !== 0 &&
        (places[2 * held - 2] !== column || places[2 * held - 1] !== row)
      ) {
        slot = (slot + 1) & mask;
        held = slots[slot]!;
      }
      if (held === 0) {
        held = ++made;
        if (2 * held > slots.length) {
          // The table twice as large, with every cell in it again
          const more = new Int32Array(places.length * 2);
          more.set(places);
          places = more;
          const larger = new Float64Array(sums.length * 2);
          larger.set(sums);
          sums = larger;
          slots = new Int32Array(slots.length * 2);
          mask = slots.length - 1;
          places[2 * held - 2] = column;
          places[2 * held - 1] = row;
          for (let other = 1; other <= held; other++) {
            let free = slotOf(
              places[2 * other - 2]!,
              places[2 * other - 1]!,
              mask,
            );
            while (slots[free] !== 0) free = (free + 1) & mask;
            slots[free] = other;
          }
        } else {
          places[2 * held - 2] = column;
          places[2 * held - 1] = row;
          slots[slot] = held;
        }
      }
      last = (held - 1) * CELL_FLOATS;
      lastColumn = column;
      lastRow = row;
      return last;
    },
    sums: () => sums,
  };
}

/**
 * Write how strongly each stretch of the points `values` may draw the
 * marks of the way it was flown, from 0 to 1, into its float `marks`, by
 * its agreement with the cells of `cell` Mercator units it passes
 * (MARK_AGREEMENT_RANGE).
 *
 * The points are `floats` each, x and y first in Mercator units, and
 * `heat` the float of the heat of the stretch from each to the next: a
 * point of none starts no stretch, and ends a run of them. A stretch is
 * added to every cell it passes, at two places a cell along it, so a long
 * one merged from many steps (see CLOUD_MERGE_PX) counts wherever it runs
 * and not only where it starts; a stretch of no heat adds nothing. The
 * point that ends a run takes the marks of the stretch that ends at it, so
 * the layer can blend them along a stretch into the next without a step.
 */
export function markStretches(
  values: number[],
  floats: number,
  heat: number,
  marks: number,
  cell: number,
): void {
  const count = values.length / floats;
  const cells = cellTable();
  /** The places along the stretch from `k`, and `add` at each */
  const along = (
    k: number,
    add: (at: number, part: number, ux: number, uy: number) => void,
  ): void => {
    const x = values[k]!;
    const y = values[k + 1]!;
    const dx = values[k + floats]! - x;
    const dy = values[k + floats + 1]! - y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (!(length > 0)) return;
    const samples = Math.min(Math.ceil((2 * length) / cell), MOST_SAMPLES);
    for (let s = 0; s < samples; s++) {
      const f = (s + 0.5) / samples;
      add(
        cells.at(x + f * dx, y + f * dy, cell),
        1 / samples,
        dx / length,
        dy / length,
      );
    }
  };
  for (let p = 0; p < count; p++) {
    const k = p * floats;
    const seconds = values[k + heat]!;
    if (!(seconds > 0)) continue;
    along(k, (at, part, ux, uy) => {
      const sums = cells.sums();
      const weight = seconds * part;
      sums[at] = sums[at]! + weight * ux;
      sums[at + 1] = sums[at + 1]! + weight * uy;
      sums[at + 2] = sums[at + 2]! + weight * ux * ux;
      sums[at + 3] = sums[at + 3]! + weight * ux * uy;
      sums[at + 4] = sums[at + 4]! + weight * uy * uy;
    });
  }
  const [low, high] = MARK_AGREEMENT_RANGE;
  const passed = new Float64Array(CELL_FLOATS);
  for (let p = 0; p < count; p++) {
    const k = p * floats;
    let mark = 0;
    if (values[k + heat]! > 0) {
      passed.fill(0);
      let dx = 0;
      let dy = 0;
      along(k, (at, part, ux, uy) => {
        const sums = cells.sums();
        for (let f = 0; f < CELL_FLOATS; f++) {
          passed[f] = passed[f]! + part * sums[at + f]!;
        }
        dx = ux;
        dy = uy;
      });
      const t = Math.min(
        Math.max((agreement(passed, 0, dx, dy) - low) / (high - low), 0),
        1,
      );
      mark = t * t * (3 - 2 * t);
    } else if (p > 0) {
      mark = values[k - floats + marks]!;
    }
    values[k + marks] = mark;
  }
}

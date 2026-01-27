/**
 * Array utility helpers
 * Pure functions for common array operations
 */

/**
 * Find minimum value in array using iterative approach
 * Avoids stack overflow with large arrays compared to Math.min(...array)
 */
export function findMin(values: number[]): number {
  if (values.length === 0) return 0;

  let min = values[0]!;
  for (let i = 1; i < values.length; i++) {
    const val = values[i]!;
    if (val < min) min = val;
  }
  return min;
}

/**
 * Find maximum value in array using iterative approach
 * Avoids stack overflow with large arrays compared to Math.max(...array)
 */
export function findMax(values: number[]): number {
  if (values.length === 0) return 0;

  let max = values[0]!;
  for (let i = 1; i < values.length; i++) {
    const val = values[i]!;
    if (val > max) max = val;
  }
  return max;
}

/**
 * Find both minimum and maximum values in a single pass
 * More efficient than calling findMin and findMax separately
 */
export function findMinMax(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 };

  let min = values[0]!;
  let max = values[0]!;

  for (let i = 1; i < values.length; i++) {
    const val = values[i]!;
    if (val < min) min = val;
    if (val > max) max = val;
  }

  return { min, max };
}

/* Optional 1-2-1 temporal smoothing. The published documents carry derived
   series unsmoothed; renderers that want calmer cloud-base and usable-lift
   lines apply this kernel themselves. */

const HOUR_MS = 3_600_000;

/**
 * Returns a smoothed copy of the series (the input is not mutated). An
 * interior point becomes (previous + 2*current + next) / 4 only when both
 * neighbours exist (non-null), and both time steps are exactly one hour —
 * three-hourly models and gaps pass through untouched, as do the endpoints.
 * Neighbours are always the ORIGINAL values, never already-smoothed ones.
 */
export function smooth121(
  series: ReadonlyArray<{ validAt: string; value: number | null }>,
): Array<number | null> {
  const original = series.map((entry) => entry.value);
  const times = series.map((entry) => Date.parse(entry.validAt));
  const smoothed = [...original];

  for (let index = 1; index < series.length - 1; index += 1) {
    if (
      times[index] - times[index - 1] !== HOUR_MS ||
      times[index + 1] - times[index] !== HOUR_MS
    ) {
      continue;
    }
    const previous = original[index - 1];
    const current = original[index];
    const next = original[index + 1];
    if (previous === null || current === null || next === null) continue;
    smoothed[index] = (previous + 2 * current + next) / 4;
  }

  return smoothed;
}

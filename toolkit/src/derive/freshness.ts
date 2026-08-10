/* Run freshness: a pure judgment of runs.json entries against catalogue
   facts, with the tolerance thresholds as parameters. The FACTS come from
   the catalogue — `runIntervalHours` (how often a successor run appears)
   and `typicalPublicationLagHours` (the upper end of normal for the
   publish after referenceTime) — and the PREFERENCE is the consumer's:
   how many missed intervals separate "delayed" from "stale" is a display
   policy, never a dataset property. */

const HOUR_MS = 3_600_000;

export type RunFreshness = "current" | "delayed" | "stale";

/**
 * The consumer-owned tolerance: both counts are run intervals of age
 * beyond the model's typical publication lag. There are no defaults —
 * how much lateness a product tolerates before warning its users is that
 * product's decision, stated at the call site.
 */
export interface RunFreshnessThresholds {
  /**
   * Intervals a run may trail `now` (beyond the lag) and read "current" —
   * 1 means "the successor run may simply not exist yet".
   */
  currentIntervals: number;
  /**
   * Intervals past which the run reads "stale" instead of "delayed" —
   * 2 means "a whole successor run has been skipped and the one after is
   * late too".
   */
  staleAfterIntervals: number;
}

/**
 * Judges how fresh a published run is at `now`:
 *
 * - `"current"` — age ≤ `currentIntervals × runIntervalHours +
 *   typicalPublicationLagHours`: the successor may simply not have been
 *   published yet; nothing is late.
 * - `"delayed"` — age within `staleAfterIntervals` intervals plus the
 *   lag: the successor is genuinely late, but this run is still the
 *   newest forecast there is.
 * - `"stale"` — older than that: the feed has missed enough runs that
 *   the forecast should no longer be presented as current weather.
 *
 * Facts vs preference: `runsEntry` and `model` carry published facts
 * (runs.json and the models.json catalogue — pass their entries
 * straight in); `thresholds` is the consumer's tolerance and is
 * deliberately a required parameter (this library states facts, never
 * display policy). Age is `now − referenceTime`: `generatedAt` is
 * accepted so a runs.json entry drops in unchanged, but a republish of
 * the same run never makes the forecast younger. Observation datasets
 * never come here — they have no runs; judge them against their
 * catalogue `cadenceMinutes`.
 *
 * Throws a `RangeError` on an unparseable instant rather than returning
 * a plausible-but-wrong grade.
 */
export function runFreshness(
  runsEntry: { referenceTime: string; generatedAt?: string },
  model: { runIntervalHours: number; typicalPublicationLagHours: number },
  now: string,
  thresholds: RunFreshnessThresholds,
): RunFreshness {
  const referenceMs = Date.parse(runsEntry.referenceTime);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(referenceMs)) {
    throw new RangeError(`runFreshness: unparseable referenceTime ${runsEntry.referenceTime}`);
  }
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`runFreshness: unparseable now ${now}`);
  }

  const ageMs = Math.max(0, nowMs - referenceMs);
  const intervalMs = model.runIntervalHours * HOUR_MS;
  const lagMs = model.typicalPublicationLagHours * HOUR_MS;
  if (ageMs <= thresholds.currentIntervals * intervalMs + lagMs) return "current";
  if (ageMs <= thresholds.staleAfterIntervals * intervalMs + lagMs) return "delayed";
  return "stale";
}

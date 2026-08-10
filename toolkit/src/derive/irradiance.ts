/* Measured-irradiance derivations — the consumer half of the observation
   document kind. An observation series carries measured W/m²; these
   functions make that number interpretable next to a forecast: a cited
   clear-sky expectation turns a measurement into a transmittance (how
   much of the possible sun actually arrived), and the nearest-instant
   join respects that observations live at the product's native cadence
   (GOES scan starts, :00:21/:10:21/…), never on forecast hours.

   Like the smoke module's constants, the clear-sky model is a versioned
   physics claim with a citation, not a consumer preference. Its scope is
   stated honestly: Haurwitz is a sea-level, climatological-atmosphere
   model with no site pressure or turbidity inputs — good to roughly
   ±5 % at mid solar elevations, and the reason observedTransmittance can
   legitimately exceed 1 on clean high-altitude days or under cloud-edge
   brightening. */

import type { Observation, ObservationDocument } from "../contract/index.js";

/**
 * Clear-sky global horizontal irradiance, W/m², from the cosine of the
 * solar zenith angle alone — Haurwitz (1945, J. Meteorology 2, 154–166;
 * 1946, 3, 123–124): GHI = 1098 · cosθz · exp(−0.059 / cosθz). Chosen
 * per Reno, Hansen & Stein 2012 (SAND2012-2389), where it is the best
 * performer among models needing only the zenith angle. Zero when the
 * sun is at or below the horizon.
 */
export function clearSkyGhiWm2(cosZenith: number): number {
  if (cosZenith <= 0) return 0;
  return 1098 * cosZenith * Math.exp(-0.059 / cosZenith);
}

/* Below this sun height the clear-sky denominator is tiny and the ratio
   swings wildly with horizon terrain and refraction — the same cos floor
   the smoke slant path uses, for the same reason. */
const MIN_COS_ZENITH = 0.15;
/* Cloud-edge brightening and clean high-altitude air genuinely beat the
   sea-level climatological model; beyond this the inputs are suspect. */
const MAX_TRANSMITTANCE = 1.5;

/**
 * The fraction of the clear-sky expectation that actually arrived:
 * measured GHI over Haurwitz. 1 means a textbook clear sky, ~0.85 a
 * moderate smoke plume, well under 0.5 serious cloud. Null when the sun
 * is too low for the ratio to mean anything (cosθz < 0.15) — near the
 * horizon both the model and the measurement geometry degrade. Values
 * modestly above 1 are real (see the module note); the result is capped
 * at 1.5 as an input-sanity bound.
 */
export function observedTransmittance(
  measuredWm2: number,
  cosZenith: number,
): number | null {
  if (cosZenith < MIN_COS_ZENITH) return null;
  if (!(measuredWm2 >= 0)) return null;
  const expectation = clearSkyGhiWm2(cosZenith);
  return Math.min(measuredWm2 / expectation, MAX_TRANSMITTANCE);
}

/**
 * The observation nearest an instant, within a tolerance — the join
 * primitive for putting measurements beside forecast hours. Observations
 * sit at the product's native cadence (GOES-18 DSR: scan starts every
 * 10 minutes), so an exact-key join against a forecast validAt never
 * matches; nearest-within-tolerance is the honest alignment, and the
 * returned offset lets a consumer display how far the match reached.
 * Null when nothing lies within the tolerance (night hours, gaps).
 */
export function nearestObservation(
  document: ObservationDocument,
  instant: string,
  maxOffsetMinutes = 30,
): { observation: Observation; offsetMinutes: number } | null {
  const target = Date.parse(instant);
  if (Number.isNaN(target)) return null;
  let best: { observation: Observation; offsetMinutes: number } | null = null;
  for (const observation of document.observations) {
    const offsetMinutes = Math.abs(Date.parse(observation.observedAt) - target) / 60_000;
    if (offsetMinutes > maxOffsetMinutes) continue;
    if (best === null || offsetMinutes < best.offsetMinutes) {
      best = { observation, offsetMinutes };
    }
  }
  return best;
}

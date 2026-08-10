/* bandShear — the kind's type and its extractor, one module. */

import type { WindgramHour } from "../../contract/index.js";
import { p50 } from "../../derive/ensemble.js";
import { vectorShearMs } from "../../derive/shear.js";
import type { ThermalWindowFinding } from "./thermal-window.js";
import { round1, round2, type CitedInstant, type Context, type LocalDayKey } from "./shared.js";

/**
 * The strongest layer-shear rate inside the climb band — launch to lift
 * top — per thermalWindow day: component-wise vector shear between
 * ADJACENT PUBLISHED LEVELS divided by the layer's thickness. This is the
 * height-resolved form `surfaceToBoundaryLayerShearMs`'s own JSDoc points
 * terrain-driven sites to — it measures layer by layer within the column
 * and never straddles the valley decoupling that quantity confesses.
 *
 * ANALYZE-ONLY, NEVER COMPARED. Rates are NOT comparable across level
 * densities: S3 (2026-08-10) subsampled a dense model to a 5-level
 * ensemble's grid and read a median 0.41× (p10 0.11×) of the dense rate
 * on identical hours — the thick layer reports a DIFFERENT, smeared layer,
 * not a softer number (dense found 4.7 m/s/km in 3133-3733 m where sparse
 * reported 0.8 across 1501-3133 m). Shear rates never join a compare
 * roster; cross-model readers must read `levelsInBand` and the layer
 * bounds first, which is why both are mandatory in the shape — "2.3
 * m/s/km across 1506-3129 m" cannot be mistaken for a sharp shear zone.
 *
 * On 5-level ensemble grids the kind effectively never emits (S3 measured
 * ≥2 in-band levels at 0.4-6 % of lift hours on GEPS/REPS): absence means
 * "column too sparse to state", never "no shear". The gate here is
 * DETERMINISTIC DOCUMENTS ONLY regardless — ensemble level winds would
 * additionally ride direction percentiles that are not circular
 * statistics (the same gate as windDirection).
 *
 * The light-wind artifact survives into the layer form at reduced
 * amplitude: on the spike corpus 12 % of day maxima were direction
 * differences between two sub-2 m/s endpoint winds (e.g. "3.6 m/s/km"
 * manufactured from 0.61 m/s @ 324° against 0.44 m/s @ 77° across 247 m).
 * `bothEndpointsUnderFloorMs` states that arithmetic relation against the
 * embedded `endpointFloorMs` and nothing more — no quality verdict; the
 * 2026-08-08 spike's kill on package-owned judgments stands, and
 * downstream decides what a light-wind layer difference means. The spike
 * ran `minLayerThicknessM` 30 and evidenced the 2 m/s floor; both are
 * embedded, caller-movable conventions.
 */
export interface BandShearFinding {
  kind: "bandShear";
  day: LocalDayKey;
  maxShear: {
    /** m/s per km — the layer-normalized number. */
    ratePerKm: number;
    /** The raw vector wind difference across the layer, stated beside the
     * rate so the normalization hides nothing. */
    shearMs: number;
    /** Mandatory — the rate means nothing without its layer. */
    layer: { fromM: number; toM: number; thicknessM: number };
    at: CitedInstant;
    lower: { speedMs: number; directionDeg: number; heightM: number };
    upper: { speedMs: number; directionDeg: number; heightM: number };
  };
  /** In-band published levels at the cited hour — the sparsity confession
   * a cross-document reader must read before the rate. */
  levelsInBand: number;
  /** Both endpoint speeds sit under `endpointFloorMs` — an arithmetic
   * relation, not a verdict (see the kind JSDoc for the measured 12 %). */
  bothEndpointsUnderFloorMs: boolean;
  thresholds: { minLayerThicknessM: number; endpointFloorMs: number };
  /** Per window-scope hour: the hour's own max layer rate (null where the
   * hour has no lift top or fewer than two in-band levels). */
  evidence: { hours: string[]; maxRatePerKm: (number | null)[] };
}

interface LayerMax {
  ratePerKm: number;
  shearMs: number;
  lower: { speedMs: number; directionDeg: number; heightM: number };
  upper: { speedMs: number; directionDeg: number; heightM: number };
  levelsInBand: number;
}

export function findBandShear(
  context: Context,
  windows: ThermalWindowFinding[],
): BandShearFinding[] {
  // The same hard gate as windDirection (see the kind JSDoc).
  if (!context.deterministic) return [];
  const { profile, launchReferenceM, thresholds } = context;
  const { minLayerThicknessM, endpointFloorMs } = thresholds.bandShear;
  const hourByValidAt = new Map(profile.hours.map((hour) => [hour.validAt, hour]));

  /* The scope, per day: the union of the same-day thermalWindows' cited
     hours — the family's one scope mechanism. */
  const windowHoursByDay = new Map<string, string[]>();
  for (const window of windows) {
    const bucket = windowHoursByDay.get(window.day) ?? [];
    bucket.push(...window.evidence.hours);
    windowHoursByDay.set(window.day, bucket);
  }

  const hourMax = (hour: WindgramHour): LayerMax | null => {
    const top = p50(hour.derived.usableLiftTopM);
    if (top === null) return null;
    const inBand = hour.levels
      .flatMap((level) => {
        const heightM = p50(level.heightM);
        const speedMs = p50(level.windSpeedMs);
        const directionDeg = p50(level.windDirectionDeg);
        if (heightM === null || speedMs === null || directionDeg === null) return [];
        if (heightM < launchReferenceM || heightM > top) return [];
        return [{ heightM, speedMs, directionDeg }];
      })
      .sort((left, right) => left.heightM - right.heightM);
    let best: LayerMax | null = null;
    for (let i = 0; i + 1 < inBand.length; i += 1) {
      const lower = inBand[i];
      const upper = inBand[i + 1];
      const thicknessM = upper.heightM - lower.heightM;
      if (thicknessM < minLayerThicknessM) continue;
      const shearMs = vectorShearMs(
        { windSpeedMs: lower.speedMs, windDirectionDeg: lower.directionDeg },
        { windSpeedMs: upper.speedMs, windDirectionDeg: upper.directionDeg },
      );
      const ratePerKm = shearMs / (thicknessM / 1000);
      if (best === null || ratePerKm > best.ratePerKm) {
        best = { ratePerKm, shearMs, lower, upper, levelsInBand: inBand.length };
      }
    }
    return best;
  };

  const findings: BandShearFinding[] = [];
  for (const [day, windowHours] of windowHoursByDay) {
    const maxima = windowHours.map((validAt) => ({
      validAt,
      max: hourMax(hourByValidAt.get(validAt)!),
    }));
    const peak = maxima.reduce(
      (best: (typeof maxima)[number] | null, entry) =>
        entry.max !== null && (best === null || entry.max.ratePerKm > best.max!.ratePerKm)
          ? entry
          : best,
      null,
    );
    if (peak === null) continue; // no hour offers >= 2 in-band levels

    const { max } = peak;
    findings.push({
      kind: "bandShear",
      day,
      maxShear: {
        ratePerKm: round2(max!.ratePerKm),
        shearMs: round2(max!.shearMs),
        layer: {
          fromM: round1(max!.lower.heightM),
          toM: round1(max!.upper.heightM),
          thicknessM: round1(max!.upper.heightM - max!.lower.heightM),
        },
        at: context.cite(peak.validAt),
        lower: {
          speedMs: round2(max!.lower.speedMs),
          directionDeg: Math.round(max!.lower.directionDeg),
          heightM: round1(max!.lower.heightM),
        },
        upper: {
          speedMs: round2(max!.upper.speedMs),
          directionDeg: Math.round(max!.upper.directionDeg),
          heightM: round1(max!.upper.heightM),
        },
      },
      levelsInBand: max!.levelsInBand,
      bothEndpointsUnderFloorMs:
        max!.lower.speedMs < endpointFloorMs && max!.upper.speedMs < endpointFloorMs,
      thresholds: { minLayerThicknessM, endpointFloorMs },
      evidence: {
        hours: [...windowHours],
        maxRatePerKm: maxima.map((entry) =>
          entry.max === null ? null : round2(entry.max.ratePerKm),
        ),
      },
    });
  }
  return findings;
}

/* terrainMismatch — the kind's type and its extractor, one module. */

import { isEnsembleValue } from "../../contract/index.js";
import { p50 } from "../../derive/ensemble.js";
import { round1, type CitedInstant, type Context } from "./shared.js";

/**
 * The model's grid terrain sits far from the launch, so every
 * altitude-referenced series in the document is structurally biased — the
 * spike's motivating case is GEPS at Flagpole, which models the site at
 * 144 m though launch is 1222 m, so its usable-lift top never reaches
 * launch. Invisible on a chart; only the metadata says it. The one verdict,
 * `liftTopEverReachesLaunch`, is pure arithmetic: max published lift top
 * vs launch elevation. Documents are launch-agnostic, so the launch is the
 * caller's (`AnalyzeOptions.launch`): emitted only when a launch is
 * supplied and |delta| is at least `thresholds.minAbsDeltaM`.
 */
export interface TerrainMismatchFinding {
  kind: "terrainMismatch";
  modelElevationM: number;
  /** The caller-supplied launch elevation (AnalyzeOptions.launch), metres MSL. */
  siteAltitudeM: number;
  /** modelElevationM − siteAltitudeM; negative = model terrain below launch. */
  deltaM: number;
  /** Arithmetic verdict: does any hour's published lift top exceed launch? */
  liftTopEverReachesLaunch: boolean;
  thresholds: { minAbsDeltaM: number };
  evidence: {
    maxUsableLiftTopM: number | null;
    maxUsableLiftTopAt: CitedInstant | null;
    /**
     * The max published p90 lift top — ensemble documents only, null for
     * deterministic ones — so the bench is checkable against the band's
     * top, not only the median the verdict reads (S1, 2026-08-10, live at
     * red-mountain: p50 depth −52 m while p90 cleared launch by +1072 m;
     * benched members stay benched, and this number is the evidence a
     * consumer needs to see that the call read the whole band).
     */
    maxUsableLiftTopP90M: number | null;
  };
}

export function findTerrainMismatch(context: Context): TerrainMismatchFinding[] {
  const { profile, thresholds } = context;
  // Launch vs model ground needs a launch: without AnalyzeOptions.launch
  // there is no statement to make (documents carry no launch).
  const launch = context.launchElevationM;
  if (launch === null) return [];
  const delta = profile.site.modelElevationM - launch;
  if (Math.abs(delta) < thresholds.terrainMismatch.minAbsDeltaM) return [];

  let maxTop: number | null = null;
  let maxTopAt: CitedInstant | null = null;
  let maxTopP90: number | null = null;
  for (const hour of profile.hours) {
    const value = hour.derived.usableLiftTopM;
    const top = p50(value);
    if (top !== null && (maxTop === null || top > maxTop)) {
      maxTop = top;
      maxTopAt = context.cite(hour.validAt);
    }
    if (value !== null && isEnsembleValue(value) && value.p90 !== null) {
      if (maxTopP90 === null || value.p90 > maxTopP90) maxTopP90 = value.p90;
    }
  }
  return [
    {
      kind: "terrainMismatch",
      modelElevationM: profile.site.modelElevationM,
      siteAltitudeM: launch,
      deltaM: round1(delta),
      liftTopEverReachesLaunch: maxTop !== null && maxTop > launch,
      thresholds: { ...thresholds.terrainMismatch },
      evidence: {
        maxUsableLiftTopM: maxTop === null ? null : round1(maxTop),
        maxUsableLiftTopAt: maxTopAt,
        maxUsableLiftTopP90M: maxTopP90 === null ? null : round1(maxTopP90),
      },
    },
  ];
}

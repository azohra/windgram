/* dataCaveats — the kind's type and its extractor, one module. */

import { p50 } from "../../derive/ensemble.js";
import type { Context } from "./shared.js";

/** One entry in the dataCaveats honesty layer — all threshold-free. */
export type DataCaveat =
  | {
      /** Quantity families never published in this document — per the
       * contract, absence means "not published", never zero. The `"smoke"`
       * family token means an absent `hours[].smoke` block AND no joined
       * smoke document stated it either: per the contract absence is
       * "not published", NEVER clear air — and since every finding is
       * smoke-blind arithmetic, no finding in such an analysis accounts
       * for smoke. S2 (2026-08-10) confirmed the gap live: on a
       * GOES-verified heavy-smoke day the smoke-blind and smoke-carrying
       * analyses produced indistinguishable caveats. */
      caveat: "absentQuantities";
      quantities: string[];
    }
  | {
      /** Hours where a derived nullable series is null — a real forecast of
       * "none" (no usable lift, no buoyant parcel), not a gap. */
      caveat: "derivedNullHours";
      quantity: "usableLiftTopM" | "boundaryLayerTopM";
      hoursNull: number;
      ofHours: number;
    }
  | {
      /** Multi-hour steps: timing finer than the cadence (window edges,
       * onset times) is interpolation, not forecast. `stepHours` is the
       * document's WIDEST adjacent gap — cadence can widen mid-horizon
       * (live GEPS: 3 h then 6 h), and the widest step is the honest
       * single number where the shape allows only one. */
      caveat: "stepCadence";
      stepHours: number;
    }
  | {
      /** The document declares no site.timeZone and no override was given,
       * so every local field in this analysis reads in UTC. */
      caveat: "timesAreUtc";
    };

/**
 * What this document cannot say: quantity families it never publishes,
 * derived-null hours, cadence-interpolation notes. Threshold-free by
 * definition — these are declarations, not judgments.
 */
export interface DataCaveatsFinding {
  kind: "dataCaveats";
  caveats: DataCaveat[];
}

export function findDataCaveats(
  context: Context,
  timeZoneSource: "document" | "override" | "utcFallback",
  /** Whether any smokeImpact finding was emitted — a supplied smoke
   * document that never matches (every profile hour beyond its horizon)
   * still leaves the analysis smoke-blind, and this stays false. */
  smokeStated: boolean,
): DataCaveatsFinding {
  const { profile } = context;
  const caveats: DataCaveat[] = [];

  // Quantity families never present anywhere in this document. Contract
  // semantics: absence means "not published", never zero — so a family
  // absent from every hour is a declaration this document cannot speak to it.
  const surfaceFamilies = [
    "windGustMs",
    "capeJkg",
    "cinJkg",
    "pblHeightM",
    "lowCloudPercent",
    "midCloudPercent",
    "highCloudPercent",
  ] as const;
  const absent: string[] = [];
  for (const family of surfaceFamilies) {
    if (profile.hours.every((hour) => hour.surface[family] === undefined)) absent.push(family);
  }
  if (profile.hours.every((hour) => hour.levels.length === 0)) {
    absent.push("levels");
  } else {
    if (
      profile.hours.every((hour) =>
        hour.levels.every((level) => level.verticalVelocityPaS === undefined),
      )
    ) {
      absent.push("levels[].verticalVelocityPaS");
    }
    if (
      profile.hours.every((hour) =>
        hour.levels.every((level) => level.cloudFractionPercent === undefined),
      )
    ) {
      absent.push("levels[].cloudFractionPercent");
    }
  }
  // The smoke family: absence means "not published", never clear air (the
  // contract's own semantics), so a document with no hours[].smoke and no
  // joined smoke statement gets the one family token — the smoke-blind and
  // smoke-carrying analyses stop producing identical caveats (S2 Q5).
  if (!smokeStated && profile.hours.every((hour) => hour.smoke === undefined)) {
    absent.push("smoke");
  }
  if (absent.length > 0) caveats.push({ caveat: "absentQuantities", quantities: absent });

  for (const quantity of ["usableLiftTopM", "boundaryLayerTopM"] as const) {
    const hoursNull = profile.hours.filter(
      (hour) => p50(hour.derived[quantity]) === null,
    ).length;
    if (hoursNull > 0) {
      caveats.push({ caveat: "derivedNullHours", quantity, hoursNull, ofHours: profile.hours.length });
    }
  }

  // The widest gap, not the leading pair's: a document that starts hourly
  // and widens mid-horizon still interpolates timing at its far steps.
  if (context.steps.maxStepHours > 1) {
    caveats.push({ caveat: "stepCadence", stepHours: context.steps.maxStepHours });
  }
  if (timeZoneSource === "utcFallback") caveats.push({ caveat: "timesAreUtc" });

  return { kind: "dataCaveats", caveats };
}

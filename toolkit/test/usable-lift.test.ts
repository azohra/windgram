import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWindgramProfile } from "../src/contract/index.js";
import { p50, usableLiftTopM } from "../src/derive/index.js";
import { buildScene } from "../src/scene/index.js";
import { ensembleSceneProfile } from "./scene-fixtures.js";

/* pipeline-parity.json is genuine pipeline output: a real HRDPS column,
   run back through pipeline/src/windgram/derive.py's derive_windgram_profile (current
   code, unrounded) from its own published surface and column fields — the
   fluxes are published directly, so the document round-trips. Fifteen
   hours: stable nights (null), a growing morning boundary layer, and one
   afternoon hour capped by cloud base (the exact-LCL cloud base sits above
   the sink crossing in the other candidates). */
const fixture = parseWindgramProfile(
  JSON.parse(readFileSync(join(__dirname, "pipeline-parity.json"), "utf-8")),
);

describe("parameterized usable-lift top", () => {
  it("reproduces the pipeline's published value exactly at the default 1.0 m/s", () => {
    expect(fixture).not.toBeNull();
    const { site, hours } = fixture!;
    expect(hours).toHaveLength(15);
    let nonNull = 0;
    for (const hour of hours) {
      const rederived = usableLiftTopM({
        modelElevationM: site.modelElevationM,
        boundaryLayerTopM: p50(hour.derived.boundaryLayerTopM),
        thermalVelocityMs: p50(hour.derived.thermalVelocityMs)!,
        cloudBaseM: p50(hour.derived.cloudBaseM)!,
        levels: hour.levels.map((level) => ({ heightM: p50(level.heightM)! })),
      });
      const published = p50(hour.derived.usableLiftTopM);
      if (published === null) {
        expect(rederived, hour.validAt).toBeNull();
      } else {
        expect(rederived, hour.validAt).not.toBeNull();
        // Float-identical: same constants, same arithmetic, same inputs.
        expect(rederived!, hour.validAt).toBeCloseTo(published, 9);
        nonNull += 1;
      }
    }
    expect(nonNull).toBe(10); // the fixture's soarable hours
  });

  it("covers the cloud-base cap in the real column, not just synthetic data", () => {
    const { hours } = fixture!;
    const capped = hours.filter(
      (hour) =>
        p50(hour.derived.usableLiftTopM) !== null &&
        p50(hour.derived.usableLiftTopM) === p50(hour.derived.cloudBaseM),
    );
    // 2026-08-08T21:00Z: the strongest core still out-climbs the sink rate
    // at the highest retained level below cloud base, so the cap binds.
    expect(capped.length).toBeGreaterThanOrEqual(1);
  });

  it("moves monotonically with the sink rate — a floatier glider climbs higher", () => {
    const { site, hours } = fixture!;
    const hour = hours.find((entry) => p50(entry.derived.usableLiftTopM) !== null)!;
    const inputs = {
      modelElevationM: site.modelElevationM,
      boundaryLayerTopM: p50(hour.derived.boundaryLayerTopM),
      thermalVelocityMs: p50(hour.derived.thermalVelocityMs)!,
      cloudBaseM: p50(hour.derived.cloudBaseM)!,
      levels: hour.levels.map((level) => ({ heightM: p50(level.heightM)! })),
    };
    const floaty = usableLiftTopM(inputs, 0.7)!;
    const standard = usableLiftTopM(inputs, 1.0)!;
    const sinky = usableLiftTopM(inputs, 1.6)!;
    expect(floaty).toBeGreaterThanOrEqual(standard);
    expect(standard).toBeGreaterThanOrEqual(sinky);
  });

  it("returns null when the strongest core cannot beat the sink rate", () => {
    const { site, hours } = fixture!;
    const hour = hours.find((entry) => p50(entry.derived.usableLiftTopM) !== null)!;
    const inputs = {
      modelElevationM: site.modelElevationM,
      boundaryLayerTopM: p50(hour.derived.boundaryLayerTopM),
      thermalVelocityMs: p50(hour.derived.thermalVelocityMs)!,
      cloudBaseM: p50(hour.derived.cloudBaseM)!,
      levels: hour.levels.map((level) => ({ heightM: p50(level.heightM)! })),
    };
    // W* * 2.02 is the pipeline's launch guard: a sink rate above it kills
    // the day outright.
    expect(usableLiftTopM(inputs, inputs.thermalVelocityMs * 2.02 + 0.01)).toBeNull();
    expect(usableLiftTopM({ ...inputs, boundaryLayerTopM: null })).toBeNull();
  });
});

describe("scene option sinkRateMs", () => {
  const TZ = { timeZone: "America/Vancouver" };

  it("at 1.0 the recomputed series equals the published one — the whole scene is unchanged", () => {
    const published = buildScene(fixture!, TZ);
    const recomputed = buildScene(fixture!, { ...TZ, sinkRateMs: 1.0 });
    expect(JSON.stringify(recomputed)).toBe(JSON.stringify(published));
  });

  it("a different sink rate moves the drawn line without touching the published document", () => {
    const usableSeries = (sinkRateMs?: number) =>
      buildScene(fixture!, sinkRateMs === undefined ? TZ : { ...TZ, sinkRateMs }).series.find(
        (entry) => entry.key === "usableLiftTop",
      )!;
    expect(usableSeries(1.6).path).not.toBe(usableSeries().path);
    expect(usableSeries(0.7).path).not.toBe(usableSeries().path);
  });

  it("no-ops for ensemble documents — the published percentile series is kept, not a fabricated p50 rerun", () => {
    const published = buildScene(ensembleSceneProfile(), TZ);
    const requested = buildScene(ensembleSceneProfile(), { ...TZ, sinkRateMs: 0.7 });
    expect(JSON.stringify(requested)).toBe(JSON.stringify(published));
  });
});

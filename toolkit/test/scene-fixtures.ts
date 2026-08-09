import type { EnsembleValue, WindgramHour, WindgramProfile } from "../src/contract/index.js";

/* Real-ish fixture profiles for scene/svg tests: a deterministic morning
   (HRDPS-like, five levels, warming surface, moistening column aloft) and an
   ensemble one (REPS-like: percentile objects, no levels). Values are simple
   linear ramps — no trig, no randomness — so golden SVG fixtures are stable
   everywhere. */

const FLOOR_M = 1072.5;
const LEVEL_PRESSURES = [925, 900, 875, 850, 800];
const LEVEL_HEIGHTS = [1252.4, 1494.1, 1741.6, 1996.2, 2531.7];

function isoHour(startIso: string, offset: number): string {
  return new Date(Date.parse(startIso) + offset * 3_600_000).toISOString().replace(".000Z", "Z");
}

export function deterministicSceneProfile(): WindgramProfile {
  const wStar = [0, 0.4, 0.9, 1.5, 2.0, 2.4, 2.2, 1.8];
  const hours: WindgramHour[] = wStar.map((thermalVelocityMs, h) => {
    // Cool start so the early-morning column crosses 0 degC aloft (the
    // freezing-level isotherm needs something to find).
    const surfaceTemperatureC = 8 + 2 * h;
    return {
      validAt: isoHour("2026-08-09T14:00:00Z", h),
      surface: {
        pressurePa: 101300 - h * 40,
        temperatureC: surfaceTemperatureC,
        dewPointC: surfaceTemperatureC - (10 - h * 0.5),
        windSpeedMs: 1 + h * 0.4,
        windDirectionDeg: 220 + h,
        cloudCoverPercent: 10 + h * 5,
        precipitationMmHr: h < 6 ? 0 : 0.2,
        sensibleHeatFluxWm2: h * 50,
        latentHeatFluxWm2: 60,
      },
      levels: (() => {
        /* Slightly superadiabatic low layers (0.011 degC/m) so the TI
           overlay has negative values to shade, easing toward stable aloft
           for stability-class variety. */
        const layerRates = [0.011, 0.011, 0.008, 0.006, 0.005];
        let previousHeightM = FLOOR_M;
        let temperatureC = surfaceTemperatureC;
        return LEVEL_PRESSURES.map((pressureHpa, i) => {
          const heightM = LEVEL_HEIGHTS[i] + h * 2;
          temperatureC -= (heightM - previousHeightM) * layerRates[i];
          previousHeightM = heightM;
          const depressionC = Math.max(0.2, 8 - i * 2 - h * 0.3);
          return {
            pressureHpa,
            heightM,
            temperatureC,
            dewPointC: temperatureC - depressionC,
            windSpeedMs: 1.5 + i * 1.5 + h * 0.1,
            windDirectionDeg: 200 + i * 15 + h,
            verticalVelocityPaS: -0.4 + i * 0.15,
          };
        });
      })(),
      derived: {
        // BL top and usable lift zigzag so the 1-2-1 kernel is NOT the
        // identity on them (cloud base stays linear, where it is).
        boundaryLayerTopM: h === 0 ? null : 1200 + h * 300 + (h % 2) * 80,
        thermalVelocityMs,
        cloudBaseM: 2600 + h * 150,
        usableLiftTopM: h < 2 ? null : 1400 + h * 280 + (h % 2) * 90,
      },
    };
  });

  return {
    schemaVersion: 1,
    model: "hrdps-continental",
    run: { referenceTime: "2026-08-09T00:00:00Z", generatedAt: "2026-08-09T04:47:14Z" },
    site: {
      id: "dundee",
      name: "Dundee",
      latitude: 49.291977,
      longitude: -117.183569,
      altitudeM: 1485,
      modelElevationM: FLOOR_M,
    },
    hours,
  };
}

function ens(median: number, spread: number, ceiledMembers?: number): EnsembleValue {
  const value: EnsembleValue = {
    members: 21,
    p10: median - 1.5 * spread,
    p25: median - spread,
    p50: median,
    p75: median + spread,
    p90: median + 1.5 * spread,
  };
  if (ceiledMembers !== undefined) value.ceiledMembers = ceiledMembers;
  return value;
}

export function ensembleSceneProfile(): WindgramProfile {
  const hours: WindgramHour[] = Array.from({ length: 6 }, (_, h) => ({
    validAt: isoHour("2026-08-09T16:00:00Z", h),
    surface: {
      pressurePa: ens(101200 - h * 30, 60),
      temperatureC: ens(16 + 2 * h, 0.8),
      dewPointC: ens(6 + h * 0.5, 0.6),
      windSpeedMs: ens(2 + h * 0.5, 0.5),
      windDirectionDeg: ens(240 + h, 8),
      cloudCoverPercent: ens(20 + h * 8, 10),
      precipitationMmHr: ens(0, 0),
      sensibleHeatFluxWm2: ens(80 + h * 40, 25),
      latentHeatFluxWm2: ens(70, 15),
    },
    levels: [], // REPS publishes no levels until its GRIB migration
    derived: {
      boundaryLayerTopM: h === 0 ? null : ens(1400 + h * 320, 180, 0),
      thermalVelocityMs: ens(0.3 + h * 0.35, 0.2),
      cloudBaseM: ens(2500 + h * 120, 220),
      usableLiftTopM: h < 2 ? null : ens(1600 + h * 300, 250, 1),
    },
  }));

  return {
    schemaVersion: 1,
    model: "reps",
    run: { referenceTime: "2026-08-09T00:00:00Z", generatedAt: "2026-08-09T05:58:33Z" },
    site: {
      id: "dundee",
      name: "Dundee",
      latitude: 49.291977,
      longitude: -117.183569,
      altitudeM: 1485,
      modelElevationM: 1573.9,
    },
    hours,
  };
}

/* A science-wave profile (GFS-like): six hours carrying every optional
   field the wave added — gusts, CAPE crossing all four risk classes, CIN
   strong enough to cap two hours, model PBL height, the three cloud
   layers, and per-level cloud fraction on the LAST three hours only, so
   the clouds overlay must switch source per hour. Values are ramps and
   fixed tables — deterministic everywhere. */
export function scienceSceneProfile(): WindgramProfile {
  const capeByHour = [120, 450, 950, 1700, 650, 90];
  const cinByHour = [-5, -80, -15, -120, -30, 0];
  const base = deterministicSceneProfile();
  const hours: WindgramHour[] = capeByHour.map((capeJkg, h) => {
    const template = base.hours[h];
    return {
      ...template,
      surface: {
        ...template.surface,
        windGustMs: 6 + h * 1.5,
        capeJkg,
        cinJkg: cinByHour[h],
        pblHeightM: 400 + h * 350, // AGL: the drawn line adds model elevation
        lowCloudPercent: h * 12,
        midCloudPercent: h < 4 ? 5 + h * 20 : 90,
        highCloudPercent: h === 0 ? 0 : 40,
      },
      levels: template.levels.map((level, index) =>
        h >= 3
          ? { ...level, cloudFractionPercent: index >= 3 ? 90 : 10 }
          : { ...level },
      ),
    };
  });
  return { ...base, model: "gfs", hours };
}

/* A tiny two-hour, two-level column with round numbers for exact hit-testing
   assertions: floor 1000 m, levels at 2000 m and 3000 m. */
export function tinySceneProfile(): WindgramProfile {
  const hour = (validAt: string, surfaceTemperatureC: number): WindgramHour => ({
    validAt,
    surface: {
      pressurePa: 101000,
      temperatureC: surfaceTemperatureC,
      dewPointC: surfaceTemperatureC - 10,
      windSpeedMs: 0,
      windDirectionDeg: 0,
      cloudCoverPercent: 0,
      precipitationMmHr: 0,
      sensibleHeatFluxWm2: 100,
      latentHeatFluxWm2: 50,
    },
    levels: [
      {
        pressureHpa: 850,
        heightM: 2000,
        temperatureC: 10,
        dewPointC: 0,
        windSpeedMs: 10,
        windDirectionDeg: 270,
      },
      {
        pressureHpa: 700,
        heightM: 3000,
        temperatureC: 2,
        dewPointC: -10,
        windSpeedMs: 10,
        windDirectionDeg: 270,
      },
    ],
    derived: {
      boundaryLayerTopM: 2500,
      thermalVelocityMs: 1.5,
      cloudBaseM: 2210,
      usableLiftTopM: 2400,
    },
  });
  return {
    schemaVersion: 1,
    model: "hrdps-continental",
    run: { referenceTime: "2026-08-09T00:00:00Z", generatedAt: "2026-08-09T04:00:00Z" },
    site: {
      id: "tiny",
      name: "Tiny",
      latitude: 49,
      longitude: -117,
      altitudeM: null,
      modelElevationM: 1000,
    },
    hours: [hour("2026-08-09T18:00:00Z", 20), hour("2026-08-09T19:00:00Z", 22)],
  };
}

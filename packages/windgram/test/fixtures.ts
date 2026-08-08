import type {
  EnsembleValue,
  ModelCatalogue,
  WindgramHour,
  WindgramManifest,
  WindgramProfile,
} from "../src/contract/index.js";

/* Hand-built fixtures mirroring the published documents so the contract
   tests exercise the exact published shapes. */

export function deterministicHour(overrides: Partial<WindgramHour> = {}): WindgramHour {
  return {
    validAt: "2026-08-09T00:00:00Z",
    surface: {
      pressurePa: 101071,
      temperatureC: 28.28,
      dewPointC: 4.72,
      windSpeedMs: 1.47,
      windDirectionDeg: 246,
      cloudCoverPercent: 9.2,
      precipitationMmHr: 0,
      sensibleHeatFluxWm2: 310.4,
      latentHeatFluxWm2: 95.1,
    },
    levels: [
      {
        pressureHpa: 875,
        heightM: 1252.4,
        temperatureC: 25.74,
        dewPointC: 2.17,
        windSpeedMs: 2.99,
        windDirectionDeg: 245,
      },
    ],
    derived: {
      boundaryLayerTopM: 3223.1,
      thermalVelocityMs: 1.63,
      cloudBaseM: 4145.1,
      usableLiftTopM: 3585.0,
    },
    ...overrides,
  };
}

export function deterministicProfile(overrides: Partial<WindgramProfile> = {}): WindgramProfile {
  return {
    schemaVersion: 1,
    model: "hrdps-continental",
    run: {
      referenceTime: "2026-08-08T00:00:00Z",
      generatedAt: "2026-08-08T04:47:14Z",
    },
    site: {
      id: "dundee",
      name: "Dundee",
      latitude: 49.291977,
      longitude: -117.183569,
      altitudeM: 1485,
      modelElevationM: 1072.5,
    },
    hours: [deterministicHour()],
    ...overrides,
  };
}

export function ensembleValue(overrides: Partial<EnsembleValue> = {}): EnsembleValue {
  return { members: 21, p10: 0, p25: 0.3, p50: 1.3, p75: 3.7, p90: 9.4, ...overrides };
}

export function ensembleProfile(): WindgramProfile {
  return deterministicProfile({
    model: "reps",
    hours: [
      deterministicHour({
        surface: {
          pressurePa: ensembleValue({ p50: 101121 }),
          temperatureC: ensembleValue({ p50: 21.69 }),
          dewPointC: ensembleValue({ p50: 4.1 }),
          windSpeedMs: ensembleValue({ p50: 1.3 }),
          windDirectionDeg: ensembleValue({ p50: 246 }),
          cloudCoverPercent: ensembleValue({ p50: 6.75 }),
          precipitationMmHr: ensembleValue({ p50: 0 }),
          sensibleHeatFluxWm2: ensembleValue({ p50: 210.4 }),
          latentHeatFluxWm2: ensembleValue({ p50: 80.2 }),
        },
        levels: [], // REPS publishes no levels until its GRIB migration
        derived: {
          boundaryLayerTopM: ensembleValue({ p50: 3556.4, ceiledMembers: 0 }),
          thermalVelocityMs: ensembleValue({ p50: 2.33 }),
          cloudBaseM: ensembleValue({ p50: 3595.0 }),
          usableLiftTopM: ensembleValue({ p50: 3595.0, ceiledMembers: 0 }),
        },
      }),
    ],
  });
}

export function manifest(): WindgramManifest {
  return {
    schemaVersion: 1,
    model: "hrdps-continental",
    referenceTime: "2026-08-08T00:00:00Z",
    generatedAt: "2026-08-08T04:47:14.561Z",
    firstForecastHour: 14,
    lastForecastHour: 48,
    forecastHours: 26,
    sites: [
      { name: "Dundee", slug: "dundee" },
      { name: "Red Mtn", slug: "red-mountain" },
    ],
    stats: {
      durationMs: 129427,
      geoMetRequests: 1406,
      geoMetResponseBytes: 5190709,
      geoMetRetries: 0,
    },
  };
}

export function catalogue(): ModelCatalogue {
  return {
    schemaVersion: 1,
    models: [
      {
        slug: "hrdps-continental",
        label: "HRDPS continental",
        provider: "ECCC",
        gridKm: 2.5,
        stepHours: 1,
        horizonHours: 48,
        runIntervalHours: 6,
        kind: "deterministic",
        experimental: false,
        capabilities: {
          levels: true,
          pressureLevels: [925, 900, 875, 850, 800, 750, 700, 650, 600],
          verticalVelocity: false,
          heatFluxes: true,
          gust: "hourMax",
          cape: true,
          cin: false, // the HRDPS family has CAPE without CIN
          pblHeight: true,
          cloudLayers: false,
          cloudProfile: false,
        },
      },
      {
        slug: "reps",
        label: "REPS",
        provider: "ECCC",
        gridKm: 10,
        stepHours: 1,
        horizonHours: 72,
        runIntervalHours: 6,
        kind: "ensemble",
        experimental: false,
        capabilities: {
          levels: false,
          pressureLevels: [],
          verticalVelocity: false,
          heatFluxes: true,
          gust: false, // REPS carries none of the science-wave families
          cape: false,
          cin: false,
          pblHeight: false,
          cloudLayers: false,
          cloudProfile: false,
        },
      },
    ],
  };
}

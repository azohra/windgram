import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isEnsembleValue,
  modelCatalogueSchema,
  parseModelCatalogue,
  parseModelCatalogueJson,
  parseWindgramManifest,
  parseWindgramManifestJson,
  parseWindgramProfile,
  parseWindgramProfileJson,
  windgramManifestSchema,
  windgramProfileSchema,
} from "../src/contract/index.js";
import {
  catalogue,
  deterministicHour,
  deterministicProfile,
  ensembleProfile,
  ensembleValue,
  manifest,
} from "./fixtures.js";

describe("profile schema", () => {
  it("accepts the spec's deterministic document", () => {
    expect(parseWindgramProfile(deterministicProfile())).not.toBeNull();
  });

  it("accepts ensemble values in every numeric data position", () => {
    const parsed = parseWindgramProfile(ensembleProfile());
    expect(parsed).not.toBeNull();
    const temperature = parsed!.hours[0].surface.temperatureC;
    expect(isEnsembleValue(temperature)).toBe(true);
  });

  it("accepts an ensemble value in a level position", () => {
    const profile = deterministicProfile({
      hours: [
        deterministicHour({
          levels: [
            {
              pressureHpa: 875,
              heightM: ensembleValue({ p50: 1250 }),
              temperatureC: ensembleValue({ p50: 20 }),
              dewPointC: ensembleValue({ p50: 2 }),
              windSpeedMs: ensembleValue({ p50: 3 }),
              windDirectionDeg: ensembleValue({ p50: 245 }),
            },
          ],
        }),
      ],
    });
    expect(parseWindgramProfile(profile)).not.toBeNull();
  });

  it("accepts the optional verticalVelocityPaS and ceiledMembers fields", () => {
    const profile = deterministicProfile({
      hours: [
        deterministicHour({
          levels: [
            {
              pressureHpa: 875,
              heightM: 1252.4,
              temperatureC: 25.74,
              dewPointC: 2.17,
              windSpeedMs: 2.99,
              windDirectionDeg: 245,
              verticalVelocityPaS: -0.31,
            },
          ],
          derived: {
            boundaryLayerTopM: ensembleValue({ ceiledMembers: 3 }),
            thermalVelocityMs: 1.63,
            cloudBaseM: 4145.1,
            usableLiftTopM: null,
          },
        }),
      ],
    });
    expect(parseWindgramProfile(profile)).not.toBeNull();
  });

  it("accepts null boundary-layer top and usable-lift top, and null site altitude", () => {
    const profile = deterministicProfile({
      site: { ...deterministicProfile().site, altitudeM: null },
      hours: [
        deterministicHour({
          derived: {
            boundaryLayerTopM: null,
            thermalVelocityMs: 0,
            cloudBaseM: 1500,
            usableLiftTopM: null,
          },
        }),
      ],
    });
    expect(parseWindgramProfile(profile)).not.toBeNull();
  });

  it("accepts every optional science-wave surface field — schemaVersion stays 1", () => {
    const hour = deterministicHour();
    const profile = deterministicProfile({
      hours: [
        {
          ...hour,
          surface: {
            ...hour.surface,
            windGustMs: 11.44,
            capeJkg: 851,
            cinJkg: -56,
            pblHeightM: 1650.4,
            lowCloudPercent: 62,
            midCloudPercent: 18,
            highCloudPercent: 4,
          },
        },
      ],
    });
    const parsed = parseWindgramProfile(profile);
    expect(parsed).not.toBeNull();
    expect(parsed!.schemaVersion).toBe(1); // additive optional fields are not a break
    expect(parsed!.hours[0].surface.capeJkg).toBe(851);
  });

  it("accepts a per-level cloud fraction and an ensemble gust", () => {
    const hour = deterministicHour();
    const profile = deterministicProfile({
      hours: [
        {
          ...hour,
          surface: { ...hour.surface, windGustMs: ensembleValue({ p50: 9.4 }) },
          levels: [{ ...hour.levels[0], cloudFractionPercent: 85 }],
        },
      ],
    });
    const parsed = parseWindgramProfile(profile);
    expect(parsed).not.toBeNull();
    expect(parsed!.hours[0].levels[0].cloudFractionPercent).toBe(85);
  });

  it("still accepts pre-wave documents that omit every science field", () => {
    expect(parseWindgramProfile(deterministicProfile())).not.toBeNull();
  });

  it("rejects other schema versions", () => {
    expect(parseWindgramProfile({ ...deterministicProfile(), schemaVersion: 2 })).toBeNull();
  });

  it("rejects prose model names — identity is the slug", () => {
    expect(
      parseWindgramProfile({ ...deterministicProfile(), model: "HRDPS continental 2.5 km" }),
    ).toBeNull();
  });

  it("accepts any well-formed slug — there is no model enum", () => {
    expect(
      parseWindgramProfile({ ...deterministicProfile(), model: "icon-d2-2km" }),
    ).not.toBeNull();
  });

  it("rejects a truncated ensemble value", () => {
    const { p50: _dropped, ...partial } = ensembleValue();
    const profile = deterministicProfile({
      hours: [
        deterministicHour({
          surface: { ...deterministicHour().surface, temperatureC: partial as never },
        }),
      ],
    });
    expect(parseWindgramProfile(profile)).toBeNull();
  });

  it("rejects timestamps without a Z suffix", () => {
    const profile = deterministicProfile();
    profile.hours[0].validAt = "2026-08-09T00:00:00";
    expect(parseWindgramProfile(profile)).toBeNull();
  });

  it("guards the stored-JSON boundary like parseStoredWindgram", () => {
    expect(parseWindgramProfileJson(JSON.stringify(deterministicProfile()))).not.toBeNull();
    expect(parseWindgramProfileJson("not json")).toBeNull();
    expect(parseWindgramProfileJson("{}")).toBeNull();
  });
});

describe("manifest schema", () => {
  it("accepts a manifest with transport-specific stats", () => {
    expect(parseWindgramManifest(manifest())).not.toBeNull();
  });

  it("accepts an ensemble manifest with memberCount", () => {
    expect(parseWindgramManifest({ ...manifest(), model: "reps", memberCount: 21 })).not.toBeNull();
  });

  it("rejects a manifest without schemaVersion", () => {
    const { schemaVersion: _dropped, ...unversioned } = manifest();
    expect(parseWindgramManifest(unversioned)).toBeNull();
  });

  it("parses from a stored string", () => {
    expect(parseWindgramManifestJson(JSON.stringify(manifest()))).not.toBeNull();
    expect(parseWindgramManifestJson("[")).toBeNull();
  });
});

describe("models.json schema", () => {
  it("accepts the catalogue", () => {
    const parsed = parseModelCatalogue(catalogue());
    expect(parsed).not.toBeNull();
    expect(parsed!.models.map((model) => model.slug)).toEqual(["hrdps-continental", "reps"]);
  });

  it("rejects an unknown kind", () => {
    const bad = catalogue();
    (bad.models[0] as { kind: string }).kind = "nowcast";
    expect(parseModelCatalogue(bad)).toBeNull();
  });

  it("parses from a stored string", () => {
    expect(parseModelCatalogueJson(JSON.stringify(catalogue()))).not.toBeNull();
  });

  it("types gust as a semantics declaration, not a boolean", () => {
    const bad = catalogue();
    (bad.models[0].capabilities as { gust: unknown }).gust = true; // presence without meaning
    expect(parseModelCatalogue(bad)).toBeNull();
    (bad.models[0].capabilities as { gust: unknown }).gust = "hourlyMax"; // not a known semantic
    expect(parseModelCatalogue(bad)).toBeNull();
    (bad.models[0].capabilities as { gust: unknown }).gust = "instant";
    expect(parseModelCatalogue(bad)).not.toBeNull();
  });

  it("types verticalVelocity as a provenance declaration, not a boolean", () => {
    const bad = catalogue();
    const capabilities = bad.models[0].capabilities as { verticalVelocity: unknown };
    capabilities.verticalVelocity = true; // presence without provenance
    expect(parseModelCatalogue(bad)).toBeNull();
    capabilities.verticalVelocity = "w"; // not a known provenance
    expect(parseModelCatalogue(bad)).toBeNull();
    capabilities.verticalVelocity = "omega"; // the provider's own published omega
    expect(parseModelCatalogue(bad)).not.toBeNull();
    capabilities.verticalVelocity = "fromGeometricW"; // converted at build via omega ≈ −ρgw
    expect(parseModelCatalogue(bad)).not.toBeNull();
  });

  it("carries an optional sunset notice with a nullable successor", () => {
    const entry = catalogue();
    const model = entry.models[0] as { sunset?: unknown };
    model.sunset = { date: "2026-10-06", successor: "rrfs" };
    expect(parseModelCatalogue(entry)).not.toBeNull();
    model.sunset = { date: "2026-10-06", successor: null }; // end-of-life, no replacement
    expect(parseModelCatalogue(entry)).not.toBeNull();
    model.sunset = { date: "October 6, 2026", successor: null }; // not a calendar date
    expect(parseModelCatalogue(entry)).toBeNull();
    model.sunset = { date: "2026-10-06" }; // successor must be stated, null when none
    expect(parseModelCatalogue(entry)).toBeNull();
    delete model.sunset; // absent = no announced retirement
    expect(parseModelCatalogue(entry)).not.toBeNull();
  });

  it("carries the run cadence, optional for entries predating the field", () => {
    const parsed = parseModelCatalogue(catalogue());
    expect(parsed!.models[0].runIntervalHours).toBe(6);
    const legacy = catalogue();
    delete (legacy.models[0] as { runIntervalHours?: number }).runIntervalHours;
    const reparsed = parseModelCatalogue(legacy);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.models[0].runIntervalHours).toBeUndefined();
  });

  it("represents CAPE without CIN — the HRDPS family's real shape", () => {
    const parsed = parseModelCatalogue(catalogue());
    const hrdps = parsed!.models.find((model) => model.slug === "hrdps-continental")!;
    expect(hrdps.capabilities.cape).toBe(true);
    expect(hrdps.capabilities.cin).toBe(false);
  });

  it("accepts the repository's actual data/models.json", () => {
    const raw = readFileSync(join(__dirname, "..", "..", "..", "data", "models.json"), "utf-8");
    const parsed = parseModelCatalogueJson(raw);
    expect(parsed).not.toBeNull();
    // The one profile-capable gap the research verified: REPS carries none
    // of the four science families.
    const reps = parsed!.models.find((model) => model.slug === "reps")!;
    expect(reps.capabilities.gust).toBe(false);
    expect(reps.capabilities.cape).toBe(false);
    // And the only cloud profile is GFS's.
    const withProfile = parsed!.models.filter((model) => model.capabilities.cloudProfile);
    expect(withProfile.map((model) => model.slug)).toEqual(["gfs"]);
    // Omega models declare which levels actually carry it, as a subset of
    // their published level set; non-omega models stay silent — absence
    // means "no omega anywhere", never an unknown.
    for (const model of parsed!.models) {
      const levels = model.capabilities.verticalVelocityLevels;
      if (model.capabilities.verticalVelocity) {
        expect(levels, model.slug).toBeDefined();
        expect(levels!.length, model.slug).toBeGreaterThan(0);
        for (const level of levels!) {
          expect(model.capabilities.pressureLevels, model.slug).toContain(level);
        }
      } else {
        expect(levels, model.slug).toBeUndefined();
      }
    }
    // The ECCC deterministic trio publishes its own omega — the provenance
    // token records that, not just presence.
    for (const slug of ["hrdps-continental", "rdps", "gdps"]) {
      const entry = parsed!.models.find((model) => model.slug === slug)!;
      expect(entry.capabilities.verticalVelocity, slug).toBe("omega");
    }
    // Every model the site's freshness display covers declares its cadence.
    const hrdps = parsed!.models.find((model) => model.slug === "hrdps-continental")!;
    expect(hrdps.runIntervalHours).toBe(6);
  });
});

describe("JSON Schema generation", () => {
  it("converts every published schema without throwing", () => {
    for (const schema of [windgramProfileSchema, windgramManifestSchema, modelCatalogueSchema]) {
      const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" });
      expect(jsonSchema).toHaveProperty("type", "object");
    }
  });
});

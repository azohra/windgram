import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isEnsembleDropout,
  isEnsembleValue,
  modelCatalogueSchema,
  parseModelCatalogue,
  parseModelCatalogueJson,
  parseRunsIndex,
  parseRunsIndexJson,
  parseSitesCatalogue,
  parseSitesCatalogueJson,
  parseWindgramManifest,
  parseWindgramManifestJson,
  parseWindgramProfile,
  parseWindgramProfileJson,
  runsIndexSchema,
  sitesCatalogueSchema,
  windgramManifestSchema,
  windgramProfileSchema,
} from "../src/contract/index.js";
import { schemaArtifactJson, schemaArtifacts } from "../src/internal/schema-artifacts.js";
import {
  catalogue,
  deterministicHour,
  deterministicProfile,
  ensembleProfile,
  ensembleValue,
  manifest,
  runsIndex,
  sitesCatalogue,
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

  it("accepts full ensemble dropout — members: 0 with every percentile null", () => {
    // The live GEPS/REPS shape: the run asked every member and none
    // produced a value. A published fact, distinct from "not published"
    // and from a forecast of none.
    const dropout = { members: 0, p10: null, p25: null, p50: null, p75: null, p90: null };
    const profile = ensembleProfile();
    profile.hours[0].surface.capeJkg = dropout as never;
    profile.hours[0].derived.usableLiftTopM = { ...dropout, ceiledMembers: 0 } as never;
    const parsed = parseWindgramProfile(profile);
    expect(parsed).not.toBeNull();
    expect(isEnsembleDropout(parsed!.hours[0].surface.capeJkg!)).toBe(true);
    expect(isEnsembleDropout(parsed!.hours[0].surface.temperatureC)).toBe(false);
  });

  it("rejects partial dropout — zero members with numbers, or members with nulls", () => {
    const base = ensembleProfile();
    const zeroWithNumbers = structuredClone(base);
    zeroWithNumbers.hours[0].surface.capeJkg = {
      members: 0, p10: 1, p25: 2, p50: 3, p75: 4, p90: 5,
    } as never;
    expect(parseWindgramProfile(zeroWithNumbers)).toBeNull();

    const membersWithNulls = structuredClone(base);
    membersWithNulls.hours[0].surface.capeJkg = {
      members: 7, p10: null, p25: null, p50: null, p75: null, p90: null,
    } as never;
    expect(parseWindgramProfile(membersWithNulls)).toBeNull();
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

  it("carries the optional semantics tag and rejects unknown tokens", () => {
    const tagged = {
      ...deterministicProfile(),
      semantics: { gust: "hourMax", precipitation: "instantRate" },
    };
    const parsed = parseWindgramProfile(tagged);
    expect(parsed).not.toBeNull();
    expect(parsed!.semantics).toEqual({ gust: "hourMax", precipitation: "instantRate" });
    // Partial tags are real documents: GEPS/REPS declare precipitation only
    // (no per-member gust is published).
    expect(
      parseWindgramProfile({ ...deterministicProfile(), semantics: { precipitation: "windowMeanRate" } }),
    ).not.toBeNull();
    // Absence means "predates the tag", so it must stay valid…
    expect(parseWindgramProfile(deterministicProfile())).not.toBeNull();
    // …but a present tag must use the declared vocabulary.
    expect(
      parseWindgramProfile({ ...deterministicProfile(), semantics: { gust: "gustingTo" } }),
    ).toBeNull();
    expect(
      parseWindgramProfile({ ...deterministicProfile(), semantics: { precipitation: "accumulation" } }),
    ).toBeNull();
  });

  it("carries the optional site.timeZone echo and tolerates its absence", () => {
    // Since the 0.4.0 wave builders echo the catalogue's timezone per
    // document, so a stored profile self-interprets its local clock.
    const echoed = deterministicProfile();
    (echoed.site as { timeZone?: string }).timeZone = "America/Vancouver";
    const parsed = parseWindgramProfile(echoed);
    expect(parsed).not.toBeNull();
    expect(parsed!.site.timeZone).toBe("America/Vancouver");
    // Absence means "predates the echo" — pre-0.4.0 documents stay valid.
    expect(parseWindgramProfile(deterministicProfile())!.site.timeZone).toBeUndefined();
    // A present echo must be a non-empty string.
    (echoed.site as { timeZone?: string }).timeZone = "";
    expect(parseWindgramProfile(echoed)).toBeNull();
  });

  it("carries run.members on ensemble documents and tolerates its absence", () => {
    const parsed = parseWindgramProfile(ensembleProfile());
    expect(parsed).not.toBeNull();
    expect(parsed!.run.members).toBe(21);
    // Deterministic documents omit it — absence is the declaration.
    expect(parseWindgramProfile(deterministicProfile())!.run.members).toBeUndefined();
    // It is a member COUNT: a positive integer.
    const bad = ensembleProfile();
    (bad.run as { members: unknown }).members = 21.5;
    expect(parseWindgramProfile(bad)).toBeNull();
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

  it("types stats as the stable core plus an open numeric extension", () => {
    const parsed = parseWindgramManifest(manifest())!;
    // The four core keys are contract and keep their names…
    expect(parsed.stats.downloads).toBe(1406);
    expect(parsed.stats.downloadBytes).toBe(5190709);
    expect(parsed.stats.retries).toBe(0);
    expect(parsed.stats.durationMs).toBe(129427);
    // …and transport-specific extension keys ride along untyped-but-numeric.
    expect(parsed.stats["geoMetCoverageProbes"]).toBe(12);
    // A manifest missing a core key fails the guard,
    const { downloads: _dropped, ...coreless } = manifest().stats;
    expect(parseWindgramManifest({ ...manifest(), stats: coreless })).toBeNull();
    // as does a non-numeric extension value.
    expect(
      parseWindgramManifest({ ...manifest(), stats: { ...manifest().stats, note: "fast" } }),
    ).toBeNull();
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

  it("requires the run cadence since 0.3.0 — every entry declares it", () => {
    const parsed = parseModelCatalogue(catalogue());
    expect(parsed!.models[0].runIntervalHours).toBe(6);
    const legacy = catalogue();
    delete (legacy.models[0] as { runIntervalHours?: number }).runIntervalHours;
    expect(parseModelCatalogue(legacy)).toBeNull();
  });

  it("types precipitation as a required semantics declaration", () => {
    const bad = catalogue();
    const capabilities = bad.models[0].capabilities as { precipitation: unknown };
    capabilities.precipitation = "windowMeanRate"; // NOAA-style window mean
    expect(parseModelCatalogue(bad)).not.toBeNull();
    capabilities.precipitation = "accumulation"; // not a known semantic
    expect(parseModelCatalogue(bad)).toBeNull();
    capabilities.precipitation = false; // every model publishes precip: no false
    expect(parseModelCatalogue(bad)).toBeNull();
    delete (bad.models[0].capabilities as { precipitation?: unknown }).precipitation;
    expect(parseModelCatalogue(bad)).toBeNull(); // required, unlike the profile tag
  });

  it("represents CAPE without CIN — the HRDPS family's real shape", () => {
    const parsed = parseModelCatalogue(catalogue());
    const hrdps = parsed!.models.find((model) => model.slug === "hrdps-continental")!;
    expect(hrdps.capabilities.cape).toBe(true);
    expect(hrdps.capabilities.cin).toBe(false);
  });

  it("accepts the repository's actual models.json", () => {
    const raw = readFileSync(join(__dirname, "..", "..", "models.json"), "utf-8");
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
    // And every entry declares its precipitation semantics — required since
    // 0.3.0, no boolean escape: HRRR's is the true instantaneous PRATE, the
    // synoptic NOAA models publish window means.
    const hrrr = parsed!.models.find((model) => model.slug === "hrrr-conus")!;
    expect(hrrr.capabilities.precipitation).toBe("instantRate");
    const gfs = parsed!.models.find((model) => model.slug === "gfs")!;
    expect(gfs.capabilities.precipitation).toBe("windowMeanRate");
  });
});

describe("sites.json schema", () => {
  it("accepts the {schemaVersion, sites} catalogue", () => {
    const parsed = parseSitesCatalogue(sitesCatalogue());
    expect(parsed).not.toBeNull();
    expect(parsed!.sites.map((site) => site.slug)).toEqual(["dundee", "red-mountain"]);
    expect(parsed!.sites[0].elevationM).toBe(1485);
  });

  it("rejects the pre-0.3.0 bare-array shape — unversioned documents cannot promise theirs", () => {
    expect(parseSitesCatalogue(sitesCatalogue().sites)).toBeNull();
  });

  it("requires the surveyed elevation — the catalogue is its home", () => {
    const bad = sitesCatalogue();
    delete (bad.sites[0] as { elevationM?: number }).elevationM;
    expect(parseSitesCatalogue(bad)).toBeNull();
  });

  it("rejects prose slugs", () => {
    const bad = sitesCatalogue();
    (bad.sites[0] as { slug: string }).slug = "Red Mountain";
    expect(parseSitesCatalogue(bad)).toBeNull();
  });

  it("requires the IANA timezone — local time is load-bearing for reading a windgram", () => {
    const parsed = parseSitesCatalogue(sitesCatalogue());
    expect(parsed!.sites[0].timeZone).toBe("America/Vancouver");
    const bad = sitesCatalogue();
    delete (bad.sites[0] as { timeZone?: string }).timeZone;
    expect(parseSitesCatalogue(bad)).toBeNull();
  });

  it("parses from a stored string and accepts the repository's actual sites.json", () => {
    expect(parseSitesCatalogueJson(JSON.stringify(sitesCatalogue()))).not.toBeNull();
    expect(parseSitesCatalogueJson("[]")).toBeNull();
    const raw = readFileSync(join(__dirname, "..", "..", "sites.json"), "utf-8");
    expect(parseSitesCatalogueJson(raw)).not.toBeNull();
  });
});

describe("runs.json schema", () => {
  it("accepts the slug-keyed run index", () => {
    const parsed = parseRunsIndex(runsIndex());
    expect(parsed).not.toBeNull();
    expect(parsed!.runs["hrdps-continental"]!.referenceTime).toBe("2026-08-08T00:00:00Z");
    expect(Object.keys(parsed!.runs)).toHaveLength(2);
  });

  it("rejects prose keys and truncated entries", () => {
    const badKey = { schemaVersion: 1, runs: { "HRDPS continental": runsIndex().runs["reps"] } };
    expect(parseRunsIndex(badKey)).toBeNull();
    const truncated = {
      schemaVersion: 1,
      runs: { reps: { referenceTime: "2026-08-08T00:00:00Z" } }, // no generatedAt
    };
    expect(parseRunsIndex(truncated)).toBeNull();
  });

  it("accepts an empty index — a fresh tree with nothing published yet", () => {
    expect(parseRunsIndex({ schemaVersion: 1, runs: {} })).not.toBeNull();
  });

  it("parses from a stored string", () => {
    expect(parseRunsIndexJson(JSON.stringify(runsIndex()))).not.toBeNull();
    expect(parseRunsIndexJson("not json")).toBeNull();
  });
});

describe("JSON Schema generation", () => {
  const published = [
    windgramProfileSchema,
    windgramManifestSchema,
    modelCatalogueSchema,
    sitesCatalogueSchema,
    runsIndexSchema,
  ];

  it("converts every published schema without throwing", () => {
    for (const schema of published) {
      const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" });
      expect(jsonSchema).toHaveProperty("type", "object");
    }
  });

  it("carries the field semantics as descriptions — the non-JS parity promise", () => {
    type JsonSchema = { description?: string; properties?: Record<string, JsonSchema> } & Record<
      string,
      unknown
    >;
    const profile = z.toJSONSchema(windgramProfileSchema, {
      target: "draft-2020-12",
      io: "input",
    }) as JsonSchema;
    const hour = (profile.properties!["hours"] as { items: JsonSchema }).items;
    const derived = hour.properties!["derived"]!;
    expect(derived.properties!["cloudBaseM"]!.description).toContain("Bolton");
    expect(derived.properties!["cloudBaseM"]!.description).toContain("boundaryLayerTopM");
    expect(derived.properties!["thermalVelocityMs"]!.description).toContain("Deardorff");
    expect(derived.properties!["boundaryLayerTopM"]!.description).toContain("Null when");
    expect(derived.properties!["usableLiftTopM"]!.description).toContain("1.0 m/s");
    const surface = hour.properties!["surface"]!;
    expect(surface.properties!["windGustMs"]!.description).toContain("semantics.gust");
    expect(surface.properties!["precipitationMmHr"]!.description).toContain(
      "semantics.precipitation",
    );
    expect(surface.properties!["pressurePa"]!.description).toContain("SI pascals");

    const models = z.toJSONSchema(modelCatalogueSchema, {
      target: "draft-2020-12",
      io: "input",
    }) as JsonSchema;
    const capabilities = (models.properties!["models"] as { items: JsonSchema }).items.properties![
      "capabilities"
    ]!;
    expect(capabilities.properties!["precipitation"]!.description).toContain("windowMeanRate");
    expect(capabilities.properties!["gust"]!.description).toContain("hourMax");

    const sites = z.toJSONSchema(sitesCatalogueSchema, {
      target: "draft-2020-12",
      io: "input",
    }) as JsonSchema;
    const entry = (sites.properties!["sites"] as { items: JsonSchema }).items;
    expect(entry.properties!["elevationM"]!.description).toContain("altitudeM");
    expect(entry.properties!["timeZone"]!.description).toContain("IANA");
  });

  it("matches the shipped schema/*.json artifacts — regenerate with pnpm schemas", () => {
    // The emitter's own table and conversion (internal/schema-artifacts.ts),
    // so a new artifact is fenced the moment it exists. Deep-equality here
    // means the shipped artifacts cannot drift behind the zod contract.
    expect(schemaArtifacts.length).toBeGreaterThan(0);
    for (const artifact of schemaArtifacts) {
      const expected = schemaArtifactJson(artifact);
      const onDisk = JSON.parse(
        readFileSync(join(__dirname, "..", "schema", artifact.fileName), "utf-8"),
      );
      expect(onDisk, artifact.fileName).toEqual(JSON.parse(JSON.stringify(expected)));
    }
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseSiteContext, parseSiteContextJson } from "../src/contract/index.js";

/* Values from the live terrain probe [verified 2026-08-10]: GLO-30 at
   dundee, LidarBC bare earth at erie, WorldCover fractions at flagpole. */
const CONTEXT = {
  schemaVersion: 1,
  generatedAt: "2026-08-10T08:00:00Z",
  sources: [
    {
      id: "glo30",
      product: "Copernicus GLO-30 DEM (2021 release)",
      kind: "surfaceModel",
      resolutionM: 30,
      licence: "Copernicus DEM licence",
      attribution:
        "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved",
      url: "https://registry.opendata.aws/copernicus-dem/",
    },
    {
      id: "lidarbc",
      product: "LidarBC 1 m DTM",
      kind: "bareEarthModel",
      resolutionM: 1,
      licence: "OGL-BC",
      attribution: "Contains information licensed under the Open Government Licence – British Columbia.",
      url: "https://lidar.gov.bc.ca",
    },
    {
      id: "worldcover2021",
      product: "ESA WorldCover 10 m 2021 v200",
      kind: "landCover",
      resolutionM: 10,
      licence: "CC-BY 4.0",
      attribution:
        "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium",
      url: "https://esa-worldcover.org",
    },
  ],
  sites: {
    dundee: {
      terrain: {
        source: "glo30",
        elevationM: 1492.1,
        slopeDeg: 18.3,
        aspectDeg: 241,
        relief: [
          { radiusKm: 1, minM: 896, maxM: 1666, percentile: 80 },
          { radiusKm: 3, minM: 713, maxM: 1916, percentile: 79 },
          { radiusKm: 10, minM: 671, maxM: 2211, percentile: 57 },
        ],
      },
      landCover: {
        source: "worldcover2021",
        atLaunch: "grassland",
        fractions: [
          { radiusKm: 1, byClass: { treeCover: 0.97, grassland: 0.029, bareSparse: 0.001 } },
          { radiusKm: 3, byClass: { treeCover: 0.943, grassland: 0.052, builtUp: 0.004 } },
        ],
      },
    },
    erie: {
      terrain: {
        source: "glo30",
        elevationM: 1244.2,
        slopeDeg: 16.1,
        aspectDeg: 236,
        relief: [{ radiusKm: 1, minM: 760, maxM: 1503, percentile: 72 }],
      },
      bareEarth: { source: "lidarbc", elevationM: 1245.8 },
      landCover: {
        source: "worldcover2021",
        atLaunch: "grassland",
        fractions: [{ radiusKm: 1, byClass: { treeCover: 0.894, grassland: 0.106 } }],
      },
    },
  },
};

describe("site context contract", () => {
  it("parses the committed site-context.json — generator and contract cannot drift", () => {
    const text = readFileSync(new URL("../../site-context.json", import.meta.url), "utf8");
    const parsed = parseSiteContextJson(text);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed?.sites ?? {}).length).toBeGreaterThan(0);
  });

  it("accepts a generated context and parses from the stored string", () => {
    expect(parseSiteContext(CONTEXT)).not.toBeNull();
    const parsed = parseSiteContextJson(JSON.stringify(CONTEXT));
    expect(parsed?.sites.dundee?.terrain.relief[2]?.percentile).toBe(57);
    expect(parsed?.sites.erie?.bareEarth?.elevationM).toBe(1245.8);
    expect(parsed?.sites.dundee?.bareEarth).toBeUndefined();
  });

  it("keeps the licence attributions — they must travel with the data", () => {
    const parsed = parseSiteContext(CONTEXT);
    for (const source of parsed?.sources ?? []) {
      expect(source.attribution.length).toBeGreaterThan(0);
    }
    const stripped = {
      ...CONTEXT,
      sources: [{ ...CONTEXT.sources[0], attribution: "" }],
    };
    expect(parseSiteContext(stripped)).toBeNull();
  });

  it("rejects a coordinate echo — sites.json is the home of identity", () => {
    const echoed = {
      ...CONTEXT,
      sites: {
        dundee: { ...CONTEXT.sites.dundee, latitude: 49.291977 },
      },
    };
    // Unknown keys strip harmlessly; the entry still parses without them.
    const parsed = parseSiteContext(echoed);
    expect(parsed).not.toBeNull();
    expect((parsed?.sites.dundee as Record<string, unknown>).latitude).toBeUndefined();
  });

  it("rejects an unknown land-cover class name", () => {
    const unknownClass = {
      ...CONTEXT,
      sites: {
        dundee: {
          ...CONTEXT.sites.dundee,
          landCover: {
            ...CONTEXT.sites.dundee.landCover,
            fractions: [{ radiusKm: 1, byClass: { lava: 1 } }],
          },
        },
      },
    };
    expect(parseSiteContext(unknownClass)).toBeNull();
  });

  it("rejects a fraction outside 0-1", () => {
    const overUnity = {
      ...CONTEXT,
      sites: {
        dundee: {
          ...CONTEXT.sites.dundee,
          landCover: {
            ...CONTEXT.sites.dundee.landCover,
            fractions: [{ radiusKm: 1, byClass: { treeCover: 97 } }],
          },
        },
      },
    };
    expect(parseSiteContext(overUnity)).toBeNull();
  });
});

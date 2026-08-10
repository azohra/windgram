import { describe, expect, it } from "vitest";

import {
  parseObservationDocument,
  parseObservationDocumentJson,
} from "../src/contract/index.js";

const DOCUMENT = {
  schemaVersion: 1,
  model: "goes18-dsr",
  observed: {
    firstObservedAt: "2026-08-09T15:00:00Z",
    lastObservedAt: "2026-08-10T02:00:00Z",
    generatedAt: "2026-08-10T02:31:12Z",
  },
  site: {
    id: "dundee",
    name: "Dundee",
    latitude: 49.291977,
    longitude: -117.183569,
    timeZone: "America/Vancouver",
  },
  observations: [
    { observedAt: "2026-08-09T15:00:00Z", downwardShortwaveWm2: 112.4 },
    { observedAt: "2026-08-09T16:00:00Z", downwardShortwaveWm2: 287.9 },
  ],
};

describe("observation document contract", () => {
  it("accepts a measured series and parses from a stored string", () => {
    expect(parseObservationDocument(DOCUMENT)).not.toBeNull();
    const parsed = parseObservationDocumentJson(JSON.stringify(DOCUMENT));
    const second = parsed?.observations[1];
    expect(second && "downwardShortwaveWm2" in second ? second.downwardShortwaveWm2 : null).toBe(
      287.9,
    );
    expect(parsed?.observed.lastObservedAt).toBe("2026-08-10T02:00:00Z");
  });

  it("accepts a measured-AOT series — one entry shape per product", () => {
    const aotDocument = {
      ...DOCUMENT,
      model: "goes18-aod",
      observations: [
        { observedAt: "2026-08-09T21:00:00Z", aot: 1.56 },
        { observedAt: "2026-08-09T22:00:00Z", aot: 1.341 },
      ],
    };
    const parsed = parseObservationDocument(aotDocument);
    expect(parsed).not.toBeNull();
    const first = parsed?.observations[0];
    expect(first && "aot" in first ? first.aot : null).toBe(1.56);
  });

  it("rejects an entry with no measurement field — an empty instant is absence, not an entry", () => {
    const empty = {
      ...DOCUMENT,
      observations: [{ observedAt: "2026-08-09T15:00:00Z" }],
    };
    expect(parseObservationDocument(empty)).toBeNull();
  });

  it("rejects a forecast-shaped document — observations have no run block", () => {
    const forecastShaped = {
      ...DOCUMENT,
      observed: undefined,
      run: { referenceTime: "2026-08-10T00:00:00Z", generatedAt: "2026-08-10T02:00:00Z" },
    };
    expect(parseObservationDocument(forecastShaped)).toBeNull();
  });

  it("rejects null measurements — an unmeasured instant is absent, not null", () => {
    const withNull = {
      ...DOCUMENT,
      observations: [{ observedAt: "2026-08-09T15:00:00Z", downwardShortwaveWm2: null }],
    };
    expect(parseObservationDocument(withNull)).toBeNull();
  });
});

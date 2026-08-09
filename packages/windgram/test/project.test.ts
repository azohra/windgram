import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWindgramProfile, type WindgramProfile } from "../src/contract/index.js";
import { projectProfile } from "../src/derive/project.js";

const fixtures = JSON.parse(
  readFileSync(join(__dirname, "analyze-fixtures.json"), "utf-8"),
) as Record<string, unknown>;

function hrrr(): WindgramProfile {
  const profile = parseWindgramProfile(fixtures["hrrrConusErie"]);
  expect(profile).not.toBeNull();
  return profile!;
}

describe("projectProfile", () => {
  it("returns a structural copy with no options — and it still passes the contract", () => {
    const projected = projectProfile(hrrr());
    expect(projected).toEqual(hrrr());
    expect(parseWindgramProfile(projected)).not.toBeNull();
  });

  it("windows to one local day in the document's own timezone", () => {
    const projected = projectProfile(hrrr(), { day: "2026-08-08" });
    // The trimmed run starts 19:00Z = 12:00 Pacific daylight time; local
    // Aug 8 runs through 06:59Z, so 12 of the 24 hours survive.
    expect(projected.hours).toHaveLength(12);
    expect(projected.hours[0].validAt).toBe("2026-08-08T19:00:00Z");
    expect(projected.hours[11].validAt).toBe("2026-08-09T06:00:00Z");
    // The envelope is untouched — the projection stays self-interpreting.
    expect(projected.model).toBe("hrrr-conus");
    expect(projected.site.timeZone).toBe("America/Vancouver");
  });

  it("windows in a caller-supplied timezone override", () => {
    const utc = projectProfile(hrrr(), { day: "2026-08-08", timeZone: "UTC" });
    expect(utc.hours).toHaveLength(5); // 19:00Z through 23:00Z
  });

  it("throws rather than guessing a timezone for day windowing", () => {
    const undeclared = hrrr();
    delete (undeclared.site as { timeZone?: string }).timeZone;
    expect(() => projectProfile(undeclared, { day: "2026-08-08" })).toThrow(/timeZone/);
    // Without a day there is nothing to window, so no zone is needed.
    expect(() => projectProfile(undeclared)).not.toThrow();
  });

  it("strips levels — the single biggest subtraction — leaving a contract-valid document", () => {
    const projected = projectProfile(hrrr(), { dropLevels: true });
    expect(projected.hours.every((hour) => hour.levels.length === 0)).toBe(true);
    expect(parseWindgramProfile(projected)).not.toBeNull();
    const before = JSON.stringify(hrrr()).length;
    const after = JSON.stringify(projected).length;
    expect(after).toBeLessThan(before / 2);
  });

  it("selects field subsets per block, keeping validAt and only the asked-for values", () => {
    const projected = projectProfile(hrrr(), {
      day: "2026-08-08",
      dropLevels: true,
      fields: {
        surface: ["windSpeedMs", "windGustMs", "precipitationMmHr"],
        derived: ["usableLiftTopM", "thermalVelocityMs"],
      },
    });
    const hour = projected.hours[0];
    expect(Object.keys(hour.surface).sort()).toEqual([
      "precipitationMmHr",
      "windGustMs",
      "windSpeedMs",
    ]);
    expect(Object.keys(hour.derived).sort()).toEqual(["thermalVelocityMs", "usableLiftTopM"]);
    // The values are the document's own, untouched.
    expect(hour.surface.windSpeedMs).toBe(hrrr().hours[0].surface.windSpeedMs);
    expect(hour.derived.usableLiftTopM).toBe(hrrr().hours[0].derived.usableLiftTopM);
  });

  it("skips selected fields an hour does not carry instead of inventing them", () => {
    const geps = parseWindgramProfile(fixtures["gepsFlagpole"]);
    expect(geps).not.toBeNull();
    const projected = projectProfile(geps!, {
      fields: { surface: ["capeJkg", "cinJkg"] },
    });
    // Two of the trimmed GEPS steps publish no CAPE: the key is absent
    // there, never null or zero.
    const withCape = projected.hours.filter((hour) => "capeJkg" in hour.surface);
    expect(withCape).toHaveLength(14);
    expect(projected.hours).toHaveLength(16);
  });

  it("does not mutate its input", () => {
    const original = hrrr();
    const snapshot = JSON.parse(JSON.stringify(original));
    projectProfile(original, { day: "2026-08-08", dropLevels: true, fields: { surface: [] } });
    expect(original).toEqual(snapshot);
  });
});

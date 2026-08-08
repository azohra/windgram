import { describe, expect, it } from "vitest";
import { localDateKey, localHourOfDay, windgramDisplayHours } from "../src/derive/day-window.js";

function hoursBetween(startIso: string, count: number): Array<{ validAt: string }> {
  const startMs = Date.parse(startIso);
  return Array.from({ length: count }, (_, index) => ({
    validAt: new Date(startMs + index * 3_600_000).toISOString().replace(".000Z", "Z"),
  }));
}

describe("localHourOfDay / localDateKey", () => {
  it("resolves local time in the requested zone (PDT, UTC-7 in August)", () => {
    expect(localHourOfDay("2026-08-09T14:00:00Z", "America/Vancouver")).toBe(7);
    expect(localDateKey("2026-08-09T05:00:00Z", "America/Vancouver")).toBe("2026-08-08");
  });

  it("resolves the same instant differently in another zone (AEST, UTC+10)", () => {
    expect(localHourOfDay("2026-08-09T14:00:00Z", "Australia/Sydney")).toBe(0);
    expect(localDateKey("2026-08-09T14:00:00Z", "Australia/Sydney")).toBe("2026-08-10");
  });

  it("zero-pads the date key so string order is date order", () => {
    expect(localDateKey("2026-01-02T20:00:00Z", "America/Vancouver")).toBe("2026-01-02");
  });
});

describe("windgramDisplayHours", () => {
  it("keeps 07:00-21:00 local inclusive and drops the rest", () => {
    // 2026-08-09T13:00Z..2026-08-10T05:00Z = 06:00..22:00 PDT on Aug 9.
    const hours = hoursBetween("2026-08-09T13:00:00Z", 17);
    const kept = windgramDisplayHours(hours, { timeZone: "America/Vancouver" });
    expect(kept).toHaveLength(15);
    expect(kept[0].validAt).toBe("2026-08-09T14:00:00Z"); // 07:00 local
    expect(kept.at(-1)?.validAt).toBe("2026-08-10T04:00:00Z"); // 21:00 local
  });

  it("windows against the parameterized timezone, not a hardcoded one", () => {
    // 2026-08-08T21:00Z..2026-08-09T11:00Z = 07:00..21:00 AEST on Aug 9.
    const hours = hoursBetween("2026-08-08T20:00:00Z", 17);
    const kept = windgramDisplayHours(hours, { timeZone: "Australia/Sydney" });
    expect(kept).toHaveLength(15);
    expect(kept[0].validAt).toBe("2026-08-08T21:00:00Z");
  });

  it("drops days with fewer than five in-window hours", () => {
    const fullDay = hoursBetween("2026-08-09T14:00:00Z", 15); // Aug 9, 07:00-21:00 PDT
    const shortDay = hoursBetween("2026-08-10T14:00:00Z", 4); // Aug 10, 07:00-10:00 PDT
    const kept = windgramDisplayHours([...fullDay, ...shortDay], {
      timeZone: "America/Vancouver",
    });
    expect(kept).toHaveLength(15);
    expect(kept.every((hour) => localDateKey(hour.validAt, "America/Vancouver") === "2026-08-09")).toBe(
      true,
    );
  });

  it("honours custom day bounds and minimum", () => {
    const hours = hoursBetween("2026-08-09T13:00:00Z", 17); // 06:00..22:00 PDT
    const kept = windgramDisplayHours(hours, {
      timeZone: "America/Vancouver",
      dayStartHour: 10,
      dayEndHour: 12,
      minHoursPerDay: 3,
    });
    expect(kept.map((hour) => localHourOfDay(hour.validAt, "America/Vancouver"))).toEqual([
      10, 11, 12,
    ]);
  });

  it("returns the source hours when no day survives the window", () => {
    const nightHours = hoursBetween("2026-08-09T09:00:00Z", 3); // 02:00-04:00 PDT
    const kept = windgramDisplayHours(nightHours, { timeZone: "America/Vancouver" });
    expect(kept).toEqual(nightHours);
  });

  it("returns an empty set for empty input", () => {
    expect(windgramDisplayHours([], { timeZone: "America/Vancouver" })).toEqual([]);
  });
});

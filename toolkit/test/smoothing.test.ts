import { describe, expect, it } from "vitest";
import { smooth121 } from "../src/derive/smoothing.js";

function series(values: Array<number | null>, stepHours = 1, startIso = "2026-08-09T14:00:00Z") {
  const startMs = Date.parse(startIso);
  return values.map((value, index) => ({
    validAt: new Date(startMs + index * stepHours * 3_600_000).toISOString(),
    value,
  }));
}

describe("smooth121", () => {
  it("applies (previous + 2*current + next) / 4 across contiguous hours", () => {
    expect(smooth121(series([0, 8, 0]))).toEqual([0, 4, 0]);
  });

  it("always smooths against original values, never smoothed ones", () => {
    expect(smooth121(series([0, 8, 0, 8, 0]))).toEqual([0, 4, 4, 4, 0]);
  });

  it("leaves the endpoints untouched", () => {
    expect(smooth121(series([100, 0, 100]))).toEqual([100, 50, 100]);
  });

  it("skips points whose neighbours are not exactly one hour away", () => {
    // Three-hourly model: nothing is contiguous, nothing changes.
    expect(smooth121(series([0, 8, 0, 8], 3))).toEqual([0, 8, 0, 8]);
  });

  it("skips across a gap in an otherwise hourly series", () => {
    const entries = [
      ...series([0, 8], 1, "2026-08-09T14:00:00Z"),
      // 16:00 missing
      ...series([0, 8, 0], 1, "2026-08-09T17:00:00Z"),
    ];
    // Only index 3 has two one-hour neighbours: (0 + 16 + 0) / 4 = 4.
    expect(smooth121(entries)).toEqual([0, 8, 0, 4, 0]);
  });

  it("skips points with a null neighbour and leaves nulls in place", () => {
    expect(smooth121(series([0, 8, null, 8, 0]))).toEqual([0, 8, null, 8, 0]);
  });

  it("passes short series through unchanged", () => {
    expect(smooth121(series([]))).toEqual([]);
    expect(smooth121(series([5]))).toEqual([5]);
    expect(smooth121(series([5, 7]))).toEqual([5, 7]);
  });
});

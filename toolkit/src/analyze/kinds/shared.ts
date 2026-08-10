/* Shared internals for the finding-kind modules: the extraction Context,
   the cited-instant/local-day types every kind's shape leans on, and the
   precision helpers. Kind modules import from here and from the contract;
   the public barrel (vocabulary.ts) re-exports the types that are part of
   the vocabulary surface. */

import type { WindgramProfile } from "../../contract/index.js";
import type { AnalyzeThresholds } from "../vocabulary.js";

/** An instant a finding cites: the document's own UTC `validAt` (so the
 * claim joins back to the published hour) plus its local clock reading
 * ("2026-08-08T11:00") in the analysis timezone. */
export interface CitedInstant {
  validAt: string;
  /**
   * The FULL local timestamp, ISO-shaped, h23, minute precision — a data
   * value, not display copy. Voice formatting (12-hour clocks, "1 p.m.",
   * dropping the date) is deliberately downstream: format from this or
   * from `validAt` in your own presentation layer; this field never
   * follows the scene's `hourLabel` convention.
   */
  local: string;
}

/**
 * Local calendar date key ("2026-08-09") in the analysis `timeZone` —
 * derive/'s `localDateKey` of the hour's `validAt`. Pairing findings with
 * a consumer's own day tabs (`groupByLocalDay`, `windgramDisplayHours`)
 * works only when both sides compute the key in the SAME zone: pass the
 * same timeZone to `analyzeProfile` as to the windowing, or the days
 * around midnight will land in different tabs.
 */
export type LocalDayKey = string;

/** The per-analysis context every extractor reads from. */
export interface Context {
  profile: WindgramProfile;
  timeZone: string;
  deterministic: boolean;
  stepHours: number;
  /** The caller-supplied launch elevation; null when none was supplied. */
  launchElevationM: number | null;
  /** launchElevationM, falling back to the model's own ground. */
  launchReferenceM: number;
  cite: (validAt: string) => CitedInstant;
  thresholds: AnalyzeThresholds;
}

export function stepHoursOf(profile: WindgramProfile): number {
  if (profile.hours.length < 2) return 1;
  const first = Date.parse(profile.hours[0].validAt);
  const second = Date.parse(profile.hours[1].validAt);
  return Math.max(1, Math.round((second - first) / 3_600_000));
}

const localClockFormatters = new Map<string, Intl.DateTimeFormat>();

export function citedInstantFactory(timeZone: string): (validAt: string) => CitedInstant {
  let formatter = localClockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    });
    localClockFormatters.set(timeZone, formatter);
  }
  const format = formatter;
  return (validAt: string) => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(validAt)).map(({ type, value }) => [type, value]),
    );
    return {
      validAt,
      local: `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}`,
    };
  };
}

/* Stated magnitudes ship at the contract's own precision for their
   quantity — the pipeline's publish table (_FIELD_DECIMALS) is the
   authority: metre quantities at one decimal, m/s quantities at two.
   Coarser would let a finding contradict its own evidence (a raw w* of
   0.89 votes quiet against a 0.9 floor while a 1-dp print says 0.9).
   compare/ imports these rather than restating them. */

/** One decimal — contract precision for metre magnitudes
 * (usableLiftTopM, cloudBaseM, heights, deltas). */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Two decimals — contract precision for m/s magnitudes
 * (thermalVelocityMs, windSpeedMs, windGustMs). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

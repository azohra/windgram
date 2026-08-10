/* Shared internals for the finding-kind modules: the extraction Context,
   the cited-instant/local-day types every kind's shape leans on, and the
   precision helpers. Kind modules import from here and from the contract;
   the public barrel (vocabulary.ts) re-exports the types that are part of
   the vocabulary surface. */

import type { WindgramProfile } from "../../contract/index.js";
import type { AnalyzeThresholds, WindCeilings } from "../vocabulary.js";

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
  /**
   * The LEADING cadence (the first two hours' gap) — an envelope/ledger
   * display fact only. Live documents switch cadence mid-horizon (GEPS
   * publishes 63 steps at 3 h then 32 at 6 h), so no arithmetic may treat
   * this as a document-wide constant: spacing-derived statements read the
   * actual per-gap spacing from `steps`.
   */
  stepHours: number;
  /** Per-hour spacing facts at the document's actual (varying) cadence. */
  steps: HourSteps;
  /** The caller-supplied launch elevation; null when none was supplied. */
  launchElevationM: number | null;
  /** launchElevationM, falling back to the model's own ground. */
  launchReferenceM: number;
  cite: (validAt: string) => CitedInstant;
  thresholds: AnalyzeThresholds;
  /** The caller's wind ceilings (`AnalyzeOptions.windCeilings`) — absent
   * means windExceedance emits nothing; no defaults exist anywhere. */
  windCeilings?: WindCeilings;
}

/**
 * Per-hour spacing at the document's ACTUAL cadence — the per-gap answer
 * to the defect S1 measured live (2026-08-10): GEPS switches from 3-hourly
 * to 6-hourly mid-horizon, so any spacing arithmetic reading only the
 * first pair of hours misreads the far horizon of every live GEPS
 * document. Arrays align with `profile.hours`.
 *
 * THE COVERED-SPAN CONVENTION (one convention, used by every consumer):
 * a published step covers the hours from its own instant to the next
 * published sample, so `after[i]` IS hour i's covered span; the horizon's
 * last sample has no successor and mirrors its arriving gap. At constant
 * cadence every span equals the cadence and sums restate
 * `samples × stepHours` exactly — the pre-v4 arithmetic — so only
 * mixed-cadence documents read differently.
 */
export interface HourSteps {
  /** Hours from the previous published sample to hour i; the first hour
   * mirrors its forward gap (1 for single-hour documents). */
  before: number[];
  /** Hours from hour i to the next published sample — hour i's covered
   * span; the last hour mirrors its arriving gap (1 for single-hour
   * documents). */
  after: number[];
  /** The document's widest adjacent gap — the honest single number where
   * one is unavoidable (caveats); 1 for documents under two hours. */
  maxStepHours: number;
  /** Document hour index by validAt, for extractors holding cited hours. */
  indexOf: Map<string, number>;
}

export function hourStepsOf(profile: WindgramProfile): HourSteps {
  const n = profile.hours.length;
  const indexOf = new Map(profile.hours.map((hour, index) => [hour.validAt, index]));
  if (n < 2) {
    return { before: n ? [1] : [], after: n ? [1] : [], maxStepHours: 1, indexOf };
  }
  const times = profile.hours.map((hour) => Date.parse(hour.validAt));
  const gaps: number[] = [];
  for (let i = 1; i < n; i += 1) {
    gaps.push(Math.max(1, Math.round((times[i] - times[i - 1]) / 3_600_000)));
  }
  const before = [gaps[0], ...gaps];
  const after = [...gaps, gaps[gaps.length - 1]];
  return { before, after, maxStepHours: Math.max(...gaps), indexOf };
}

/**
 * Forecast lead in hours from the run's referenceTime to a cited instant —
 * the design's item 6a, computed in ONE home so every day-keyed kind
 * states lead the same way: thermalWindow anchors on the day's peak-lift
 * hour, and the percentile-crossing and quiet-day statements reuse this
 * helper on their own anchor instants. S1 (2026-08-10) measured why the
 * number is mandatory wherever band statements ride: all 22
 * p50-quiet/band-window days sat at lead ≥ 72 h — a day-10 window and a
 * day-1 window are epistemically different objects wearing the same
 * vocabulary. Rounded to one decimal (both instants are on-the-hour on
 * live documents, so this reads as an integer in practice).
 */
export function leadHoursTo(referenceTime: string, validAt: string): number {
  return round1((Date.parse(validAt) - Date.parse(referenceTime)) / 3_600_000);
}

/** The leading cadence — see `Context.stepHours` for what it may and may
 * not be used for. */
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

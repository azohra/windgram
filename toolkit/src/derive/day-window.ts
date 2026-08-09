/* Day windowing: an inclusive-bounds filter, a min-hours-per-day rule, and
   an all-or-nothing fallback, with the timezone and day bounds as
   parameters. Profiles publish every forecast hour; which of them make a
   pilot's day is a renderer choice, not a dataset property. */

export interface DayWindowOptions {
  /** IANA timezone the day is judged in (e.g. "America/Vancouver"). */
  timeZone: string;
  /** First local hour kept, inclusive. Default 7. */
  dayStartHour?: number;
  /** Last local hour kept, inclusive. Default 21. */
  dayEndHour?: number;
  /** Days with fewer in-window hours than this are dropped. Default 5. */
  minHoursPerDay?: number;
}

const DEFAULT_DAY_START_HOUR = 7;
const DEFAULT_DAY_END_HOUR = 21;
const DEFAULT_MIN_HOURS_PER_DAY = 5;

// Intl.DateTimeFormat construction is costly; cache per timezone.
const hourFormatters = new Map<string, Intl.DateTimeFormat>();
const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();

/** Local hour of day (0-23) of a UTC instant in the given timezone. */
export function localHourOfDay(validAt: string, timeZone: string): number {
  let formatter = hourFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { hour: "2-digit", hourCycle: "h23", timeZone });
    hourFormatters.set(timeZone, formatter);
  }
  return Number(formatter.format(new Date(validAt)));
}

/** Zero-padded local date key (YYYY-MM-DD) — string order is date order. */
export function localDateKey(validAt: string, timeZone: string): string {
  let formatter = dateKeyFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone,
    });
    dateKeyFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(validAt));
  const part = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${part["year"]}-${part["month"]}-${part["day"]}`;
}

/**
 * Groups hours by local calendar day in the given timezone — the shape a
 * day-tab UI wants, and the `dateKey` half of `buildScene`'s
 * `{ timeZone, dateKey }` windowing option. Groups appear in first-
 * encounter order, so chronological input (profile hours always are)
 * yields chronological days; each group's hours keep their input order.
 * Grouping is the whole job — apply `windgramDisplayHours` first if the
 * pilots'-day filter is wanted too.
 */
export function groupByLocalDay<T extends { validAt: string }>(
  hours: readonly T[],
  timeZone: string,
): Array<{ dateKey: string; hours: T[] }> {
  const groups: Array<{ dateKey: string; hours: T[] }> = [];
  const byKey = new Map<string, T[]>();
  for (const hour of hours) {
    const dateKey = localDateKey(hour.validAt, timeZone);
    let bucket = byKey.get(dateKey);
    if (!bucket) {
      bucket = [];
      byKey.set(dateKey, bucket);
      groups.push({ dateKey, hours: bucket });
    }
    bucket.push(hour);
  }
  return groups;
}

/**
 * Keeps the hours inside the pilots' day — local hour within
 * [dayStartHour, dayEndHour], dropping days with fewer than minHoursPerDay
 * in-window hours — unless that would empty the set, in which case the
 * source hours are returned unchanged.
 */
export function windgramDisplayHours<T extends { validAt: string }>(
  hours: readonly T[],
  options: DayWindowOptions,
): T[] {
  const dayStartHour = options.dayStartHour ?? DEFAULT_DAY_START_HOUR;
  const dayEndHour = options.dayEndHour ?? DEFAULT_DAY_END_HOUR;
  const minHoursPerDay = options.minHoursPerDay ?? DEFAULT_MIN_HOURS_PER_DAY;

  const byDate = new Map<string, T[]>();
  for (const hour of hours) {
    const hourOfDay = localHourOfDay(hour.validAt, options.timeZone);
    if (hourOfDay < dayStartHour || hourOfDay > dayEndHour) continue;
    const dateKey = localDateKey(hour.validAt, options.timeZone);
    const dateHours = byDate.get(dateKey) ?? [];
    dateHours.push(hour);
    byDate.set(dateKey, dateHours);
  }

  const completeDays = [...byDate.values()].filter(
    (dateHours) => dateHours.length >= minHoursPerDay,
  );
  return completeDays.length > 0 ? completeDays.flat() : [...hours];
}

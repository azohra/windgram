// All chart/day-tab labels use the founding catalogue's local timezone, per
// research/windgram-derivations.md's flyable-day window (America/Vancouver).
// The thread-through for a future non-Pacific site now exists — sites.json
// entries declare `timeZone` and profiles echo it as `site.timeZone` — but
// adopting it here means per-site label formatters too, so this stays the
// single display choice until such a site is catalogued.
export const DISPLAY_TZ = "America/Vancouver";

/* Day keys and day grouping are windgram/derive's job (localDateKey,
   groupByLocalDay); this module keeps only the site's label formatting. */

const dayLabelFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
});

const hourLabelFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TZ,
  hour: "numeric",
  hour12: false,
});

export function localDayLabel(iso: string): string {
  return dayLabelFmt.format(new Date(iso));
}

export function localHourLabel(iso: string): string {
  return hourLabelFmt.format(new Date(iso));
}

/** Aviation-style run label, e.g. "12Z Aug 7" — matches how pilots already talk about runs. */
export function runLabel(referenceTimeIso: string): string {
  const d = new Date(referenceTimeIso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${hh}Z ${month} ${d.getUTCDate()}`;
}

export function hoursSince(iso: string, now: Date = new Date()): number {
  return (now.getTime() - new Date(iso).getTime()) / 3_600_000;
}

export function formatAge(hours: number): string {
  if (hours < 1) return "under an hour ago";
  const h = Math.round(hours);
  return `${h}h ago`;
}

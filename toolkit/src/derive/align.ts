import type { WindgramHour, WindgramProfile } from "../contract/index.js";

/* The minimal cross-document join: intersect profiles on their shared
   validAt instants. validAt strings are directly comparable (UTC, Z-suffixed,
   whole seconds), and coarser models' instants are a subset of finer ones',
   so string equality IS the alignment — no interpolation, no resampling.

   The output rows are quantities, not claims: each shared instant with every
   model's own published hour beside it, untouched. What stays deliberately
   unsaid is everything an honest cross-model statement would have to
   normalize first — the models' different modelElevationM (heights are not
   comparable raw), gust and precipitation semantics (hourMax vs instant runs
   ~20-30 % apart systematically), run ages, and step cadences. Showing the
   disagreement is a consumer's job; adjudicating it is nobody's here. */

export interface AlignedHours {
  /** The shared forecast instant, UTC — every profile publishes an hour here. */
  validAt: string;
  /** Each model's own published hour at this instant, keyed by model slug. */
  byModel: Record<string, WindgramHour>;
}

/**
 * Intersects profiles on `validAt`: returns the instants every given profile
 * publishes, chronological, each row carrying the models' hours keyed by
 * slug. Give it one profile per model — a duplicate slug would silently
 * shadow, so it throws instead. Empty input yields no rows.
 */
export function alignByValidAt(profiles: readonly WindgramProfile[]): AlignedHours[] {
  if (profiles.length === 0) return [];
  const hoursBySlug = new Map<string, Map<string, WindgramHour>>();
  for (const profile of profiles) {
    if (hoursBySlug.has(profile.model)) {
      throw new Error(`alignByValidAt: two profiles share the model slug "${profile.model}"`);
    }
    hoursBySlug.set(
      profile.model,
      new Map(profile.hours.map((hour) => [hour.validAt, hour])),
    );
  }

  const [first, ...rest] = profiles;
  const aligned: AlignedHours[] = [];
  for (const hour of first.hours) {
    if (rest.some((profile) => !hoursBySlug.get(profile.model)!.has(hour.validAt))) continue;
    const byModel: Record<string, WindgramHour> = {};
    for (const profile of profiles) {
      byModel[profile.model] = hoursBySlug.get(profile.model)!.get(hour.validAt)!;
    }
    aligned.push({ validAt: hour.validAt, byModel });
  }
  return aligned;
}

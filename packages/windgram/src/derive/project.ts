import type {
  WindgramDerived,
  WindgramLevel,
  WindgramProfile,
  WindgramSurface,
} from "../contract/index.js";
import { localDateKey } from "./day-window.js";

/* Descriptive projection over a profile document: window to one local day,
   strip levels, select field subsets. Pure subtraction — every value in the
   output is a value from the input, unchanged; nothing is judged, summed, or
   thresholded. The measured reason it exists (notes from the 2026-08 context
   spikes, budgets restated in the README's "Feeding a windgram to an LLM"):
   a full single-model profile is ~13-14k tokens with its reading context, a
   full GEPS ensemble document ~72k alone — one local day with levels
   stripped and a derived-block field selection is ~0.5-1.5k. Projection is
   what makes every measured payload fit every budget. */

export interface ProjectProfileOptions {
  /**
   * Local calendar day to window to, as a zero-padded date key
   * ("2026-08-09"). Judged in `timeZone` when given, else in the document's
   * own `site.timeZone`; requesting a day when neither exists throws —
   * local time is load-bearing, and guessing a zone would silently window
   * the wrong hours.
   */
  day?: string;
  /** IANA timezone override for `day`. Defaults to `profile.site.timeZone`. */
  timeZone?: string;
  /** Publish every hour's `levels` as `[]` — the single biggest subtraction. */
  dropLevels?: boolean;
  /**
   * Field subsets to keep, per block; a block absent here keeps every
   * field. `validAt` always survives, and the site/run/model/semantics
   * envelope is never touched — the projection stays a self-interpreting
   * document, just a smaller one.
   */
  fields?: {
    surface?: readonly (keyof WindgramSurface)[];
    levels?: readonly (keyof WindgramLevel)[];
    derived?: readonly (keyof WindgramDerived)[];
  };
}

/** An hour whose blocks may carry field subsets. Without a `fields` option
 * the blocks are complete and the projection is still a contract-valid
 * profile document. */
export interface ProjectedWindgramHour {
  validAt: string;
  surface: Partial<WindgramSurface>;
  levels: Array<Partial<WindgramLevel>>;
  derived: Partial<WindgramDerived>;
}

export type ProjectedWindgramProfile = Omit<WindgramProfile, "hours"> & {
  hours: ProjectedWindgramHour[];
};

/**
 * Projects a profile document down to the hours and fields a consumer's
 * budget wants: window to a local `day`, `dropLevels`, and/or select
 * `fields` subsets per block. Purely descriptive — no thresholds, no
 * judgments, no recomputation; the output is the same document with parts
 * removed, envelope intact. With no options it returns a structural copy.
 */
export function projectProfile(
  profile: WindgramProfile,
  options: ProjectProfileOptions = {},
): ProjectedWindgramProfile {
  let hours: readonly WindgramProfile["hours"][number][] = profile.hours;
  if (options.day !== undefined) {
    const timeZone = options.timeZone ?? profile.site.timeZone;
    if (!timeZone) {
      throw new Error(
        "projectProfile: windowing to a local day needs a timezone — the document declares no site.timeZone, so pass options.timeZone",
      );
    }
    const day = options.day;
    hours = hours.filter((hour) => localDateKey(hour.validAt, timeZone) === day);
  }

  const { fields } = options;
  return {
    ...profile,
    site: { ...profile.site },
    run: { ...profile.run },
    ...(profile.semantics ? { semantics: { ...profile.semantics } } : {}),
    hours: hours.map((hour) => ({
      validAt: hour.validAt,
      surface: pickFields(hour.surface, fields?.surface),
      levels: options.dropLevels
        ? []
        : hour.levels.map((level) => pickFields(level, fields?.levels)),
      derived: pickFields(hour.derived, fields?.derived),
    })),
  };
}

function pickFields<T extends object>(block: T, keep?: readonly (keyof T)[]): Partial<T> {
  if (keep === undefined) return { ...block };
  const picked: Partial<T> = {};
  for (const key of keep) {
    if (key in block) picked[key] = block[key];
  }
  return picked;
}

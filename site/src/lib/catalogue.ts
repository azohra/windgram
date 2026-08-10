import { modelCatalogueSchema, type ModelCatalogue, type ModelEntry } from "windgram/contract";
import rawCatalogue from "../../../models.json";

/* models.json is the discovery catalogue: slugs are model identity and
   labels are the only prose model names. It is validated against the
   package contract here at build time, so catalogue drift fails the build
   instead of shipping a picker that lies. */
const catalogue: ModelCatalogue = modelCatalogueSchema.parse(rawCatalogue);

export const MODELS: ModelEntry[] = catalogue.models;

export function modelBySlug(slug: string): ModelEntry | undefined {
  return MODELS.find((model) => model.slug === slug);
}

/* Pressure levels that also carry vertical velocity (omega), per model —
   `capabilities.verticalVelocityLevels` straight from the typed catalogue. */
export function omegaLevels(slug: string): number[] {
  return modelBySlug(slug)?.capabilities.verticalVelocityLevels ?? [];
}

/* Hours between published runs — `runIntervalHours` from the typed
   catalogue. An entry that doesn't declare it yet gets the most forgiving
   published cadence so a new model is never falsely flagged stale. */
export function runIntervalHours(slug: string): number {
  return modelBySlug(slug)?.runIntervalHours ?? 12;
}

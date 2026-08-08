import { z } from "zod";

/* The published contract: zod schemas for the profile document, the per-model
   manifest, and the models.json catalogue, with types inferred and safeParse
   guards for the trust boundary where stored JSON is read back.

   Model identity is the slug string (the data/ directory name). There is
   deliberately no enum of model names anywhere: models.json is the catalogue,
   and consumers discover models from it instead of hardcoding a list. */

export const SCHEMA_VERSION = 1;

// Slugs are lowercase alphanumeric runs joined by single hyphens — the shape
// of every data/ directory and site id today ("hrdps-continental", "red-mountain").
const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "expected a lowercase hyphenated slug");

// UTC instants; "Z" required, fractional seconds tolerated (manifests carry
// milliseconds, profile documents whole seconds).
const utcInstantSchema = z.iso.datetime();

/* ---------------------------------------------------------------- ensemble */

/* Ensemble models publish a percentile object in any numeric data position
   where deterministic models publish a plain number. `ceiledMembers` appears
   only where the pipeline records censoring (boundary-layer top and usable
   lift capped by the column ceiling). */
export const ensembleValueSchema = z.object({
  members: z.number().int().positive(),
  p10: z.number(),
  p25: z.number(),
  p50: z.number(),
  p75: z.number(),
  p90: z.number(),
  ceiledMembers: z.number().int().nonnegative().optional(),
});
export type EnsembleValue = z.infer<typeof ensembleValueSchema>;

/* Every numeric data position in `surface`, `levels`, and `derived` is a
   Scalar; consumers switch on shape, never on model name. Site and run
   metadata (coordinates, elevations, timestamps) stay plain. */
export const scalarSchema = z.union([z.number(), ensembleValueSchema]);
export type Scalar = number | EnsembleValue;

export function isEnsembleValue(value: Scalar): value is EnsembleValue {
  return typeof value === "object" && value !== null;
}

/* ----------------------------------------------------------------- profile */

export const windgramSurfaceSchema = z.object({
  pressurePa: scalarSchema, // MSL pressure
  temperatureC: scalarSchema, // 2 m
  dewPointC: scalarSchema, // 2 m
  windSpeedMs: scalarSchema, // 10 m
  windDirectionDeg: scalarSchema, // met convention (from), 0-359
  cloudCoverPercent: scalarSchema, // total
  precipitationMmHr: scalarSchema,
  sensibleHeatFluxWm2: scalarSchema,
  latentHeatFluxWm2: scalarSchema,
  /* The science-wave fields below are additive and optional: a model
     publishes each one only where its transport carries it (models.json
     capabilities say which). Absence means "not published", never zero. */
  /**
   * 10 m wind gust, m/s. The SEMANTICS DIFFER BY PROVIDER and are declared
   * per model in models.json `capabilities.gust`: ECCC models publish the
   * maximum model-timestep gust over the hour ending at validAt ("hourMax",
   * the pilot's "gusting to"); NOAA models publish only the instantaneous
   * diagnostic gust at validAt ("instant"). Hour-max runs systematically
   * ~20-30 % higher than instant, so cross-model comparisons must consult
   * the capability flag.
   */
  windGustMs: scalarSchema.optional(),
  /**
   * Surface-based CAPE, J/kg (>= 0), instantaneous — the parcel a
   * surface-heated thermal actually flies. The one CAPE variant every
   * capable model shares; ECCC's "not computed" sentinels (9999 on
   * RDPS/GDPS, -1 on the HRDPS family) are masked in the pipeline and the
   * field is omitted for those hours.
   */
  capeJkg: scalarSchema.optional(),
  /**
   * Surface-based CIN, J/kg (<= 0), instantaneous. Exists only on
   * RDPS/GDPS/HRRR/GFS — the HRDPS family publishes CAPE with no CIN, so
   * capabilities decouple `cin` from `cape` and absence must not be read
   * as "no cap".
   */
  cinJkg: scalarSchema.optional(),
  /**
   * Model planetary-boundary-layer depth, metres ABOVE GROUND (AGL), not
   * MSL. To plot it on the altitude axis next to derived.boundaryLayerTopM
   * (which is MSL), add site.modelElevationM first.
   */
  pblHeightM: scalarSchema.optional(),
  /**
   * Instantaneous low / middle / high cloud-layer fractions, % 0-100
   * (NOAA models only). The bands are NCEP's terrain-following sigma
   * layers (low sigma 1.0-0.642, middle 0.642-0.35, high 0.35-0.15 of
   * surface pressure), not fixed altitudes.
   */
  lowCloudPercent: scalarSchema.optional(),
  midCloudPercent: scalarSchema.optional(),
  highCloudPercent: scalarSchema.optional(),
});
export type WindgramSurface = z.infer<typeof windgramSurfaceSchema>;

export const windgramLevelSchema = z.object({
  pressureHpa: scalarSchema,
  heightM: scalarSchema,
  temperatureC: scalarSchema,
  dewPointC: scalarSchema,
  windSpeedMs: scalarSchema,
  windDirectionDeg: scalarSchema,
  // Omitted until a model's transport provides omega (the GRIB wave);
  // models.json capabilities.verticalVelocity says which models carry it.
  verticalVelocityPaS: scalarSchema.optional(),
  /**
   * Per-isobaric-level total cloud fraction, % 0-100. GFS is the only
   * published model with a cloud profile (capabilities.cloudProfile);
   * unlike omega it is level-complete within GFS, only model-sparse.
   */
  cloudFractionPercent: scalarSchema.optional(),
});
export type WindgramLevel = z.infer<typeof windgramLevelSchema>;

/* Pipeline-authoritative quantities, unsmoothed. The package never
   recomputes these (the one-home rule). */
export const windgramDerivedSchema = z.object({
  boundaryLayerTopM: scalarSchema.nullable(), // null when no BL
  thermalVelocityMs: scalarSchema,
  cloudBaseM: scalarSchema,
  usableLiftTopM: scalarSchema.nullable(), // null when lift can't beat sink
});
export type WindgramDerived = z.infer<typeof windgramDerivedSchema>;

export const windgramHourSchema = z.object({
  validAt: utcInstantSchema,
  surface: windgramSurfaceSchema,
  // Ascending height; only levels with heightM > modelElevationM + 20.
  // Empty for models whose capabilities.levels is false (REPS today).
  levels: z.array(windgramLevelSchema),
  derived: windgramDerivedSchema,
});
export type WindgramHour = z.infer<typeof windgramHourSchema>;

export const windgramSiteSchema = z.object({
  id: slugSchema,
  name: z.string().min(1),
  latitude: z.number(),
  longitude: z.number(),
  altitudeM: z.number().nullable(), // null when unknown
  modelElevationM: z.number(),
});
export type WindgramSite = z.infer<typeof windgramSiteSchema>;

export const windgramRunSchema = z.object({
  referenceTime: utcInstantSchema,
  generatedAt: utcInstantSchema,
});
export type WindgramRun = z.infer<typeof windgramRunSchema>;

/* The document published at data/<model-slug>/sites/<site-slug>.json; history
   lines are exactly this document, one per line. Hours are ALL forecast
   hours, chronological — day windowing is a renderer choice (derive/). */
export const windgramProfileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  model: slugSchema,
  run: windgramRunSchema,
  site: windgramSiteSchema,
  hours: z.array(windgramHourSchema),
});
export type WindgramProfile = z.infer<typeof windgramProfileSchema>;

/* ---------------------------------------------------------------- manifest */

export const windgramManifestSiteSchema = z.object({
  name: z.string().min(1),
  slug: slugSchema,
});
export type WindgramManifestSite = z.infer<typeof windgramManifestSiteSchema>;

/* data/<model-slug>/manifest.json. `model` is the slug, like everywhere
   else. `stats` is transport-specific build accounting (request counts,
   bytes, retries) and stays open-ended. */
export const windgramManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  model: slugSchema,
  referenceTime: utcInstantSchema,
  generatedAt: utcInstantSchema,
  firstForecastHour: z.number().int().nonnegative(),
  lastForecastHour: z.number().int().nonnegative(),
  forecastHours: z.number().int().nonnegative(),
  memberCount: z.number().int().positive().optional(), // ensemble models only
  sites: z.array(windgramManifestSiteSchema),
  stats: z.record(z.string(), z.number()),
});
export type WindgramManifest = z.infer<typeof windgramManifestSchema>;

/* ------------------------------------------------------------- models.json */

export const modelCapabilitiesSchema = z.object({
  levels: z.boolean(), // false -> hours[].levels always empty
  // What the model publishes today; widens per model with the GRIB wave.
  pressureLevels: z.array(z.number()),
  /**
   * Vertical-velocity provenance, not just presence: "omega" = the
   * provider's own published omega (Pa/s); "fromGeometricW" = omega
   * converted at build from the provider's geometric w via the hydrostatic
   * relation omega ~ -rho*g*w; false = not published. Either token fills
   * levels[].verticalVelocityPaS — the provenance is declared so consumers
   * can label converted values differently from native ones.
   */
  verticalVelocity: z.union([z.enum(["omega", "fromGeometricW"]), z.literal(false)]),
  /**
   * The subset of `pressureLevels` (hPa) that actually carries omega
   * (levels[].verticalVelocityPaS) — providers publish omega on far fewer
   * levels than temperature or wind (the ECCC deterministic models today).
   * Present exactly when `verticalVelocity` is not false; a level absent
   * from this list never carries omega, so renderers can label the sparse
   * coverage instead of guessing at gaps.
   */
  verticalVelocityLevels: z.array(z.number()).optional(),
  heatFluxes: z.boolean(),
  /**
   * Gust semantics, not just presence: "hourMax" = max model-timestep gust
   * over the hour ending at validAt (ECCC), "instant" = diagnostic gust at
   * validAt (NOAA), false = no gust published. The two semantics differ by
   * ~20-30 % systematically, so renderers must label them differently.
   */
  gust: z.union([z.enum(["hourMax", "instant"]), z.literal(false)]),
  cape: z.boolean(), // surface-based CAPE (surface.capeJkg)
  // Deliberately decoupled from `cape`: the HRDPS family has CAPE, no CIN.
  cin: z.boolean(),
  pblHeight: z.boolean(), // surface.pblHeightM (metres AGL)
  cloudLayers: z.boolean(), // surface.low/mid/highCloudPercent
  cloudProfile: z.boolean(), // levels[].cloudFractionPercent
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export const modelEntrySchema = z.object({
  slug: slugSchema, // == data/ directory name; the identity everywhere
  label: z.string().min(1), // the only place prose model names live
  provider: z.string().min(1),
  gridKm: z.number().positive(),
  stepHours: z.number().positive(),
  horizonHours: z.number().positive(),
  /**
   * Hours between the runs this dataset publishes — the model's own
   * schedule where every run is built (most models), or the built subset
   * where it is not (HRRR runs hourly but only its 48 h synoptic runs are
   * published here, so it declares 6). Freshness display metadata: a run
   * older than about twice this interval is genuinely late, not just a
   * slow CDN. Optional so catalogue entries predating the field still
   * validate; consumers should treat absence as "cadence unknown" and fall
   * back to the most forgiving published interval (12 h today) rather than
   * flagging a new model stale.
   */
  runIntervalHours: z.number().positive().optional(),
  /**
   * Machine-readable retirement notice: no runs are expected after `date`
   * (UTC calendar date, YYYY-MM-DD). `successor` names the catalogue slug
   * that replaces this model, or null for end-of-life with no replacement.
   * Absent for models with no announced retirement.
   */
  sunset: z
    .object({
      date: z.iso.date(),
      successor: slugSchema.nullable(),
    })
    .optional(),
  kind: z.enum(["deterministic", "ensemble"]),
  experimental: z.boolean(),
  capabilities: modelCapabilitiesSchema,
});
export type ModelEntry = z.infer<typeof modelEntrySchema>;

/* data/models.json — hand-maintained, the discovery catalogue. Frontends
   render what a model declares instead of hardcoding model lists. */
export const modelCatalogueSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  models: z.array(modelEntrySchema),
});
export type ModelCatalogue = z.infer<typeof modelCatalogueSchema>;

/* ------------------------------------------------------------ parse guards */

/* safeParse wrappers guarding the trust boundary when published JSON is read
   back: the plain variants take an already-parsed value, the ...Json variants
   take the raw stored string (the parseStoredWindgram idiom). */

export function parseWindgramProfile(value: unknown): WindgramProfile | null {
  const result = windgramProfileSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseWindgramProfileJson(text: string): WindgramProfile | null {
  return parseWindgramProfile(tryParseJson(text));
}

export function parseWindgramManifest(value: unknown): WindgramManifest | null {
  const result = windgramManifestSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseWindgramManifestJson(text: string): WindgramManifest | null {
  return parseWindgramManifest(tryParseJson(text));
}

export function parseModelCatalogue(value: unknown): ModelCatalogue | null {
  const result = modelCatalogueSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseModelCatalogueJson(text: string): ModelCatalogue | null {
  return parseModelCatalogue(tryParseJson(text));
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

import { z } from "zod";

/* The published contract: zod schemas for the profile document, the per-model
   manifest, the models.json catalogue, the sites.json catalogue, and the
   runs.json aggregate, with types inferred and safeParse guards for the trust
   boundary where stored JSON is read back.

   Model identity is the slug string (the data/ directory name). There is
   deliberately no enum of model names anywhere: models.json is the catalogue,
   and consumers discover models from it instead of hardcoding a list.

   Every field's prose lives twice on purpose, adjacent and identical in
   meaning: the JSDoc block serves TypeScript consumers, and the .describe()
   call carries the same semantics into the generated JSON Schema artifacts
   (schema/*.json) so non-JS consumers read the identical contract. */

export const SCHEMA_VERSION = 1;

/* sites.json and site-context.json stepped to schemaVersion 2 in the
   launch-decoupling wave: the site catalogue stopped carrying an elevation
   of any kind (humans author WHERE; the pipeline measures WHAT), and the
   context gained the required `elevation` pick that replaced v1's optional
   bareEarth block. */
export const SITES_SCHEMA_VERSION = 2;
export const SITE_CONTEXT_SCHEMA_VERSION = 2;

// Slugs are lowercase alphanumeric runs joined by single hyphens — the shape
// of every data/ directory and site id today ("hrdps-continental", "red-mountain").
const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "expected a lowercase hyphenated slug")
  .describe("Lowercase hyphenated slug — the identity of models and sites everywhere.");

// UTC instants; "Z" required, fractional seconds tolerated (manifests carry
// milliseconds, profile documents whole seconds).
const utcInstantSchema = z.iso
  .datetime()
  .describe("UTC instant, ISO 8601 with a Z suffix; fractional seconds tolerated.");

/* ---------------------------------------------------------------- ensemble */

/* Ensemble models publish a percentile object in any numeric data position
   where deterministic models publish a plain number. `ceiledMembers` appears
   only where the pipeline records censoring (boundary-layer top and usable
   lift capped by the column ceiling). */
const populatedEnsembleSchema = z.object({
  members: z
    .number()
    .int()
    .positive()
    .describe(
      "How many ensemble members contributed to this position — can be lower than run.members where members were censored (null positions are excluded, not ranked at zero).",
    ),
  p10: z.number(),
  p25: z.number(),
  p50: z.number(),
  p75: z.number(),
  p90: z.number(),
  ceiledMembers: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "How many contributing members were capped at the column ceiling rather than resolved — present only where the pipeline records censoring (boundary-layer top and usable-lift top).",
    ),
});

/* Full dropout: the run asked every member and none produced a value —
   members: 0 with every percentile null, nothing in between. A published
   fact, distinct from both "not published" (the field is absent) and a
   forecast of none (the position is plain null): GEPS publishes CAPE at
   every hour, and at some hours zero members contribute. Percentiles of
   zero members cannot exist, so they are null, never fabricated. */
const ensembleDropoutSchema = z.object({
  members: z
    .literal(0)
    .describe("Zero members contributed to this position — full dropout, a published fact."),
  p10: z.null(),
  p25: z.null(),
  p50: z.null(),
  p75: z.null(),
  p90: z.null(),
  ceiledMembers: z
    .literal(0)
    .optional()
    .describe("Zero of zero contributing members were ceiling-capped."),
});

export const ensembleValueSchema = z
  .union([populatedEnsembleSchema, ensembleDropoutSchema])
  .describe(
    "Ensemble percentile object: appears in any numeric data position where deterministic models publish a plain number. members: 0 with all-null percentiles is full dropout — no member produced a value at this position.",
  );
export type EnsembleValue = z.infer<typeof ensembleValueSchema>;

/* Every numeric data position in `surface`, `levels`, and `derived` is a
   Scalar; consumers switch on shape, never on model name. Site and run
   metadata (coordinates, elevations, timestamps) stay plain. */
export const scalarSchema = z
  .union([z.number(), ensembleValueSchema])
  .describe(
    "Scalar data position: a plain number (deterministic models) or an ensemble percentile object.",
  );
export type Scalar = number | EnsembleValue;

export function isEnsembleValue(value: Scalar): value is EnsembleValue {
  return typeof value === "object" && value !== null;
}

/**
 * True for a full-dropout ensemble position — members: 0, every percentile
 * null. `p50()` of a dropout is null; `analyze`'s ensembleMembership
 * finding is where the fact surfaces as a statement.
 */
export function isEnsembleDropout(value: Scalar): boolean {
  return isEnsembleValue(value) && value.members === 0;
}

/* ----------------------------------------------------------------- profile */

export const windgramSurfaceSchema = z.object({
  /**
   * Mean-sea-level pressure, Pa. Surface pressure is a measured quantity and
   * is published in SI pascals; level pressure (`levels[].pressureHpa`) is
   * the vertical coordinate and keeps the conventional hectopascals levels
   * are named by (925, 850, …). The unit split is deliberate, not an
   * inconsistency: coordinates read in their conventional unit, measurements
   * in SI.
   */
  pressurePa: scalarSchema.describe(
    "Mean-sea-level pressure, Pa. A measured quantity, so SI pascals; level pressure (levels[].pressureHpa) is the vertical coordinate and keeps conventional hectopascals — the unit split is deliberate.",
  ),
  temperatureC: scalarSchema.describe("2 m air temperature, degC."),
  dewPointC: scalarSchema.describe("2 m dew point, degC."),
  windSpeedMs: scalarSchema.describe("10 m wind speed, m/s."),
  windDirectionDeg: scalarSchema.describe(
    "10 m wind direction, meteorological convention (direction the wind comes FROM), 0-359 deg.",
  ),
  cloudCoverPercent: scalarSchema.describe("Total cloud cover, % 0-100."),
  /**
   * Precipitation rate, mm/h. The SEMANTICS DIFFER BY PROVIDER and are
   * declared per model in models.json `capabilities.precipitation`, echoed
   * on the document itself in the top-level `semantics.precipitation` tag:
   * "instantRate" is the model's instantaneous rate diagnostic at validAt;
   * "windowMeanRate" is the accumulation over the publishing step window
   * ending at validAt divided by the window length. A shower shorter than
   * the window reads lower-but-wider under window-mean than under an
   * instantaneous diagnostic, so cross-model comparisons must consult the
   * declaration.
   */
  precipitationMmHr: scalarSchema.describe(
    'Precipitation rate, mm/h. SEMANTICS DIFFER BY PROVIDER — declared per model in models.json capabilities.precipitation and echoed in the document\'s top-level semantics.precipitation: "instantRate" = instantaneous rate diagnostic at validAt; "windowMeanRate" = accumulation over the step window ending at validAt divided by the window length.',
  ),
  sensibleHeatFluxWm2: scalarSchema.describe("Surface sensible heat flux, W/m2."),
  latentHeatFluxWm2: scalarSchema.describe("Surface latent heat flux, W/m2."),
  /* The science-wave fields below are additive and optional: a model
     publishes each one only where its transport carries it (models.json
     capabilities say which). Absence means "not published", never zero. */
  /**
   * 10 m wind gust, m/s. The SEMANTICS DIFFER BY PROVIDER and are declared
   * per model in models.json `capabilities.gust`, echoed on the document in
   * the top-level `semantics.gust` tag: ECCC models publish the maximum
   * model-timestep gust over the hour ending at validAt ("hourMax", the
   * pilot's "gusting to"); NOAA models publish only the instantaneous
   * diagnostic gust at validAt ("instant"). Hour-max runs systematically
   * ~20-30 % higher than instant, so cross-model comparisons must consult
   * the declaration.
   */
  windGustMs: scalarSchema
    .optional()
    .describe(
      '10 m wind gust, m/s. SEMANTICS DIFFER BY PROVIDER — declared per model in models.json capabilities.gust and echoed in the document\'s top-level semantics.gust: "hourMax" = maximum model-timestep gust over the hour ending at validAt (ECCC, the pilot\'s "gusting to"); "instant" = instantaneous diagnostic gust at validAt (NOAA). Hour-max runs ~20-30 % higher systematically. Absent where the model publishes no gust.',
    ),
  /**
   * Surface-based CAPE, J/kg (>= 0), instantaneous — the parcel a
   * surface-heated thermal actually flies. The one CAPE variant every
   * capable model shares; ECCC's "not computed" sentinels (9999 on
   * RDPS/GDPS, -1 on the HRDPS family) are masked in the pipeline and the
   * field is omitted for those hours.
   */
  capeJkg: scalarSchema
    .optional()
    .describe(
      'Surface-based CAPE, J/kg (>= 0), instantaneous — the parcel a surface-heated thermal actually flies. Provider "not computed" sentinels are masked upstream; absent means "not published", never zero.',
    ),
  /**
   * Surface-based CIN, J/kg (<= 0), instantaneous. Exists only on
   * RDPS/GDPS/HRRR/GFS — the HRDPS family publishes CAPE with no CIN, so
   * capabilities decouple `cin` from `cape` and absence must not be read
   * as "no cap".
   */
  cinJkg: scalarSchema
    .optional()
    .describe(
      "Surface-based CIN, J/kg (<= 0), instantaneous. Decoupled from CAPE in the capabilities (the HRDPS family publishes CAPE with no CIN); absence must not be read as \"no cap\".",
    ),
  /**
   * Model planetary-boundary-layer depth, metres ABOVE GROUND (AGL), not
   * MSL. To plot it on the altitude axis next to derived.boundaryLayerTopM
   * (which is MSL), add site.modelElevationM first.
   */
  pblHeightM: scalarSchema
    .optional()
    .describe(
      "Model planetary-boundary-layer depth, metres ABOVE GROUND (AGL), not MSL — add site.modelElevationM before comparing with derived.boundaryLayerTopM (MSL).",
    ),
  /**
   * Instantaneous low / middle / high cloud-layer fractions, % 0-100
   * (NOAA models only). The bands are NCEP's terrain-following sigma
   * layers (low sigma 1.0-0.642, middle 0.642-0.35, high 0.35-0.15 of
   * surface pressure), not fixed altitudes.
   */
  lowCloudPercent: scalarSchema
    .optional()
    .describe(
      "Instantaneous low cloud-layer fraction, % 0-100 (NOAA models only). NCEP's terrain-following sigma band (1.0-0.642 of surface pressure), not a fixed altitude.",
    ),
  midCloudPercent: scalarSchema
    .optional()
    .describe(
      "Instantaneous middle cloud-layer fraction, % 0-100 (NOAA models only). NCEP sigma band 0.642-0.35 of surface pressure.",
    ),
  highCloudPercent: scalarSchema
    .optional()
    .describe(
      "Instantaneous high cloud-layer fraction, % 0-100 (NOAA models only). NCEP sigma band 0.35-0.15 of surface pressure.",
    ),
});
export type WindgramSurface = z.infer<typeof windgramSurfaceSchema>;

export const windgramLevelSchema = z.object({
  /**
   * Isobaric level pressure, hPa — the vertical coordinate, in the
   * hectopascals levels are named by everywhere in meteorology (925, 850,
   * …). Surface pressure (`surface.pressurePa`), a measured quantity, is
   * SI pascals instead; the unit split is deliberate.
   */
  pressureHpa: scalarSchema.describe(
    "Isobaric level pressure, hPa — the vertical coordinate, in the conventional hectopascals levels are named by (925, 850, …); surface.pressurePa, a measured quantity, is SI pascals instead.",
  ),
  heightM: scalarSchema.describe("Geopotential height of the level, metres MSL."),
  temperatureC: scalarSchema.describe("Level temperature, degC."),
  dewPointC: scalarSchema.describe("Level dew point, degC."),
  windSpeedMs: scalarSchema.describe("Level wind speed, m/s."),
  windDirectionDeg: scalarSchema.describe(
    "Level wind direction, meteorological convention (from), 0-359 deg.",
  ),
  // Omitted until a model's transport provides omega (the GRIB wave);
  // models.json capabilities.verticalVelocity says which models carry it.
  verticalVelocityPaS: scalarSchema
    .optional()
    .describe(
      "Vertical velocity as pressure tendency (omega), Pa/s; negative is lift. Present only on models and levels declared by models.json capabilities.verticalVelocity / verticalVelocityLevels.",
    ),
  /**
   * Per-isobaric-level total cloud fraction, % 0-100. GFS is the only
   * published model with a cloud profile (capabilities.cloudProfile);
   * unlike omega it is level-complete within GFS, only model-sparse.
   */
  cloudFractionPercent: scalarSchema
    .optional()
    .describe(
      "Per-isobaric-level total cloud fraction, % 0-100. Present only where models.json capabilities.cloudProfile is true (GFS today); level-complete within a capable model, only model-sparse.",
    ),
});
export type WindgramLevel = z.infer<typeof windgramLevelSchema>;

/* Pipeline-authoritative published quantities, unsmoothed. windgram/derive
   also exposes usableLiftTopM as a projection over published inputs for
   another sink rate; it does not replace the stored 1.0 m/s value. */
export const windgramDerivedSchema = z.object({
  /**
   * Parcel-derived boundary-layer top, metres MSL: the height where a
   * surface parcel lifted dry-adiabatically stops being warmer than the
   * model environment, interpolated between the bracketing levels. Null
   * when the surface parcel is never buoyant — no positive-buoyancy depth
   * at all (night, rain, hard inversions) — which is a real forecast of
   * "no convective mixing", not a gap. When the parcel outclimbs the entire
   * published column the value is the column ceiling, not physics; ensemble
   * documents record that censoring in the position's `ceiledMembers`.
   * Derivation: site/src/content/docs/docs/python/derivation-science.mdx ("Lift the surface parcel").
   */
  boundaryLayerTopM: scalarSchema
    .nullable()
    .describe(
      "Parcel-derived boundary-layer top, metres MSL — where a dry-adiabatically lifted surface parcel stops being warmer than the model environment, interpolated between bracketing levels. Null when the parcel is never buoyant (no positive-buoyancy depth: night, rain, hard inversions) — a real forecast, not a gap. A parcel outclimbing the whole column yields the column ceiling, not physics; ensemble documents record that censoring in ceiledMembers.",
    ),
  /**
   * Deardorff's convective velocity scale w*, m/s — the strength scale of
   * boundary-layer thermals. Computed as the cube root of
   * (g/θ) × virtual kinematic heat flux × boundary-layer depth, where the
   * virtual heat flux combines the published sensible and latent fluxes
   * (the latent flux enters through the virtual-temperature correction —
   * moist air is buoyant air). Zero whenever the virtual heat flux or the
   * boundary-layer depth is non-positive — night, rain, heavily suppressed
   * heating — so zero means "no thermals", never "unknown". Derivation and
   * constants: site/src/content/docs/docs/python/derivation-science.mdx ("Turn surface heating
   * into w*").
   */
  thermalVelocityMs: scalarSchema.describe(
    'Deardorff\'s convective velocity scale w*, m/s: cube root of (g/theta) x virtual kinematic heat flux x boundary-layer depth, from the published sensible and latent heat fluxes (latent enters via the virtual-temperature correction) and the parcel-derived depth. Zero when the virtual heat flux or depth is non-positive (night, rain) — "no thermals", never "unknown". Derivation: site/src/content/docs/docs/python/derivation-science.mdx.',
  ),
  /**
   * Effective cloud base, metres MSL — always present, never null. The
   * LOWER of two estimates: the surface parcel's lifting condensation
   * level from Bolton (1980, Mon. Wea. Rev. 108, eq. 15 — explicit LCL
   * temperature from surface temperature and dew point, no iteration), and
   * the first level where the published column itself already saturates
   * (dew-point depression at the 0.5 °C cloud-hatch threshold,
   * interpolated between samples). Clamped to model terrain: a saturated
   * or supersaturated surface puts cloud base at the ground, and the value
   * never sits below it. It CAN sit below boundaryLayerTopM — that is a
   * forecast of cloud forming inside the convective layer (overdevelopment
   * territory), not an inconsistency. Derivation:
   * site/src/content/docs/docs/python/derivation-science.mdx ("Estimate cloud base").
   */
  cloudBaseM: scalarSchema.describe(
    "Effective cloud base, metres MSL, always present. The LOWER of the surface parcel's condensation level (Bolton 1980, eq. 15) and the first level where the published column itself saturates (dew-point depression at the 0.5 degC hatch threshold, interpolated), clamped to model terrain (a saturated surface puts it at the ground). CAN sit below boundaryLayerTopM — cloud forming inside the convective layer, not an inconsistency. Derivation: site/src/content/docs/docs/python/derivation-science.mdx.",
  ),
  /**
   * Usable-lift top ("hcrit"), metres MSL: the height where the STRONGEST
   * thermal core still out-climbs the pilot's sink rate. The core profile
   * is w* × 4 × z^(1/3) × (1 − 0.8 z) with z = height / boundary-layer
   * depth — canadarasp's hcrit, the 4 being Lenschow & Stephens' mean-
   * updraft coefficient (1.34) times ~3 for the core, which is why the
   * line can sit above the boundary layer: cores overshoot the mixed-layer
   * top before they die. The published value EMBEDS the fixed 1.0 m/s sink
   * convention — that convention is part of the value. Capped by
   * cloudBaseM everywhere; null when even the profile-maximum core cannot
   * beat the sink rate (2.02 × w* < 1 m/s) — weak days publish null, not
   * zero. For other sink rates ("what about my glider?"), the
   * parameterized `usableLiftTopM` in windgram/derive recomputes this from
   * published inputs alone.
   */
  usableLiftTopM: scalarSchema
    .nullable()
    .describe(
      "Usable-lift top (hcrit), metres MSL: where the STRONGEST thermal core — w* x 4 x z^(1/3) x (1 - 0.8 z), z = height / boundary-layer depth — falls back to the pilot's sink rate. EMBEDS the fixed 1.0 m/s sink convention (part of the published value). Capped by cloudBaseM; null when even the profile-maximum core cannot beat the sink (2.02 x w* < 1 m/s). Other sink rates: the parameterized usableLiftTopM in windgram/derive.",
    ),
});
export type WindgramDerived = z.infer<typeof windgramDerivedSchema>;

/* Wildfire smoke from the profile model's OWN run — never another model's
   (cross-model smoke lives in its own document kind, joined by consumers).
   Whether the model's radiation already feels this smoke is declared in
   models.json capabilities.smoke and echoed in semantics.smoke. */
export const windgramSmokeSchema = z.object({
  /**
   * Near-surface smoke mass concentration, µg/m³ — the visibility and
   * health number. HRRR publishes it at 8 m above ground (MASSDEN).
   */
  surfaceUgm3: scalarSchema.describe(
    "Near-surface smoke mass concentration, µg/m³ — the visibility/health number. HRRR publishes it at 8 m above ground (MASSDEN).",
  ),
  /**
   * Vertically integrated smoke mass, mg/m² (column mass density, COLMD) —
   * the total smoke over the site regardless of the layer it rides in.
   */
  columnMgm2: scalarSchema.describe(
    "Vertically integrated smoke mass, mg/m² (column mass density) — total smoke over the site regardless of the layer it rides in.",
  ),
  /**
   * Column aerosol optical thickness, dimensionless (AOTK) — the
   * sun-dimming number, the optics input for smoke-adjusted derivations.
   * HRRRv4's only prognostic aerosol is wildfire smoke (no dust or
   * anthropogenic aerosols), so its AOT is effectively smoke optical depth.
   */
  aot: scalarSchema.describe(
    "Column aerosol optical thickness, dimensionless — the sun-dimming number and the optics input for smoke-adjusted derivations. HRRRv4's only prognostic aerosol is wildfire smoke, so its AOT is effectively smoke optical depth.",
  ),
});
export type WindgramSmoke = z.infer<typeof windgramSmokeSchema>;

export const windgramHourSchema = z.object({
  validAt: utcInstantSchema.describe("Forecast valid time, UTC instant."),
  surface: windgramSurfaceSchema,
  // Ascending height; only levels with heightM > modelElevationM + 20.
  // Empty for models whose capabilities.levels is false (REPS today).
  levels: z
    .array(windgramLevelSchema)
    .describe(
      "Isobaric levels, ascending height; only levels with heightM > modelElevationM + 20. Empty for models whose capabilities.levels is false.",
    ),
  derived: windgramDerivedSchema,
  /**
   * Prognostic wildfire smoke from the profile model's own run — present
   * only on models whose models.json `capabilities.smoke` is not false
   * (HRRR today). Absence means "not published", never clear air. Whether
   * the model's radiation and fluxes already feel this smoke — i.e.
   * whether `derived` is already smoke-aware — is declared in
   * `capabilities.smoke` and echoed in `semantics.smoke`.
   */
  smoke: windgramSmokeSchema
    .optional()
    .describe(
      'Prognostic wildfire smoke from the profile model\'s own run — present only where models.json capabilities.smoke is not false. Absence means "not published", never clear air. Whether derived is already smoke-aware is declared in capabilities.smoke and echoed in semantics.smoke.',
    ),
});
export type WindgramHour = z.infer<typeof windgramHourSchema>;

/* SAMPLE PROVENANCE, deliberately not launch identity: a windgram document
   describes the atmosphere the model computed over a grid sample and is
   launch-agnostic. This block records where the atmosphere was sampled and
   what the model's own ground there is; launch attributes (a name, an
   elevation) arrive at render time (SceneOptions.launch) — a missing
   launch marker is honest, a baked-in one would bind a grid forecast to
   one launch. */
export const windgramSiteSchema = z
  .object({
    id: slugSchema,
    name: z.string().min(1),
    latitude: z.number(),
    longitude: z.number(),
    /**
     * The model's own terrain elevation at the sampled grid point, metres
     * MSL — the plot floor and the physics reference. It stays here because
     * it is a fact about the model's sample, not about any launch.
     */
    modelElevationM: z
      .number()
      .describe(
        "The model's own terrain elevation at the sampled grid point, metres MSL — the plot floor and the physics reference; a fact about the model's sample, not about any launch.",
      ),
    /**
     * The site's IANA timezone (e.g. "America/Vancouver"), echoed per-profile
     * from the sites.json catalogue so a stored document stays interpretable
     * on its own — local time is load-bearing for reading a windgram (the
     * pilots' day, window edges, cap timing). Optional: absence means the
     * document predates the echo, never that UTC applies locally.
     */
    timeZone: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The site\'s IANA timezone (e.g. "America/Vancouver"), echoed per-profile from the sites.json catalogue — local time is load-bearing for reading a windgram. Absence means the document predates the echo, never that UTC applies locally.',
      ),
  })
  .describe(
    "Sample provenance: where the atmosphere was sampled and the model's own ground there. Launch attributes are deliberately absent — a windgram document is launch-agnostic, and the launch arrives at render time (SceneOptions.launch); a missing launch marker is honest, a baked-in one would bind a grid forecast to one launch.",
  );
export type WindgramSite = z.infer<typeof windgramSiteSchema>;

export const windgramRunSchema = z.object({
  referenceTime: utcInstantSchema.describe("Model run reference time (initialization), UTC."),
  generatedAt: utcInstantSchema.describe("When the pipeline generated this document, UTC."),
  /**
   * Ensemble member count for the run, declared once here. OMITTED on
   * deterministic documents — the absence IS the deterministic
   * declaration, and `isDeterministicProfile` checks it first. Each
   * EnsembleValue's own `members` is the per-position count of
   * contributing members, which can be lower than this where members were
   * censored.
   */
  members: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Ensemble member count for the run, declared once. OMITTED on deterministic documents — the absence is the deterministic declaration. Per-position EnsembleValue.members can be lower where members were censored.",
    ),
});
export type WindgramRun = z.infer<typeof windgramRunSchema>;

/**
 * Per-document echo of the provider semantics models.json declares for the
 * model — present from the 0.3.0 wave so a stored profile stays
 * interpretable on its own, without the catalogue beside it. Optional at
 * every layer: absence means the document (or the field's model) predates
 * the tag, never that a default semantic applies.
 */
export const windgramSemanticsSchema = z
  .object({
    /**
     * Gust semantics for `surface.windGustMs`: "hourMax" = maximum
     * model-timestep gust over the hour ending at validAt (ECCC, the
     * pilot's "gusting to"); "instant" = instantaneous diagnostic gust at
     * validAt (NOAA). Mirrors models.json `capabilities.gust`.
     */
    gust: z
      .enum(["hourMax", "instant"])
      .optional()
      .describe(
        'Gust semantics for surface.windGustMs: "hourMax" = maximum model-timestep gust over the hour ending at validAt (ECCC); "instant" = instantaneous diagnostic at validAt (NOAA). Mirrors models.json capabilities.gust.',
      ),
    /**
     * Precipitation-rate semantics for `surface.precipitationMmHr`:
     * "instantRate" = the model's instantaneous rate diagnostic at
     * validAt; "windowMeanRate" = accumulation over the step window ending
     * at validAt divided by the window length. Mirrors models.json
     * `capabilities.precipitation`.
     */
    precipitation: z
      .enum(["instantRate", "windowMeanRate"])
      .optional()
      .describe(
        'Precipitation-rate semantics for surface.precipitationMmHr: "instantRate" = instantaneous rate diagnostic at validAt; "windowMeanRate" = accumulation over the step window ending at validAt divided by the window length. Mirrors models.json capabilities.precipitation.',
      ),
    /**
     * Smoke semantics for `hours[].smoke`: "radiativelyCoupled" = the
     * model's own radiation is attenuated by this smoke, so the published
     * fluxes and everything derived from them are ALREADY smoke-aware — a
     * downstream smoke derate would double-count; "passive" = the smoke
     * rides along without feeding back on the model's radiation, so
     * derived quantities are smoke-blind. Mirrors models.json
     * `capabilities.smoke`; present exactly when the document carries
     * smoke blocks.
     */
    smoke: z
      .enum(["radiativelyCoupled", "passive"])
      .optional()
      .describe(
        'Smoke semantics for hours[].smoke: "radiativelyCoupled" = the model\'s radiation is attenuated by this smoke, so fluxes and derived quantities are ALREADY smoke-aware (a downstream derate would double-count); "passive" = smoke rides along without radiative feedback, so derived quantities are smoke-blind. Mirrors models.json capabilities.smoke.',
      ),
  })
  .describe(
    "Per-document echo of the provider semantics models.json declares for this model, so a stored profile stays interpretable without the catalogue. Absence of the block or a field means the document predates the tag, never that a default applies.",
  );
export type WindgramSemantics = z.infer<typeof windgramSemanticsSchema>;

/* The document published at data/<model-slug>/sites/<site-slug>.json; history
   lines are exactly this document, one per line. Hours are ALL forecast
   hours, chronological — day windowing is a renderer choice (derive/). */
export const windgramProfileSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    model: slugSchema,
    run: windgramRunSchema,
    site: windgramSiteSchema,
    semantics: windgramSemanticsSchema.optional(),
    hours: z
      .array(windgramHourSchema)
      .describe("ALL forecast hours, chronological — day windowing is a renderer choice."),
  })
  .describe(
    "Windgram profile document, published at data/<model-slug>/sites/<site-slug>.json; history lines are the same document, one per line.",
  );
export type WindgramProfile = z.infer<typeof windgramProfileSchema>;

/* ---------------------------------------------------------- smoke document */

/* The first non-profile document kind: a per-site wildfire-smoke time
   series from an air-quality model (RAQDPS today). A different model than
   the wind-profile feeds — consumers join it to a profile by site and
   validAt; nothing from it is ever folded into a profile document. */

export const smokeDocumentHourSchema = z.object({
  validAt: utcInstantSchema.describe("Forecast valid time, UTC instant."),
  /**
   * Total near-surface PM2.5, µg/m³ — all sources, the air-quality number.
   */
  pm25Ugm3: scalarSchema.describe("Total near-surface PM2.5, µg/m³ — all sources."),
  /**
   * Near-surface PM2.5 attributed to wildfire smoke, µg/m³ (RAQDPS
   * PM2.5-WildfireSmokePlume_Sfc) — the wildfire share of pm25Ugm3.
   */
  smokePlumeSurfaceUgm3: scalarSchema.describe(
    "Near-surface PM2.5 attributed to wildfire smoke, µg/m³ — the wildfire share of pm25Ugm3.",
  ),
  /**
   * Vertically integrated wildfire-smoke PM2.5, mg/m² (RAQDPS
   * PM2.5-WildfireSmokePlume_EAtm) — total smoke over the site regardless
   * of the layer it rides in; the mass input for optics-based derivations.
   */
  smokePlumeColumnMgm2: scalarSchema.describe(
    "Vertically integrated wildfire-smoke PM2.5, mg/m² — total smoke over the site regardless of the layer it rides in; the mass input for optics-based derivations.",
  ),
});
export type SmokeDocumentHour = z.infer<typeof smokeDocumentHourSchema>;

export const smokeDocumentSiteSchema = z.object({
  id: slugSchema,
  name: z.string().min(1),
  latitude: z.number(),
  longitude: z.number(),
  /** The site's IANA timezone, echoed from the catalogue like the profile's. */
  timeZone: z
    .string()
    .min(1)
    .optional()
    .describe("The site's IANA timezone, echoed from the sites.json catalogue."),
});
export type SmokeDocumentSite = z.infer<typeof smokeDocumentSiteSchema>;

export const smokeDocumentSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    model: slugSchema,
    run: windgramRunSchema,
    site: smokeDocumentSiteSchema,
    hours: z
      .array(smokeDocumentHourSchema)
      .describe("ALL forecast hours, chronological — same convention as profile documents."),
  })
  .describe(
    "Per-site wildfire-smoke time series from an air-quality model (RAQDPS), published at <model-slug>/sites/<site-slug>.json — a different model than the wind-profile feeds; consumers join it to a profile by site and validAt.",
  );
export type SmokeDocument = z.infer<typeof smokeDocumentSchema>;

export function parseSmokeDocument(value: unknown): SmokeDocument | null {
  const result = smokeDocumentSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseSmokeDocumentJson(text: string): SmokeDocument | null {
  return parseSmokeDocument(tryParseJson(text));
}

/* ---------------------------------------------------- observation document */

/* The contract's third document kind: MEASUREMENTS, not forecasts — a
   per-site time series of satellite observations (GOES-18 downward
   shortwave today). Instants are the past at product cadence, so there is
   no run block and no forecast hours; the `observed` block carries the
   window and the generation instant instead. Consumers join observations
   to forecasts by instant — the natural use is truth beside prediction
   (measured irradiance under a smoke plume against the smoke-adjusted
   derivation's transmittance claim). */

const observedAtSchema = utcInstantSchema.describe(
  "Observation instant, UTC — the product's own timestamp, at its native cadence.",
);

export const dsrObservationSchema = z.object({
  observedAt: observedAtSchema,
  /**
   * Measured downward shortwave flux at the surface, W/m² (GOES-R ABI
   * L2 DSR). A DAYTIME product: instants with no good-quality retrieval
   * — night, quality-flagged pixels, scan gaps — are simply absent from
   * the series. Absence means "not measured", never zero.
   */
  downwardShortwaveWm2: z
    .number()
    .describe(
      'Measured downward shortwave flux at the surface, W/m² (GOES-R ABI L2 DSR). Daytime product: instants without a good-quality retrieval are absent from the series — "not measured", never zero.',
    ),
});
export type DsrObservation = z.infer<typeof dsrObservationSchema>;

export const aotObservationSchema = z.object({
  observedAt: observedAtSchema,
  /**
   * Measured aerosol optical thickness at 550 nm (GOES-R ABI L2 AOD,
   * high+medium quality retrievals) — dimensionless, the same quantity
   * and wavelength a smoke document forecasts as `aot`, so the two
   * compare directly. A daytime, clear-line-of-sight product: instants
   * with no accepted retrieval — night, cloud, failed quality tests —
   * are simply absent. Absence means "not measured", never clear air.
   */
  aot: z
    .number()
    .describe(
      'Measured aerosol optical thickness at 550 nm (GOES-R ABI L2 AOD, high+medium quality) — the same quantity and wavelength a smoke document forecasts as aot. Daytime product: instants without an accepted retrieval are absent — "not measured", never clear air.',
    ),
});
export type AotObservation = z.infer<typeof aotObservationSchema>;

/* One entry shape per product: a document's `model` names the dataset,
   and every entry in it carries that product's single measurement field.
   A union rather than one object with optional fields, so an entry can
   never be empty and a consumer narrows with a key check. */
export const observationSchema = z.union([dsrObservationSchema, aotObservationSchema]);
export type Observation = z.infer<typeof observationSchema>;

export const observationDocumentSiteSchema = z.object({
  id: slugSchema,
  name: z.string().min(1),
  latitude: z.number(),
  longitude: z.number(),
  /** The site's IANA timezone, echoed from the catalogue like the profile's. */
  timeZone: z
    .string()
    .min(1)
    .optional()
    .describe("The site's IANA timezone, echoed from the sites.json catalogue."),
});
export type ObservationDocumentSite = z.infer<typeof observationDocumentSiteSchema>;

export const observationDocumentSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    model: slugSchema,
    /**
     * The observation window and generation instant — the observation
     * kind's replacement for a forecast document's `run` block: there is
     * no model initialization, only the measured span this document
     * currently holds (a rolling window; the provider's own archive is
     * the permanent record).
     */
    observed: z
      .object({
        firstObservedAt: utcInstantSchema,
        lastObservedAt: utcInstantSchema,
        generatedAt: utcInstantSchema.describe(
          "When the pipeline generated this document, UTC.",
        ),
      })
      .describe(
        "The observation window and generation instant — the observation kind's replacement for a run block. The window rolls; the provider's own archive is the permanent record.",
      ),
    site: observationDocumentSiteSchema,
    observations: z
      .array(observationSchema)
      .describe(
        "Chronological measured instants at product cadence. Gaps are real: an absent instant had no good-quality retrieval (night, quality flags, scan gaps).",
      ),
  })
  .describe(
    "Per-site satellite observation time series (GOES-18 ABI L2 downward shortwave today), published at <model-slug>/sites/<site-slug>.json — measurements, not forecasts; join to profile or smoke documents by instant.",
  );
export type ObservationDocument = z.infer<typeof observationDocumentSchema>;

export function parseObservationDocument(value: unknown): ObservationDocument | null {
  const result = observationDocumentSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseObservationDocumentJson(text: string): ObservationDocument | null {
  return parseObservationDocument(tryParseJson(text));
}

/* ------------------------------------------- deterministic narrowing */

/* Recursively replaces every Scalar position with its number arm. Mapped
   from the contract types rather than restated, so a schema change cannot
   leave the narrowed types behind. EnsembleValue maps to never, which
   collapses `number | EnsembleValue` to `number` (and `Scalar | null` to
   `number | null`) wherever it appears. */
type NarrowScalars<T> = T extends EnsembleValue
  ? never
  : T extends ReadonlyArray<infer Element>
    ? Array<NarrowScalars<Element>>
    : T extends object
      ? { [Key in keyof T]: NarrowScalars<T[Key]> }
      : T;

/**
 * A profile document whose every Scalar position is a plain number — what
 * deterministic models publish. Narrow to it with `isDeterministicProfile`
 * and every `p50()` unwrap disappears: `hours[].surface.temperatureC` is a
 * `number`, `derived.usableLiftTopM` is `number | null`, and so on.
 * `run.members` is typed absent: ensemble documents declare it, and its
 * absence is the deterministic declaration.
 */
export type DeterministicWindgramProfile = Omit<NarrowScalars<WindgramProfile>, "run"> & {
  run: Omit<WindgramRun, "members"> & { members?: undefined };
};

/**
 * Narrows a parsed profile to `DeterministicWindgramProfile` — one check to
 * escape `p50()` everywhere downstream.
 *
 * Declaration-first: documents from the 0.3.0 pipeline wave declare
 * ensembles via `run.members`, so a present `members` answers in O(1).
 * When `members` is absent the document may simply predate the declaration
 * (schemaVersion stayed 1), so the guard falls back to a shape scan over
 * every Scalar position. The fallback's cost: for a genuinely deterministic
 * document it must visit every position to prove the negative —
 * O(hours × (surface fields + derived fields + levels × level fields)),
 * a few thousand property reads on a real 48 h profile — while a
 * pre-declaration ensemble document exits at the first percentile object
 * it meets (almost always the first position). Once no pre-0.3.0 documents
 * remain in the wild, the scan never runs for ensembles and only ever
 * confirms deterministics.
 *
 * Expects a document that passed the contract guards: zod strips unknown
 * keys, so every object value in a data position is an EnsembleValue.
 */
export function isDeterministicProfile(
  profile: WindgramProfile,
): profile is DeterministicWindgramProfile {
  if (profile.run.members !== undefined) return false;
  for (const hour of profile.hours) {
    if (recordHasEnsembleValue(hour.surface) || recordHasEnsembleValue(hour.derived)) {
      return false;
    }
    for (const level of hour.levels) {
      if (recordHasEnsembleValue(level)) return false;
    }
  }
  return true;
}

function recordHasEnsembleValue(record: object): boolean {
  for (const value of Object.values(record)) {
    if (typeof value === "object" && value !== null) return true;
  }
  return false;
}

/* ---------------------------------------------------------------- manifest */

export const windgramManifestSiteSchema = z.object({
  name: z.string().min(1),
  slug: slugSchema,
});
export type WindgramManifestSite = z.infer<typeof windgramManifestSiteSchema>;

/**
 * Build accounting with a stable core and an open, unstable rest. The four
 * core keys are contract — every manifest carries them, whatever the
 * transport: `downloads` (transport requests made), `downloadBytes` (bytes
 * fetched), `retries` (requests retried), `durationMs` (wall-clock build
 * time). Every OTHER key is transport-specific and UNSTABLE: builders add,
 * rename, and drop them freely between releases, so read them for
 * dashboards and curiosity, never for logic.
 */
export const windgramManifestStatsSchema = z
  .object({
    downloads: z.number().describe("Transport requests made during the build (stable core)."),
    downloadBytes: z.number().describe("Bytes fetched during the build (stable core)."),
    retries: z.number().describe("Requests retried during the build (stable core)."),
    durationMs: z.number().describe("Wall-clock build duration, ms (stable core)."),
  })
  .catchall(z.number())
  .describe(
    "Build accounting: the four core keys (downloads, downloadBytes, retries, durationMs) are stable contract; every other key is transport-specific and UNSTABLE — builders add, rename, and drop them freely, so never build logic on them.",
  );
export type WindgramManifestStats = z.infer<typeof windgramManifestStatsSchema>;

/* data/<model-slug>/manifest.json. `model` is the slug, like everywhere
   else. */
export const windgramManifestSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    model: slugSchema,
    referenceTime: utcInstantSchema,
    generatedAt: utcInstantSchema,
    firstForecastHour: z.number().int().nonnegative(),
    lastForecastHour: z.number().int().nonnegative(),
    forecastHours: z.number().int().nonnegative(),
    memberCount: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Ensemble member count; ensemble models only."),
    sites: z.array(windgramManifestSiteSchema),
    stats: windgramManifestStatsSchema,
  })
  .describe("Per-model build manifest, published at data/<model-slug>/manifest.json.");
export type WindgramManifest = z.infer<typeof windgramManifestSchema>;

/* ------------------------------------------------------------- models.json */

export const modelCapabilitiesSchema = z.object({
  levels: z.boolean().describe("False -> hours[].levels is always empty for this model."),
  // What the model publishes today; widens per model with the GRIB wave.
  pressureLevels: z
    .array(z.number())
    .describe("The isobaric levels (hPa) the model publishes today."),
  /**
   * Vertical-velocity provenance, not just presence: "omega" = the
   * provider's own published omega (Pa/s); "fromGeometricW" = omega
   * converted at build from the provider's geometric w via the hydrostatic
   * relation omega ~ -rho*g*w; false = not published. Either token fills
   * levels[].verticalVelocityPaS — the provenance is declared so consumers
   * can label converted values differently from native ones.
   */
  verticalVelocity: z
    .union([z.enum(["omega", "fromGeometricW"]), z.literal(false)])
    .describe(
      'Vertical-velocity provenance, not just presence: "omega" = the provider\'s own published omega (Pa/s); "fromGeometricW" = converted at build from geometric w via omega ~ -rho*g*w; false = not published. Declared so consumers can label converted values differently from native ones.',
    ),
  /**
   * The subset of `pressureLevels` (hPa) that actually carries omega
   * (levels[].verticalVelocityPaS) — providers publish omega on far fewer
   * levels than temperature or wind (the ECCC deterministic models today).
   * Present exactly when `verticalVelocity` is not false; a level absent
   * from this list never carries omega, so renderers can label the sparse
   * coverage instead of guessing at gaps.
   */
  verticalVelocityLevels: z
    .array(z.number())
    .optional()
    .describe(
      "The subset of pressureLevels (hPa) that actually carries omega — present exactly when verticalVelocity is not false. A level absent from this list never carries omega, so renderers can label the sparse coverage instead of guessing at gaps.",
    ),
  heatFluxes: z
    .boolean()
    .describe("Whether the model publishes surface sensible and latent heat fluxes."),
  /**
   * Gust semantics, not just presence: "hourMax" = max model-timestep gust
   * over the hour ending at validAt (ECCC), "instant" = diagnostic gust at
   * validAt (NOAA), false = no gust published. The two semantics differ by
   * ~20-30 % systematically, so renderers must label them differently.
   */
  gust: z
    .union([z.enum(["hourMax", "instant"]), z.literal(false)])
    .describe(
      'Gust semantics, not just presence: "hourMax" = max model-timestep gust over the hour ending at validAt (ECCC); "instant" = diagnostic gust at validAt (NOAA); false = no gust published. The two differ ~20-30 % systematically, so renderers must label them differently.',
    ),
  /**
   * Precipitation-rate semantics for `surface.precipitationMmHr`:
   * "instantRate" = the provider's instantaneous rate diagnostic at
   * validAt; "windowMeanRate" = accumulation over the publishing step
   * window ending at validAt divided by the window length. Required — every
   * model publishes precipitation, so unlike `gust` there is no false;
   * the semantics still differ by provider and renderers must caption them
   * differently. Echoed per document in the profile's `semantics` tag.
   */
  precipitation: z
    .enum(["instantRate", "windowMeanRate"])
    .describe(
      'Precipitation-rate semantics: "instantRate" = instantaneous rate diagnostic at validAt; "windowMeanRate" = accumulation over the step window ending at validAt divided by its length. Required — every model publishes precipitation, so unlike gust there is no false. Echoed per document in the profile\'s semantics tag.',
    ),
  cape: z.boolean().describe("Whether the model publishes surface-based CAPE (surface.capeJkg)."),
  // Deliberately decoupled from `cape`: the HRDPS family has CAPE, no CIN.
  cin: z
    .boolean()
    .describe(
      "Whether the model publishes surface-based CIN — deliberately decoupled from cape: the HRDPS family has CAPE with no CIN.",
    ),
  pblHeight: z
    .boolean()
    .describe("Whether the model publishes its own PBL depth (surface.pblHeightM, metres AGL)."),
  cloudLayers: z
    .boolean()
    .describe("Whether the model publishes low/mid/high cloud-layer fractions (NOAA sigma bands)."),
  cloudProfile: z
    .boolean()
    .describe("Whether the model publishes a per-level cloud fraction (levels[].cloudFractionPercent)."),
  /**
   * Smoke semantics, not just presence: "radiativelyCoupled" = the model
   * publishes prognostic smoke (hours[].smoke) whose direct radiative
   * effect attenuates its own shortwave, so the published fluxes and the
   * derived thermal quantities are ALREADY smoke-aware — a downstream
   * smoke derate would double-count (HRRRv4: Dowell et al. 2022, WAF,
   * doi:10.1175/WAF-D-21-0151.1, §2d); "passive" = smoke published
   * without radiative feedback, so derived quantities are smoke-blind
   * and a derate applies; false = no smoke fields published. Echoed per
   * document in the profile's `semantics.smoke`.
   */
  smoke: z
    .union([z.enum(["radiativelyCoupled", "passive"]), z.literal(false)])
    .describe(
      'Smoke semantics, not just presence: "radiativelyCoupled" = prognostic smoke whose radiative effect attenuates the model\'s own shortwave, so fluxes and derived thermal quantities are ALREADY smoke-aware and a downstream derate would double-count (HRRRv4: Dowell et al. 2022, doi:10.1175/WAF-D-21-0151.1); "passive" = smoke published without radiative feedback (derived quantities are smoke-blind, a derate applies); false = no smoke published. Echoed in the profile\'s semantics.smoke.',
    ),
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export const modelEntrySchema = z.object({
  slug: slugSchema, // == data/ directory name; the identity everywhere
  label: z.string().min(1).describe("The only place prose model names live."),
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
   * slow CDN. Required since 0.3.0 — every catalogue entry declares its
   * cadence, so consumers no longer need an absence fallback.
   */
  runIntervalHours: z
    .number()
    .positive()
    .describe(
      "Hours between the runs this dataset publishes — the model's own schedule where every run is built, or the built subset where it is not (HRRR declares 6, its published synoptic subset). Freshness metadata: a run older than about twice this interval is genuinely late. Required since 0.3.0.",
    ),
  /**
   * The upper end of NORMAL for this dataset's publish of a run after its
   * referenceTime, hours: the provider's complete-availability time plus
   * pipeline overhead (a ≤15 min poll plus the build), rounded up. A run
   * younger than `runIntervalHours + typicalPublicationLagHours` may be
   * the newest that can exist; older, and its successor is late. The fact
   * lives here; how much lateness a consumer tolerates is a threshold the
   * consumer owns (see derive's `runFreshness`). Seeded 2026-08-10 from
   * the dated [verified] provider availability in the portal's
   * forecast-model-feeds reference page; to be re-verified against the
   * accumulated run archive around September 2026.
   */
  typicalPublicationLagHours: z
    .number()
    .positive()
    .describe(
      "Upper end of normal for THIS dataset's publish of a run after its referenceTime, hours: provider complete-availability plus pipeline overhead (≤15 min poll + build), rounded up. Judge freshness against runIntervalHours + this; thresholds stay consumer-owned. Seeded 2026-08-10 from the dated [verified] availability times in the portal's forecast-model-feeds reference; re-verify against the accumulated run archive ~September 2026.",
    ),
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
    .optional()
    .describe(
      "Machine-readable retirement notice: no runs expected after date (UTC calendar date); successor names the replacing catalogue slug, or null for end-of-life with no replacement. Absent when no retirement is announced.",
    ),
  kind: z.enum(["deterministic", "ensemble"]),
  experimental: z.boolean(),
  capabilities: modelCapabilitiesSchema,
});
export type ModelEntry = z.infer<typeof modelEntrySchema>;

/**
 * A smoke-document model (RAQDPS today): the same identity and cadence
 * metadata as a profile entry, without profile capabilities — it publishes
 * smoke documents, not wind profiles. Deliberately NOT an entry in
 * `models`: adding a capabilities-less entry there would make every
 * already-deployed catalogue guard reject the whole file, so non-profile
 * datasets live in their own top-level array that older parsers strip.
 */
export const smokeModelEntrySchema = z.object({
  slug: slugSchema,
  label: z.string().min(1).describe("The only place prose model names live."),
  provider: z.string().min(1),
  gridKm: z.number().positive(),
  stepHours: z.number().positive(),
  horizonHours: z.number().positive(),
  runIntervalHours: z
    .number()
    .positive()
    .describe("Hours between published runs — freshness metadata, like the profile entries'."),
  /** Same semantics, seeding, and re-verification intent as the profile entries'. */
  typicalPublicationLagHours: z
    .number()
    .positive()
    .describe(
      "Upper end of normal for THIS dataset's publish of a run after its referenceTime, hours — semantics, 2026-08-10 forecast-model-feeds seeding, and ~September 2026 re-verification intent exactly as on the profile entries.",
    ),
  kind: z.enum(["deterministic", "ensemble"]),
  experimental: z.boolean(),
});
export type SmokeModelEntry = z.infer<typeof smokeModelEntrySchema>;

/**
 * An observation dataset (GOES-18 DSR today): satellite measurements at
 * the catalogued sites. Identity and provenance metadata only — there is
 * no forecast horizon, run interval, or publication lag (nothing has
 * runs to lag); `cadenceMinutes` is the product's native observation
 * cadence, the freshness yardstick (an observation series whose newest
 * instant is much older than a few cadences during daylight is genuinely
 * late). Like `smokeModels`, deliberately NOT an entry in `models`.
 */
export const observationModelEntrySchema = z.object({
  slug: slugSchema,
  label: z.string().min(1).describe("The only place prose model names live."),
  provider: z.string().min(1),
  gridKm: z
    .number()
    .positive()
    .describe("Nominal product resolution at the sites, km — not the instrument's finest."),
  cadenceMinutes: z
    .number()
    .positive()
    .describe("Native observation cadence, minutes — the freshness yardstick."),
  experimental: z.boolean(),
});
export type ObservationModelEntry = z.infer<typeof observationModelEntrySchema>;

/* data/models.json — hand-maintained, the discovery catalogue. Frontends
   render what a model declares instead of hardcoding model lists. */
export const modelCatalogueSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    models: z.array(modelEntrySchema),
    /**
     * Smoke-document models (RAQDPS today). Optional and separate from
     * `models` so pre-smoke consumers — whose guards require profile
     * capabilities on every `models` entry — keep parsing the catalogue
     * untouched. Absence means the catalogue predates smoke documents.
     */
    smokeModels: z
      .array(smokeModelEntrySchema)
      .optional()
      .describe(
        "Smoke-document models (RAQDPS today) — separate from models so pre-smoke consumers keep parsing the catalogue. Absence means the catalogue predates smoke documents.",
      ),
    /**
     * Observation datasets (GOES-18 DSR today). Optional and separate
     * from `models` for the same compatibility reason as `smokeModels`:
     * older parsers strip the unknown key and keep working. Absence
     * means the catalogue predates observations.
     */
    observationModels: z
      .array(observationModelEntrySchema)
      .optional()
      .describe(
        "Observation datasets (GOES-18 DSR today) — separate from models so pre-observation consumers keep parsing the catalogue. Absence means the catalogue predates observations.",
      ),
  })
  .describe(
    "data/models.json — the hand-maintained discovery catalogue. Frontends render what a model declares instead of hardcoding model lists.",
  );
export type ModelCatalogue = z.infer<typeof modelCatalogueSchema>;

/* -------------------------------------------------------------- sites.json */

/* Identity and build selection ONLY — nothing physical. Humans author
   WHERE (coordinates, identity); the pipeline measures WHAT (elevation,
   terrain, land cover — site-context.json is the home of those). No
   elevation of any kind lives here since schemaVersion 2. */
export const siteCatalogueEntrySchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1),
    latitude: z.number(),
    longitude: z.number(),
    /**
     * The site's IANA timezone (e.g. "America/Vancouver") — the catalogue is
     * its home, and it is required: local time is load-bearing for reading a
     * windgram (the pilots' day, window edges, cap timing), so every
     * catalogued site declares it. Builders echo it per-profile as the
     * optional `site.timeZone`.
     */
    timeZone: z
      .string()
      .min(1)
      .describe(
        'The site\'s IANA timezone (e.g. "America/Vancouver") — required; the catalogue is its home. Local time is load-bearing for reading a windgram, and builders echo it per-profile as the optional site.timeZone.',
      ),
  })
  .describe(
    "One catalogued site: identity and build selection only — humans author WHERE, and nothing physical. The pipeline measures WHAT at these coordinates and publishes it in site-context.json.",
  );
export type SiteCatalogueEntry = z.infer<typeof siteCatalogueEntrySchema>;

/* sites.json at the repository root — hand-maintained, the site catalogue.
   schemaVersion 2 since the launch-decoupling wave: identity and build
   selection only, no elevation field (v1 carried the launch's typed-in
   elevationM; the guard rejects v1 by its version literal). Published to
   the dataset root VERBATIM — there is no separate published shape. */
export const sitesCatalogueSchema = z
  .object({
    schemaVersion: z.literal(SITES_SCHEMA_VERSION),
    sites: z.array(siteCatalogueEntrySchema),
  })
  .describe(
    "sites.json — the hand-maintained site catalogue: every site the builders publish documents for. Identity and build selection only: humans author WHERE; the pipeline measures WHAT (site-context.json). Published to the dataset root verbatim.",
  );
export type SitesCatalogue = z.infer<typeof sitesCatalogueSchema>;

/* ------------------------------------------------------ site-context.json */

/* Static per-site ground truth, machine-measured from open elevation and
   land-cover data — the third catalogue file, beside hand-maintained
   sites.json and models.json, and the ONE published home of
   pipeline-measured physical fact: humans author WHERE (sites.json), the
   pipeline measures WHAT (this file). It answers "what is this site,
   physically?" where a profile can only answer "what does this model think
   the atmosphere above it does?": how far the model's smoothed terrain
   sits from the real mountain is read by joining a profile's
   site.modelElevationM against this document's elevations. No cadence and
   no runs — regenerate when the site catalogue changes, never on a
   schedule. */

/** WorldCover class, published as a semantic name rather than the numeric
 * code so the JSON reads without a lookup table. */
export const landCoverClassSchema = z
  .enum([
    "treeCover",
    "shrubland",
    "grassland",
    "cropland",
    "builtUp",
    "bareSparse",
    "snowIce",
    "water",
    "wetland",
    "mangroves",
    "mossLichen",
  ])
  .describe(
    "Land-cover class, the ESA WorldCover taxonomy published as semantic names (10 treeCover, 20 shrubland, 30 grassland, 40 cropland, 50 builtUp, 60 bareSparse, 70 snowIce, 80 water, 90 wetland, 95 mangroves, 100 mossLichen).",
  );
export type LandCoverClass = z.infer<typeof landCoverClassSchema>;

export const siteContextSourceSchema = z
  .object({
    id: slugSchema,
    product: z.string().min(1).describe("Human-readable product name and vintage."),
    kind: z
      .enum(["surfaceModel", "bareEarthModel", "landCover"])
      .describe(
        'What the source measures: "surfaceModel" = DSM, canopy and buildings included; "bareEarthModel" = DTM, ground returns only; "landCover" = classified cover.',
      ),
    resolutionM: z.number().positive().describe("Native ground resolution, metres."),
    licence: z.string().min(1).describe('Licence name (e.g. "CC-BY 4.0", "OGL-BC").'),
    /**
     * The attribution statement the source's licence requires — it must
     * travel with the data, so it lives in the document, not only in the
     * docs. Renderers that display values from this source display this.
     */
    attribution: z
      .string()
      .min(1)
      .describe(
        "The attribution statement the source's licence requires. It travels with the data; renderers displaying this source's values display it.",
      ),
    url: z.string().min(1).describe("The source's authoritative landing page."),
  })
  .describe(
    "One upstream data source, with the licence attribution that must travel with its values.",
  );
export type SiteContextSource = z.infer<typeof siteContextSourceSchema>;

export const siteContextReliefSchema = z
  .object({
    radiusKm: z.number().positive(),
    minM: z.number().describe("Lowest terrain in the disc, metres MSL."),
    maxM: z.number().describe("Highest terrain in the disc, metres MSL."),
    /**
     * The launch's percentile rank within the disc's terrain — 100 means
     * the launch IS the local summit, 50 means it sits mid-slope in its
     * surroundings. Read radii together: high at 1 km and low at 10 km is
     * a foothill in front of bigger terrain.
     */
    percentile: z
      .number()
      .min(0)
      .max(100)
      .describe(
        "The launch elevation's percentile rank among the disc's terrain: 100 = the local summit, 50 = mid-slope. Read radii together — high at 1 km and low at 10 km is a foothill in front of bigger terrain.",
      ),
  })
  .describe("Terrain relief within one radius of the launch.");
export type SiteContextRelief = z.infer<typeof siteContextReliefSchema>;

export const siteContextTerrainSchema = z
  .object({
    source: slugSchema.describe("The sources[] entry these values came from."),
    elevationM: z
      .number()
      .describe(
        "Terrain-model elevation at the catalogued point, metres MSL, bilinear. From a surface model this includes canopy — compare with the elevation pick before reading small differences as error (a gap over ~100 m suggests the pin hits different terrain in different sources).",
      ),
    slopeDeg: z
      .number()
      .min(0)
      .describe("Terrain slope at the launch, degrees (Horn 3×3 on the source grid)."),
    /**
     * Compass bearing of the downslope direction, degrees 0-359. Treat as
     * low-confidence on near-summit launches, where tiny elevation noise
     * swings the bearing.
     */
    aspectDeg: z
      .number()
      .min(0)
      .max(359)
      .describe(
        "Compass bearing of the downslope direction, degrees 0-359. Low-confidence on near-summit launches (relief percentile near 100), where noise swings the bearing.",
      ),
    relief: z
      .array(siteContextReliefSchema)
      .min(1)
      .describe("Relief discs, ascending radius."),
  })
  .describe(
    "Terrain analysis from ONE consistent elevation model across every site, so numbers compare across the catalogue.",
  );
export type SiteContextTerrain = z.infer<typeof siteContextTerrainSchema>;

/* THE launch elevation: a measurement selection, not a computation. The
   pipeline samples ground observations at the catalogued coordinates and
   picks by explicit priority — lidarbc (1 m ground returns) → mrdem30
   (30 m national DTM) → glo30 (surface model, canopy included — a loud
   last resort). Replaced v1's optional bareEarth block: the pick IS the
   best bare-earth, and keeping both would duplicate. */
export const siteContextElevationSchema = z
  .object({
    source: slugSchema.describe("The sources[] entry the pick came from."),
    elevationM: z
      .number()
      .describe("The picked ground elevation at the catalogued coordinates, metres MSL, bilinear."),
  })
  .describe(
    "THE launch elevation: a measurement selection, not a computation — the pipeline samples ground observations at the catalogued coordinates and picks by explicit priority: lidarbc 1 m ground returns → mrdem30 30 m national DTM → glo30 surface model as a loud last resort (canopy included).",
  );
export type SiteContextElevation = z.infer<typeof siteContextElevationSchema>;

export const siteContextLandCoverFractionsSchema = z
  .object({
    radiusKm: z.number().positive(),
    byClass: z
      .partialRecord(landCoverClassSchema, z.number().min(0).max(1))
      .describe(
        "Fraction of the disc under each class, 0-1. Classes absent from the disc are omitted — absence means zero here (the map is wall-to-wall), unlike data absences elsewhere in the contract.",
      ),
  })
  .describe("Land-cover composition within one radius of the launch.");
export type SiteContextLandCoverFractions = z.infer<typeof siteContextLandCoverFractionsSchema>;

export const siteContextLandCoverSchema = z
  .object({
    source: slugSchema.describe("The sources[] entry these values came from."),
    atLaunch: landCoverClassSchema.describe(
      "The class of the single pixel under the launch point. One 10 m pixel is fragile — read it beside the 1 km fractions.",
    ),
    fractions: z
      .array(siteContextLandCoverFractionsSchema)
      .min(1)
      .describe("Composition discs, ascending radius."),
  })
  .describe(
    "What the ground around the launch is made of — the thermal-source character (forest holds heat back; clearcut, rock and grass release it; water kills it).",
  );
export type SiteContextLandCover = z.infer<typeof siteContextLandCoverSchema>;

export const siteContextEntrySchema = z
  .object({
    elevation: siteContextElevationSchema,
    terrain: siteContextTerrainSchema,
    landCover: siteContextLandCoverSchema,
  })
  .describe(
    "One site's measured ground truth: the elevation pick, terrain analysis, and land cover. Coordinates and timezone are NOT echoed here — sites.json is their home; join by slug.",
  );
export type SiteContextEntry = z.infer<typeof siteContextEntrySchema>;

/* site-context.json at the repository root, machine-written by the
   pipeline's one-shot `windgram terrain` command and committed like the
   catalogues it annotates. Published to the dataset root beside
   sites.json. */
export const siteContextSchema = z
  .object({
    schemaVersion: z.literal(SITE_CONTEXT_SCHEMA_VERSION),
    generatedAt: utcInstantSchema.describe("When the context was generated, UTC."),
    sources: z
      .array(siteContextSourceSchema)
      .min(1)
      .describe("Every upstream source any site block references, with licence attributions."),
    sites: z
      .record(slugSchema, siteContextEntrySchema)
      .describe("Site slug → context. Join against sites.json; slugs are the identity."),
  })
  .describe(
    "site-context.json — static per-site ground truth (the elevation pick, terrain, land cover), machine-measured from open data and committed beside the hand-maintained catalogues: humans author WHERE (sites.json); the pipeline measures WHAT (this file). No cadence: regenerate when the site catalogue changes.",
  );
export type SiteContext = z.infer<typeof siteContextSchema>;

/* -------------------------------------------------------------- runs.json */

export const runsIndexEntrySchema = z.object({
  referenceTime: utcInstantSchema.describe("The model's currently published run, UTC."),
  generatedAt: utcInstantSchema.describe("When that run's documents were generated, UTC."),
});
export type RunsIndexEntry = z.infer<typeof runsIndexEntrySchema>;

/* data/runs.json — the machine-written cross-model run index, keyed by
   model slug: per published model, its manifest's (referenceTime,
   generatedAt) pair, regenerated wholesale from the on-disk manifests at
   every publish. One fetch answers "how fresh is everything" without
   touching a manifest per model; judge lateness against each model's
   declared runIntervalHours. */
export const runsIndexSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    runs: z
      .record(slugSchema, runsIndexEntrySchema)
      .describe("Model slug -> the manifest's (referenceTime, generatedAt) pair."),
  })
  .describe(
    "data/runs.json — the machine-written cross-model run index, keyed by model slug: per published model, its manifest's (referenceTime, generatedAt) pair, regenerated wholesale at every publish. One fetch answers \"how fresh is everything\"; judge lateness against each model's declared runIntervalHours.",
  );
export type RunsIndex = z.infer<typeof runsIndexSchema>;

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

export function parseSitesCatalogue(value: unknown): SitesCatalogue | null {
  const result = sitesCatalogueSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseSitesCatalogueJson(text: string): SitesCatalogue | null {
  return parseSitesCatalogue(tryParseJson(text));
}

export function parseSiteContext(value: unknown): SiteContext | null {
  const result = siteContextSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseSiteContextJson(text: string): SiteContext | null {
  return parseSiteContext(tryParseJson(text));
}

export function parseRunsIndex(value: unknown): RunsIndex | null {
  const result = runsIndexSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseRunsIndexJson(text: string): RunsIndex | null {
  return parseRunsIndex(tryParseJson(text));
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

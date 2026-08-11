import type { ObservationDocument, SmokeDocument } from "../contract/index.js";
import type { FieldNode } from "./field.js";

/* The typed scene graph: everything a serializer or interactive layer needs
   to draw and read a windgram, computed once from a profile document. Pure data —
   no DOM, no functions — so it can be built server-side, snapshotted, or
   shipped across a worker boundary. */

/**
 * Overlay toggles. Each overlay contributes scene elements; the default set
 * reproduces what today's windgram shows. Encodings (documented per overlay
 * where they're built in scene.ts):
 * - `temperature`: isotherm lines at 0/10/20 degC (freezing level emphasized);
 * - `wind`: barbs per hour column at surface and levels;
 * - `clouds`: humidity-graded field patches from level dew-point depression
 *   (dense < 0.5 degC — the classic boolean hatch threshold — then medium
 *   < 1.5, light < 3)
 *   plus the cloud-cover strip;
 * - `thermalStrength`: the w* surface strip;
 * - `stability`: the eight-class lapse-rate field;
 * - `thermalIndex`: TI field patches (parcel vs environment), strong <= -8,
 *   good <= -4, fair <= -1, weak <= 0 degC; positive TI is unshaded;
 * - `windShear`: layer shear-rate field patches in m/s per km, light >= 2,
 *   moderate >= 4, strong >= 8;
 * - `buoyancyShear`: B/S ratio surface strip (W* / surface-to-BL-top
 *   shear). Inherits the shear term's same-air-mass assumption, which
 *   fails structurally at mountain sites — valley circulation pins the
 *   ratio low on the best days; see derive/'s buoyancyShearRatio JSDoc.
 *   Hours where buoyancy is fully unopposed (zero shear, unbounded ratio)
 *   draw a `wg-bs-unopposed` cell rather than a gap: a gap means "no
 *   ratio computable", not "the best possible reading";
 * - `dewPoint`: isodrosotherm lines at 0/10 degC dew point;
 * - `relativeHumidity`: RH field patches at >= 60 / >= 80 / >= 95 %;
 * - `verticalVelocity`: omega field patches (lift <= -0.1, strong <= -0.5;
 *   sink >= 0.1, strong >= 0.5 Pa/s) — only when the model publishes omega.
 *
 * Science-wave overlays (all degrade to nothing when a model does not
 * publish the field, so they can default on):
 * - `cape`: the overdevelopment-risk strip. Per-hour cells classed by
 *   surface-based CAPE with the strip line drawn over them; the class
 *   boundaries are a scene option (`options.capeClasses`) whose default,
 *   `DEFAULT_CAPE_CLASSES`, documents the soaring-specific thresholds and
 *   their WMO-No. 1038 rationale. Hours whose cinJkg is at or below the
 *   capped threshold add a `wg-cape-capped` modifier: a strong cap delays
 *   or suppresses the overdevelopment the CAPE alone would suggest — and
 *   can also mean an explosive afternoon if it breaks, which is why the
 *   cell dims rather than disappears;
 * - `gusts`: "G<km/h>" readouts above the surface wind barbs from
 *   surface.windGustMs, at the barb stride. Whether the number is an
 *   hour-max ("gusting to") or an instantaneous diagnostic is a per-model
 *   fact (models.json capabilities.gust) the scene does not decide;
 * - `pblHeight`: the MODEL's own boundary-layer top as a line series —
 *   surface.pblHeightM (metres AGL) plus site.modelElevationM, so it is
 *   directly comparable to the parcel-derived boundaryLayerTop series
 *   drawn beside it. Distinct token (--wg-pbl), tighter dash;
 * - `cloudLayers`: one strip of three stacked rows — high, middle, low
 *   reading down, like the sky — whose cells darken with layer cloud
 *   fraction (surface.low/mid/highCloudPercent; NOAA models only).
 *
 * Surface-temperature overlay:
 * - `surfaceTemperature`: per-hour "<n>°" readouts in a row under the
 *   hour labels — the classic windgram element pilots read the day's
 *   warming from. It rounds published surface.temperatureC to integer °C.
 *   The overlay is on by default and adds one text row to the scene.
 *
 * Cloud-shading precedence inside `clouds`: hours whose levels carry
 * cloudFractionPercent (GFS's model cloud profile) shade from it directly
 * (light >= 30 %, medium >= 60 %, dense >= 85 %); all other hours keep the
 * dew-point-depression inference. Model cloud beats inference wherever the
 * model actually says cloud.
 *
 * Complete-control overlays (all default on — the default render is
 * unchanged). Nothing the renderer draws is unremovable except the axes
 * and plot frame; each remaining element rides its own toggle. The
 * derived-height lines are PER-LINE toggles rather than one group, matching
 * the `pblHeight` per-line precedent already shipped — a consumer comparing
 * the parcel-derived and model boundary layers wants exactly one of the
 * other lines gone, not all of them:
 * - `pressure`, `precipitation`: the two always-published surface strips;
 * - `boundaryLayerTop`: the parcel-derived boundary-layer-top line (+band);
 * - `cloudBase`: the derived cloud-base line (+band). The cloud glyph at
 *   the selected hour marks this line, so it follows the toggle;
 * - `usableLiftTop`: the derived usable-lift-top line (+band). The wing
 *   glyph marks this line and follows it;
 * - `launch`: the launch-elevation line and label;
 * - `selectedHour`: the best-hour (max W*) column highlight. The scene
 *   still computes and reports `selectedHourIndex` either way — consumers
 *   read it for readouts — the toggle only suppresses the drawn highlight.
 * A toggled-off height series also leaves the altitude-domain scan, so the
 * chart never reserves headroom for a line it is not drawing.
 */
export type OverlayName =
  | "temperature"
  | "wind"
  | "clouds"
  | "thermalStrength"
  | "stability"
  | "thermalIndex"
  | "windShear"
  | "buoyancyShear"
  | "dewPoint"
  | "relativeHumidity"
  | "verticalVelocity"
  | "cape"
  | "gusts"
  | "pblHeight"
  | "cloudLayers"
  | "smoke"
  | "observedIrradiance"
  | "observedAot"
  | "pressure"
  | "precipitation"
  | "boundaryLayerTop"
  | "cloudBase"
  | "usableLiftTop"
  | "launch"
  | "selectedHour"
  | "surfaceTemperature";

export const DEFAULT_OVERLAYS: Readonly<Record<OverlayName, boolean>> = {
  temperature: true,
  wind: true,
  clouds: true,
  thermalStrength: true,
  stability: true,
  thermalIndex: false,
  windShear: false,
  buoyancyShear: false,
  dewPoint: false,
  relativeHumidity: false,
  verticalVelocity: false,
  // Science-wave overlays default on: each contributes nothing at all for
  // a model that does not publish its field, so the default look is
  // unchanged wherever the data predates the wave.
  cape: true,
  gusts: true,
  pblHeight: true,
  cloudLayers: true,
  // Contributes nothing without smoke data (the model's own block or a
  // smoke document supplied via SceneOptions.smoke), so pre-smoke
  // documents render unchanged.
  smoke: true,
  // Contributes nothing without an observation document supplied via
  // SceneOptions.observations, so forecast-only renders are unchanged.
  observedIrradiance: true,
  // Same degrade-to-nothing default: no document (or no joinable
  // instants) via SceneOptions.aotObservations draws no strip.
  observedAot: true,
  // Complete-control overlays (see the docblock above): every previously
  // unconditional element, on by default so defaults render byte-identically.
  pressure: true,
  precipitation: true,
  boundaryLayerTop: true,
  cloudBase: true,
  usableLiftTop: true,
  launch: true,
  selectedHour: true,
  // Surface temperature always has data, so it defaults on and adds one
  // text row to the reference render.
  surfaceTemperature: true,
};

/**
 * Class boundaries for the CAPE overdevelopment-risk strip. Cells class as
 * calm below `watchJkg`, watch below `riskJkg`, risk below `severeJkg`, and
 * severe at or above it; hours whose surface CIN is at or below
 * `cappedCinJkg` dim with the `wg-cape-capped` modifier.
 */
export interface CapeClassThresholds {
  /** Lower bound of the watch class, J/kg. */
  watchJkg: number;
  /** Lower bound of the risk class, J/kg. */
  riskJkg: number;
  /** Lower bound of the severe class, J/kg — also the strip's minimum axis maximum. */
  severeJkg: number;
  /** CIN (J/kg, <= 0) at or below which the hour's cell dims as capped. */
  cappedCinJkg: number;
}

/**
 * Default renderer classes for the CAPE strip. The boundaries are 300,
 * 800, and 1500 J/kg; surface CIN at or below -50 J/kg dims the cell.
 * These presentation classes are not weather-severity categories or
 * operational thresholds. Consumers can replace them through
 * `options.capeClasses`.
 */
export const DEFAULT_CAPE_CLASSES: Readonly<CapeClassThresholds> = {
  watchJkg: 300,
  riskJkg: 800,
  severeJkg: 1500,
  cappedCinJkg: -50,
};

export interface SceneOptions {
  /** IANA timezone for hour-tick labels (day windowing itself is derive/'s job). */
  timeZone: string;
  /**
   * Hours to render, by index into `profile.hours` — typically one day
   * pre-windowed with derive/windgramDisplayHours. Defaults to every hour
   * in the profile. Takes precedence over `hours` when both are given (it
   * is the most explicit form).
   */
  hourIndices?: readonly number[];
  /**
   * Hours to render, without index bookkeeping. Either the hour objects
   * themselves — e.g. one group from derive/groupByLocalDay or the output
   * of windgramDisplayHours, matched back to the profile by `validAt`
   * (hours not in the profile are ignored) — or `{ timeZone, dateKey }`,
   * which renders the profile hours falling on that local calendar day
   * (derive/localDateKey's zero-padded YYYY-MM-DD). Both forms map to
   * `hourIndices` internally, so everything downstream is identical.
   * Precedence: `hourIndices` wins over `hours`; absent both, every hour
   * renders.
   */
  hours?: ReadonlyArray<{ validAt: string }> | { timeZone: string; dateKey: string };
  overlays?: Partial<Record<OverlayName, boolean>>;
  /**
   * The launch to draw over this render — a RENDER INPUT, deliberately not
   * a document field: a windgram document describes the atmosphere over a
   * grid sample and is launch-agnostic, so one document serves every
   * launch it covers and the consumer names the launch per render.
   * `elevationM` (metres MSL, typically site-context.json's `elevation`
   * pick) places the marker line and joins the altitude-domain scan;
   * `name` joins the label (`"<name> <n> m"` instead of `"launch <n> m"`).
   * Absent, `scene.launch` is null and no marker draws — a missing marker
   * is honest, never an error. The `launch` overlay toggle still applies:
   * off hides even a provided launch.
   */
  launch?: { name?: string; elevationM: number } | null;
  /**
   * A smoke document (RAQDPS) for the same site, joined per hour by
   * validAt to feed the smoke strip where the profile model publishes no
   * smoke of its own. The profile's own smoke block wins where both
   * exist (same-run provenance beats a cross-model join). The graph's
   * `smokeSource` names whichever model and run the drawn strip came
   * from — a DIFFERENT model and cadence than the profile's, which
   * renderers must be able to label.
   */
  smoke?: SmokeDocument | null;
  /**
   * Render the smoke-adjusted ALTERNATE VIEW: each hour's w* derated by
   * the cube root of the slant-path smoke transmittance and its
   * usable-lift envelope re-derived, coherently through the strip, the
   * series, and the best-hour pick. The stored document never changes;
   * this is a read-time re-derivation, and the graph declares it in
   * `smokeAdjustment` — WHICH RENDERERS MUST LABEL. Quietly no-ops
   * (smokeAdjustment stays null) when there is no smoke data, when the
   * profile's fluxes are already smoke-aware (semantics.smoke
   * "radiativelyCoupled" — deriving again would double-count), or when
   * the correction changes no hour at all (sun below the horizon
   * through the smoky hours, or nothing to derate where it is up) — a
   * label over an unchanged picture would lie. Scope:
   * boundary-layer depth and cloud base are NOT re-derived, so the
   * adjusted view is a partial correction, still optimistic in heavy
   * smoke.
   */
  smokeAdjusted?: boolean;
  /**
   * A site's observation document (GOES-18 DSR today), joined per
   * rendered hour by NEAREST instant (observations live at the
   * product's native cadence, never on forecast hours): the measured
   * "Sun" strip draws where a good-quality retrieval sits within half
   * an hour of the rendered instant. Measurements beside forecasts —
   * the graph's `observationSource` names the dataset and its newest
   * instant, which renderers must be able to label.
   */
  observations?: ObservationDocument | null;
  /**
   * A site's measured-AOT observation document (GOES-18 AOD), joined per
   * rendered hour by nearest instant exactly like `observations` — a
   * SECOND observation input, never folded into the first: each document
   * carries one product, and each strip carries one provenance label.
   * The "AOT" strip draws the measured optical thickness beside the
   * forecast smoke strip's — the measured third opinion on smoke, on the
   * same tint scale, so the two compare at a glance. Entries that are
   * not AOT-shaped contribute nothing. The graph's `aotObservationSource`
   * names the dataset and its newest instant, which renderers must be
   * able to label.
   */
  aotObservations?: ObservationDocument | null;
  /**
   * 1-2-1 smoothing (derive/smooth121) on the cloud-base and usable-lift
   * series — the pipeline's retired pass, now a renderer option. Default
   * true so the rendered look matches today's windgram.
   */
  smooth?: boolean;
  /**
   * Class boundaries for the CAPE overdevelopment-risk strip. Defaults to
   * `DEFAULT_CAPE_CLASSES` (see its JSDoc for the WMO-No. 1038 rationale);
   * defaults render byte-identically to the pre-option output.
   */
  capeClasses?: CapeClassThresholds;
  /**
   * Pilot sink rate (m/s) for the usable-lift-top series. The document's
   * published `derived.usableLiftTopM` embeds the fixed 1.0 m/s convention;
   * when this option is set the scene recomputes the series per hour with
   * derive/'s parameterized `usableLiftTopM` over the same published inputs
   * instead of reading the document value, so a consumer UI can offer a
   * sink-rate control without injecting its own series. At 1.0 the
   * recomputed series equals the published one exactly (asserted against a
   * real pipeline fixture), and the recomputed values ride the same
   * optional 1-2-1 smoothing as the published series. For ensemble
   * documents the option is a deliberate no-op and the published
   * percentile series is kept: recomputing from p50 inputs is not the same
   * quantity as the pipeline's per-member derivation aggregated to
   * percentiles, and drawing it as if it were would fabricate a line.
   */
  sinkRateMs?: number;
  /** Column width in px per hour. Default 44. */
  columnWidthPx?: number;
  /**
   * Target TOTAL scene width in px — the container-fit form. buildScene
   * derives the column width from it after windowing
   * (`(widthPx − gutters) / hourCount`) using its internal gutter widths,
   * so `scene.width` comes out equal to the target and a consumer filling
   * a measured panel never needs a probe build. Wins over
   * `columnWidthPx` when both are given (it is the statement of intent);
   * absent both, the 44px default column applies.
   */
  widthPx?: number;
  /**
   * Lower bound on the resolved column pitch, px. Applied after the
   * `widthPx` fit (and to an explicit `columnWidthPx` alike), so a
   * density policy — "columns never narrower than 32px on this panel" —
   * is one build instead of a probe build plus a corrected one. When the
   * floor moves a `widthPx` fit, `scene.width` exceeds the target and the
   * consumer's panel scrolls: the legibility floor wins over the fit, and
   * over `maxColumnWidthPx` if the two conflict.
   */
  minColumnWidthPx?: number;
  /**
   * Upper bound on the resolved column pitch, px — the ceiling half of
   * the density policy (`minColumnWidthPx` above). When the ceiling moves
   * a `widthPx` fit, the chart comes out narrower than the target rather
   * than stretching its columns past legibility.
   */
  maxColumnWidthPx?: number;
  /**
   * Fit as if the window had at least this many columns: the `widthPx`
   * derivation divides by `max(hourCount, fitMinColumns)`, so a two-hour
   * window does not stretch two columns across the whole panel. Only the
   * fit reads it; explicit `columnWidthPx` is already a statement of
   * pitch. Default 1 — no effect.
   */
  fitMinColumns?: number;
  /**
   * Height of the time-height profile panel in px (the strips keep their
   * fixed heights above it). Default 340 — the reference proportions.
   * A page-scale consumer widening the columns raises this to match.
   */
  plotHeightPx?: number;
  /**
   * Hour-tick label convention. `"24h"` (default) renders `7 … 13 … 21`,
   * exactly today's output; `"12h"` renders `7a … 12p … 9p` (lowercase
   * a/p, noon is 12p, midnight 12a); a function receives the hour's
   * `validAt` and the display `timeZone` and owns the string outright.
   * The convention threads through everything the scene prints an hour
   * in: the tick labels and the aria label (whose `:00` suffix is a
   * 24-hour idiom — in the other modes the span reads `7a to 9p`, or the
   * function's output verbatim). Deliberately NOT covered, because they
   * are data timestamps rather than display hours: analyze/'s
   * `CitedInstant.local` (ISO-shaped, joins back to `validAt`) and
   * derive/'s day-window formatters (windowing arithmetic) stay h23.
   */
  hourLabel?: "24h" | "12h" | ((validAt: string, timeZone: string) => string);
  /**
   * Wind-barb hour stride. `"auto"` (default) is geometry-aware: stride 1
   * whenever the column pitch covers the rotated glyph's footprint
   * (2 × BARB_GLYPH_RADIUS × the resolved barb scale), widening only as
   * columns actually get too narrow — a page-scale chart gets a barb
   * every hour where the old count heuristic halved any day longer than
   * nine hours. An explicit number forces that stride. The gust row
   * follows the resolved stride either way.
   */
  barbStride?: number | "auto";
  /**
   * Minimum vertical clearance in px between barbs in one hour's column.
   * Replaces the count-based level stride (every 2nd level past six) with
   * a greedy walk up the column: the surface barb always draws, each
   * level barb draws only if it clears the last drawn one by this gap,
   * and the topmost level always draws (a lower neighbour that would
   * crowd it is dropped instead — the top wins). Level spacing is
   * irregular — dense near the surface, sparse aloft — so a pixel gap
   * thins exactly where it is dense, which a count stride cannot.
   * Default: 24 × the resolved barb scale.
   */
  barbMinGapPx?: number;
  /**
   * Barb glyph scale. Default follows the column pitch: 0.85 (the
   * reference look) at the default 44px columns and below, growing
   * linearly to 1.0 at 66px and wider — page-scale charts get
   * page-scale barbs. Set a number to pin it.
   */
  barbScale?: number;
  /**
   * Marker trains along the derived-height lines. Absent (default), each
   * line carries exactly one glyph at the selected hour — today's look.
   * A bare number draws the glyph every n hours along its line, anchored
   * so the selected hour is among them (`{ every: n }` says the same).
   * Trains CAN land on the same hour at the same height: the contract
   * caps `usableLiftTopM` at `cloudBaseM`, so wherever lift reaches base
   * the two lines share coordinates by definition. The scene renders
   * that coincidence itself — the wing tucks just below the cloud and
   * carries `atCloudBase` (see SceneMarker) — so trains never need to be
   * phased apart. Each train rides its line's own overlay toggle.
   */
  markerStride?: {
    cloudBase?: number | MarkerTrainStride;
    usableLiftTop?: number | MarkerTrainStride;
  };
  /**
   * Display-label overrides per strip key ("thermalStrength" → "LIFT").
   * Voice only: the strip's `key` (and its `wg-strip-*` class) remain the
   * identity; the default labels state the honest quantity (`w*` is the
   * Deardorff convective velocity scale, not a climb rate).
   */
  stripLabels?: Partial<Record<MetricStrip["key"], string>>;
  /**
   * The consumer's selection — the hour (and, optionally, altitude) an
   * inspector is reading — as a scene input, so the reference serializer
   * draws the marker and "tooltips and pixels cannot disagree" extends to
   * it. Distinct from `selectedHourIndex`, which the scene computes
   * (peak W*): this one is the consumer's, and the scene only resolves
   * it. `hourIndex` clamps into the rendered window; `altitudeM` (metres
   * MSL) snaps to the hour's nearest DRAWN barb for the ring — the same
   * answer `nearestDrawnBarb` gives — and an hour without drawn barbs
   * gets column and hairline alone. The scene reports the resolved
   * geometry as `SceneGraph.selection`. Selection is per-build by design:
   * hover previews that must not pay a rebuild stay a consumer overlay
   * (drawn from these same scales), pins ride the option.
   */
  selection?: { hourIndex: number; altitudeM?: number | null } | null;
}

export interface SceneScales {
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
  columnWidth: number;
  /**
   * The y where the metric-strip stack begins — the top of the first strip
   * frame, and where the selected-hour column highlight starts. Serializers
   * read it here instead of restating the layout constant.
   */
  stripTop: number;
  /** Altitude domain: floor (model elevation) to padded column top, metres. */
  floorM: number;
  topM: number;
  hourCount: number;
  /**
   * The y the surface wind barbs are actually placed at — half a rendered
   * glyph height above the plot floor, so the glyph is not bisected by
   * the frame. Consumers hit-testing against wind rows read this instead
   * of assuming y(floorM).
   */
  surfaceWindY: number;
}

export interface AltitudeTick {
  altitudeM: number;
  y: number;
  labelMetres: string;
  labelFeet: string;
}

/** Median published height per pressure level (null = model elevation row). */
export interface PressureAltitudeTick {
  altitudeM: number;
  y: number;
  pressureHpa: number | null;
}

export interface HourTick {
  index: number;
  x: number;
  label: string;
  gridline: boolean;
}

/** One classed hour cell inside a strip (the CAPE and cloud-layer strips). */
export interface StripCell {
  x: number;
  width: number;
  className: string;
  /** Data-driven opacity (cloud-layer fraction); classed cells omit it. */
  opacity?: number;
}

/** A stacked sub-row of a strip (the cloud-layer strip's high/mid/low). */
export interface StripRow {
  /** One-letter row tag rendered at the strip's right edge ("H"/"M"/"L"). */
  label: string;
  top: number;
  height: number;
  cells: ReadonlyArray<StripCell | null>;
}

export interface MetricStrip {
  key:
    | "pressure"
    | "precipitation"
    | "cloudCover"
    | "cloudLayers"
    | "cape"
    | "thermalStrength"
    | "buoyancyShear"
    | "smoke"
    | "observedIrradiance"
    | "observedAot";
  className: string;
  label: string;
  unit: string;
  top: number;
  height: number;
  minimum: number;
  maximum: number;
  values: ReadonlyArray<number | null>;
  linePath: string;
  areaPath: string;
  /** p25-p75 envelope where the source position is an ensemble value. */
  bandPath: string | null;
  /** Full-height classed cells drawn behind the line (CAPE risk classes). */
  cells?: ReadonlyArray<StripCell | null>;
  /** Stacked sub-rows (cloud layers); such strips draw no line. */
  rows?: ReadonlyArray<StripRow>;
  /**
   * Whose data this strip draws — the structural answer to "did the
   * model account for this?". "model" strips are the viewed model's own
   * values and render in the main stack; "crossModel" (another model's
   * forecast joined beside it) and "measurement" (an observation —
   * nobody's forecast) render BELOW the provenance divider, in the
   * beside-this-model zone the reference renderer always draws when any
   * foreign strip exists.
   */
  provenance: "model" | "crossModel" | "measurement";
  /**
   * The inline provenance statement drawn inside the strip: the source
   * slug and instant for foreign strips ("raqdps · 2026-08-10 12Z"),
   * or the in-zone caveat for a model's own passive smoke ("this
   * model's forecast · not in its physics"). Absent on ordinary model
   * strips.
   */
  sourceLabel?: string;
}

/**
 * One classified field's iso-band paths, in banding order. Each path is
 * the outline pair of the band's two thresholds and MUST be filled with
 * fill-rule "evenodd" (the reference serializer does): the even-odd rule
 * is what turns the two outlines into the area between them, holes
 * included.
 */
export interface FieldLayer {
  key: "stability" | "clouds" | "thermalIndex" | "windShear" | "relativeHumidity" | "verticalVelocity";
  /** Class name -> path data, in stable class order. */
  paths: ReadonlyArray<{ className: string; path: string }>;
}

export interface SeriesElement {
  key:
    | "boundaryLayerTop"
    | "modelPblTop"
    | "cloudBase"
    | "usableLiftTop"
    | "isotherm"
    | "dewPointIsoline";
  className: string;
  path: string;
  /** p25-p75 envelope where the source position is an ensemble value. */
  bandPath: string | null;
  strokeWidth: number;
  dash: string | null;
}

export interface BarbPlacement {
  x: number;
  y: number;
  directionDeg: number;
  speedKmh: number;
  calm: boolean;
  shaftPath: string;
  pennantPaths: ReadonlyArray<string>;
  scale: number;
  /** Rendered hour index (into `hourValidAts`) the barb belongs to. */
  hourIndex: number;
  /**
   * The wind reading's data altitude, metres MSL: the level's `heightM`,
   * or the model elevation for the surface barb. The surface barb DRAWS
   * at `scales.surfaceWindY` (lifted clear of the frame), so its `y` and
   * `yForAltitude(altitudeM)` deliberately differ — identity comes from
   * here, not from inverting the drawn position.
   */
  altitudeM: number;
  /** True for the surface (10 m) barb — a level can sit at floor height. */
  surface: boolean;
}

/**
 * The consumer-supplied selection, resolved to scene geometry
 * (`SceneOptions.selection` -> `SceneGraph.selection`): the tinted column
 * spanning strips and profile, its centre hairline, and the drawn barb
 * the selection names, ring-ready. The reference serializer draws all
 * three (`wg-selection-column`/`-line`/`-ring`), so the marker and the
 * consumer's readout cannot disagree.
 */
export interface SceneSelection {
  hourIndex: number;
  /** Column-left x; the column is `width` wide. */
  x: number;
  width: number;
  centerX: number;
  /** The strip-stack origin, matching the selected-hour highlight's span. */
  top: number;
  /** The plot floor. */
  bottom: number;
  /**
   * The selected drawn barb — nearest drawn barb to the requested
   * altitude, in drawn-y distance. Null when the selection named no
   * altitude or the hour drew no barbs (a stride-skipped column).
   * `scale` is the barb's own, so the ring sizes with page-scale barbs.
   */
  barb: { x: number; y: number; altitudeM: number; surface: boolean; scale: number } | null;
}

export interface SceneLabel {
  x: number;
  y: number;
  text: string;
  className: string;
  anchor: "start" | "middle" | "end";
}

export interface SceneMarker {
  kind: "wing" | "cloud";
  x: number;
  y: number;
  path: string;
  /**
   * True on a wing whose hour also carries a cloud glyph at the same
   * height — usable lift reached cloud base. `y` is then tucked slightly
   * below the cloud's, canopy overlapping its lower body (the pair reads
   * as one symbol: wing in front, cloud rising behind); the usable-lift
   * line itself still marks the height.
   */
  atCloudBase?: boolean;
}

/**
 * Per-hour gust readout drawn above the surface wind barb: "G<km/h>".
 * Whether that number means "gusting to" (hour-max) or an instantaneous
 * diagnostic is declared per model in models.json capabilities.gust — the
 * scene carries the value, the consumer carries the caption.
 */
export interface GustMark {
  x: number;
  y: number;
  speedKmh: number;
  label: string;
}

/** A marker train's step (see SceneOptions.markerStride). */
export interface MarkerTrainStride {
  /** Draw a glyph every this many hours along the line. */
  every: number;
}

/**
 * Per-hour surface-temperature readout in the row under the hour labels:
 * "<n>°", integer °C from surface.temperatureC (the `surfaceTemperature`
 * overlay).
 */
export interface SurfaceTemperatureMark {
  x: number;
  y: number;
  temperatureC: number;
  label: string;
}

/** Vertical node stacks per hour that hit-testing interpolates against. */
export interface HourSampling {
  validAt: string;
  temperatureC: ReadonlyArray<FieldNode>;
  dewPointC: ReadonlyArray<FieldNode>;
  lapseCPer1000Ft: ReadonlyArray<FieldNode>;
  thermalIndexC: ReadonlyArray<FieldNode>;
  relativeHumidityPercent: ReadonlyArray<FieldNode>;
  windU: ReadonlyArray<FieldNode>;
  windV: ReadonlyArray<FieldNode>;
  verticalVelocityPaS: ReadonlyArray<FieldNode>;
  /**
   * The hour's smoke as the strip drew it — the same single source
   * (profile block or joined document, never blended), so a tooltip can
   * never disagree with the pixels. Whole-column values, not
   * altitude-interpolated; null where no smoke was drawn. `aot` is null
   * on joined-document hours: the RAQDPS plume column it would derive
   * from is quarantined (see the contract's smokePlumeColumnMgm2 note),
   * so only a profile's own published AOT ever reaches a renderer.
   */
  smoke: { surfaceUgm3: number; aot: number | null } | null;
  /**
   * The hour's measured irradiance as the "Sun" strip drew it: W/m²
   * plus the observed transmittance against the clear-sky expectation
   * (null near the horizon, where the ratio means nothing). Same
   * single source as the strip, so tooltips and pixels agree; null
   * where no observation was drawn.
   */
  observation: { wm2: number; transmittance: number | null } | null;
  /**
   * The hour's measured aerosol optical thickness as the "AOT" strip
   * drew it (nearest instant, whole-column like the smoke fields, not
   * altitude-interpolated). Same single source as the strip, so
   * tooltips and pixels agree; null where no observation was drawn.
   */
  aotObservation: { aot: number } | null;
}

export interface SceneGraph {
  width: number;
  height: number;
  ariaLabel: string;
  scales: SceneScales;
  axes: {
    altitude: ReadonlyArray<AltitudeTick>;
    pressureAltitude: ReadonlyArray<PressureAltitudeTick>;
    hours: ReadonlyArray<HourTick>;
  };
  strips: ReadonlyArray<MetricStrip>;
  fields: ReadonlyArray<FieldLayer>;
  series: ReadonlyArray<SeriesElement>;
  barbs: ReadonlyArray<BarbPlacement>;
  gusts: ReadonlyArray<GustMark>;
  surfaceTemperatures: ReadonlyArray<SurfaceTemperatureMark>;
  labels: ReadonlyArray<SceneLabel>;
  markers: ReadonlyArray<SceneMarker>;
  /**
   * The launch marker's resolved geometry, drawn from `SceneOptions.launch`
   * (documents carry no launch). Null when no launch was supplied, when the
   * `launch` overlay is off, or when the elevation falls outside the
   * altitude domain.
   */
  launch: { y: number; altitudeM: number; label: string } | null;
  /** Hour column highlighted as "the day's best" (max W*). */
  selectedHourIndex: number;
  /**
   * The consumer-supplied selection resolved to geometry (see
   * `SceneOptions.selection`); null when the build supplied none.
   */
  selection: SceneSelection | null;
  /**
   * Where the smoke strip's data came from: the profile model itself
   * (its own smoke block) or the joined smoke document's model and run.
   * A cross-model source runs on its own cadence, so renderers labeling
   * the strip MUST show this rather than implying same-run provenance.
   * Null when no smoke strip was drawn.
   */
  smokeSource: { model: string; referenceTime: string } | null;
  /**
   * Present exactly when this scene IS the smoke-adjusted alternate view
   * (SceneOptions.smokeAdjusted honored): the smoke model and run whose
   * optical thickness derated the drawn w* and lift envelope. Renderers
   * MUST surface this label — an adjusted view that looks like the base
   * forecast is the failure mode this field exists to prevent. Null on
   * the base view, including when the adjustment was requested but
   * no-opped (no smoke data, or the profile is already smoke-aware).
   */
  smokeAdjustment: { smokeModel: string; smokeRun: string } | null;
  /**
   * Where the measured "Sun" strip's data came from: the observation
   * dataset and its newest measured instant. Observations are another
   * source with its own cadence, so renderers labeling the strip MUST
   * show this. Null when no observations were drawn.
   */
  observationSource: { model: string; lastObservedAt: string } | null;
  /**
   * Where the measured "AOT" strip's data came from: the AOD observation
   * dataset and its newest measured instant — its own field beside
   * `observationSource`, because the two strips draw two documents and a
   * renderer must be able to label each. Null when no measured AOT was
   * drawn.
   */
  aotObservationSource: { model: string; lastObservedAt: string } | null;
  /**
   * The provenance divider between the model's own strips and the
   * beside-this-model zone (cross-model forecasts, measurements) — the
   * y of the rule and its label. Null when every drawn strip is the
   * model's own. The reference renderer always draws it when present:
   * an honest default is the thesis.
   */
  stripDivider: { y: number; label: string } | null;
  /**
   * Whether the serializer draws the selected-hour column highlight —
   * the `selectedHour` overlay. `selectedHourIndex` above stays computed
   * either way, so readouts keep working with the highlight off.
   */
  highlightSelectedHour: boolean;
  hourValidAts: ReadonlyArray<string>;
  sampling: ReadonlyArray<HourSampling>;
}

/** What value-at-cursor hit-testing reports for a plot position. */
export interface CursorReading {
  hourIndex: number;
  validAt: string;
  altitudeM: number;
  temperatureC: number | null;
  dewPointC: number | null;
  dewPointDepressionC: number | null;
  relativeHumidityPercent: number | null;
  lapseCPer1000Ft: number | null;
  stabilityClassName: string | null;
  thermalIndexC: number | null;
  windSpeedMs: number | null;
  windDirectionDeg: number | null;
  verticalVelocityPaS: number | null;
  /**
   * Near-surface smoke, µg/m³ — the hour's whole-column value as the
   * smoke strip drew it (same source, so tooltip and pixels agree), not
   * an altitude interpolation. Null where no smoke was drawn.
   */
  smokeSurfaceUgm3: number | null;
  /** Column aerosol optical thickness for the hour; null without smoke. */
  smokeAot: number | null;
  /**
   * Measured downward shortwave for the hour, W/m² — the observation
   * the "Sun" strip drew (nearest instant), whole-column like the smoke
   * fields, not altitude-interpolated. Null where none was drawn.
   */
  observedIrradianceWm2: number | null;
  /** Measured/clear-sky transmittance for that observation; null near the horizon or without one. */
  observedTransmittance: number | null;
  /**
   * Measured aerosol optical thickness for the hour — the observation
   * the "AOT" strip drew (nearest instant), whole-column like the smoke
   * fields, not altitude-interpolated. Null where none was drawn.
   */
  observedAot: number | null;
}

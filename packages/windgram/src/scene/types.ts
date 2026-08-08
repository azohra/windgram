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
 * - `buoyancyShear`: B/S ratio surface strip (W* / surface-to-BL-top shear);
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
  | "pressure"
  | "precipitation"
  | "boundaryLayerTop"
  | "cloudBase"
  | "usableLiftTop"
  | "launch"
  | "selectedHour";

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
  // Complete-control overlays (see the docblock above): every previously
  // unconditional element, on by default so defaults render byte-identically.
  pressure: true,
  precipitation: true,
  boundaryLayerTop: true,
  cloudBase: true,
  usableLiftTop: true,
  launch: true,
  selectedHour: true,
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
 * The default CAPE classes — soaring thresholds, not severe-weather ones.
 * The WMO Handbook of Meteorology for Soaring Flight (WMO-No. 1038) treats
 * a few hundred J/kg of surface-based CAPE as where cumulus overdevelopment
 * enters the forecast problem, while SPC's operational categories
 * (weak < 1000, moderate 1000-2500) are tuned to severe storms and would
 * hide the OD band pilots care about. Chosen classes: calm < 300 (cumulus
 * stay friendly), watch 300-800 (afternoon overdevelopment possible), risk
 * 800-1500 (showers / spreadout likely), severe >= 1500 (thunderstorm
 * potential — a land-early day). The capped threshold of -50 J/kg CIN sits
 * where SPC's moderate-inhibition band starts (near -25 to -50). Consumers
 * with a different forecasting doctrine override via
 * `options.capeClasses`; the defaults render byte-identically to the
 * pre-option goldens.
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
   * Hours to render — typically one day pre-windowed with
   * derive/windgramDisplayHours. Defaults to every hour in the profile.
   */
  hourIndices?: readonly number[];
  overlays?: Partial<Record<OverlayName, boolean>>;
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
   * Height of the time-height profile panel in px (the strips keep their
   * fixed heights above it). Default 340 — the gold-standard proportions.
   * A page-scale consumer widening the columns raises this to match.
   */
  plotHeightPx?: number;
}

export interface SceneScales {
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
  columnWidth: number;
  /** Altitude domain: floor (model elevation) to padded column top, metres. */
  floorM: number;
  topM: number;
  hourCount: number;
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
    | "buoyancyShear";
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
}

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
  labels: ReadonlyArray<SceneLabel>;
  markers: ReadonlyArray<SceneMarker>;
  launch: { y: number; altitudeM: number; label: string } | null;
  /** Hour column highlighted as "the day's best" (max W*). */
  selectedHourIndex: number;
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
}

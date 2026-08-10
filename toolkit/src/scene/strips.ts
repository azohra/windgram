import { buoyancyShearRatio, surfaceToBoundaryLayerShearMs } from "../derive/shear.js";
import { bandPath, pointPath, type PlotPoint } from "./path.js";
import type { Band, ResolvedHour } from "./resolve.js";
import type { CapeClassThresholds, MetricStrip, OverlayName, StripCell } from "./types.js";

/* The surface metric strips: which strips this render selects (a function
   of the overlays and what the hours publish) and their geometry. Selection
   comes first because the plot top depends on the strip count — buildScene
   calls buildStripSpecs, derives the plot frame, then layoutStrips. */

/* Strip-stack layout constants (the plot frame sits below the stack;
   scene.ts derives plotTop from these plus its own profile gap). */
export const METRIC_TOP = 20;
export const METRIC_BAND_HEIGHT = 25;
export const METRIC_BAND_GAP = 5;

/** The horizontal frame both strip passes share. */
export interface StripGeometry {
  marginLeft: number;
  columnWidth: number;
  plotWidth: number;
}

export interface StripSpec {
  key: MetricStrip["key"];
  label: string;
  unit: string;
  values: Array<number | null>;
  bands: Array<Band>;
  minimum: number;
  maximum: number;
  cells?: Array<StripCell | null>;
  /** Row cells without geometry; tops are assigned once the strip has one. */
  rows?: Array<{ label: string; cells: Array<StripCell | null> }>;
  /** MetricStrip.provenance; absent means "model". */
  provenance?: MetricStrip["provenance"];
  /** MetricStrip.sourceLabel — the inline provenance statement. */
  sourceLabel?: string;
}

/* Vertical room the provenance divider takes between the model zone and
   the beside-this-model zone. */
export const STRIP_DIVIDER_HEIGHT = 16;
export const STRIP_DIVIDER_LABEL = "beside this model — not in its physics";

const PROVENANCE_RANK: Record<MetricStrip["provenance"], number> = {
  model: 0,
  crossModel: 1,
  measurement: 2,
};

/** Model strips first (original order), then the foreign zone. */
export function orderStripSpecs(specs: StripSpec[]): StripSpec[] {
  return [...specs].sort(
    (a, b) => PROVENANCE_RANK[a.provenance ?? "model"] - PROVENANCE_RANK[b.provenance ?? "model"],
  );
}

/** True when the spec renders below the provenance divider. */
export function isForeignStrip(spec: { provenance?: MetricStrip["provenance"] }): boolean {
  return (spec.provenance ?? "model") !== "model";
}

const finite = (values: Array<number | null>) =>
  values.filter((value): value is number => value != null && Number.isFinite(value));

export function buildStripSpecs(args: {
  hours: ResolvedHour[];
  overlays: Record<OverlayName, boolean>;
  capeClasses: CapeClassThresholds;
  /** Model elevation (MSL) — the B/S shear column's surface height. */
  floorM: number;
  /** Per-rendered-hour smoke (profile block or joined document), scene.ts's
      join; index-aligned with `hours`. Absent/all-null draws no strip. */
  smokeSeries?: ReadonlyArray<{ surfaceUgm3: number; aot: number } | null>;
  /** The smoke strip's provenance statement (scene.ts decides it from the
      source and the semantics.smoke coupling claim). */
  smokeStripSource?: { provenance: MetricStrip["provenance"]; sourceLabel?: string };
  /** The Sun strip's inline provenance statement. */
  observationSourceLabel?: string;
  /** Per-rendered-hour measured irradiance (scene.ts's nearest-instant
      join); index-aligned with `hours`. Absent/all-null draws no strip. */
  observationSeries?: ReadonlyArray<{ wm2: number; transmittance: number | null } | null>;
  /** The AOT strip's inline provenance statement. */
  aotObservationSourceLabel?: string;
  /** Per-rendered-hour measured optical thickness (scene.ts's
      nearest-instant join); index-aligned with `hours`. Absent/all-null
      draws no strip. */
  aotObservationSeries?: ReadonlyArray<{ aot: number } | null>;
  geometry: StripGeometry;
}): StripSpec[] {
  const {
    hours,
    overlays,
    capeClasses,
    floorM,
    smokeSeries,
    observationSeries,
    aotObservationSeries,
    smokeStripSource,
    observationSourceLabel,
    aotObservationSourceLabel,
  } = args;
  const { marginLeft, columnWidth } = args.geometry;
  const stripSpecs: StripSpec[] = [];

  if (overlays.pressure) {
    const values = hours.map((hour) => hour.surface.pressurePa / 1000);
    stripSpecs.push({
      key: "pressure",
      label: "Pressure",
      unit: "kPa",
      values,
      bands: hours.map((hour) =>
        hour.bands.pressurePa
          ? { p25: hour.bands.pressurePa.p25 / 1000, p75: hour.bands.pressurePa.p75 / 1000 }
          : null,
      ),
      minimum: Math.floor(Math.min(...finite(values)) * 10) / 10,
      maximum: Math.ceil(Math.max(...finite(values)) * 10) / 10,
    });
  }
  if (overlays.precipitation) {
    const precip = hours.map((hour) => hour.surface.precipitationMmHr);
    stripSpecs.push({
      key: "precipitation",
      label: "Precip",
      unit: "mm/h",
      values: precip,
      bands: hours.map((hour) => hour.bands.precipitationMmHr),
      minimum: 0,
      maximum: Math.max(0.5, ...finite(precip)),
    });
  }
  if (overlays.clouds) {
    stripSpecs.push({
      key: "cloudCover",
      label: "Cloud",
      unit: "%",
      values: hours.map((hour) => hour.surface.cloudCoverPercent),
      bands: hours.map((hour) => hour.bands.cloudCoverPercent),
      minimum: 0,
      maximum: 100,
    });
  }
  if (overlays.cloudLayers) {
    /* Layered cloud: one strip of three stacked rows — high, middle, low
       reading downward like the sky — with per-hour cells whose opacity
       is the layer fraction. Only layers the model publishes get a row;
       a model without any (ECCC total-cloud-only) gets no strip. */
    const layerRows = [
      { label: "H", values: hours.map((hour) => hour.surface.highCloudPercent) },
      { label: "M", values: hours.map((hour) => hour.surface.midCloudPercent) },
      { label: "L", values: hours.map((hour) => hour.surface.lowCloudPercent) },
    ].filter((row) => row.values.some((value) => value != null));
    if (layerRows.length > 0) {
      stripSpecs.push({
        key: "cloudLayers",
        label: "Layers",
        unit: "%",
        values: hours.map(() => null), // rows carry the data; no strip line
        bands: hours.map(() => null),
        minimum: 0,
        maximum: 100,
        rows: layerRows.map((row) => ({
          label: row.label,
          cells: row.values.map((value, index) =>
            value == null
              ? null
              : {
                  x: marginLeft + index * columnWidth,
                  width: columnWidth,
                  className: "wg-cloud-cell",
                  opacity: Number((Math.min(100, Math.max(0, value)) / 100).toFixed(2)),
                },
          ),
        })),
      });
    }
  }
  if (overlays.smoke && smokeSeries && smokeSeries.some((entry) => entry !== null)) {
    /* Wildfire smoke: the line is near-surface concentration (the
       visibility/health number) and the haze behind it is optical
       thickness — full tint at AOT 3, the observed severe-episode range.
       Both numbers, one strip: concentration says "breathe it", AOT says
       "the sun is dimmer". */
    const surface = smokeSeries.map((entry) => (entry === null ? null : entry.surfaceUgm3));
    stripSpecs.push({
      ...(smokeStripSource ?? {}),
      key: "smoke",
      label: "Smoke",
      unit: "µg/m³",
      values: surface,
      bands: smokeSeries.map(() => null),
      minimum: 0,
      maximum: Math.max(50, ...finite(surface)),
      cells: smokeSeries.map((entry, index) =>
        entry === null || entry.aot <= 0
          ? null
          : {
              x: marginLeft + index * columnWidth,
              width: columnWidth,
              className: "wg-smoke-cell",
              opacity: Number(Math.min(1, entry.aot / 3).toFixed(2)),
            },
      ),
    });
  }
  if (
    overlays.observedIrradiance &&
    observationSeries &&
    observationSeries.some((entry) => entry !== null)
  ) {
    /* Measured sun: the line is satellite-measured W/m² at the surface —
       truth beside the forecasts around it — and the shadow behind it
       deepens as the sky under-delivers against the clear-sky
       expectation (tint = 1 − observed transmittance). Hours where the
       ratio means nothing (sun near the horizon) draw the line without
       a shadow claim. */
    const measured = observationSeries.map((entry) => (entry === null ? null : entry.wm2));
    stripSpecs.push({
      provenance: "measurement",
      ...(observationSourceLabel ? { sourceLabel: observationSourceLabel } : {}),
      key: "observedIrradiance",
      label: "Sun",
      unit: "W/m²",
      values: measured,
      bands: observationSeries.map(() => null),
      minimum: 0,
      maximum: Math.max(800, ...finite(measured)),
      cells: observationSeries.map((entry, index) =>
        entry === null || entry.transmittance === null || entry.transmittance >= 1
          ? null
          : {
              x: marginLeft + index * columnWidth,
              width: columnWidth,
              className: "wg-dim-cell",
              opacity: Number(Math.min(1, 1 - entry.transmittance).toFixed(2)),
            },
      ),
    });
  }
  if (
    overlays.observedAot &&
    aotObservationSeries &&
    aotObservationSeries.some((entry) => entry !== null)
  ) {
    /* Measured smoke: satellite-retrieved aerosol optical thickness at
       550 nm — the same quantity the smoke document forecasts as `aot`,
       measured. The line carries the AOT number and the haze behind it
       is the forecast smoke strip's own tint (same cell class, full
       tint at AOT 3), so "forecast smoke" and "measured smoke" compare
       at a glance. */
    const measuredAot = aotObservationSeries.map((entry) => (entry === null ? null : entry.aot));
    stripSpecs.push({
      provenance: "measurement",
      ...(aotObservationSourceLabel ? { sourceLabel: aotObservationSourceLabel } : {}),
      key: "observedAot",
      label: "AOT",
      unit: "550 nm",
      values: measuredAot,
      bands: aotObservationSeries.map(() => null),
      minimum: 0,
      maximum: Math.max(3, ...finite(measuredAot)),
      cells: aotObservationSeries.map((entry, index) =>
        entry === null || entry.aot <= 0
          ? null
          : {
              x: marginLeft + index * columnWidth,
              width: columnWidth,
              className: "wg-smoke-cell",
              opacity: Number(Math.min(1, entry.aot / 3).toFixed(2)),
            },
      ),
    });
  }
  if (overlays.thermalStrength) {
    const wStar = hours.map((hour) => hour.derived.thermalVelocityMs);
    stripSpecs.push({
      key: "thermalStrength",
      label: "w*",
      unit: "m/s",
      values: wStar,
      bands: hours.map((hour) => hour.bands.thermalVelocityMs),
      minimum: 0,
      maximum: Math.max(3, ...finite(wStar)),
    });
  }
  if (overlays.cape) {
    /* The overdevelopment-risk strip. Class boundaries come from
       options.capeClasses (default DEFAULT_CAPE_CLASSES, whose JSDoc in
       types.ts documents the thresholds and their sources). Cells carry
       the at-a-glance class; the line over them carries the number. A
       CIN cap at or below capeClasses.cappedCinJkg dims the cell
       (wg-cape-capped) instead of clearing it: suppressed for now is not
       gone. */
    const capeValues = hours.map((hour) => hour.surface.capeJkg);
    if (capeValues.some((value) => value != null)) {
      stripSpecs.push({
        key: "cape",
        label: "CAPE",
        unit: "J/kg",
        values: capeValues,
        bands: hours.map((hour) => hour.bands.capeJkg),
        minimum: 0,
        maximum: Math.max(capeClasses.severeJkg, ...finite(capeValues)),
        cells: hours.map((hour, index) => {
          const cape = hour.surface.capeJkg;
          if (cape == null) return null;
          const riskClass =
            cape < capeClasses.watchJkg
              ? "wg-cape-calm"
              : cape < capeClasses.riskJkg
                ? "wg-cape-watch"
                : cape < capeClasses.severeJkg
                  ? "wg-cape-risk"
                  : "wg-cape-severe";
          const capped = hour.surface.cinJkg != null && hour.surface.cinJkg <= capeClasses.cappedCinJkg;
          return {
            x: marginLeft + index * columnWidth,
            width: columnWidth,
            className: capped ? `${riskClass} wg-cape-capped` : riskClass,
          };
        }),
      });
    }
  }
  if (overlays.buoyancyShear) {
    /* B/S per hour: derive/'s W* / surface-to-BL-top vector shear. Hours
       without a boundary layer or without levels have no ratio (a plain
       gap). An unbounded ratio (zero shear, buoyancy fully unopposed)
       cannot be placed as a point — but it is the best possible reading,
       not missing data, so it draws a classed cell instead of hiding in
       the same gap. */
    const perHour = hours.map((hour) => {
      const shear = surfaceToBoundaryLayerShearMs({
        surfaceWind: hour.surface,
        modelElevationM: floorM,
        boundaryLayerTopM: hour.derived.boundaryLayerTopM,
        levels: hour.levels,
      });
      if (shear === null) return { ratio: null, unopposed: false };
      const ratio = buoyancyShearRatio(hour.derived.thermalVelocityMs, shear);
      if (ratio === Number.POSITIVE_INFINITY) return { ratio: null, unopposed: true };
      return { ratio: ratio !== null && Number.isFinite(ratio) ? ratio : null, unopposed: false };
    });
    const ratios = perHour.map((entry) => entry.ratio);
    const spec: StripSpec = {
      key: "buoyancyShear",
      label: "B/S",
      unit: "ratio",
      values: ratios,
      bands: hours.map(() => null),
      minimum: 0,
      maximum: Math.max(5, ...finite(ratios)),
    };
    if (perHour.some((entry) => entry.unopposed)) {
      spec.cells = perHour.map((entry, index) =>
        entry.unopposed
          ? {
              x: marginLeft + index * columnWidth,
              width: columnWidth,
              className: "wg-bs-unopposed",
            }
          : null,
      );
    }
    stripSpecs.push(spec);
  }

  return orderStripSpecs(stripSpecs);
}

/** One authority for strip tops, the provenance divider, and stack height. */
export function stripStackGeometry(
  specs: ReadonlyArray<{ provenance?: MetricStrip["provenance"] }>,
): { tops: number[]; dividerY: number | null; height: number } {
  const tops: number[] = [];
  let cursor = METRIC_TOP;
  let dividerY: number | null = null;
  for (const spec of specs) {
    if (dividerY === null && isForeignStrip(spec)) {
      dividerY = cursor + STRIP_DIVIDER_HEIGHT / 2;
      cursor += STRIP_DIVIDER_HEIGHT;
    }
    tops.push(cursor);
    cursor += METRIC_BAND_HEIGHT + METRIC_BAND_GAP;
  }
  return { tops, dividerY, height: cursor };
}

export function layoutStrips(
  stripSpecs: StripSpec[],
  args: {
    geometry: StripGeometry;
    /** Display-label overrides (SceneOptions.stripLabels); keys stay identity. */
    stripLabels?: Partial<Record<MetricStrip["key"], string>>;
  },
): MetricStrip[] {
  const { marginLeft, columnWidth, plotWidth } = args.geometry;
  const xCenter = (index: number) => marginLeft + index * columnWidth + columnWidth / 2;

  const geometry = stripStackGeometry(stripSpecs);
  return stripSpecs.map((spec, stripIndex) => {
    const top = geometry.tops[stripIndex];
    const bottom = top + METRIC_BAND_HEIGHT;
    const range = Math.max(0.001, spec.maximum - spec.minimum);
    const yOf = (value: number) => {
      const fraction = Math.min(1, Math.max(0, (value - spec.minimum) / range));
      return bottom - fraction * METRIC_BAND_HEIGHT;
    };
    const centred: Array<PlotPoint | null> = spec.values.map((value, index) =>
      value == null || !Number.isFinite(value) ? null : { x: xCenter(index), y: yOf(value) },
    );
    /* The strip holds its terminal values flat out to the plot edges —
       the field's classified cells already paint full columns edge to
       edge, and centre-to-centre strips left a data-less half-column at
       both ends. Centre-anchored points stay; only the ends extend, and
       only when the terminal hour actually has a value. */
    const first = centred[0];
    const last = centred[centred.length - 1];
    const points: Array<PlotPoint | null> = [
      ...(first ? [{ x: marginLeft, y: first.y }] : []),
      ...centred,
      ...(last ? [{ x: marginLeft + plotWidth, y: last.y }] : []),
    ];
    const linePath = pointPath(points);
    const complete = centred.every((point) => point !== null);
    const areaPath =
      complete && centred.length > 0
        ? `${linePath} L${(marginLeft + plotWidth).toFixed(2)},${bottom} L${marginLeft.toFixed(2)},${bottom} Z`
        : "";
    const bandPoints = spec.bands.map((entry, index) =>
      entry === null
        ? null
        : { x: xCenter(index), yLow: yOf(entry.p25), yHigh: yOf(entry.p75) },
    );
    const firstBand = bandPoints[0];
    const lastBand = bandPoints[bandPoints.length - 1];
    const band = bandPath([
      ...(firstBand ? [{ ...firstBand, x: marginLeft }] : []),
      ...bandPoints,
      ...(lastBand ? [{ ...lastBand, x: marginLeft + plotWidth }] : []),
    ]);
    const strip: MetricStrip = {
      provenance: spec.provenance ?? "model",
      ...(spec.sourceLabel ? { sourceLabel: spec.sourceLabel } : {}),
      key: spec.key,
      className: `wg-strip-${spec.key}`,
      // Voice is the consumer's; the key stays the identity.
      label: args.stripLabels?.[spec.key] ?? spec.label,
      unit: spec.unit,
      top,
      height: METRIC_BAND_HEIGHT,
      minimum: spec.minimum,
      maximum: spec.maximum,
      values: spec.values,
      linePath,
      areaPath,
      bandPath: band === "" ? null : band,
    };
    if (spec.cells) strip.cells = spec.cells;
    if (spec.rows) {
      const rowHeight = METRIC_BAND_HEIGHT / spec.rows.length;
      strip.rows = spec.rows.map((row, rowIndex) => ({
        label: row.label,
        top: top + rowIndex * rowHeight,
        height: rowHeight,
        cells: row.cells,
      }));
    }
    return strip;
  });
}

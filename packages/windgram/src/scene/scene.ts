import {
  isEnsembleValue,
  type Scalar,
  type WindgramHour,
  type WindgramProfile,
} from "../contract/index.js";
import { p50 } from "../derive/ensemble.js";
import { lapseRateCPer1000Ft, surfaceLapseCPer1000Ft } from "../derive/lapse.js";
import { dewPointDepressionC, relativeHumidityPercent } from "../derive/moisture.js";
import { buoyancyShearRatio, surfaceToBoundaryLayerShearMs, vectorShearMs } from "../derive/shear.js";
import { localDateKey } from "../derive/day-window.js";
import { smooth121 } from "../derive/smoothing.js";
import { stabilityClass } from "../derive/stability.js";
import { thermalIndexC } from "../derive/thermal-index.js";
import { usableLiftTopM } from "../derive/usable-lift.js";
import { msToKmh, windToComponents } from "../derive/wind.js";
import { windBarbParts, windBarbPaths } from "./barbs.js";
import { sampledFieldPaths, type FieldNode } from "./field.js";
import { bandPath, pointPath, type PlotPoint } from "./path.js";
import {
  DEFAULT_CAPE_CLASSES,
  DEFAULT_OVERLAYS,
  type AltitudeTick,
  type BarbPlacement,
  type FieldLayer,
  type GustMark,
  type HourSampling,
  type HourTick,
  type MetricStrip,
  type OverlayName,
  type PressureAltitudeTick,
  type SceneGraph,
  type SceneLabel,
  type SceneMarker,
  type SceneOptions,
  type SeriesElement,
  type StripCell,
  type StripRow,
} from "./types.js";

/* Layout constants ported from the site renderer (the gold standard for
   geometry). PROFILE_TOP is derived from the strip count instead of being a
   magic 148, so optional strips (B/S) can join without overlap. */
const METRIC_TOP = 20;
const METRIC_BAND_HEIGHT = 25;
const METRIC_BAND_GAP = 5;
const PROFILE_GAP = 8;
const MARGIN_LEFT = 60;
const MARGIN_RIGHT = 60;
/* Exported (not via scene/'s public index) so presets/ can name the
   defaults without restating the numbers — the one-home rule. */
export const DEFAULT_COLUMN_WIDTH = 44;
export const DEFAULT_PLOT_HEIGHT = 340;
const HOUR_LABEL_DY = 18;
const BOTTOM_PADDING = 14;
const WIND_BARB_SCALE = 0.85;
export const M_TO_FT = 3.28084;

/* Glyph paths for the sport-specific markers (wing at usable-lift top, cloud
   at cloud base), ported verbatim from the site renderer. */
const WING_MARKER_PATH = "M-8 2Q0-6.5 8 2Q0-1.5-8 2Z";
const CLOUD_MARKER_PATH =
  "M-7 2.5h14a3.2 3.2 0 0 0-.6-6.3A5 5 0 0 0-3-5a4 4 0 0 0-4 4 3 3 0 0 0 0 3.5Z";

interface ResolvedLevel {
  pressureHpa: number;
  heightM: number;
  temperatureC: number;
  dewPointC: number;
  windSpeedMs: number;
  windDirectionDeg: number;
  verticalVelocityPaS: number | null;
  cloudFractionPercent: number | null;
}

interface ResolvedHour {
  validAt: string;
  surface: {
    pressurePa: number;
    temperatureC: number;
    dewPointC: number;
    windSpeedMs: number;
    windDirectionDeg: number;
    cloudCoverPercent: number;
    precipitationMmHr: number;
    // Science-wave fields: null where the model does not publish them.
    windGustMs: number | null;
    capeJkg: number | null;
    cinJkg: number | null;
    pblHeightM: number | null;
    lowCloudPercent: number | null;
    midCloudPercent: number | null;
    highCloudPercent: number | null;
  };
  levels: ResolvedLevel[];
  derived: {
    boundaryLayerTopM: number | null;
    thermalVelocityMs: number;
    cloudBaseM: number;
    usableLiftTopM: number | null;
  };
  bands: {
    pressurePa: Band;
    precipitationMmHr: Band;
    cloudCoverPercent: Band;
    capeJkg: Band;
    pblHeightM: Band;
    thermalVelocityMs: Band;
    boundaryLayerTopM: Band;
    cloudBaseM: Band;
    usableLiftTopM: Band;
  };
}

type Band = { p25: number; p75: number } | null;

function bandOf(value: Scalar | null): Band {
  if (value === null || !isEnsembleValue(value)) return null;
  return { p25: value.p25, p75: value.p75 };
}

/** Median of an optional Scalar position: absent stays null. */
function p50opt(value: Scalar | undefined): number | null {
  return value == null ? null : p50(value);
}

function resolveHour(hour: WindgramHour): ResolvedHour {
  const levels = hour.levels
    .map((level) => ({
      pressureHpa: p50(level.pressureHpa),
      heightM: p50(level.heightM),
      temperatureC: p50(level.temperatureC),
      dewPointC: p50(level.dewPointC),
      windSpeedMs: p50(level.windSpeedMs),
      windDirectionDeg: p50(level.windDirectionDeg),
      verticalVelocityPaS: level.verticalVelocityPaS == null ? null : p50(level.verticalVelocityPaS),
      cloudFractionPercent: p50opt(level.cloudFractionPercent),
    }))
    .sort((left, right) => left.heightM - right.heightM);
  return {
    validAt: hour.validAt,
    surface: {
      pressurePa: p50(hour.surface.pressurePa),
      temperatureC: p50(hour.surface.temperatureC),
      dewPointC: p50(hour.surface.dewPointC),
      windSpeedMs: p50(hour.surface.windSpeedMs),
      windDirectionDeg: p50(hour.surface.windDirectionDeg),
      cloudCoverPercent: p50(hour.surface.cloudCoverPercent),
      precipitationMmHr: p50(hour.surface.precipitationMmHr),
      windGustMs: p50opt(hour.surface.windGustMs),
      capeJkg: p50opt(hour.surface.capeJkg),
      cinJkg: p50opt(hour.surface.cinJkg),
      pblHeightM: p50opt(hour.surface.pblHeightM),
      lowCloudPercent: p50opt(hour.surface.lowCloudPercent),
      midCloudPercent: p50opt(hour.surface.midCloudPercent),
      highCloudPercent: p50opt(hour.surface.highCloudPercent),
    },
    levels,
    derived: {
      boundaryLayerTopM: p50(hour.derived.boundaryLayerTopM),
      thermalVelocityMs: p50(hour.derived.thermalVelocityMs),
      cloudBaseM: p50(hour.derived.cloudBaseM),
      usableLiftTopM: p50(hour.derived.usableLiftTopM),
    },
    bands: {
      pressurePa: bandOf(hour.surface.pressurePa),
      precipitationMmHr: bandOf(hour.surface.precipitationMmHr),
      cloudCoverPercent: bandOf(hour.surface.cloudCoverPercent),
      capeJkg: bandOf(hour.surface.capeJkg ?? null),
      pblHeightM: bandOf(hour.surface.pblHeightM ?? null),
      thermalVelocityMs: bandOf(hour.derived.thermalVelocityMs),
      boundaryLayerTopM: bandOf(hour.derived.boundaryLayerTopM),
      cloudBaseM: bandOf(hour.derived.cloudBaseM),
      usableLiftTopM: bandOf(hour.derived.usableLiftTopM),
    },
  };
}

/* ---------------------------------------------------------- vertical nodes */

/* Stability node semantics: the surface node carries the surface-to-first-
   level lapse, and each level node carries the lapse of the layer ABOVE it
   (the topmost level repeats the layer below — the null-lapse
   carry-forward). */
function lapseNodes(hour: ResolvedHour, floorM: number): FieldNode[] {
  const first = hour.levels[0];
  if (!first || first.heightM <= floorM) return [];
  const surfaceLapse = surfaceLapseCPer1000Ft(hour.surface.temperatureC, floorM, first);
  if (surfaceLapse === null) return [];
  let lastLapse = surfaceLapse;
  const nodes: FieldNode[] = [{ altitudeM: floorM, value: surfaceLapse }];
  for (let index = 0; index < hour.levels.length; index += 1) {
    const level = hour.levels[index];
    const next = hour.levels[index + 1];
    const layerLapse = next ? lapseRateCPer1000Ft(level, next) : null;
    if (layerLapse !== null) lastLapse = layerLapse;
    nodes.push({ altitudeM: level.heightM, value: lastLapse });
  }
  return nodes;
}

/* Profiles publish a surface dew point, so the surface node is the real
   2 m depression rather than borrowing the first level's. */
function depressionNodes(hour: ResolvedHour, floorM: number): FieldNode[] {
  if (hour.levels.length === 0) return [];
  return [
    {
      altitudeM: floorM,
      value: dewPointDepressionC(hour.surface.temperatureC, hour.surface.dewPointC),
    },
    ...hour.levels.map((level) => ({
      altitudeM: level.heightM,
      value: dewPointDepressionC(level.temperatureC, level.dewPointC),
    })),
  ];
}

function thermalIndexNodes(hour: ResolvedHour, floorM: number): FieldNode[] {
  if (hour.levels.length === 0) return [];
  return [
    { altitudeM: floorM, value: 0 },
    ...hour.levels.map((level) => ({
      altitudeM: level.heightM,
      value: thermalIndexC({
        surfaceTemperatureC: hour.surface.temperatureC,
        surfaceElevationM: floorM,
        level,
      }),
    })),
  ];
}

function relativeHumidityNodes(hour: ResolvedHour, floorM: number): FieldNode[] {
  if (hour.levels.length === 0) return [];
  return [
    {
      altitudeM: floorM,
      value: relativeHumidityPercent(hour.surface.temperatureC, hour.surface.dewPointC),
    },
    ...hour.levels.map((level) => ({
      altitudeM: level.heightM,
      value: relativeHumidityPercent(level.temperatureC, level.dewPointC),
    })),
  ];
}

/* Shear-rate nodes: each layer's vector shear divided by its thickness
   (m/s per km), placed at the layer midpoint. The surface layer runs from
   the 10 m wind at model elevation to the first level. */
function shearRateNodes(hour: ResolvedHour, floorM: number): FieldNode[] {
  const column = [
    {
      heightM: floorM,
      windSpeedMs: hour.surface.windSpeedMs,
      windDirectionDeg: hour.surface.windDirectionDeg,
    },
    ...hour.levels,
  ];
  const nodes: FieldNode[] = [];
  for (let index = 0; index < column.length - 1; index += 1) {
    const lower = column[index];
    const upper = column[index + 1];
    const thicknessM = upper.heightM - lower.heightM;
    if (thicknessM <= 0) continue;
    nodes.push({
      altitudeM: lower.heightM + thicknessM / 2,
      value: (vectorShearMs(lower, upper) / thicknessM) * 1000,
    });
  }
  return nodes;
}

function omegaNodes(hour: ResolvedHour): FieldNode[] {
  return hour.levels
    .filter((level) => level.verticalVelocityPaS !== null)
    .map((level) => ({ altitudeM: level.heightM, value: level.verticalVelocityPaS as number }));
}

/* Height at which the column's temperature-like profile crosses `target`,
   scanning surface + levels (identical crossing logic in both reference
   renderers). */
function verticalCrossing(
  points: Array<{ heightM: number; value: number }>,
  target: number,
): number | null {
  const sorted = [...points].sort((left, right) => left.heightM - right.heightM);
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const lower = sorted[index];
    const upper = sorted[index + 1];
    if ((target - lower.value) * (target - upper.value) > 0) continue;
    const span = upper.value - lower.value;
    if (span === 0) continue;
    return lower.heightM + ((target - lower.value) / span) * (upper.heightM - lower.heightM);
  }
  return null;
}

/* ---------------------------------------------------------------- builder */

/* Windowing options map to indices here, once, so everything downstream of
   buildScene sees exactly what hourIndices consumers see. Precedence
   (documented on SceneOptions): hourIndices is the most explicit form and
   wins; then hours (either shape); absent both, every hour renders. */
function resolveHourIndices(
  profile: WindgramProfile,
  options: SceneOptions,
): readonly number[] | undefined {
  if (options.hourIndices) return options.hourIndices;
  const hours = options.hours;
  if (hours === undefined) return undefined;
  if (isHourArray(hours)) {
    // Matched by validAt (unique per profile), so pre-windowed hour objects
    // — a groupByLocalDay group, windgramDisplayHours output — select
    // without index bookkeeping. Hours not in the profile are ignored.
    const indexByValidAt = new Map(profile.hours.map((hour, index) => [hour.validAt, index]));
    return hours
      .map((hour) => indexByValidAt.get(hour.validAt))
      .filter((index): index is number => index !== undefined);
  }
  return profile.hours
    .map((hour, index) => index)
    .filter(
      (index) => localDateKey(profile.hours[index].validAt, hours.timeZone) === hours.dateKey,
    );
}

function isHourArray(
  hours: ReadonlyArray<{ validAt: string }> | { timeZone: string; dateKey: string },
): hours is ReadonlyArray<{ validAt: string }> {
  return Array.isArray(hours);
}

export function buildScene(profile: WindgramProfile, options: SceneOptions): SceneGraph {
  const allHours = profile.hours.map(resolveHour);
  const hourIndices = resolveHourIndices(profile, options);
  const hours = hourIndices
    ? hourIndices.map((index) => allHours[index]).filter((hour) => hour !== undefined)
    : allHours;
  const overlays: Record<OverlayName, boolean> = { ...DEFAULT_OVERLAYS, ...options.overlays };
  const smooth = options.smooth !== false;
  const capeClasses = options.capeClasses ?? DEFAULT_CAPE_CLASSES;
  const columnWidth = options.columnWidthPx ?? DEFAULT_COLUMN_WIDTH;
  const plotHeight = options.plotHeightPx ?? DEFAULT_PLOT_HEIGHT;
  const floorM = profile.site.modelElevationM;
  const siteAltitudeM = profile.site.altitudeM;

  /* Usable-lift-top values for the series (pre-smoothing). The published
     derived.usableLiftTopM embeds the pipeline's fixed 1.0 m/s sink-rate
     convention; options.sinkRateMs recomputes the series with derive/'s
     parameterized usableLiftTopM over the same published inputs (at 1.0
     the two are float-identical). Ensemble documents deliberately keep the
     published percentile series even when the option is set: recomputing
     from p50 inputs is not the pipeline's per-member derivation aggregated
     to percentiles, and drawing it as if it were would fabricate a line. */
  const ensembleDerived = hours.some(
    (hour) =>
      hour.bands.usableLiftTopM !== null ||
      hour.bands.boundaryLayerTopM !== null ||
      hour.bands.thermalVelocityMs !== null ||
      hour.bands.cloudBaseM !== null,
  );
  const sinkRateMs = options.sinkRateMs;
  const usableLiftRaw =
    sinkRateMs === undefined || ensembleDerived
      ? hours.map((hour) => hour.derived.usableLiftTopM)
      : hours.map((hour) =>
          usableLiftTopM(
            {
              modelElevationM: floorM,
              boundaryLayerTopM: hour.derived.boundaryLayerTopM,
              thermalVelocityMs: hour.derived.thermalVelocityMs,
              cloudBaseM: hour.derived.cloudBaseM,
              levels: hour.levels,
            },
            sinkRateMs,
          ),
        );

  // Altitude domain: everything drawable must fit, including ensemble p75
  // band edges (the site scanned only medians; bands would clip otherwise).
  // Only VISIBLE series count — a toggled-off height line must not reserve
  // headroom (with defaults all-on this scan is unchanged).
  let topM = Math.max(floorM + 800, overlays.launch ? (siteAltitudeM ?? floorM) : floorM);
  for (const [hourIndex, hour] of hours.entries()) {
    for (const candidate of [
      overlays.cloudBase ? hour.derived.cloudBaseM : null,
      overlays.usableLiftTop ? usableLiftRaw[hourIndex] : null,
      overlays.boundaryLayerTop ? hour.derived.boundaryLayerTopM : null,
      // Model PBL height publishes AGL; the drawn line sits at floor + depth.
      overlays.pblHeight && hour.surface.pblHeightM != null ? floorM + hour.surface.pblHeightM : null,
      overlays.cloudBase ? hour.bands.cloudBaseM?.p75 : null,
      overlays.usableLiftTop ? hour.bands.usableLiftTopM?.p75 : null,
      overlays.boundaryLayerTop ? hour.bands.boundaryLayerTopM?.p75 : null,
      overlays.pblHeight && hour.bands.pblHeightM != null ? floorM + hour.bands.pblHeightM.p75 : null,
    ]) {
      if (candidate != null && candidate > topM) topM = candidate;
    }
    for (const level of hour.levels) {
      if (level.heightM > topM) topM = level.heightM;
    }
  }
  topM *= 1.04;

  /* ----- strips (selection first: the plot top depends on the count) ----- */

  type StripSpec = {
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
  };
  const stripSpecs: StripSpec[] = [];
  const finite = (values: Array<number | null>) =>
    values.filter((value): value is number => value != null && Number.isFinite(value));

  {
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
                    x: MARGIN_LEFT + index * columnWidth,
                    width: columnWidth,
                    className: "wg-cloud-cell",
                    opacity: Number((Math.min(100, Math.max(0, value)) / 100).toFixed(2)),
                  },
            ),
          })),
        });
      }
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
              x: MARGIN_LEFT + index * columnWidth,
              width: columnWidth,
              className: capped ? `${riskClass} wg-cape-capped` : riskClass,
            };
          }),
        });
      }
    }
    if (overlays.buoyancyShear) {
      /* B/S per hour: derive/'s W* / surface-to-BL-top vector shear. Hours
         without a boundary layer or without levels have no ratio (gap); an
         unbounded ratio (zero shear) is stored as null too, since a strip
         cannot place infinity honestly. */
      const ratios = hours.map((hour) => {
        const shear = surfaceToBoundaryLayerShearMs({
          surfaceWind: hour.surface,
          modelElevationM: floorM,
          boundaryLayerTopM: hour.derived.boundaryLayerTopM,
          levels: hour.levels,
        });
        if (shear === null) return null;
        const ratio = buoyancyShearRatio(hour.derived.thermalVelocityMs, shear);
        return ratio !== null && Number.isFinite(ratio) ? ratio : null;
      });
      stripSpecs.push({
        key: "buoyancyShear",
        label: "B/S",
        unit: "ratio",
        values: ratios,
        bands: hours.map(() => null),
        minimum: 0,
        maximum: Math.max(5, ...finite(ratios)),
      });
    }
  }

  const plotTop = METRIC_TOP + stripSpecs.length * (METRIC_BAND_HEIGHT + METRIC_BAND_GAP) + PROFILE_GAP;
  const plotBottom = plotTop + plotHeight;
  const plotWidth = columnWidth * Math.max(hours.length, 1);
  const width = MARGIN_LEFT + plotWidth + MARGIN_RIGHT;
  const height = plotBottom + HOUR_LABEL_DY + BOTTOM_PADDING;

  const y = (altitudeM: number) =>
    plotTop + plotHeight * (1 - (altitudeM - floorM) / (topM - floorM));
  const x = (index: number) => MARGIN_LEFT + index * columnWidth;
  const xCenter = (index: number) => x(index) + columnWidth / 2;

  const strips: MetricStrip[] = stripSpecs.map((spec, stripIndex) => {
    const top = METRIC_TOP + stripIndex * (METRIC_BAND_HEIGHT + METRIC_BAND_GAP);
    const bottom = top + METRIC_BAND_HEIGHT;
    const range = Math.max(0.001, spec.maximum - spec.minimum);
    const yOf = (value: number) => {
      const fraction = Math.min(1, Math.max(0, (value - spec.minimum) / range));
      return bottom - fraction * METRIC_BAND_HEIGHT;
    };
    const points: Array<PlotPoint | null> = spec.values.map((value, index) =>
      value == null || !Number.isFinite(value) ? null : { x: xCenter(index), y: yOf(value) },
    );
    const linePath = pointPath(points);
    const complete = points.every((point) => point !== null);
    const areaPath =
      complete && points.length > 0
        ? `${linePath} L${xCenter(spec.values.length - 1).toFixed(2)},${bottom} L${xCenter(0).toFixed(2)},${bottom} Z`
        : "";
    const band = bandPath(
      spec.bands.map((entry, index) =>
        entry === null
          ? null
          : { x: xCenter(index), yLow: yOf(entry.p25), yHigh: yOf(entry.p75) },
      ),
    );
    const strip: MetricStrip = {
      key: spec.key,
      className: `wg-strip-${spec.key}`,
      label: spec.label,
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

  /* --------------------------------------------------------------- fields */

  const fieldArgs = { floorM, topM, plotLeft: MARGIN_LEFT, plotTop, plotBottom, plotWidth };
  const fields: FieldLayer[] = [];
  const pushField = (
    key: FieldLayer["key"],
    nodesByHour: FieldNode[][],
    classify: (value: number) => string | null,
    classOrder: string[],
  ) => {
    const paths = sampledFieldPaths({ ...fieldArgs, nodesByHour, classify });
    const ordered = classOrder
      .filter((className) => paths[className])
      .map((className) => ({ className, path: paths[className] }));
    if (ordered.length > 0) fields.push({ key, paths: ordered });
  };

  const lapseNodesByHour = hours.map((hour) => lapseNodes(hour, floorM));
  if (overlays.stability) {
    pushField(
      "stability",
      lapseNodesByHour,
      (value) => `wg-stab-${stabilityClass(value)}`,
      [
        "wg-stab-very-unstable",
        "wg-stab-unstable",
        "wg-stab-conditional-strong",
        "wg-stab-conditional",
        "wg-stab-near-neutral",
        "wg-stab-stable",
        "wg-stab-inverted",
        "wg-stab-strong-inversion",
      ],
    );
  }
  if (overlays.clouds) {
    /* Cloud shading precedence (documented on the overlay in types.ts):
       hours whose levels carry the model's own cloud fraction (GFS) shade
       from it; every other hour keeps the dew-point-depression inference.
       Both routes land in the same three classes so the chart speaks one
       visual language regardless of source. */
    const modelCloudNodesByHour = hours.map((hour) =>
      hour.levels
        .filter((level) => level.cloudFractionPercent !== null)
        .map((level) => ({
          altitudeM: level.heightM,
          value: level.cloudFractionPercent as number,
        })),
    );
    const hasModelCloud = modelCloudNodesByHour.map((nodes) => nodes.length >= 2);
    const cloudClassOrder = ["wg-cloud-light", "wg-cloud-medium", "wg-cloud-dense"];
    pushField(
      "clouds",
      hours.map((hour, index) => (hasModelCloud[index] ? [] : depressionNodes(hour, floorM))),
      (value) =>
        value < 0.5
          ? "wg-cloud-dense"
          : value < 1.5
            ? "wg-cloud-medium"
            : value < 3
              ? "wg-cloud-light"
              : null,
      cloudClassOrder,
    );
    pushField(
      "clouds",
      modelCloudNodesByHour.map((nodes, index) => (hasModelCloud[index] ? nodes : [])),
      (value) =>
        value >= 85
          ? "wg-cloud-dense"
          : value >= 60
            ? "wg-cloud-medium"
            : value >= 30
              ? "wg-cloud-light"
              : null,
      cloudClassOrder,
    );
  }
  if (overlays.thermalIndex) {
    pushField(
      "thermalIndex",
      hours.map((hour) => thermalIndexNodes(hour, floorM)),
      (value) =>
        value <= -8
          ? "wg-ti-strong"
          : value <= -4
            ? "wg-ti-good"
            : value <= -1
              ? "wg-ti-fair"
              : value <= 0
                ? "wg-ti-weak"
                : null,
      ["wg-ti-weak", "wg-ti-fair", "wg-ti-good", "wg-ti-strong"],
    );
  }
  if (overlays.relativeHumidity) {
    pushField(
      "relativeHumidity",
      hours.map((hour) => relativeHumidityNodes(hour, floorM)),
      (value) => (value >= 95 ? "wg-rh-95" : value >= 80 ? "wg-rh-80" : value >= 60 ? "wg-rh-60" : null),
      ["wg-rh-60", "wg-rh-80", "wg-rh-95"],
    );
  }
  if (overlays.windShear) {
    pushField(
      "windShear",
      hours.map((hour) => shearRateNodes(hour, floorM)),
      (value) =>
        value >= 8
          ? "wg-shear-strong"
          : value >= 4
            ? "wg-shear-moderate"
            : value >= 2
              ? "wg-shear-light"
              : null,
      ["wg-shear-light", "wg-shear-moderate", "wg-shear-strong"],
    );
  }
  if (overlays.verticalVelocity) {
    pushField(
      "verticalVelocity",
      hours.map(omegaNodes),
      (value) =>
        value <= -0.5
          ? "wg-omega-lift-strong"
          : value <= -0.1
            ? "wg-omega-lift"
            : value >= 0.5
              ? "wg-omega-sink-strong"
              : value >= 0.1
                ? "wg-omega-sink"
                : null,
      ["wg-omega-sink", "wg-omega-sink-strong", "wg-omega-lift", "wg-omega-lift-strong"],
    );
  }

  /* --------------------------------------------------------------- series */

  const series: SeriesElement[] = [];
  const labels: SceneLabel[] = [];

  const smoothSeries = (values: Array<number | null>) =>
    smooth
      ? smooth121(values.map((value, index) => ({ validAt: hours[index].validAt, value })))
      : values;

  const altitudeSeries = (
    key: SeriesElement["key"],
    className: string,
    values: Array<number | null>,
    bands: Array<Band>,
    strokeWidth: number,
    dash: string | null,
  ): { values: Array<number | null> } => {
    const path = pointPath(
      values.map((value, index) => (value == null ? null : { x: xCenter(index), y: y(value) })),
    );
    const band = bandPath(
      bands.map((entry, index) =>
        entry === null ? null : { x: xCenter(index), yLow: y(entry.p25), yHigh: y(entry.p75) },
      ),
    );
    series.push({ key, className, path, bandPath: band === "" ? null : band, strokeWidth, dash });
    return { values };
  };

  const smoothBand = (bands: Array<Band>): Array<Band> => {
    if (!smooth) return bands;
    const p25 = smoothSeries(bands.map((band) => band?.p25 ?? null));
    const p75 = smoothSeries(bands.map((band) => band?.p75 ?? null));
    return bands.map((band, index) =>
      band === null ? null : { p25: p25[index] as number, p75: p75[index] as number },
    );
  };

  if (overlays.boundaryLayerTop) {
    altitudeSeries(
      "boundaryLayerTop",
      "wg-series-boundary",
      hours.map((hour) => hour.derived.boundaryLayerTopM),
      hours.map((hour) => hour.bands.boundaryLayerTopM),
      2,
      "10 5",
    );
  }
  if (overlays.pblHeight && hours.some((hour) => hour.surface.pblHeightM != null)) {
    /* The model's own boundary-layer top, beside the parcel-derived one so
       the two are directly comparable. pblHeightM publishes metres AGL —
       the AGL-vs-MSL conversion happens exactly here, once, by adding the
       model elevation the profile also publishes. Distinct token
       (--wg-pbl), tighter dash than the parcel series. */
    altitudeSeries(
      "modelPblTop",
      "wg-series-pbl",
      hours.map((hour) =>
        hour.surface.pblHeightM == null ? null : floorM + hour.surface.pblHeightM,
      ),
      hours.map((hour) =>
        hour.bands.pblHeightM == null
          ? null
          : { p25: floorM + hour.bands.pblHeightM.p25, p75: floorM + hour.bands.pblHeightM.p75 },
      ),
      1.6,
      "3 3",
    );
  }
  // Values stay computed even when a line is toggled off — the selected-hour
  // glyphs below reuse them, and each glyph rides its own line's toggle.
  const cloudBaseValues = smoothSeries(hours.map((hour) => hour.derived.cloudBaseM));
  if (overlays.cloudBase) {
    altitudeSeries(
      "cloudBase",
      "wg-series-cloud-base",
      cloudBaseValues,
      smoothBand(hours.map((hour) => hour.bands.cloudBaseM)),
      1.8,
      "1 5",
    );
  }
  const usableValues = smoothSeries(usableLiftRaw);
  if (overlays.usableLiftTop) {
    altitudeSeries(
      "usableLiftTop",
      "wg-series-usable",
      usableValues,
      smoothBand(hours.map((hour) => hour.bands.usableLiftTopM)),
      2.3,
      null,
    );
  }

  const crossingSeries = (
    key: SeriesElement["key"],
    classNameOf: (target: number) => string,
    labelClassOf: (target: number) => string,
    labelTextOf: (target: number) => string,
    pointsOf: (hour: ResolvedHour) => Array<{ heightM: number; value: number }>,
    targets: number[],
    strokeOf: (target: number) => { width: number; dash: string | null },
  ) => {
    for (const target of targets) {
      const crossings = hours.map((hour) => verticalCrossing(pointsOf(hour), target));
      const path = pointPath(
        crossings.map((altitude, index) =>
          altitude == null ? null : { x: xCenter(index), y: y(altitude) },
        ),
      );
      if (path === "") continue;
      const stroke = strokeOf(target);
      series.push({
        key,
        className: classNameOf(target),
        path,
        bandPath: null,
        strokeWidth: stroke.width,
        dash: stroke.dash,
      });
      const labelIndex = crossings.reduce<number>(
        (best, altitude, index) => (altitude != null ? index : best),
        -1,
      );
      if (labelIndex >= 0) {
        labels.push({
          x: xCenter(labelIndex) - 4,
          y: y(crossings[labelIndex] as number) - 5,
          text: labelTextOf(target),
          className: labelClassOf(target),
          anchor: "end",
        });
      }
    }
  };

  if (overlays.temperature) {
    crossingSeries(
      "isotherm",
      (t) => (t === 0 ? "wg-isotherm wg-isotherm-freezing" : "wg-isotherm"),
      (t) => (t === 0 ? "wg-isotherm-label wg-isotherm-label-freezing" : "wg-isotherm-label"),
      (t) => `${t}°`,
      (hour) => [
        { heightM: floorM, value: hour.surface.temperatureC },
        ...hour.levels.map((level) => ({ heightM: level.heightM, value: level.temperatureC })),
      ],
      [0, 10, 20],
      (t) => (t === 0 ? { width: 1.7, dash: "7 3 1 3" } : { width: 1, dash: null }),
    );
  }
  if (overlays.dewPoint) {
    /* Isodrosotherms: constant-dew-point lines, same crossing engine as the
       isotherms; where a dewpoint line converges with its isotherm the air
       is saturated. */
    crossingSeries(
      "dewPointIsoline",
      () => "wg-dewpoint-isoline",
      () => "wg-dewpoint-label",
      (t) => `Td ${t}°`,
      (hour) => [
        { heightM: floorM, value: hour.surface.dewPointC },
        ...hour.levels.map((level) => ({ heightM: level.heightM, value: level.dewPointC })),
      ],
      [0, 10],
      () => ({ width: 1.2, dash: "4 3" }),
    );
  }

  /* ---------------------------------------------------------------- barbs */

  const barbs: BarbPlacement[] = [];
  if (overlays.wind) {
    const stride = hours.length > 9 ? 2 : 1;
    hours.forEach((hour, index) => {
      if (index % stride !== 0) return;
      const cx = xCenter(index);
      const place = (cy: number, speedMs: number, directionDeg: number) => {
        const speedKmh = msToKmh(speedMs);
        const parts = windBarbParts(speedKmh);
        const paths = windBarbPaths(speedKmh);
        barbs.push({
          x: cx,
          y: cy,
          directionDeg,
          speedKmh,
          calm: parts.calm,
          shaftPath: paths.shaft,
          pennantPaths: paths.pennants,
          scale: WIND_BARB_SCALE,
        });
      };
      place(y(floorM), hour.surface.windSpeedMs, hour.surface.windDirectionDeg);
      const levelStride = hour.levels.length > 6 ? 2 : 1;
      hour.levels.forEach((level, levelIndex) => {
        if (levelIndex % levelStride !== 0 && levelIndex !== hour.levels.length - 1) return;
        place(y(level.heightM), level.windSpeedMs, level.windDirectionDeg);
      });
    });
  }

  /* Gust readouts ride just above the surface barbs at the same stride, so
     sustained (barb) and gust (number) read as one row. The scene labels
     the value "G…"; whether that means hour-max or instantaneous is the
     consumer's caption, from models.json capabilities.gust. */
  const gusts: GustMark[] = [];
  if (overlays.gusts) {
    const stride = hours.length > 9 ? 2 : 1;
    hours.forEach((hour, index) => {
      if (index % stride !== 0) return;
      const gustMs = hour.surface.windGustMs;
      if (gustMs == null) return;
      const speedKmh = msToKmh(gustMs);
      gusts.push({
        x: xCenter(index),
        y: y(floorM) - 16,
        speedKmh,
        label: `G${Math.round(speedKmh)}`,
      });
    });
  }

  /* ------------------------------------------------------- axes + markers */

  const altitudeTicks: AltitudeTick[] = [];
  for (let tick = 0; tick <= 5; tick += 1) {
    const altitudeM = floorM + ((topM - floorM) * tick) / 5;
    altitudeTicks.push({
      altitudeM,
      y: y(altitudeM),
      labelMetres: `${Math.round(altitudeM)}m`,
      labelFeet: `${Math.round(altitudeM * M_TO_FT)}ft`,
    });
  }

  // Median published height per pressure level, >= 80 m apart.
  const byPressure = new Map<number, number[]>();
  for (const hour of hours) {
    for (const level of hour.levels) {
      const heights = byPressure.get(level.pressureHpa) ?? [];
      heights.push(level.heightM);
      byPressure.set(level.pressureHpa, heights);
    }
  }
  const pressureAltitude: PressureAltitudeTick[] = [
    { altitudeM: Math.round(floorM), pressureHpa: null as number | null },
    ...[...byPressure.entries()].map(([pressureHpa, heights]) => ({
      altitudeM: Math.round(median(heights)),
      pressureHpa: pressureHpa as number | null,
    })),
  ]
    .sort((left, right) => left.altitudeM - right.altitudeM)
    .filter(
      (entry, index, entries) => index === 0 || entry.altitudeM - entries[index - 1].altitudeM >= 80,
    )
    .map((entry) => ({ ...entry, y: y(entry.altitudeM) }));

  const hourTicks: HourTick[] = hours.map((hour, index) => ({
    index,
    x: xCenter(index),
    label: hourLabel(hour.validAt, options.timeZone),
    gridline: index % 2 === 0,
  }));

  const selectedHourIndex = hours.reduce(
    (best, hour, index) =>
      hour.derived.thermalVelocityMs > (hours[best]?.derived.thermalVelocityMs ?? 0) ? index : best,
    0,
  );
  const markers: SceneMarker[] = [];
  const selected = hours[selectedHourIndex];
  if (selected) {
    const usable = usableValues[selectedHourIndex];
    if (overlays.usableLiftTop && usable != null) {
      markers.push({ kind: "wing", x: xCenter(selectedHourIndex), y: y(usable), path: WING_MARKER_PATH });
    }
    const cloudBase = cloudBaseValues[selectedHourIndex];
    if (overlays.cloudBase && cloudBase != null) {
      markers.push({ kind: "cloud", x: xCenter(selectedHourIndex), y: y(cloudBase), path: CLOUD_MARKER_PATH });
    }
  }

  const launch =
    overlays.launch && siteAltitudeM != null && siteAltitudeM >= floorM && siteAltitudeM <= topM
      ? { y: y(siteAltitudeM), altitudeM: siteAltitudeM, label: `launch ${Math.round(siteAltitudeM)} m` }
      : null;

  /* ------------------------------------------------------------- sampling */

  const sampling: HourSampling[] = hours.map((hour, index) => {
    const surfaceWind = windToComponents(hour.surface.windSpeedMs, hour.surface.windDirectionDeg);
    const levelWinds = hour.levels.map((level) =>
      windToComponents(level.windSpeedMs, level.windDirectionDeg),
    );
    return {
      validAt: hour.validAt,
      temperatureC: [
        { altitudeM: floorM, value: hour.surface.temperatureC },
        ...hour.levels.map((level) => ({ altitudeM: level.heightM, value: level.temperatureC })),
      ],
      dewPointC: [
        { altitudeM: floorM, value: hour.surface.dewPointC },
        ...hour.levels.map((level) => ({ altitudeM: level.heightM, value: level.dewPointC })),
      ],
      lapseCPer1000Ft: lapseNodesByHour[index],
      thermalIndexC: thermalIndexNodes(hour, floorM),
      relativeHumidityPercent: relativeHumidityNodes(hour, floorM),
      windU: [
        { altitudeM: floorM, value: surfaceWind.uMs },
        ...hour.levels.map((level, levelIndex) => ({
          altitudeM: level.heightM,
          value: levelWinds[levelIndex].uMs,
        })),
      ],
      windV: [
        { altitudeM: floorM, value: surfaceWind.vMs },
        ...hour.levels.map((level, levelIndex) => ({
          altitudeM: level.heightM,
          value: levelWinds[levelIndex].vMs,
        })),
      ],
      verticalVelocityPaS: omegaNodes(hour),
    };
  });

  return {
    width,
    height,
    ariaLabel: sceneAriaLabel(profile, hours.map((hour) => hour.validAt), options.timeZone),
    scales: {
      plotLeft: MARGIN_LEFT,
      plotTop,
      plotWidth,
      plotHeight,
      columnWidth,
      floorM,
      topM,
      hourCount: hours.length,
    },
    axes: { altitude: altitudeTicks, pressureAltitude, hours: hourTicks },
    strips,
    fields,
    series,
    barbs,
    gusts,
    labels,
    markers,
    launch,
    selectedHourIndex,
    highlightSelectedHour: overlays.selectedHour,
    hourValidAts: hours.map((hour) => hour.validAt),
    sampling,
  };
}

/* The accessible name says WHICH forecast this is — site, model slug, and
   the rendered hour span in the display timezone — not just what kind of
   chart it is. en-CA date formatting gives ISO-style YYYY-MM-DD, matching
   the run timestamps consumers already read. */
function sceneAriaLabel(
  profile: WindgramProfile,
  hourValidAts: ReadonlyArray<string>,
  timeZone: string,
): string {
  const chartDescription =
    "surface metric strips above a time-height field; derived series, isotherms, shading overlays and winds aloft are drawn over the profile";
  const identity = `Windgram for ${profile.site.name}, model ${profile.model}`;
  if (hourValidAts.length === 0) return `${identity}, no forecast hours: ${chartDescription}.`;
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const first = hourValidAts[0];
  const last = hourValidAts[hourValidAts.length - 1];
  const firstDay = day.format(new Date(first));
  const lastDay = day.format(new Date(last));
  const span =
    firstDay === lastDay
      ? `${firstDay} ${hourLabel(first, timeZone)}:00 to ${hourLabel(last, timeZone)}:00`
      : `${firstDay} ${hourLabel(first, timeZone)}:00 to ${lastDay} ${hourLabel(last, timeZone)}:00`;
  return `${identity}, ${span} (${timeZone}): ${chartDescription}.`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

const hourLabelFormatters = new Map<string, Intl.DateTimeFormat>();

function hourLabel(validAt: string, timeZone: string): string {
  let formatter = hourLabelFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false });
    hourLabelFormatters.set(timeZone, formatter);
  }
  // ICU versions disagree on zero-padding "numeric" h23 hours ("07" vs "7");
  // normalize through Number so labels are deterministic everywhere.
  return String(Number(formatter.format(new Date(validAt))));
}

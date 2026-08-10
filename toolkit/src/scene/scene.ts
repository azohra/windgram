import { type WindgramProfile } from "../contract/index.js";
import { p50 } from "../derive/ensemble.js";
import {
  cosSolarZenith,
  isSmokeAwareProfile,
  smokeAdjustedThermalVelocityMs,
  smokeAotFromColumn,
  smokeHoursByValidAt,
  smokeTransmittance,
} from "../derive/smoke.js";
import { lapseRateCPer1000Ft, surfaceLapseCPer1000Ft } from "../derive/lapse.js";
import { dewPointDepressionC, relativeHumidityPercent } from "../derive/moisture.js";
import { vectorShearMs } from "../derive/shear.js";
import { smooth121 } from "../derive/smoothing.js";
import { WINDGRAM_STABILITY_CLASSES } from "../derive/stability.js";
import { thermalIndexC } from "../derive/thermal-index.js";
import { usableLiftTopM } from "../derive/usable-lift.js";
import { msToKmh, windToComponents } from "../derive/wind.js";
import { BARB_GLYPH_HEIGHT, BARB_GLYPH_RADIUS, windBarbParts, windBarbPaths } from "./barbs.js";
import { resolveSelection } from "./hit-test.js";
import { sampledFieldPaths, type FieldBanding, type FieldNode } from "./field.js";
import { bandPath, pointPath } from "./path.js";
import { resolveHour, resolveHourIndices, type Band, type ResolvedHour } from "./resolve.js";
import {
  METRIC_BAND_GAP,
  METRIC_BAND_HEIGHT,
  METRIC_TOP,
  buildStripSpecs,
  layoutStrips,
  type StripGeometry,
} from "./strips.js";
import {
  DEFAULT_CAPE_CLASSES,
  DEFAULT_OVERLAYS,
  type AltitudeTick,
  type BarbPlacement,
  type FieldLayer,
  type GustMark,
  type HourSampling,
  type HourTick,
  type OverlayName,
  type PressureAltitudeTick,
  type SceneGraph,
  type SceneLabel,
  type SceneMarker,
  type SceneOptions,
  type SeriesElement,
  type SurfaceTemperatureMark,
} from "./types.js";

/* Layout constants ported from the site renderer (the reference for
   geometry; the strip-stack constants live in strips.ts). PROFILE_TOP is
   derived from the strip count instead of being a magic 148, so optional
   strips (B/S) can join without overlap. */
const PROFILE_GAP = 8;
const MARGIN_LEFT = 60;
const MARGIN_RIGHT = 60;
const DEFAULT_COLUMN_WIDTH = 44;
const DEFAULT_PLOT_HEIGHT = 340;
const HOUR_LABEL_DY = 18;
const BOTTOM_PADDING = 14;
/* The surfaceTemperature row sits one line under the hour labels; the
   scene grows by this much when the overlay draws. */
const SURFACE_TEMP_ROW_PX = 14;
/* Barb scale follows the column pitch: the reference 0.85 at the default
   44px columns and below, growing linearly to 1.0 at 66px and wider —
   page-scale charts get page-scale barbs. options.barbScale pins it. */
const BARB_SCALE_MIN = 0.85;
const BARB_SCALE_MIN_COLUMN = DEFAULT_COLUMN_WIDTH;
const BARB_SCALE_MAX_COLUMN = 66;
/* Default vertical clearance between one column's barbs, at scale 1;
   the resolved default multiplies by the resolved barb scale. */
const BARB_MIN_GAP_PX = 24;
export const M_TO_FT = 3.28084;

function pitchBarbScale(columnWidth: number): number {
  const span = BARB_SCALE_MAX_COLUMN - BARB_SCALE_MIN_COLUMN;
  const fraction = Math.min(1, Math.max(0, (columnWidth - BARB_SCALE_MIN_COLUMN) / span));
  return BARB_SCALE_MIN + (1 - BARB_SCALE_MIN) * fraction;
}

/* Glyph paths for the sport-specific markers (wing at usable-lift top, cloud
   at cloud base), ported verbatim from the site renderer. */
const WING_MARKER_PATH = "M-8 2Q0-6.5 8 2Q0-1.5-8 2Z";
const CLOUD_MARKER_PATH =
  "M-7 2.5h14a3.2 3.2 0 0 0-.6-6.3A5 5 0 0 0-3-5a4 4 0 0 0-4 4 3 3 0 0 0 0 3.5Z";

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

export function buildScene(profile: WindgramProfile, options: SceneOptions): SceneGraph {
  // Index-aligned with profile.hours (hourIndices must keep meaning), with
  // nulls where an hour had no renderable state; the nulls drop here.
  const allHours = profile.hours.map(resolveHour);
  const hourIndices = resolveHourIndices(profile, options);
  let hours = (
    hourIndices ? hourIndices.map((index) => allHours[index]) : allHours
  ).filter((hour): hour is ResolvedHour => hour != null);
  const overlays: Record<OverlayName, boolean> = { ...DEFAULT_OVERLAYS, ...options.overlays };

  /* Smoke, per rendered hour — ONE source per strip, never a blend: a
     strip carries one provenance label, so mixing two models' hours under
     it would lie. The profile's own block wins (same-run provenance, and
     its published AOT); only a profile with no smoke at all falls back to
     the supplied smoke document through the validAt join, AOT derived
     from the plume column. smokeSource records whichever model fed the
     drawn strip. */
  const profileHasSmoke = hours.some((hour) => hour.smoke !== null);
  const joinedSmoke =
    !profileHasSmoke && options.smoke ? smokeHoursByValidAt(options.smoke) : null;
  const smokeSeries = hours.map((hour) => {
    if (profileHasSmoke) {
      return hour.smoke ? { surfaceUgm3: hour.smoke.surfaceUgm3, aot: hour.smoke.aot } : null;
    }
    const documentHour = joinedSmoke?.get(hour.validAt);
    if (!documentHour) return null;
    const surfaceUgm3 = p50(documentHour.smokePlumeSurfaceUgm3);
    const columnMgm2 = p50(documentHour.smokePlumeColumnMgm2);
    if (surfaceUgm3 === null || columnMgm2 === null) return null;
    return { surfaceUgm3, aot: smokeAotFromColumn(columnMgm2) };
  });
  const smokeSource = profileHasSmoke
    ? { model: profile.model, referenceTime: profile.run.referenceTime }
    : options.smoke && smokeSeries.some((entry) => entry !== null)
      ? { model: options.smoke.model, referenceTime: options.smoke.run.referenceTime }
      : null;

  /* The smoke-adjusted alternate view: derate each hour's w* by the
     cube root of the slant-path transmittance and re-derive its lift
     envelope, BEFORE anything downstream reads the hours — the strip,
     the usable-lift series, the best-hour pick, and any sink-rate
     recompute all see one coherent view. Never applied to a profile
     whose fluxes already feel smoke (semantics.smoke
     "radiativelyCoupled"): the request quietly no-ops and
     smokeAdjustment stays null, which is the renderer's signal that the
     base picture is already smoke-aware. On ensembles the medians and
     the w* envelope scale (quantile-safe: × ∛f is monotone); the
     lift-top envelope cannot be re-derived from percentiles alone, so
     it drops rather than lies. */
  let smokeAdjustment: SceneGraph["smokeAdjustment"] = null;
  if (options.smokeAdjusted && smokeSource && !isSmokeAwareProfile(profile)) {
    hours = hours.map((hour, index) => {
      const entry = smokeSeries[index];
      if (!entry || entry.aot <= 0) return hour;
      const transmittance = smokeTransmittance(
        entry.aot,
        cosSolarZenith(hour.validAt, profile.site.latitude, profile.site.longitude),
      );
      if (transmittance >= 1) return hour;
      const adjustedW = smokeAdjustedThermalVelocityMs(
        hour.derived.thermalVelocityMs,
        transmittance,
      );
      const scale = Math.cbrt(transmittance);
      const wBand = hour.bands.thermalVelocityMs;
      return {
        ...hour,
        derived: {
          ...hour.derived,
          thermalVelocityMs: adjustedW,
          usableLiftTopM: usableLiftTopM({
            modelElevationM: profile.site.modelElevationM,
            boundaryLayerTopM: hour.derived.boundaryLayerTopM,
            thermalVelocityMs: adjustedW,
            cloudBaseM: hour.derived.cloudBaseM,
            levels: hour.levels,
          }),
        },
        bands: {
          ...hour.bands,
          thermalVelocityMs: wBand
            ? { p25: wBand.p25 * scale, p75: wBand.p75 * scale }
            : null,
          usableLiftTopM: null,
        },
      };
    });
    smokeAdjustment = { smokeModel: smokeSource.model, smokeRun: smokeSource.referenceTime };
  }
  const smooth = options.smooth !== false;
  const capeClasses = options.capeClasses ?? DEFAULT_CAPE_CLASSES;
  /* Container fit: widthPx states the consumer's intent (fill this panel)
     and wins over columnWidthPx; the gutters stay internal so they can
     vary without a breaking export. fitMinColumns keeps a short window
     from stretching (the fit divides by at least that many columns), and
     the min/max clamp bounds the resolved pitch — both applied HERE, so a
     consumer with pitch policy never needs a probe build to learn what
     pitch the fit produced. The minimum wins over the maximum: a
     legibility floor beats a fit ceiling. */
  const fitColumns = Math.max(hours.length, Math.max(1, Math.floor(options.fitMinColumns ?? 1)));
  let columnWidth =
    options.widthPx !== undefined
      ? Math.max(1, (options.widthPx - MARGIN_LEFT - MARGIN_RIGHT) / fitColumns)
      : (options.columnWidthPx ?? DEFAULT_COLUMN_WIDTH);
  if (options.maxColumnWidthPx !== undefined) {
    columnWidth = Math.min(columnWidth, options.maxColumnWidthPx);
  }
  if (options.minColumnWidthPx !== undefined) {
    columnWidth = Math.max(columnWidth, options.minColumnWidthPx);
  }
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

  const plotWidth = columnWidth * Math.max(hours.length, 1);
  const stripGeometry: StripGeometry = { marginLeft: MARGIN_LEFT, columnWidth, plotWidth };
  const stripSpecs = buildStripSpecs({
    hours,
    overlays,
    capeClasses,
    floorM,
    smokeSeries,
    geometry: stripGeometry,
  });

  const plotTop = METRIC_TOP + stripSpecs.length * (METRIC_BAND_HEIGHT + METRIC_BAND_GAP) + PROFILE_GAP;
  const plotBottom = plotTop + plotHeight;
  const width = MARGIN_LEFT + plotWidth + MARGIN_RIGHT;
  const surfaceTemperatureRow = overlays.surfaceTemperature && hours.length > 0;
  const height =
    plotBottom +
    HOUR_LABEL_DY +
    (surfaceTemperatureRow ? SURFACE_TEMP_ROW_PX : 0) +
    BOTTOM_PADDING;

  const y = (altitudeM: number) =>
    plotTop + plotHeight * (1 - (altitudeM - floorM) / (topM - floorM));
  const x = (index: number) => MARGIN_LEFT + index * columnWidth;
  const xCenter = (index: number) => x(index) + columnWidth / 2;

  const strips = layoutStrips(stripSpecs, {
    geometry: stripGeometry,
    stripLabels: options.stripLabels,
  });

  /* --------------------------------------------------------------- fields */

  const fieldArgs = { floorM, topM, plotLeft: MARGIN_LEFT, plotTop, plotBottom, plotWidth };
  const fields: FieldLayer[] = [];
  /* Each field is an ordered banding of one continuous scalar; the engine
     takes the banding itself so iso-band vertices land on the exact
     threshold crossings (see field.ts). Paths require even-odd fill. */
  const pushField = (
    key: FieldLayer["key"],
    nodesByHour: FieldNode[][],
    banding: FieldBanding,
  ) => {
    const paths = sampledFieldPaths({ ...fieldArgs, nodesByHour, banding });
    const ordered: Array<{ className: string; path: string }> = [];
    for (const className of banding.classNames) {
      if (className !== null && paths[className]) {
        ordered.push({ className, path: paths[className] });
      }
    }
    if (ordered.length > 0) fields.push({ key, paths: ordered });
  };

  const lapseNodesByHour = hours.map((hour) => lapseNodes(hour, floorM));
  if (overlays.stability) {
    // One home: the class table's own boundaries are the breakpoints.
    pushField("stability", lapseNodesByHour, {
      breakpoints: WINDGRAM_STABILITY_CLASSES.slice(0, -1).map((entry) => entry.maxLapse),
      classNames: WINDGRAM_STABILITY_CLASSES.map((entry) => `wg-stab-${entry.className}`),
    });
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
    pushField(
      "clouds",
      hours.map((hour, index) => (hasModelCloud[index] ? [] : depressionNodes(hour, floorM))),
      {
        breakpoints: [0.5, 1.5, 3],
        classNames: ["wg-cloud-dense", "wg-cloud-medium", "wg-cloud-light", null],
      },
    );
    pushField(
      "clouds",
      modelCloudNodesByHour.map((nodes, index) => (hasModelCloud[index] ? nodes : [])),
      {
        breakpoints: [30, 60, 85],
        classNames: [null, "wg-cloud-light", "wg-cloud-medium", "wg-cloud-dense"],
      },
    );
  }
  if (overlays.thermalIndex) {
    pushField(
      "thermalIndex",
      hours.map((hour) => thermalIndexNodes(hour, floorM)),
      {
        breakpoints: [-8, -4, -1, 0],
        classNames: ["wg-ti-strong", "wg-ti-good", "wg-ti-fair", "wg-ti-weak", null],
      },
    );
  }
  if (overlays.relativeHumidity) {
    pushField(
      "relativeHumidity",
      hours.map((hour) => relativeHumidityNodes(hour, floorM)),
      {
        breakpoints: [60, 80, 95],
        classNames: [null, "wg-rh-60", "wg-rh-80", "wg-rh-95"],
      },
    );
  }
  if (overlays.windShear) {
    pushField(
      "windShear",
      hours.map((hour) => shearRateNodes(hour, floorM)),
      {
        breakpoints: [2, 4, 8],
        classNames: [null, "wg-shear-light", "wg-shear-moderate", "wg-shear-strong"],
      },
    );
  }
  if (overlays.verticalVelocity) {
    pushField("verticalVelocity", hours.map(omegaNodes), {
      breakpoints: [-0.5, -0.1, 0.1, 0.5],
      classNames: [
        "wg-omega-lift-strong",
        "wg-omega-lift",
        null,
        "wg-omega-sink",
        "wg-omega-sink-strong",
      ],
    });
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

  /* Density is geometry, not count. Horizontally: stride 1 whenever
     the column pitch covers the rotated glyph footprint, widening only as
     columns actually get too narrow. Vertically: a greedy min-gap walk up
     each column — level spacing is irregular (dense near the surface,
     sparse aloft), so a pixel gap thins exactly where it is dense, which
     the old count stride could not. The surface barb always draws; the
     topmost level always draws and wins over a lower neighbour that would
     crowd it. */
  const barbScale = options.barbScale ?? pitchBarbScale(columnWidth);
  const barbFootprint = 2 * BARB_GLYPH_RADIUS * barbScale;
  const barbStride =
    options.barbStride === undefined || options.barbStride === "auto"
      ? Math.max(1, Math.ceil(barbFootprint / columnWidth))
      : Math.max(1, Math.floor(options.barbStride));
  const barbMinGap = options.barbMinGapPx ?? BARB_MIN_GAP_PX * barbScale;
  /* The surface row sits half a rendered glyph height above the plot
     floor — dead on y(floorM) the glyph is bisected by the frame and
     spills over the time axis (the predecessor chart lifted its surface
     wind row clear of the bottom edge for exactly this reason).
     Pixel-space, so it holds at any plotHeightPx; exposed as
     scales.surfaceWindY so hit-testing agrees with the render. */
  const surfaceWindY = y(floorM) - (BARB_GLYPH_HEIGHT / 2) * barbScale;
  const barbs: BarbPlacement[] = [];
  if (overlays.wind) {
    hours.forEach((hour, index) => {
      if (index % barbStride !== 0) return;
      const cx = xCenter(index);
      const place = (
        cy: number,
        speedMs: number,
        directionDeg: number,
        altitudeM: number,
        surface: boolean,
      ) => {
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
          scale: barbScale,
          hourIndex: index,
          altitudeM,
          surface,
        });
      };
      place(surfaceWindY, hour.surface.windSpeedMs, hour.surface.windDirectionDeg, floorM, true);
      const topIndex = hour.levels.length - 1;
      const topY = topIndex >= 0 ? y(hour.levels[topIndex].heightM) : null;
      let lastY = surfaceWindY;
      hour.levels.forEach((level, levelIndex) => {
        const levelY = y(level.heightM);
        if (levelIndex !== topIndex) {
          if (lastY - levelY < barbMinGap) return; // too close to the last drawn
          if (topY !== null && levelY - topY < barbMinGap) return; // the top wins
        }
        place(levelY, level.windSpeedMs, level.windDirectionDeg, level.heightM, false);
        lastY = levelY;
      });
    });
  }

  /* Gust readouts ride just clear of the surface glyphs' rotated reach,
     at the resolved barb stride, so sustained (barb) and gust (number)
     read as one row without tangling. The scene labels the value "G…";
     whether that means hour-max or instantaneous is the consumer's
     caption, from models.json capabilities.gust. */
  const gusts: GustMark[] = [];
  if (overlays.gusts) {
    const gustY = surfaceWindY - BARB_GLYPH_RADIUS * barbScale - 5;
    hours.forEach((hour, index) => {
      if (index % barbStride !== 0) return;
      const gustMs = hour.surface.windGustMs;
      if (gustMs == null) return;
      const speedKmh = msToKmh(gustMs);
      gusts.push({
        x: xCenter(index),
        y: gustY,
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

  /* The hour-label convention: one resolver feeds everything the scene
     prints an hour in — the tick labels and the aria label. */
  const hourConvention = options.hourLabel ?? "24h";
  const hourText =
    typeof hourConvention === "function"
      ? (validAt: string) => hourConvention(validAt, options.timeZone)
      : hourConvention === "12h"
        ? (validAt: string) => twelveHourLabel(hourLabel(validAt, options.timeZone))
        : (validAt: string) => hourLabel(validAt, options.timeZone);
  /* The ":00" the aria label appends is a 24-hour idiom; the other modes
     read their labels verbatim ("7a to 9p"). */
  const ariaHour =
    hourConvention === "24h" ? (validAt: string) => `${hourText(validAt)}:00` : hourText;

  const hourTicks: HourTick[] = hours.map((hour, index) => ({
    index,
    x: xCenter(index),
    label: hourText(hour.validAt),
    gridline: index % 2 === 0,
  }));

  /* Per-hour surface temperature: the row under the hour labels pilots
     read the day's warming from. Pure function of published state —
     surface.temperatureC, rounded — so it lives here, once. */
  const surfaceTemperatures: SurfaceTemperatureMark[] = surfaceTemperatureRow
    ? hours.map((hour, index) => ({
        x: xCenter(index),
        y: plotBottom + HOUR_LABEL_DY + SURFACE_TEMP_ROW_PX,
        temperatureC: hour.surface.temperatureC,
        label: `${Math.round(hour.surface.temperatureC)}°`,
      }))
    : [];

  const selectedHourIndex = hours.reduce(
    (best, hour, index) =>
      hour.derived.thermalVelocityMs > (hours[best]?.derived.thermalVelocityMs ?? 0) ? index : best,
    0,
  );
  /* Marker glyphs on the derived-height lines. Default: one per line at
     the selected hour. A markerStride draws a train along the line —
     hours congruent to the selected one at that stride, so the selected
     hour is always marked — making the line self-identifying without a
     legend. Each glyph rides its line's own overlay toggle. */
  const markers: SceneMarker[] = [];
  const markerIndices = (
    stride: number | { every: number; offset?: number } | undefined,
  ): number[] => {
    if (hours.length === 0) return [];
    if (stride === undefined) return [selectedHourIndex];
    const step = Math.max(1, Math.floor(typeof stride === "number" ? stride : stride.every));
    const offset = typeof stride === "number" ? 0 : Math.floor(stride.offset ?? 0);
    const anchor = selectedHourIndex + offset;
    return hours
      .map((_, index) => index)
      .filter((index) => (((index - anchor) % step) + step) % step === 0);
  };
  if (overlays.usableLiftTop) {
    for (const index of markerIndices(options.markerStride?.usableLiftTop)) {
      const usable = usableValues[index];
      if (usable == null) continue;
      markers.push({ kind: "wing", x: xCenter(index), y: y(usable), path: WING_MARKER_PATH });
    }
  }
  if (overlays.cloudBase) {
    for (const index of markerIndices(options.markerStride?.cloudBase)) {
      const cloudBase = cloudBaseValues[index];
      if (cloudBase == null) continue;
      markers.push({ kind: "cloud", x: xCenter(index), y: y(cloudBase), path: CLOUD_MARKER_PATH });
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
      smoke: overlays.smoke ? smokeSeries[index] : null,
    };
  });

  const scene: SceneGraph = {
    width,
    height,
    ariaLabel: sceneAriaLabel(profile, hours.map((hour) => hour.validAt), options.timeZone, ariaHour),
    scales: {
      plotLeft: MARGIN_LEFT,
      plotTop,
      plotWidth,
      plotHeight,
      columnWidth,
      stripTop: METRIC_TOP,
      floorM,
      topM,
      hourCount: hours.length,
      surfaceWindY,
    },
    axes: { altitude: altitudeTicks, pressureAltitude, hours: hourTicks },
    strips,
    fields,
    series,
    barbs,
    gusts,
    surfaceTemperatures,
    labels,
    markers,
    launch,
    selectedHourIndex,
    selection: null,
    smokeSource: overlays.smoke ? smokeSource : null,
    smokeAdjustment,
    highlightSelectedHour: overlays.selectedHour,
    hourValidAts: hours.map((hour) => hour.validAt),
    sampling,
  };
  /* The consumer's selection resolves through the same exported query an
     overlay calls (resolveSelection), on the finished scene — one
     implementation, so a consumer-drawn preview and the serializer-drawn
     pin can never disagree about where the selection is. */
  if (options.selection != null) {
    scene.selection = resolveSelection(scene, options.selection);
  }
  return scene;
}

/* The accessible name says WHICH forecast this is — site, model slug, and
   the rendered hour span in the display timezone — not just what kind of
   chart it is. en-CA date formatting gives ISO-style YYYY-MM-DD, matching
   the run timestamps consumers already read. */
function sceneAriaLabel(
  profile: WindgramProfile,
  hourValidAts: ReadonlyArray<string>,
  timeZone: string,
  ariaHour: (validAt: string) => string,
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
      ? `${firstDay} ${ariaHour(first)} to ${ariaHour(last)}`
      : `${firstDay} ${ariaHour(first)} to ${lastDay} ${ariaHour(last)}`;
  return `${identity}, ${span} (${timeZone}): ${chartDescription}.`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/* "7a … 12p … 9p": lowercase a/p appended to the 12-hour clock number.
   Derives from the already-normalized h23 label so the two conventions
   can never disagree about which hour it is. */
function twelveHourLabel(h23Label: string): string {
  const hour = Number(h23Label);
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
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

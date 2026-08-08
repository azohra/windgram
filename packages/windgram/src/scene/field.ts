import { short } from "./path.js";

/* The shaded-field engine: sample a continuous time-height field on a fine
   grid, classify each sample, and emit one run-length path per class. The
   meanings stay discrete while the geometry follows the atmosphere instead
   of exposing the source hour/pressure-level rectangles.

   Two deliberate choices keep the geometry clean:
   - time interpolation is LINEAR between hour columns (a Catmull-Rom across
     four hours can overshoot a class boundary and paint a class no source
     hour contains);
   - altitude sampling above the topmost node CLAMPS to the top node's value
     so the field fills the plot to its ceiling instead of leaving a blank
     strip above the highest level. */

export interface FieldNode {
  altitudeM: number;
  value: number;
}

const FIELD_COLUMNS_PER_HOUR = 24;
const FIELD_ROW_HEIGHT = 1.5;

/** Linear interpolation through ascending nodes; null outside their span. */
export function interpolateVertical(
  nodes: ReadonlyArray<FieldNode>,
  altitudeM: number,
): number | null {
  if (
    nodes.length === 0 ||
    altitudeM < nodes[0].altitudeM ||
    altitudeM > nodes[nodes.length - 1].altitudeM
  ) {
    return null;
  }
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const lower = nodes[index];
    const upper = nodes[index + 1];
    if (altitudeM > upper.altitudeM) continue;
    const fraction =
      (altitudeM - lower.altitudeM) / Math.max(0.001, upper.altitudeM - lower.altitudeM);
    return lower.value + (upper.value - lower.value) * fraction;
  }
  return nodes[nodes.length - 1]?.value ?? null;
}

export interface SampledFieldArgs {
  classify: (value: number) => string | null;
  nodesByHour: ReadonlyArray<ReadonlyArray<FieldNode>>;
  floorM: number;
  topM: number;
  plotLeft: number;
  plotTop: number;
  plotBottom: number;
  plotWidth: number;
}

/** Class name -> path data for the classified field patches. */
export function sampledFieldPaths(args: SampledFieldArgs): Record<string, string> {
  const hourCount = args.nodesByHour.length;
  if (hourCount === 0) return {};

  const valueAt = (hourIndex: number, altitudeM: number): number | null => {
    const nodes = args.nodesByHour[hourIndex];
    if (nodes.length === 0) return null;
    return interpolateVertical(
      nodes,
      Math.min(altitudeM, nodes[nodes.length - 1].altitudeM),
    );
  };
  const valueAcrossTime = (timePosition: number, altitudeM: number): number | null => {
    const lowerIndex = Math.floor(timePosition);
    const upperIndex = Math.min(hourCount - 1, Math.ceil(timePosition));
    const lower = valueAt(lowerIndex, altitudeM);
    const upper = valueAt(upperIndex, altitudeM);
    if (lower == null) return upper;
    if (upper == null) return lower;
    if (lowerIndex === upperIndex) return lower;
    return lower + (upper - lower) * (timePosition - lowerIndex);
  };

  const columns = Math.max(1, hourCount * FIELD_COLUMNS_PER_HOUR);
  const rows = Math.ceil((args.plotBottom - args.plotTop) / FIELD_ROW_HEIGHT);
  const columnWidth = args.plotWidth / columns;
  const rowHeight = (args.plotBottom - args.plotTop) / rows;
  const chunks = new Map<string, string[]>();

  /* Horizontal same-class runs per row, then vertically-contiguous runs with
     identical column spans merged into one rect. Uniform regions (a stable
     block spanning the plot) collapse from hundreds of row slivers into a
     handful of rects — roughly an order of magnitude smaller output — and
     the merged interior needs no overlap. The 0.35 px bleed below each rect
     is kept so class boundaries still meet without antialiasing seams,
     exactly as the per-row encoding rendered them. */
  interface OpenRun {
    className: string;
    startColumn: number;
    endColumn: number;
    startRow: number;
  }
  let openRuns: OpenRun[] = [];
  const emit = (run: OpenRun, endRow: number) => {
    const runWidth = (run.endColumn - run.startColumn) * columnWidth;
    const height = (endRow - run.startRow) * rowHeight;
    const path = `M${short(args.plotLeft + run.startColumn * columnWidth)} ${short(
      args.plotTop + run.startRow * rowHeight,
    )}h${short(runWidth)}v${short(height + 0.35)}h-${short(runWidth)}Z`;
    chunks.set(run.className, [...(chunks.get(run.className) ?? []), path]);
  };

  for (let row = 0; row < rows; row += 1) {
    const altitudeM = args.topM - ((row + 0.5) / rows) * (args.topM - args.floorM);
    const rowRuns: Array<{ className: string; startColumn: number; endColumn: number }> = [];
    let activeClass: string | null = null;
    let runStart = 0;
    for (let column = 0; column <= columns; column += 1) {
      let nextClass: string | null = null;
      if (column < columns) {
        const timePosition = Math.min(
          hourCount - 1,
          Math.max(0, ((column + 0.5) / columns) * hourCount - 0.5),
        );
        const value = valueAcrossTime(timePosition, altitudeM);
        nextClass = value == null ? null : args.classify(value);
      }
      if (nextClass === activeClass) continue;
      if (activeClass != null) {
        rowRuns.push({ className: activeClass, startColumn: runStart, endColumn: column });
      }
      activeClass = nextClass;
      runStart = column;
    }

    // Extend open runs whose class and span repeat on this row; emit the rest.
    const nextOpen: OpenRun[] = [];
    const carried = new Set<number>();
    for (const open of openRuns) {
      const matchIndex = rowRuns.findIndex(
        (candidate, index) =>
          !carried.has(index) &&
          candidate.className === open.className &&
          candidate.startColumn === open.startColumn &&
          candidate.endColumn === open.endColumn,
      );
      if (matchIndex >= 0) {
        carried.add(matchIndex);
        nextOpen.push(open);
      } else {
        emit(open, row);
      }
    }
    rowRuns.forEach((run, index) => {
      if (!carried.has(index)) nextOpen.push({ ...run, startRow: row });
    });
    nextOpen.sort((left, right) => left.startRow - right.startRow || left.startColumn - right.startColumn);
    openRuns = nextOpen;
  }
  for (const open of openRuns) emit(open, rows);

  return Object.fromEntries([...chunks].map(([className, paths]) => [className, paths.join("")]));
}

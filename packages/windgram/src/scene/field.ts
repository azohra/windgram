import { short } from "./path.js";

/* The shaded-field engine: sample a continuous time-height field on a fine
   grid and emit ISO-BANDS — one filled region per class, with boundary
   vertices placed by linear interpolation at the exact threshold crossing.
   The meanings stay discrete while the geometry follows the atmosphere:
   neither the source hour/pressure-level rectangles nor the sampling grid
   shows in the output (the grid only bounds how often a boundary may bend,
   not where its vertices sit).

   Every classified field here is an ordered banding of one continuous
   scalar (lapse rate, TI, shear rate, RH, omega, dew-point depression), so
   the engine takes the banding itself — ascending breakpoints and the
   class per interval — rather than an opaque classifier: exact crossings
   need the thresholds. A band's path is the marching-squares region at its
   lower threshold plus the region at its upper threshold in ONE path, so
   an even-odd fill paints exactly the area between them (and holes for
   free); consumers must fill these paths with fill-rule "evenodd", as the
   reference serializer does.

   Two deliberate choices keep the geometry honest:
   - time interpolation is LINEAR between hour columns (a Catmull-Rom across
     four hours can overshoot a class boundary and paint a class no source
     hour contains);
   - altitude sampling above the topmost node CLAMPS to the top node's value
     so the field fills the plot to its ceiling instead of leaving a blank
     strip above the highest level.

   Null regions (below a column's first node, hours without nodes) stay
   unpainted: null grid corners sit outside every threshold region, and the
   bottom band is closed against the valid-domain outline instead of the
   plot frame. Domain edges have no value to interpolate toward, so they
   land mid-cell — grid-resolution there, exactly as the run-length engine
   drew them; class boundaries, the visible geometry, are sub-cell. */

export interface FieldNode {
  altitudeM: number;
  value: number;
}

/**
 * An ordered banding of a continuous scalar: ascending `breakpoints`
 * partition the value axis into `breakpoints.length + 1` intervals, and
 * `classNames[i]` names the class filled between them (null = unpainted).
 */
export interface FieldBanding {
  breakpoints: ReadonlyArray<number>;
  classNames: ReadonlyArray<string | null>;
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
  banding: FieldBanding;
  nodesByHour: ReadonlyArray<ReadonlyArray<FieldNode>>;
  floorM: number;
  topM: number;
  plotLeft: number;
  plotTop: number;
  plotBottom: number;
  plotWidth: number;
}

/**
 * Class name -> path data for the classified field patches. Paths are
 * iso-band outlines and MUST be filled with fill-rule "evenodd".
 */
export function sampledFieldPaths(args: SampledFieldArgs): Record<string, string> {
  const hourCount = args.nodesByHour.length;
  if (hourCount === 0) return {};
  if (args.banding.classNames.length !== args.banding.breakpoints.length + 1) {
    throw new Error("sampledFieldPaths: classNames must have breakpoints.length + 1 entries");
  }

  const valueAt = (hourIndex: number, altitudeM: number): number | null => {
    const nodes = args.nodesByHour[hourIndex];
    if (nodes.length === 0) return null;
    return interpolateVertical(nodes, Math.min(altitudeM, nodes[nodes.length - 1].altitudeM));
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

  /* Grid CORNERS (columns+1 × rows+1): iso-band vertices interpolate along
     cell edges, so the samples live on the lattice, not at cell centres. */
  const columns = Math.max(1, hourCount * FIELD_COLUMNS_PER_HOUR);
  const rows = Math.max(1, Math.ceil((args.plotBottom - args.plotTop) / FIELD_ROW_HEIGHT));
  const plotHeight = args.plotBottom - args.plotTop;
  const values: Array<Array<number | null>> = [];
  for (let row = 0; row <= rows; row += 1) {
    const altitudeM = args.topM - (row / rows) * (args.topM - args.floorM);
    const rowValues: Array<number | null> = [];
    for (let column = 0; column <= columns; column += 1) {
      const timePosition = Math.min(
        hourCount - 1,
        Math.max(0, (column / columns) * hourCount - 0.5),
      );
      rowValues.push(valueAcrossTime(timePosition, altitudeM));
    }
    values.push(rowValues);
  }
  const xOf = (column: number) => args.plotLeft + (column / columns) * args.plotWidth;
  const yOf = (row: number) => args.plotTop + (row / rows) * plotHeight;

  /* Marching squares over `predicate` (corner is inside), with `edgePoint`
     placing the crossing along an edge. Emits directed segments (inside on
     the left), chained into closed rings; winding is irrelevant under
     even-odd fill, the direction only makes chaining unambiguous. */
  type Point = readonly [number, number];
  const rings = (
    inside: (row: number, column: number) => boolean,
    fraction: (a: number | null, b: number | null) => number,
  ): Point[][] => {
    /* A lattice corner sitting exactly on the threshold can start several
       segments at the same point, so starts key QUEUES of segments; a
       degenerate segment (both ends at one point) is dropped outright. */
    interface Segment {
      from: Point;
      to: Point;
      used: boolean;
    }
    const allSegments: Segment[] = [];
    const byStart = new Map<string, Segment[]>();
    const key = (point: Point) => `${point[0].toFixed(3)},${point[1].toFixed(3)}`;
    const addSegment = (from: Point, to: Point) => {
      const fromKey = key(from);
      if (fromKey === key(to)) return;
      const segment: Segment = { from, to, used: false };
      allSegments.push(segment);
      const queue = byStart.get(fromKey);
      if (queue) queue.push(segment);
      else byStart.set(fromKey, [segment]);
    };

    /* One ring of virtual OUTSIDE corners pads the grid, so a region
       touching the plot edge closes along it (a field filling the whole
       plot otherwise has no transitions and would emit nothing). Points
       generated in the virtual half-cells clamp onto the plot frame. */
    const insideAt = (row: number, column: number): boolean =>
      row >= 0 && row <= rows && column >= 0 && column <= columns && inside(row, column);
    const valueAt = (row: number, column: number): number | null =>
      row >= 0 && row <= rows && column >= 0 && column <= columns ? values[row][column] : null;
    const clampX = (x: number) => Math.min(args.plotLeft + args.plotWidth, Math.max(args.plotLeft, x));
    const clampY = (y: number) => Math.min(args.plotBottom, Math.max(args.plotTop, y));

    for (let row = -1; row <= rows; row += 1) {
      for (let column = -1; column <= columns; column += 1) {
        const tl = insideAt(row, column);
        const tr = insideAt(row, column + 1);
        const br = insideAt(row + 1, column + 1);
        const bl = insideAt(row + 1, column);
        const caseIndex = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
        if (caseIndex === 0 || caseIndex === 15) continue;

        const vTL = valueAt(row, column);
        const vTR = valueAt(row, column + 1);
        const vBR = valueAt(row + 1, column + 1);
        const vBL = valueAt(row + 1, column);
        const top: Point = [clampX(xOf(column + fraction(vTL, vTR))), clampY(yOf(row))];
        const bottom: Point = [clampX(xOf(column + fraction(vBL, vBR))), clampY(yOf(row + 1))];
        const left: Point = [clampX(xOf(column)), clampY(yOf(row + fraction(vTL, vBL)))];
        const right: Point = [clampX(xOf(column + 1)), clampY(yOf(row + fraction(vTR, vBR)))];

        switch (caseIndex) {
          case 1: addSegment(left, bottom); break;
          case 2: addSegment(bottom, right); break;
          case 3: addSegment(left, right); break;
          case 4: addSegment(right, top); break;
          case 6: addSegment(bottom, top); break;
          case 7: addSegment(left, top); break;
          case 8: addSegment(top, left); break;
          case 9: addSegment(top, bottom); break;
          case 11: addSegment(top, right); break;
          case 12: addSegment(right, left); break;
          case 13: addSegment(right, bottom); break;
          case 14: addSegment(bottom, left); break;
          case 5: {
            // Saddle: connect by which side the cell centre falls on.
            if (saddleCentreInside(row, column)) {
              addSegment(left, top);
              addSegment(right, bottom);
            } else {
              addSegment(left, bottom);
              addSegment(right, top);
            }
            break;
          }
          case 10: {
            if (saddleCentreInside(row, column)) {
              addSegment(top, right);
              addSegment(bottom, left);
            } else {
              addSegment(top, left);
              addSegment(bottom, right);
            }
            break;
          }
        }
      }
    }

    // Chain directed segments into closed rings.
    const takeFrom = (pointKey: string): Segment | null => {
      const queue = byStart.get(pointKey);
      if (!queue) return null;
      while (queue.length > 0) {
        const candidate = queue[queue.length - 1];
        if (!candidate.used) return candidate;
        queue.pop();
      }
      return null;
    };
    const out: Point[][] = [];
    for (const first of allSegments) {
      if (first.used) continue;
      const ring: Point[] = [first.from];
      let current = first;
      while (true) {
        current.used = true;
        ring.push(current.to);
        const next = takeFrom(key(current.to));
        if (!next) break;
        current = next;
      }
      if (ring.length >= 4) out.push(ring);
    }
    return out;

    function saddleCentreInside(row: number, column: number): boolean {
      const corners = [
        valueAt(row, column),
        valueAt(row, column + 1),
        valueAt(row + 1, column + 1),
        valueAt(row + 1, column),
      ].filter((value): value is number => value !== null);
      if (corners.length === 0) return false;
      const mean = corners.reduce((sum, value) => sum + value, 0) / corners.length;
      return centrePredicate(mean, corners.length === 4);
    }
  };

  /* Threshold regions G(t) = { f >= t }, null corners outside. The crossing
     between a valid and a null corner has nothing to interpolate toward and
     lands mid-edge (the domain's own resolution). */
  let centrePredicate: (mean: number, allValid: boolean) => boolean = () => false;
  const thresholdRings = (t: number): Point[][] => {
    centrePredicate = (mean, allValid) => allValid && mean >= t;
    return rings(
      (row, column) => {
        const value = values[row][column];
        return value !== null && value >= t;
      },
      (a, b) => {
        if (a === null || b === null || a === b) return 0.5;
        return clamp01((t - a) / (b - a));
      },
    );
  };
  /* The valid-data domain, for closing the bottom band. */
  const domainRings = (): Point[][] => {
    centrePredicate = (_mean, allValid) => allValid;
    return rings(
      (row, column) => values[row][column] !== null,
      () => 0.5,
    );
  };

  const ringCache = new Map<number, Point[][]>();
  const ringsAt = (t: number) => {
    let cached = ringCache.get(t);
    if (!cached) ringCache.set(t, (cached = thresholdRings(t)));
    return cached;
  };

  const toPath = (ringSets: Point[][][]): string => {
    const parts: string[] = [];
    for (const set of ringSets) {
      for (const ring of set) {
        /* Round, drop consecutive duplicates, and collapse collinear runs:
           a straight boundary (border polylines, linear-field crossings)
           otherwise carries a vertex per grid cell. The cross-product
           tolerance bounds the deviation well under the 2-decimal
           rounding the coordinates already live at. */
        const rounded: Array<[number, number]> = [];
        for (const point of ring) {
          const x = short(point[0]);
          const y = short(point[1]);
          const last = rounded[rounded.length - 1];
          if (last && last[0] === x && last[1] === y) continue;
          const beforeLast = rounded[rounded.length - 2];
          if (last && beforeLast) {
            const cross =
              (last[0] - beforeLast[0]) * (y - beforeLast[1]) -
              (last[1] - beforeLast[1]) * (x - beforeLast[0]);
            if (Math.abs(cross) < 0.35) {
              last[0] = x;
              last[1] = y;
              continue;
            }
          }
          rounded.push([x, y]);
        }
        if (rounded.length >= 3) {
          parts.push(
            rounded
              .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`)
              .join("") + "Z",
          );
        }
      }
    }
    return parts.join("");
  };

  const result: Record<string, string> = {};
  const { breakpoints, classNames } = args.banding;
  for (let interval = 0; interval < classNames.length; interval += 1) {
    const className = classNames[interval];
    if (className === null) continue;
    const lower = interval === 0 ? null : breakpoints[interval - 1];
    const upper = interval === classNames.length - 1 ? null : breakpoints[interval];
    const sets: Point[][][] = [];
    if (lower === null) {
      // Bottom band: the domain outline minus the region above `upper`.
      sets.push(domainRings());
      if (upper !== null) sets.push(ringsAt(upper));
    } else {
      sets.push(ringsAt(lower));
      if (upper !== null) sets.push(ringsAt(upper));
    }
    const path = toPath(sets);
    if (path !== "") {
      result[className] = result[className] ? result[className] + path : path;
    }
  }
  return result;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

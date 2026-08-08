/* Path-string primitives shared by every scene element. Numbers are rounded
   to two decimals so output is deterministic and golden fixtures diff
   cleanly. */

export interface PlotPoint {
  x: number;
  y: number;
}

/** Rounds to two decimals without reintroducing float noise in the string. */
export function short(value: number): number {
  return Number(value.toFixed(2));
}

/* Catmull-Rom-flavoured cubic segments (control points at 1/6 of the
   neighbour span) from the first point onward, without the leading move —
   shared by lines and band edges so both commit to one interpolation. */
function curvedSegments(points: readonly PlotPoint[]): string {
  if (points.length < 2) return "";
  if (points.length === 2) return ` L${short(points[1].x)},${short(points[1].y)}`;
  let result = "";
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const current = points[index];
    const next = points[index + 1];
    const following = points[Math.min(points.length - 1, index + 2)];
    const firstX = current.x + (next.x - previous.x) / 6;
    const firstY = current.y + (next.y - previous.y) / 6;
    const secondX = next.x - (following.x - current.x) / 6;
    const secondY = next.y - (following.y - current.y) / 6;
    result += ` C${short(firstX)},${short(firstY)} ${short(secondX)},${short(secondY)} ${short(next.x)},${short(next.y)}`;
  }
  return result;
}

/* Catmull-Rom-flavoured cubic through every point — identical geometry in
   both reference renderers. */
export function curvedPath(points: readonly PlotPoint[]): string {
  if (points.length === 0) return "";
  return `M${short(points[0].x)},${short(points[0].y)}${curvedSegments(points)}`;
}

/** Curved path over the non-null points; nulls break the line into segments. */
export function pointPath(points: ReadonlyArray<PlotPoint | null>): string {
  const paths: string[] = [];
  let segment: PlotPoint[] = [];
  for (const point of [...points, null]) {
    if (point) {
      segment.push(point);
      continue;
    }
    if (segment.length > 0) paths.push(curvedPath(segment));
    segment = [];
  }
  return paths.join(" ");
}

/* Translucent envelope between two edges (used for ensemble p25-p75 bands).
   Both edges use the same curved segments as the median line drawn over the
   band, so the line can never exit its own envelope between hour columns.
   Nulls split the band into runs; a run needs at least two points to
   enclose area. */
export function bandPath(
  points: ReadonlyArray<{ x: number; yLow: number; yHigh: number } | null>,
): string {
  const paths: string[] = [];
  let run: Array<{ x: number; yLow: number; yHigh: number }> = [];
  const flush = () => {
    if (run.length >= 2) {
      const upper = run.map((p) => ({ x: p.x, y: p.yHigh }));
      const lower = [...run].reverse().map((p) => ({ x: p.x, y: p.yLow }));
      paths.push(
        `M${short(upper[0].x)},${short(upper[0].y)}${curvedSegments(upper)}` +
          ` L${short(lower[0].x)},${short(lower[0].y)}${curvedSegments(lower)} Z`,
      );
    }
    run = [];
  };
  for (const point of [...points, null]) {
    if (point) run.push(point);
    else flush();
  }
  return paths.join(" ");
}

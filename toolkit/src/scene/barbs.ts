/* Wind-barb symbol math, shared by both reference renderers: feather values
   are 5, 10 and 50 km/h (canadarasp's convention — many aviation charts use
   the same shapes for knots, so the printed unit is part of the symbol key),
   speeds round to the nearest 5, and below 2.5 km/h the symbol is a calm
   circle. The shaft points toward where the wind comes FROM. */

export interface WindBarbParts {
  calm: boolean;
  pennants: number;
  fullBarbs: number;
  halfBarb: boolean;
  roundedSpeedKmh: number;
}

export function windBarbParts(speedKmh: number): WindBarbParts {
  const roundedSpeedKmh = Math.max(0, Math.round(speedKmh / 5) * 5);
  const pennants = Math.floor(roundedSpeedKmh / 50);
  const afterPennants = roundedSpeedKmh - pennants * 50;
  const fullBarbs = Math.floor(afterPennants / 10);
  return {
    calm: speedKmh < 2.5,
    fullBarbs,
    halfBarb: afterPennants - fullBarbs * 10 >= 5,
    pennants,
    roundedSpeedKmh,
  };
}

/* Distance from the barb's anchor (the observation point) to the farthest
   glyph point — the shaft tip. The glyph rotates freely with wind
   direction, so a column fits a barb per hour once its width covers this
   radius on both sides; scene.ts sizes the automatic hour stride from it.
   One home: derived from the same shaft geometry windBarbPaths draws. */
const SHAFT_TIP_Y = -20;
const SHAFT_BASE_Y = 5;
export const BARB_GLYPH_RADIUS = -SHAFT_TIP_Y;
/** Full glyph height in local units (shaft tip to base), before scaling. */
export const BARB_GLYPH_HEIGHT = SHAFT_BASE_Y - SHAFT_TIP_Y;

/* Glyph geometry in local barb coordinates (rotated/translated at placement):
   shaft plus feathers as one stroke path, pennant triangles as fill paths.
   Feather spacing (4.8) keeps adjacent feathers clear of each other's halo
   strokes (2.6 wide under 1.3 ink in the reference serializer) so a full
   stack reads as feathers, not a blob; the shaft is long enough that the
   densest sub-50 stack (four feathers plus a half) stays on it. */
export function windBarbPaths(speedKmh: number): { shaft: string; pennants: string[] } {
  const { pennants, fullBarbs, halfBarb } = windBarbParts(speedKmh);
  const pennantHeight = 5;
  const pennantSpacing = 7;
  const barbSpacing = 4.8;
  const pennantPaths: string[] = [];
  for (let index = 0; index < pennants; index += 1) {
    const barbY = SHAFT_TIP_Y + index * pennantSpacing;
    pennantPaths.push(
      `M0 ${round(barbY)} L9.5 ${round(barbY + pennantHeight)} L0 ${round(barbY + pennantHeight)} Z`,
    );
  }
  const featherOffset = pennants * pennantSpacing + (pennants > 0 ? 1.5 : 0);
  const featherPaths: string[] = [];
  for (let index = 0; index < fullBarbs; index += 1) {
    const barbY = SHAFT_TIP_Y + featherOffset + index * barbSpacing;
    featherPaths.push(`M0 ${round(barbY)} L8 ${round(barbY + 4.4)}`);
  }
  if (halfBarb) {
    const halfGap = pennants === 0 && fullBarbs === 0 ? 2.2 : 0;
    const barbY = SHAFT_TIP_Y + featherOffset + fullBarbs * barbSpacing + halfGap;
    featherPaths.push(`M0 ${round(barbY)} L4.5 ${round(barbY + 2.4)}`);
  }
  return {
    shaft: [`M0 ${SHAFT_BASE_Y} L0 ${SHAFT_TIP_Y}`, ...featherPaths].join(" "),
    pennants: pennantPaths,
  };
}

// Two-decimal rounding keeps the barb path strings free of float noise
// (barb spacing at 4.8 otherwise leaks ...999 tails into the output).
function round(value: number): number {
  return Number(value.toFixed(2));
}

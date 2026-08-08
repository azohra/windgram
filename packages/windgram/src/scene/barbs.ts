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

/* Glyph geometry in local barb coordinates (rotated/translated at placement):
   shaft plus feathers as one stroke path, pennant triangles as fill paths. */
export function windBarbPaths(speedKmh: number): { shaft: string; pennants: string[] } {
  const { pennants, fullBarbs, halfBarb } = windBarbParts(speedKmh);
  const pennantHeight = 5;
  const pennantSpacing = 7;
  const barbSpacing = 3.8;
  const pennantPaths: string[] = [];
  for (let index = 0; index < pennants; index += 1) {
    const barbY = -16 + index * pennantSpacing;
    pennantPaths.push(
      `M0 ${round(barbY)} L9.5 ${round(barbY + pennantHeight)} L0 ${round(barbY + pennantHeight)} Z`,
    );
  }
  const featherOffset = pennants * pennantSpacing + (pennants > 0 ? 1.5 : 0);
  const featherPaths: string[] = [];
  for (let index = 0; index < fullBarbs; index += 1) {
    const barbY = -16 + featherOffset + index * barbSpacing;
    featherPaths.push(`M0 ${round(barbY)} L8 ${round(barbY + 4.4)}`);
  }
  if (halfBarb) {
    const halfGap = pennants === 0 && fullBarbs === 0 ? 2.2 : 0;
    const barbY = -16 + featherOffset + fullBarbs * barbSpacing + halfGap;
    featherPaths.push(`M0 ${round(barbY)} L4.5 ${round(barbY + 2.4)}`);
  }
  return { shaft: ["M0 5 L0 -16", ...featherPaths].join(" "), pennants: pennantPaths };
}

// Two-decimal rounding keeps the barb path strings free of float noise
// (barb spacing at 3.8 otherwise leaks ...999 tails into the output).
function round(value: number): number {
  return Number(value.toFixed(2));
}

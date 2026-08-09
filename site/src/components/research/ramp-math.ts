import { STABILITY_TOKEN_DEFAULTS, TOKEN_DEFAULTS } from "windgram/svg";

/* Build-time colour math for the stability-ramp figures. The shipped ramp
   is imported from the package — never restated — so the figures cannot
   drift from the shipped values; the canadarasp palette is a HISTORICAL
   subject (the 0.5.x-era CANADARASP_PRESET departed with the preset
   catalogue), restated here as cited history that can no longer drift
   because it no longer ships. The math mirrors the palette validator the
   ramp was derived with: ΔE is Euclidean distance in OKLab scaled by 100,
   and colour-vision deficiency is simulated with the
   Machado–Oliveira–Fernandes (2009) matrices at severity 1.0, the same
   conventions the derivation JSDoc on STABILITY_TOKEN_DEFAULTS cites. */

export type CvdKind = "protan" | "deutan";

const MACHADO: Record<CvdKind, number[][]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

const hexToSrgb = (hex: string): number[] => {
  const h = hex.trim().replace(/^#/, "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};
const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number): number => {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};
const linear = (hex: string): number[] => hexToSrgb(hex).map(srgbToLinear);

const relativeLuminance = (hex: string): number => {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** The gray with the same relative luminance as the colour — what a grayscale rendering keeps. */
export function luminanceGray(hex: string): string {
  const g = Math.round(linearToSrgb(relativeLuminance(hex)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${g}${g}${g}`;
}

function oklabFromLinear([r, g, b]: number[]): number[] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab/OKLCH lightness of a hex colour (0–1). */
export const oklabLightness = (hex: string): number => oklabFromLinear(linear(hex))[0];

function simulate(hex: string, kind: CvdKind): number[] {
  const [r, g, b] = linear(hex);
  const m = MACHADO[kind];
  const clamp = (c: number) => Math.max(0, Math.min(1, c));
  return [
    clamp(m[0][0] * r + m[0][1] * g + m[0][2] * b),
    clamp(m[1][0] * r + m[1][1] * g + m[1][2] * b),
    clamp(m[2][0] * r + m[2][1] * g + m[2][2] * b),
  ];
}

/** OKLab ΔE ×100 between two hexes, optionally under a simulated CVD. */
export function deltaE(a: string, b: string, kind?: CvdKind): number {
  const la = oklabFromLinear(kind ? simulate(a, kind) : linear(a));
  const lb = oklabFromLinear(kind ? simulate(b, kind) : linear(b));
  return 100 * Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

/* ── the two subject palettes, in threshold order (most unstable first) ── */

export const CLASS_NAMES = Object.keys(STABILITY_TOKEN_DEFAULTS) as Array<
  keyof typeof STABILITY_TOKEN_DEFAULTS
>;

/** Display names for the eight classes, in the same order. */
export const CLASS_LABELS: Record<string, string> = {
  "very-unstable": "Very unstable",
  unstable: "Unstable",
  "conditional-strong": "Conditional · strong",
  conditional: "Conditional",
  "near-neutral": "Near neutral",
  stable: "Stable",
  inverted: "Inversion",
  "strong-inversion": "Strong inversion",
};

/* canadarasp's stability palette and background, verified 2026-08-08
   against windgram-continental.ncl / windgram-continental-colormap.ncl in
   github.com/ajberkley/canadarasp (the citations lived in the departed
   preset's JSDoc; values unchanged since). */
const canadaraspTokens: Record<string, string> = {
  "stab-very-unstable": "#ff3d3d",
  "stab-unstable": "#ff7800",
  "stab-conditional-strong": "#ff96ff",
  "stab-conditional": "#ccbfff",
  "stab-near-neutral": "#facab1",
  "stab-stable": "#8080e6",
  "stab-inverted": "#cccccc",
  "stab-strong-inversion": "#999999",
  surface: "#8080e6",
};

export interface SubjectRamp {
  name: string;
  hexes: string[];
  /** The surface the palette was designed against, from the same export. */
  surface: string;
}

export const DEFAULT_RAMP: SubjectRamp = {
  name: "windgram default",
  hexes: CLASS_NAMES.map((name) => STABILITY_TOKEN_DEFAULTS[name]),
  surface: TOKEN_DEFAULTS.surface,
};

export const CANADARASP_RAMP: SubjectRamp = {
  name: "canadarasp",
  hexes: CLASS_NAMES.map((name) => canadaraspTokens[`stab-${name}`] ?? "#000000"),
  surface: canadaraspTokens.surface ?? "#000000",
};


/** Adjacent-pair ΔE values for a ramp: seven pairs, normal + CVD. */
export function adjacentPairs(ramp: SubjectRamp) {
  return ramp.hexes.slice(1).map((hex, i) => ({
    from: CLASS_NAMES[i],
    to: CLASS_NAMES[i + 1],
    normal: deltaE(ramp.hexes[i], hex),
    protan: deltaE(ramp.hexes[i], hex, "protan"),
    deutan: deltaE(ramp.hexes[i], hex, "deutan"),
  }));
}

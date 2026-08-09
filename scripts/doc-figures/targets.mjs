/**
 * The doc-figure registry: every committed asset under assets/ is a
 * target here — an id, a composition built from committed scenario
 * profiles through the package's real buildScene/renderSvg, and an
 * output path. Compositions write ordinary <text>; the generator
 * outlines it into brand-font paths afterwards (see fonts.mjs).
 *
 * All targets share the site's field-paper look: cream page, mineral
 * ink, rust accent, visible rules — self-backgrounded so they render
 * identically on GitHub light and dark.
 */

import { measureText, wrapText } from "./fonts.mjs";

/* The field-paper palette (site theme.css / package TOKEN_DEFAULTS). */
const PAGE = "#f4efe4";
const SURFACE = "#fffdf8";
const RULE = "#776956";
const INK = "#152529";
const INK_SOFT = "#2f454a";
const INK_MUTE = "#40565a";
const ACCENT = "#913b0c";
const FLAG_ORANGE = "#da934a";
const CODE_TEXT = "#e8e1cf";
const CODE_STRING = "#7fadbb";

const SANS = "IBM Plex Sans";
const MONO = "IBM Plex Mono";
const DISPLAY = "Big Shoulders";

function esc(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/** One <text> element (outlined to paths later by the generator). */
function t(x, y, content, o = {}) {
  const attrs = [
    `x="${round(x)}"`,
    `y="${round(y)}"`,
    o.anchor ? `text-anchor="${o.anchor}"` : "",
    `fill="${o.fill ?? INK}"`,
    `font-family="${o.font ?? SANS}"`,
    `font-size="${o.size ?? 16}"`,
    o.weight ? `font-weight="${o.weight}"` : "",
    o.ls ? `letter-spacing="${o.ls}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<text ${attrs}>${esc(content)}</text>`;
}

/** Fit a display run to a target width; returns the font size. */
function fitSize(text, targetWidth, spec) {
  const probe = 100;
  const width = measureText(text, { ...spec, size: probe, letterSpacing: (spec.letterSpacingEm ?? 0) * probe });
  return round((targetWidth / width) * probe);
}

/** The cream page with the faint drafting grid and outer rule. */
function paper(id, width, height, rx = 20) {
  return `<defs>
    <pattern id="${id}-paper-grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <path d="M24 0H0V24" fill="none" stroke="${RULE}" stroke-opacity=".06" stroke-width="1"/>
    </pattern>
    <marker id="${id}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0 0l10 5-10 5z" fill="${ACCENT}"/>
    </marker>
  </defs>
  <rect width="${width}" height="${height}" rx="${rx}" fill="${PAGE}"/>
  <rect width="${width}" height="${height}" rx="${rx}" fill="url(#${id}-paper-grid)"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="${rx > 0 ? rx - 1 : 0}" fill="none" stroke="${RULE}" stroke-opacity=".75" stroke-width="2"/>`;
}

/** The skyline flag mark from the existing hero, at a given scale. */
function flag(scale = 1) {
  return `<g transform="scale(${scale})">
      <rect width="104" height="32" rx="2" fill="${INK}"/>
      <path d="M7 27V7l53 16 15 2 22-14v16z" fill="${FLAG_ORANGE}"/>
    </g>`;
}

/** Position a package-rendered chart: sets x/y and one dimension,
 * keeping the chart's own aspect ratio. */
function placeChart(chart, { x, y, width, height }) {
  const w = width ?? round((height * chart.width) / chart.height);
  const h = height ?? round((width * chart.height) / chart.width);
  const markup = chart.svg.replace("<svg ", `<svg x="${round(x)}" y="${round(y)}" width="${w}" height="${h}" `);
  return { markup, width: w, height: h };
}

/* Minimal two-hue code colouring: keywords in the flag orange, module
   strings in the moisture blue, everything else warm paper. */
function codeSegments(line) {
  const segments = [];
  const pattern = /("[^"]*")|(\b(?:import|from|const|if|throw|new)\b)/g;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > cursor) segments.push({ text: line.slice(cursor, match.index), fill: CODE_TEXT });
    segments.push({ text: match[0], fill: match[1] ? CODE_STRING : FLAG_ORANGE });
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) segments.push({ text: line.slice(cursor), fill: CODE_TEXT });
  return segments;
}

function codeBlock(x, y, lines, size, lineHeight) {
  const spec = { family: "ibm-plex-mono", weight: 400, size };
  const parts = [];
  lines.forEach((line, index) => {
    let cx = x;
    for (const segment of codeSegments(line)) {
      parts.push(t(cx, y + index * lineHeight, segment.text, { font: MONO, size, fill: segment.fill }));
      cx += measureText(segment.text, spec);
    }
  });
  return parts.join("\n  ");
}

/* ------------------------------------------------------------------ */
/* Target: readme-hero — the existing masthead + publication path,
   re-expressed in brand typography. */

const PATH_STEPS = [
  ["01 · SOURCE", "ECCC + NOAA model feeds", "GRIB2 · indexed byte ranges"],
  ["02 · BUILD", "Python publication pipeline", "sample · derive · validate"],
  ["03 · PUBLISH", "Static profile documents", "catalogue · profiles · history"],
  ["04 · RENDER", "TypeScript scene + SVG", "contract · derive · analyze"],
];

async function composeReadmeHero(ctx) {
  const chart = await ctx.renderChart("convective-cycle", "readme-hero-chart");
  const placed = placeChart(chart, { x: 612, y: 38, width: 548 });
  const titleSize = fitSize("WINDGRAM", 494, { family: "big-shoulders", weight: 800, letterSpacingEm: 0.03 });

  const steps = PATH_STEPS.map(([tag, title, sub], index) => {
    const top = 24 + index * 82;
    const arrow =
      index < PATH_STEPS.length - 1
        ? `<path d="M248 ${top + 58}v18" stroke="${ACCENT}" stroke-width="2" marker-end="url(#readme-hero-arrow)"/>`
        : "";
    return `<g transform="translate(0 ${top})">
      <rect width="496" height="58" fill="${SURFACE}" stroke="${RULE}"/>
      ${t(18, 24, tag, { font: MONO, size: 11, weight: 700, fill: ACCENT })}
      ${t(144, 24, title, { size: 17, weight: 700 })}
      ${t(144, 43, sub, { font: MONO, size: 11, fill: INK_MUTE })}
    </g>
    ${arrow}`;
  }).join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 660" role="img" aria-labelledby="readme-title readme-description">
  <title id="readme-title">Windgram — forecast profiles for soaring</title>
  <desc id="readme-description">The Windgram publication path beside a complete ten-hour windgram generated by the package reference renderer.</desc>
  ${paper("readme-hero", 1200, 660)}

  <g transform="translate(54 48)">
    ${flag()}
    ${t(122, 13, "FORECAST PROFILES FOR SOARING", { font: MONO, size: 13, weight: 700, ls: 2.2, fill: ACCENT })}
    ${t(0, 126, "WINDGRAM", { font: DISPLAY, size: titleSize, weight: 800, ls: round(titleSize * 0.03) })}
    <path d="M2 144h494" stroke="${RULE}" stroke-width="1.5"/>
    ${t(0, 181, "Model runs become inspectable, versioned profiles", { size: 20, fill: INK_SOFT })}
    ${t(0, 210, "and charts any frontend can draw.", { size: 20, fill: INK_SOFT })}
  </g>

  <g transform="translate(54 306)">
    ${t(0, 0, "THE PUBLICATION PATH", { font: MONO, size: 11, weight: 700, ls: 1.6, fill: ACCENT })}
    ${steps}
  </g>

  <rect x="592" y="18" width="588" height="622" rx="9" fill="${SURFACE}" stroke="#51483e" stroke-width="1.5"/>
  ${t(612, 31, "PACKAGE-RENDERED REFERENCE OUTPUT", { font: MONO, size: 10, weight: 700, ls: 1.4, fill: ACCENT })}
  ${placed.markup}
</svg>
`;
}

/* ------------------------------------------------------------------ */
/* Target: package-hero — the npm page's "typed data in, chart out". */

const PACKAGE_CODE = [
  'import { parseWindgramProfile } from "windgram/contract";',
  'import { buildScene } from "windgram/scene";',
  'import { renderSvg } from "windgram/svg";',
  "",
  "const profile = parseWindgramProfile(raw);",
  'if (!profile) throw new Error("invalid profile");',
  "",
  "const scene = buildScene(profile, {",
  "  timeZone: profile.site.timeZone,",
  "  widthPx: 960,",
  "});",
  "const svg = renderSvg(scene);",
];

async function composePackageHero(ctx) {
  const scenarioId = "front-arrival";
  const chart = await ctx.renderChart(scenarioId, "package-hero-chart");
  const meta = ctx.scenarioMeta(scenarioId);

  const sectionTop = 202;
  const codePad = 18;
  const lineHeight = 22;
  const codeHeight = codePad + 14 + (PACKAGE_CODE.length - 1) * lineHeight + codePad;
  const placed = placeChart(chart, { x: 512, y: sectionTop + 12, width: 316 });
  const cardHeight = placed.height + 24;
  const height = Math.max(sectionTop + codeHeight + 44, sectionTop + cardHeight + 40) + 20;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 ${round(height)}" role="img" aria-labelledby="pkg-title pkg-description">
  <title id="pkg-title">The windgram package — typed data in, chart out</title>
  <desc id="pkg-description">A twelve-line TypeScript example that validates a profile and serializes a chart, beside the exact SVG the package renders from a committed scenario profile.</desc>
  ${paper("package-hero", 880, round(height), 14)}

  <g transform="translate(40 40)">
    ${flag(0.75)}
    ${t(94, 17, "THE WINDGRAM PACKAGE · ESM · NO DOM", { font: MONO, size: 11, weight: 700, ls: 1.8, fill: ACCENT })}
    ${t(0, 106, "TYPED DATA IN, CHART OUT", { font: DISPLAY, size: 46, weight: 800, ls: 1.4 })}
    <path d="M2 122h798" stroke="${RULE}" stroke-width="1.5"/>
  </g>

  ${t(40, sectionTop - 12, "01 · VALIDATE, BUILD, SERIALIZE", { font: MONO, size: 10, weight: 700, ls: 1.4, fill: ACCENT })}
  <rect x="40" y="${sectionTop}" width="420" height="${round(codeHeight)}" rx="6" fill="${INK}"/>
  ${codeBlock(58, sectionTop + codePad + 14, PACKAGE_CODE, 11, lineHeight)}
  ${t(40, sectionTop + codeHeight + 26, "parse returns null for unsupported input — render only what validated", { font: MONO, size: 9.5, fill: INK_MUTE })}

  <path d="M466 ${round(sectionTop + cardHeight / 2)}h28" stroke="${ACCENT}" stroke-width="2" marker-end="url(#package-hero-arrow)"/>

  ${t(500, sectionTop - 12, "02 · THE CHART IT RETURNS", { font: MONO, size: 10, weight: 700, ls: 1.4, fill: ACCENT })}
  <rect x="500" y="${sectionTop}" width="340" height="${round(cardHeight)}" rx="6" fill="${SURFACE}" stroke="#51483e" stroke-width="1.5"/>
  ${placed.markup}
  ${t(500, round(sectionTop + cardHeight + 26), `scenario: ${meta.id} — a committed teaching profile`, { font: MONO, size: 9.5, fill: INK_MUTE })}
</svg>
`;
}

/* ------------------------------------------------------------------ */
/* Target: scenario-gallery — six visually distinct committed
   scenarios, captioned by their own lesson strings. */

const GALLERY_IDS = [
  "front-arrival",
  "convective-cycle",
  "ensemble-wide",
  "shear-through-lift-band",
  "morning-inversion-erodes",
  "cloud-base-limits-lift",
];

async function composeScenarioGallery(ctx) {
  const columns = 3;
  const cellWidth = 372;
  const gap = 22;
  const margin = 30;
  const width = margin * 2 + columns * cellWidth + (columns - 1) * gap;
  const innerWidth = cellWidth - 28;
  const chartHeight = 250;
  const headerHeight = 118;

  const lessonSpec = { family: "ibm-plex-sans", weight: 400, size: 12 };

  const cells = [];
  for (const id of GALLERY_IDS) {
    const meta = ctx.scenarioMeta(id);
    const chart = await ctx.renderChart(id, `gallery-${id}`);
    cells.push({ id, meta, chart, lessonLines: wrapText(meta.lesson, innerWidth, lessonSpec) });
  }

  const rows = [];
  for (let start = 0; start < cells.length; start += columns) rows.push(cells.slice(start, start + columns));

  let y = headerHeight;
  const rendered = [];
  for (const row of rows) {
    const maxLessonLines = Math.max(...row.map((cell) => cell.lessonLines.length));
    const rowHeight = 14 + 20 + 10 + chartHeight + 14 + maxLessonLines * 16 + 16;
    row.forEach((cell, column) => {
      const x = margin + column * (cellWidth + gap);
      const placed = placeChart(cell.chart, {
        x: x + 14 + (innerWidth - (chartHeight * cell.chart.width) / cell.chart.height) / 2,
        y: y + 44,
        height: chartHeight,
      });
      const lessons = cell.lessonLines
        .map((line, index) =>
          t(x + 14, y + 44 + chartHeight + 24 + index * 16, line, { size: 12, fill: INK_SOFT }),
        )
        .join("\n    ");
      rendered.push(`<g>
    <rect x="${x}" y="${y}" width="${cellWidth}" height="${rowHeight}" rx="6" fill="${SURFACE}" stroke="${RULE}"/>
    ${t(x + 14, y + 28, cell.meta.title, { size: 14.5, weight: 700 })}
    ${placed.markup}
    ${lessons}
  </g>`);
    });
    y += rowHeight + gap;
  }
  const height = y - gap + margin;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${round(height)}" role="img" aria-labelledby="gallery-title gallery-description">
  <title id="gallery-title">Windgram scenario gallery</title>
  <desc id="gallery-description">Six committed synthetic teaching scenarios rendered by the package, each captioned by the lesson string from the scenario index.</desc>
  ${paper("scenario-gallery", width, round(height), 14)}

  <g transform="translate(${margin} 46)">
    ${t(0, 0, "SIX OF SIXTEEN COMMITTED SCENARIOS", { font: MONO, size: 11, weight: 700, ls: 1.8, fill: ACCENT })}
    ${t(0, 42, "SYNTHETIC TEACHING SCENARIOS", { font: DISPLAY, size: 36, weight: 800, ls: 1 })}
    ${t(0, 64, "Rendered by the package from committed profiles — captions are the scenarios' own lesson strings.", { size: 13, fill: INK_SOFT })}
  </g>

  ${rendered.join("\n  ")}
</svg>
`;
}

/* ------------------------------------------------------------------ */
/* Target: social-card — 1200×630 og:image source (rasterized to PNG
   by the generator). Full-bleed: unfurl crops leave no page edge. */

async function composeSocialCard(ctx) {
  const chart = await ctx.renderChart("convective-cycle", "social-card-chart");
  const placed = placeChart(chart, { x: 652, y: 52, height: 526 });
  const titleSize = fitSize("WINDGRAM", 460, { family: "big-shoulders", weight: 800, letterSpacingEm: 0.03 });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-labelledby="social-title social-description">
  <title id="social-title">Windgram — forecast profiles for soaring</title>
  <desc id="social-description">The Windgram wordmark and tagline beside a package-rendered windgram of a complete convective cycle.</desc>
  ${paper("social-card", 1200, 630, 0)}

  <g transform="translate(70 84)">
    ${flag()}
    ${t(122, 13, "FORECAST PROFILES FOR SOARING", { font: MONO, size: 13, weight: 700, ls: 2.2, fill: ACCENT })}
    ${t(0, 140, "WINDGRAM", { font: DISPLAY, size: titleSize, weight: 800, ls: round(titleSize * 0.03) })}
    <path d="M2 160h460" stroke="${RULE}" stroke-width="1.5"/>
    ${t(0, 202, "Model runs become inspectable, versioned", { size: 21, fill: INK_SOFT })}
    ${t(0, 233, "profiles and charts any frontend can draw.", { size: 21, fill: INK_SOFT })}
    ${t(0, 330, "OPEN DATA CONTRACT · PYTHON PIPELINE · TYPESCRIPT RENDERER", { font: MONO, size: 12, weight: 700, ls: 1.2, fill: INK_MUTE })}
    ${t(0, 384, "WINDGRAM.AZOHRA.COM", { font: MONO, size: 15, weight: 700, ls: 2, fill: ACCENT })}
  </g>

  <rect x="640" y="40" width="520" height="550" rx="9" fill="${SURFACE}" stroke="#51483e" stroke-width="1.5"/>
  ${placed.markup}
</svg>
`;
}

/* ------------------------------------------------------------------ */

/** Every committed doc figure. Paths are repo-relative. */
export const TARGETS = [
  { id: "readme-hero", file: "assets/readme-hero.svg", compose: composeReadmeHero },
  { id: "package-hero", file: "assets/package-hero.svg", compose: composePackageHero },
  { id: "scenario-gallery", file: "assets/scenario-gallery.svg", compose: composeScenarioGallery },
  { id: "social-card", file: "assets/social-card.svg", compose: composeSocialCard },
];

/** Raster derivatives: rasterized after their SVG source regenerates,
 * excluded from byte-equality drift (raster bytes vary across chromium
 * builds and platforms) and checked for presence + dimensions instead. */
export const RASTER_TARGETS = [
  {
    id: "social-card-png",
    source: "social-card",
    file: "site/public/social-card.png",
    width: 1200,
    height: 630,
  },
];

/**
 * Brand text engine for generated doc figures.
 *
 * Committed assets under docs/assets/ render on surfaces that load no
 * webfonts (GitHub's camo proxy, npm, link unfurlers), so every <text>
 * element is converted to path outlines before an asset is written. The
 * outlines come from the site's own brand fonts — the @fontsource
 * packages already pinned in site/node_modules — parsed with opentype.js,
 * which reads the fontsource WOFF files directly and emits deterministic
 * path data. The result carries Big Shoulders / IBM Plex typography with
 * zero font dependency on the viewer.
 *
 * Shaping is deliberately per-glyph (charToGlyph + kerning +
 * letter-spacing), and outlines are serialized here straight from each
 * glyph's raw font-unit commands rather than through opentype's
 * getPath/toPathData: both the 1.x and 2.x run shapers emit NaN path
 * data for some sequences in these WOFF builds (2.x corrupts single
 * glyphs too — hence the 1.3.5 pin), while the raw command tables are
 * finite for every glyph the brand faces cover. Doing the transform and
 * rounding ourselves keeps measurement and outlining in exact agreement
 * and makes non-finite output a hard error instead of a silent glitch.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import opentype from "opentype.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const siteRequire = createRequire(join(root, "site", "package.json"));

/* The brand families and the weights the site actually ships. A requested
   weight snaps to the nearest available one, mirroring how the browser
   would synthesize from the loaded @fontsource faces. */
const FAMILIES = {
  "big-shoulders": { pkg: "@fontsource/big-shoulders", weights: [700, 800] },
  "ibm-plex-sans": { pkg: "@fontsource/ibm-plex-sans", weights: [400, 500, 600, 700] },
  "ibm-plex-mono": { pkg: "@fontsource/ibm-plex-mono", weights: [400, 500, 600, 700] },
};

const fontCache = new Map();

function fontFile(familyKey, weight) {
  const family = FAMILIES[familyKey];
  const pkgDir = dirname(siteRequire.resolve(`${family.pkg}/package.json`));
  return join(pkgDir, "files", `${familyKey}-latin-${weight}-normal.woff`);
}

/** Load (and cache) the nearest available face for a family + weight. */
export function getFont(familyKey, weight = 400) {
  const family = FAMILIES[familyKey];
  if (!family) throw new Error(`Unknown font family key: ${familyKey}`);
  const snapped = family.weights.reduce((best, candidate) =>
    Math.abs(candidate - weight) < Math.abs(best - weight) ? candidate : best,
  );
  const cacheKey = `${familyKey}-${snapped}`;
  let font = fontCache.get(cacheKey);
  if (!font) {
    const bytes = readFileSync(fontFile(familyKey, snapped));
    font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    fontCache.set(cacheKey, font);
  }
  return font;
}

/** Map a CSS font-family value onto one of the three brand families. */
export function familyKey(cssFamily) {
  const value = cssFamily.toLowerCase();
  if (value.includes("big shoulders")) return "big-shoulders";
  if (value.includes("mono")) return "ibm-plex-mono";
  return "ibm-plex-sans";
}

function coordinate(value) {
  if (!Number.isFinite(value)) throw new Error(`Non-finite coordinate in glyph outline: ${value}`);
  return String(Math.round(value * 100) / 100);
}

/** Serialize one glyph's raw font-unit commands into px path data. */
function glyphPathData(glyph, x, y, scale) {
  const px = (value) => coordinate(x + value * scale);
  const py = (value) => coordinate(y - value * scale);
  const parts = [];
  for (const cmd of glyph.path.commands) {
    if (cmd.type === "M") parts.push(`M${px(cmd.x)} ${py(cmd.y)}`);
    else if (cmd.type === "L") parts.push(`L${px(cmd.x)} ${py(cmd.y)}`);
    else if (cmd.type === "Q") parts.push(`Q${px(cmd.x1)} ${py(cmd.y1)} ${px(cmd.x)} ${py(cmd.y)}`);
    else if (cmd.type === "C")
      parts.push(`C${px(cmd.x1)} ${py(cmd.y1)} ${px(cmd.x2)} ${py(cmd.y2)} ${px(cmd.x)} ${py(cmd.y)}`);
    else if (cmd.type === "Z") parts.push("Z");
    else throw new Error(`Unsupported path command ${cmd.type}`);
  }
  return parts.join("");
}

/**
 * Per-glyph shaping: kerned advances plus CSS-style letter-spacing
 * (added after every glyph, as browsers do). Returns the glyph
 * placements (skipping blanks) and the run's total advance in px.
 */
function shapeRun(font, text, x, y, sizePx, letterSpacingPx) {
  const scale = sizePx / font.unitsPerEm;
  const placements = [];
  let cursor = x;
  let previous = null;
  for (const character of text) {
    const glyph = font.charToGlyph(character);
    if (glyph.index === 0 && character !== " ") {
      throw new Error(`No glyph for ${JSON.stringify(character)} in the latin brand faces`);
    }
    if (previous) cursor += font.getKerningValue(previous, glyph) * scale;
    if (glyph.path.commands.length > 0) placements.push({ glyph, x: cursor });
    cursor += glyph.advanceWidth * scale + letterSpacingPx;
    previous = glyph;
  }
  return { placements, width: cursor - x };
}

/** Advance width of a run in px. `spec`: { family, weight, size, letterSpacing }. */
export function measureText(text, spec) {
  const font = getFont(spec.family ?? "ibm-plex-sans", spec.weight ?? 400);
  return shapeRun(font, text, 0, 0, spec.size ?? 16, spec.letterSpacing ?? 0).width;
}

/** Greedy word wrap against real advance widths. Returns the lines. */
export function wrapText(text, maxWidthPx, spec) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && measureText(candidate, spec) > maxWidthPx) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const XML_UNESCAPES = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
  [/&#39;/g, "'"],
  [/&amp;/g, "&"],
];

function unescapeXml(value) {
  return XML_UNESCAPES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function parseAttributes(raw) {
  const attrs = {};
  for (const [, name, value] of raw.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"/g)) {
    attrs[name] = value;
  }
  return attrs;
}

function parsePx(value, relativeToPx = 16) {
  const trimmed = value.trim();
  if (trimmed.endsWith("em")) return Number.parseFloat(trimmed) * relativeToPx;
  return Number.parseFloat(trimmed);
}

function parseWeight(value) {
  if (value === "bold") return 700;
  if (value === "normal") return 400;
  return Number.parseFloat(value) || 400;
}

/**
 * Collect class-selector rules from the document's own <style> blocks,
 * in stylesheet order, with `var(--x, fallback)` resolved to its
 * fallback — exactly what an SVG-as-image context (no external CSS)
 * resolves. Handles `.wg-foo` and `.wg .wg-mono` shaped selectors; the
 * base `.wg text` family rule is IBM Plex Sans, which is also this
 * module's default, so it needs no ancestry tracking.
 */
function parseClassRules(svg) {
  const rules = [];
  for (const [, css] of svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    const resolved = css.replace(/var\(--[\w-]+,\s*([^)]+)\)/g, "$1");
    for (const [, selectors, body] of resolved.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const props = {};
      for (const declaration of body.split(";")) {
        const colon = declaration.indexOf(":");
        if (colon < 0) continue;
        props[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
      }
      for (const selector of selectors.split(",")) {
        const match = /^\.(?:wg \.)?([\w-]+)$/.exec(selector.trim());
        if (match && match[1] !== "wg") rules.push({ className: match[1], props });
      }
    }
  }
  return rules;
}

/* Attributes consumed by outlining; everything else (class, fill,
   stroke-width for text halos, opacity, …) transfers to the path so the
   document's class-based fills and halos keep applying. */
const CONSUMED_ATTRIBUTES = new Set([
  "x",
  "y",
  "text-anchor",
  "font-family",
  "font-size",
  "font-weight",
  "letter-spacing",
]);

/**
 * Replace every <text> element in an SVG string with glyph outlines,
 * resolving each element's face from its presentation attributes and
 * the document's own class rules (renderer text carries classes;
 * composition text carries explicit attributes; nothing mixes the two).
 *
 * Each distinct glyph-at-a-size is outlined once into a shared <defs>
 * block and placed with <use x y>; charts repeat digits and labels
 * heavily, so this keeps committed assets an order of magnitude smaller
 * than inlining every outline. Fill, class-based stroke halos, and
 * paint-order all inherit from the wrapping <g> into the referenced
 * paths.
 */
export function convertTextToPaths(svg) {
  const rules = parseClassRules(svg);
  const defs = new Map();

  function glyphUse(font, familyName, weight, glyph, size, x, y) {
    const key = `${familyName}-${weight}-${glyph.index}-${size}`;
    let entry = defs.get(key);
    if (!entry) {
      entry = { id: `tg${defs.size}`, d: glyphPathData(glyph, 0, 0, size / font.unitsPerEm) };
      defs.set(key, entry);
    }
    return `<use href="#${entry.id}" x="${coordinate(x)}" y="${coordinate(y)}"/>`;
  }

  const converted = svg.replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/g, (element, rawAttrs, rawContent) => {
    if (rawContent.includes("<")) {
      throw new Error(`Unsupported nested markup inside <text>: ${element}`);
    }
    const attrs = parseAttributes(rawAttrs);
    const content = unescapeXml(rawContent);
    if (!content.trim()) return "";

    const classes = (attrs.class ?? "").split(/\s+/).filter(Boolean);
    let family = "ibm-plex-sans";
    let size = 16;
    let weight = 400;
    let letterSpacingRaw = null;
    for (const rule of rules) {
      if (!classes.includes(rule.className)) continue;
      if (rule.props["font-family"]) family = familyKey(rule.props["font-family"]);
      if (rule.props["font-size"]) size = parsePx(rule.props["font-size"]);
      if (rule.props["font-weight"]) weight = parseWeight(rule.props["font-weight"]);
      if (rule.props["letter-spacing"]) letterSpacingRaw = rule.props["letter-spacing"];
    }
    if (attrs["font-family"]) family = familyKey(attrs["font-family"]);
    if (attrs["font-size"]) size = parsePx(attrs["font-size"]);
    if (attrs["font-weight"]) weight = parseWeight(attrs["font-weight"]);
    if (attrs["letter-spacing"]) letterSpacingRaw = attrs["letter-spacing"];
    const letterSpacing = letterSpacingRaw ? parsePx(letterSpacingRaw, size) : 0;

    const font = getFont(family, weight);
    let x = Number.parseFloat(attrs.x ?? "0");
    const y = Number.parseFloat(attrs.y ?? "0");
    const run = shapeRun(font, content, 0, 0, size, letterSpacing);
    if (attrs["text-anchor"] === "middle") x -= run.width / 2;
    else if (attrs["text-anchor"] === "end") x -= run.width;

    if (run.placements.length === 0) return "";
    const uses = run.placements
      .map((placement) => glyphUse(font, family, weight, placement.glyph, size, x + placement.x, y))
      .join("");
    const kept = Object.entries(attrs)
      .filter(([name]) => !CONSUMED_ATTRIBUTES.has(name))
      .map(([name, value]) => ` ${name}="${value}"`)
      .join("");
    return `<g${kept}>${uses}</g>`;
  });
  if (/<text\b/.test(converted)) {
    throw new Error("Text-to-path conversion left <text> elements behind");
  }
  if (defs.size === 0) return converted;
  const defsMarkup = `<defs>${[...defs.values()].map((entry) => `<path id="${entry.id}" d="${entry.d}"/>`).join("")}</defs>`;
  return converted.replace(/(<svg\b[^>]*>)/, `$1\n${defsMarkup}`);
}

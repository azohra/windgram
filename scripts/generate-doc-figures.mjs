/**
 * Regenerate the committed doc figures under docs/assets/ (and their
 * raster derivatives) from the target registry in doc-figures/targets.mjs.
 *
 * Every figure is composed from committed scenario profiles through the
 * package's real buildScene/renderSvg, then all text is outlined into
 * brand-font paths (doc-figures/fonts.mjs), so the assets are
 * deterministic, font-independent, and incapable of drifting from the
 * renderer without failing CI.
 *
 *   node scripts/generate-doc-figures.mjs            # regenerate in place
 *   node scripts/generate-doc-figures.mjs --check    # diff against committed
 *
 * --check mirrors the scenario-drift contract: SVG targets must match
 * byte-for-byte; raster targets (whose bytes vary across chromium builds
 * and platforms) are checked for presence and pixel dimensions only, so
 * checking needs no browser.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { convertTextToPaths } from "./doc-figures/fonts.mjs";
import { RASTER_TARGETS, TARGETS } from "./doc-figures/targets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function importPackage(subpath) {
  try {
    return await import(join(root, "packages/windgram/dist", subpath, "index.js"));
  } catch (error) {
    throw new Error(
      `Cannot load packages/windgram/dist/${subpath} — build the package first ` +
        `(pnpm --dir packages/windgram build, or run via pnpm figures). ${error.message}`,
    );
  }
}

const { parseWindgramProfileJson } = await importPackage("contract");
const { buildScene } = await importPackage("scene");
const { renderSvg } = await importPackage("svg");

const scenarioIndex = JSON.parse(await readFile(join(root, "scenarios/index.json"), "utf8"));

function scenarioMeta(id) {
  const entry = scenarioIndex.scenarios.find((scenario) => scenario.id === id);
  if (!entry) throw new Error(`Scenario ${id} not found in scenarios/index.json`);
  return entry;
}

const profileCache = new Map();

async function loadProfile(id) {
  let profile = profileCache.get(id);
  if (!profile) {
    const [output] = scenarioMeta(id).outputs;
    profile = parseWindgramProfileJson(await readFile(join(root, "scenarios", output.path), "utf8"));
    if (!profile) throw new Error(`Invalid committed profile for scenario ${id}`);
    profileCache.set(id, profile);
  }
  return profile;
}

/* One rendering recipe for every embedded chart: the committed profile,
   the profile's own timezone, and the hero's proportions. */
async function renderChart(id, idPrefix) {
  const profile = await loadProfile(id);
  const scene = buildScene(profile, {
    timeZone: profile.site.timeZone,
    widthPx: 560,
    plotHeightPx: 340,
    hourLabel: "12h",
  });
  const svg = renderSvg(scene, { idPrefix });
  const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!viewBox) throw new Error(`Rendered chart for ${id} has no viewBox`);
  return { svg, width: Number(viewBox[1]), height: Number(viewBox[2]) };
}

const composeContext = { renderChart, scenarioMeta };

async function composeTarget(target) {
  return convertTextToPaths(await target.compose(composeContext));
}

/* ---------------------------------------------------------------- */

function pngDimensions(bytes) {
  const isPng = bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47;
  if (!isPng || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function rasterize(svg, target) {
  const siteRequire = createRequire(join(root, "site", "package.json"));
  const { chromium } = siteRequire("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: target.width, height: target.height },
      deviceScaleFactor: 1,
    });
    const sized = svg.replace("<svg ", `<svg width="${target.width}" height="${target.height}" `);
    await page.setContent(`<body style="margin:0">${sized}</body>`);
    await page.screenshot({
      path: join(root, target.file),
      clip: { x: 0, y: 0, width: target.width, height: target.height },
    });
  } finally {
    await browser.close();
  }
}

/* ---------------------------------------------------------------- */

const check = process.argv.includes("--check");
const drift = [];

const composed = new Map();
for (const target of TARGETS) {
  composed.set(target.id, await composeTarget(target));
}

if (check) {
  for (const target of TARGETS) {
    const expected = composed.get(target.id);
    const committed = await readFile(join(root, target.file), "utf8").catch(() => null);
    if (committed === expected) {
      console.log(`ok    ${target.file}`);
    } else {
      drift.push(target.file);
      console.log(`DRIFT ${target.file}${committed === null ? " (missing)" : ""}`);
    }
  }
  for (const target of RASTER_TARGETS) {
    const bytes = await readFile(join(root, target.file)).catch(() => null);
    const dimensions = bytes && pngDimensions(bytes);
    if (dimensions && dimensions.width === target.width && dimensions.height === target.height) {
      console.log(`ok    ${target.file} (${target.width}×${target.height} raster; bytes not compared)`);
    } else {
      drift.push(target.file);
      console.log(`DRIFT ${target.file} (${bytes ? "wrong dimensions" : "missing"})`);
    }
  }
  if (drift.length > 0) {
    console.error(`\nDoc figures drifted from the renderer: ${drift.join(", ")}`);
    console.error("Regenerate with: pnpm figures");
    process.exit(1);
  }
} else {
  for (const target of TARGETS) {
    const path = join(root, target.file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, composed.get(target.id));
    console.log(`Wrote ${target.file}`);
  }
  for (const target of RASTER_TARGETS) {
    await mkdir(dirname(join(root, target.file)), { recursive: true });
    await rasterize(composed.get(target.source), target);
    console.log(`Wrote ${target.file} (${target.width}×${target.height})`);
  }
}

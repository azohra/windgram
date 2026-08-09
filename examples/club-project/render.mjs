import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  parseSitesCatalogueJson,
  parseWindgramManifestJson,
  parseWindgramProfileJson,
} from "windgram/contract";
import { buildKeySpec, buildScene } from "windgram/scene";
import { renderKeySvg, renderSvg } from "windgram/svg";
import { runsConsistent } from "windgram/transport";

function option(name) {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || value === undefined || value.startsWith("--")) {
    throw new Error(`missing required ${name} option`);
  }
  return value;
}

function pathWithin(root, path, label) {
  const local = relative(root, path);
  if (local === "" || local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error(`${label} must be inside the static output directory`);
  }
  return local.split(sep).join("/");
}

function html(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const profilePath = resolve(option("--profile"));
const manifestPath = resolve(option("--manifest"));
const sitesPath = resolve(option("--sites"));
const outputDirectory = resolve(option("--output"));

const profile = parseWindgramProfileJson(await readFile(profilePath, "utf8"));
if (!profile) throw new Error("profile failed the windgram contract");

const manifest = parseWindgramManifestJson(await readFile(manifestPath, "utf8"));
if (!manifest) throw new Error("manifest failed the windgram contract");
if (!runsConsistent(manifest, profile)) {
  throw new Error("manifest and profile do not describe the same model run");
}
if (!manifest.sites.some(({ slug }) => slug === profile.site.id)) {
  throw new Error("manifest does not list the rendered launch");
}

const catalogue = parseSitesCatalogueJson(await readFile(sitesPath, "utf8"));
if (!catalogue) throw new Error("site catalogue failed the windgram contract");
const configuredSite = catalogue.sites.find(({ slug }) => slug === profile.site.id);
if (!configuredSite) throw new Error("site catalogue does not list the rendered launch");
if (profile.site.timeZone !== configuredSite.timeZone) {
  throw new Error("profile does not echo the configured launch timezone");
}

const profileHref = pathWithin(outputDirectory, profilePath, "profile");
const manifestHref = pathWithin(outputDirectory, manifestPath, "manifest");
const assetsDirectory = resolve(outputDirectory, "assets");
const svgPath = resolve(assetsDirectory, `${profile.site.id}.svg`);
const keySvgPath = resolve(assetsDirectory, `${profile.site.id}-key.svg`);
await mkdir(assetsDirectory, { recursive: true });

const scene = buildScene(profile, {
  timeZone: configuredSite.timeZone,
  widthPx: 1080,
  hourLabel: "12h",
  barbStride: "auto",
  markerStride: { cloudBase: 2, usableLiftTop: 2 },
  stripLabels: { thermalStrength: "LIFT" },
});
const svg = renderSvg(scene, { idPrefix: "club-example" });
const keySvg = renderKeySvg(buildKeySpec(scene), { idPrefix: "club-example-key" });
await writeFile(svgPath, `${svg}\n`);
await writeFile(keySvgPath, `${keySvg}\n`);

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${html(profile.site.name)} — windgram example</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { max-width: 78rem; margin: 0 auto; padding: 2rem; line-height: 1.5; }
      img { display: block; width: 100%; height: auto; margin-block: 1.5rem; }
      .key { margin-block-start: -.5rem; }
      nav { display: flex; gap: 1rem; flex-wrap: wrap; }
    </style>
  </head>
  <body>
    <main>
      <h1>${html(profile.site.name)}</h1>
      <p>${html(configuredSite.timeZone)} · profile and manifest linked below</p>
      <img src="assets/${html(profile.site.id)}.svg" alt="Windgram for ${html(profile.site.name)}">
      <img class="key" src="assets/${html(profile.site.id)}-key.svg" alt="Windgram key">
      <nav aria-label="Published artifacts">
        <a href="${html(profileHref)}">Profile JSON</a>
        <a href="${html(manifestHref)}">Manifest JSON</a>
      </nav>
    </main>
  </body>
</html>
`;
await writeFile(resolve(outputDirectory, "index.html"), page);
console.log(`validated ${profilePath}`);
console.log(`validated ${manifestPath}`);
console.log(`validated ${sitesPath}`);
console.log(`rendered ${svgPath}`);
console.log(`rendered ${keySvgPath}`);
console.log(`published ${resolve(outputDirectory, "index.html")}`);

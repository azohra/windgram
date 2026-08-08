import type { WindgramProfile } from "windgram/contract";
import { p50, windgramDisplayHours } from "windgram/derive";
import { buildScene, DEFAULT_OVERLAYS, type OverlayName } from "windgram/scene";
import { renderSvg } from "windgram/svg";
import { fetchSitesCatalog, fetchProfileWithSkewGuard, type SiteCatalogEntry } from "./api";
import { MODELS, modelBySlug, modelDisplayName } from "./catalogue";
import { renderOverlaySVG, type OverlaySeries } from "./overlay";
import { groupByLocalDay, localHourLabel, DISPLAY_TZ } from "./time";
import { freshnessInfo } from "./captions";

const LAST_SITE_KEY = "windgram:lastSite";
const LAST_MODEL_KEY = "windgram:lastModel";
const MODEL_COLOR_VARS = ["--model-1", "--model-2", "--model-3", "--model-4", "--model-5", "--model-6"];

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let sites: SiteCatalogEntry[] = [];
let currentSite = "";
let currentModel = "hrdps-continental";
let currentDateKey: string | null = null;
const appRoot = document.querySelector<HTMLElement>(".wg-app");
let overlayOn = appRoot?.dataset.defaultCompare === "true";
if (appRoot) appRoot.dataset.comparing = String(overlayOn);
let currentProfile: WindgramProfile | null = null;
// Scene overlay toggles — starts at the package default (today's chart) and
// follows the checkboxes; the whole set is re-renderable client-side because
// every overlay is a pure function of the already-fetched profile.
const sceneOverlays: Record<OverlayName, boolean> = { ...DEFAULT_OVERLAYS };

const siteSelect = el<HTMLSelectElement>("site-select");
const modelSelect = el<HTMLSelectElement>("model-select");
const overlayToggle = el<HTMLInputElement>("overlay-toggle");
const dayTabs = el<HTMLDivElement>("day-tabs");
const freshnessEl = el<HTMLDivElement>("freshness");
const hourReadoutEl = el<HTMLDivElement>("hour-readout");
const chartMount = el<HTMLDivElement>("chart-mount");
const statusEl = el<HTMLDivElement>("status");
const overlaySection = el<HTMLDivElement>("overlay-section");
const overlayMount = el<HTMLDivElement>("overlay-mount");
const overlayStatus = el<HTMLDivElement>("overlay-status");
const overlayPicker = document.getElementById("overlay-picker");

function populateModelSelect() {
  modelSelect.innerHTML = "";
  for (const m of MODELS) {
    const opt = document.createElement("option");
    opt.value = m.slug;
    opt.textContent = m.experimental ? `${modelDisplayName(m)} (experimental)` : modelDisplayName(m);
    modelSelect.appendChild(opt);
  }
  modelSelect.value = currentModel;
}

function populateSiteSelect() {
  siteSelect.innerHTML = "";
  for (const [index, s] of sites.entries()) {
    const opt = document.createElement("option");
    opt.value = s.slug;
    opt.textContent = `Sample grid cell ${String.fromCharCode(65 + index)}`;
    siteSelect.appendChild(opt);
  }
  siteSelect.value = currentSite;
}

function initOverlayPicker() {
  if (!overlayPicker) return;
  for (const input of overlayPicker.querySelectorAll<HTMLInputElement>("input[data-overlay]")) {
    const name = input.dataset.overlay as OverlayName;
    input.checked = sceneOverlays[name] ?? false;
    input.addEventListener("change", () => {
      sceneOverlays[name] = input.checked;
      renderChartForCurrentDay();
    });
  }
}

function renderDayTabs(days: { dateKey: string; label: string }[]) {
  dayTabs.innerHTML = "";
  for (const d of days) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = d.label;
    btn.className = "day-tab" + (d.dateKey === currentDateKey ? " active" : "");
    btn.addEventListener("click", () => {
      currentDateKey = d.dateKey;
      renderChartForCurrentDay();
      renderDayTabs(days);
      if (overlayOn) loadOverlay();
    });
    dayTabs.appendChild(btn);
  }
}

/* Profiles publish every forecast hour; the pilots' 07:00-21:00 day (with the
   min-hours rule) is applied here with derive/'s windowing, not upstream. */
function displayDays(profile: WindgramProfile) {
  return groupByLocalDay(windgramDisplayHours(profile.hours, { timeZone: DISPLAY_TZ }));
}

function renderChartForCurrentDay() {
  if (!currentProfile || !currentDateKey) return;
  const days = displayDays(currentProfile);
  const day = days.find((d) => d.dateKey === currentDateKey) ?? days[0];
  if (!day) {
    chartMount.innerHTML = "<p>No flyable hours in this run.</p>";
    hourReadoutEl.textContent = "";
    return;
  }

  const indexByValidAt = new Map(currentProfile.hours.map((hour, index) => [hour.validAt, index]));
  const hourIndices = day.hours
    .map((hour) => indexByValidAt.get(hour.validAt))
    .filter((index): index is number => index !== undefined);

  const scene = buildScene(currentProfile, {
    timeZone: DISPLAY_TZ,
    hourIndices,
    overlays: sceneOverlays,
  });
  chartMount.innerHTML = renderSvg(scene);
  const svg = chartMount.querySelector("svg");
  if (svg) {
    svg.style.width = `${scene.width}px`;
    svg.style.maxWidth = "none";
    svg.style.height = "auto";
    svg.style.display = "block";
    svg.style.margin = "0 auto";
  }

  const selectedHour = day.hours[Math.min(scene.selectedHourIndex, day.hours.length - 1)];
  const wStar = p50(selectedHour.derived.thermalVelocityMs);
  const usableLift = p50(selectedHour.derived.usableLiftTopM);
  const usable = usableLift == null ? "none" : `${Math.round(usableLift).toLocaleString()} m`;
  // Gust wording follows the model's declared semantics: ECCC's hour-max is
  // an honest "gusting to"; NOAA's instantaneous diagnostic is not.
  const gustMs = selectedHour.surface.windGustMs == null ? null : p50(selectedHour.surface.windGustMs);
  const gustCapability = modelBySlug(currentModel)?.capabilities.gust;
  const gust =
    gustMs == null || !gustCapability
      ? ""
      : gustCapability === "hourMax"
        ? ` · gusting to ${Math.round(gustMs * 3.6)} km/h`
        : ` · gusts ${Math.round(gustMs * 3.6)} km/h`;
  hourReadoutEl.textContent = `${localHourLabel(selectedHour.validAt)}:00 · ${Math.round(
    p50(selectedHour.surface.temperatureC),
  )} °C · w* ${wStar.toFixed(1)} m/s · usable lift ${usable}${gust} · cloud ${Math.round(
    p50(selectedHour.surface.cloudCoverPercent),
  )}%`;
}

async function loadSite() {
  const model = modelBySlug(currentModel);
  if (!model) return;
  statusEl.textContent = "Loading…";
  chartMount.innerHTML = "";
  freshnessEl.textContent = "";

  try {
    const result = await fetchProfileWithSkewGuard(model, currentSite);
    if (!result) {
      statusEl.textContent = `${modelDisplayName(model)} has no readable forecast for this launch yet — it may be outside the model's domain, still publishing the previous data schema, or waiting on its first run.`;
      dayTabs.innerHTML = "";
      return;
    }
    statusEl.textContent = "";
    currentProfile = result.profile;

    const fresh = freshnessInfo(result.manifest, model, result.stale);
    freshnessEl.textContent = fresh.text;
    freshnessEl.dataset.status = fresh.status;

    const days = displayDays(result.profile);
    if (!days.some((d) => d.dateKey === currentDateKey)) {
      currentDateKey = days[0]?.dateKey ?? null;
    }
    renderDayTabs(days);
    renderChartForCurrentDay();

    try {
      localStorage.setItem(LAST_SITE_KEY, currentSite);
      localStorage.setItem(LAST_MODEL_KEY, currentModel);
    } catch {}

    if (overlayOn) loadOverlay();
  } catch (err) {
    statusEl.textContent = `Couldn't load ${modelDisplayName(model)} for this launch — the model's data may be temporarily unavailable. (${(err as Error).message})`;
  }
}

async function loadOverlay() {
  if (!currentDateKey) return;
  overlaySection.hidden = false;
  overlayMount.innerHTML = "";
  overlayStatus.textContent = "Comparing models…";

  const results = await Promise.all(
    MODELS.map(async (m) => {
      try {
        const r = await fetchProfileWithSkewGuard(m, currentSite);
        return r ? { model: m, profile: r.profile } : null;
      } catch {
        return null;
      }
    }),
  );

  const series: OverlaySeries[] = [];
  results.forEach((r, i) => {
    if (!r) return;
    const days = displayDays(r.profile);
    const day = days.find((d) => d.dateKey === currentDateKey);
    if (!day) return;
    series.push({
      label: modelDisplayName(r.model),
      color: cssVar(MODEL_COLOR_VARS[i % MODEL_COLOR_VARS.length]),
      hours: day.hours.map((hour) => ({
        validAt: hour.validAt,
        boundaryLayerTopM: p50(hour.derived.boundaryLayerTopM),
        usableLiftTopM: p50(hour.derived.usableLiftTopM),
      })),
    });
  });

  if (series.length < 2) {
    overlayStatus.textContent = "Not enough models cover this launch and day yet to compare.";
    return;
  }
  overlayStatus.textContent = "";
  overlayMount.appendChild(renderOverlaySVG(series));
}

function init() {
  populateModelSelect();
  initOverlayPicker();
  overlayToggle.checked = overlayOn;

  let savedSite = "";
  let savedModel = "";
  try {
    savedSite = localStorage.getItem(LAST_SITE_KEY) ?? "";
    savedModel = localStorage.getItem(LAST_MODEL_KEY) ?? "";
  } catch {}
  if (savedModel && modelBySlug(savedModel)) {
    currentModel = savedModel;
    modelSelect.value = savedModel;
  } else if (!modelBySlug(currentModel)) {
    currentModel = MODELS[0]?.slug ?? currentModel;
    modelSelect.value = currentModel;
  }

  fetchSitesCatalog()
    .then((catalog) => {
      sites = catalog;
      currentSite = savedSite && catalog.some((s) => s.slug === savedSite) ? savedSite : (catalog[0]?.slug ?? "");
      populateSiteSelect();
      if (currentSite) loadSite();
    })
    .catch((err) => {
      statusEl.textContent = `Couldn't load the site catalogue. (${(err as Error).message})`;
    });

  siteSelect.addEventListener("change", () => {
    currentSite = siteSelect.value;
    currentDateKey = null;
    loadSite();
  });
  modelSelect.addEventListener("change", () => {
    currentModel = modelSelect.value;
    currentDateKey = null;
    loadSite();
  });
  overlayToggle.addEventListener("change", () => {
    overlayOn = overlayToggle.checked;
    if (appRoot) appRoot.dataset.comparing = String(overlayOn);
    if (overlayOn) loadOverlay();
    else overlaySection.hidden = true;
  });
}

init();

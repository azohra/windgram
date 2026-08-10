import { expect, test, type Locator } from "@playwright/test";

/* Control-sensitivity guards: every laboratory control must visibly move
   what it claims to move. Each test drives a control across its range in
   the BUILT site and fails when the mounted chart (or, for the one
   readout-only lab, the readout) does not respond. This has real teeth:
   a smoke scenario whose convective hours were local night and a sink
   slider pinned by an always-capped column both shipped rendering every
   control position identically — a slider that changes nothing teaches
   nothing, while looking exactly like a working figure. */

async function setRange(range: Locator, value: string): Promise<void> {
  await range.evaluate((element, next) => {
    const input = element as HTMLInputElement;
    input.value = next;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

/** The mounted chart's full markup — the thing a reader's eyes compare. */
const markup = (mount: Locator): Promise<string> => mount.innerHTML();

test("the smoke lab's optical-depth slider moves the haze, the w* strip, and the readouts", async ({ page }) => {
  await page.goto("/docs/learn/smoke-and-thermals/", { waitUntil: "networkidle" });
  const figure = page.locator("#smoke-lab");
  const slider = figure.locator("[data-smoke-aot]");
  const mount = figure.locator("[data-smoke-mount]");
  const transmittance = figure.locator("[data-smoke-transmittance]");

  await setRange(slider, "0.5");
  const thin = await markup(mount);
  const thinTransmittance = await transmittance.textContent();
  const thinOpacity = await mount.locator(".wg-smoke-cell").first().getAttribute("opacity");
  const thinStrip = await mount.locator(".wg-strip-thermalStrength").getAttribute("d");

  await setRange(slider, "4");
  const thick = await markup(mount);
  expect(thick).not.toBe(thin);
  // The haze honors "tint = τ" per cell, not just at the τ=0 boundary.
  const thickOpacity = await mount.locator(".wg-smoke-cell").first().getAttribute("opacity");
  expect(thickOpacity).not.toBe(thinOpacity);
  // The adjusted w* strip actually derates as the plume thickens.
  const thickStrip = await mount.locator(".wg-strip-thermalStrength").getAttribute("d");
  expect(thickStrip).not.toBe(thinStrip);
  expect(await transmittance.textContent()).not.toBe(thinTransmittance);
});

test("the smoke before/after figure's two panels genuinely differ", async ({ page }) => {
  // The adjusted panel is labeled as a correction; a labeled no-op is the
  // failure this guards against (scene.smokeAdjustment is now withheld
  // when no hour changes, and the scenario's hours are real daytime).
  await page.goto("/docs/learn/smoke-and-thermals/", { waitUntil: "networkidle" });
  const panels = page.locator("#smoke-adjusted-comparison .smoke-compare svg");
  await expect(panels).toHaveCount(2);
  const base = await panels.nth(0).innerHTML();
  const adjusted = await panels.nth(1).innerHTML();
  expect(adjusted).not.toBe(base);
});

test("the usable-lift lab's sink slider moves the line inside its everyday range", async ({ page }) => {
  await page.goto("/docs/python/derivation-science/", { waitUntil: "networkidle" });
  const figure = page.locator("#usable-lift-lab");
  const slider = figure.locator("[data-usable-sink]");
  const mount = figure.locator("[data-usable-mount]");

  await setRange(slider, "0.5");
  const gentle = await markup(mount);
  // Everyday sink rates, not just the slider's extremes: the regression
  // this guards against was a column capped across the whole range.
  await setRange(slider, "2.5");
  expect(await markup(mount)).not.toBe(gentle);
  await setRange(slider, "6");
  expect(await markup(mount)).not.toBe(gentle);
});

test("the parcel lab responds to both the scenario select and the hour slider", async ({ page }) => {
  await page.goto("/docs/python/derivation-science/", { waitUntil: "networkidle" });
  const figure = page.locator("#parcel-lab");
  const mount = figure.locator("[data-parcel-mount]");
  const hours = figure.locator("[data-parcel-hours]");

  const full = await markup(mount);
  await setRange(hours, "1");
  const single = await markup(mount);
  expect(single).not.toBe(full);

  const max = await hours.getAttribute("max");
  await setRange(hours, max!);
  await figure.locator("[data-parcel-scenario]").selectOption({ index: 1 });
  expect(await markup(mount)).not.toBe(full);
});

test("the wind-shear lab's hour slider moves the barbs and the shear readout", async ({ page }) => {
  await page.goto("/docs/learn/reading-a-windgram/", { waitUntil: "networkidle" });
  const figure = page.locator("#wind-shear-lab");
  const slider = figure.locator("[data-shear-hour]");
  const mount = figure.locator("[data-shear-mount]");
  const readout = figure.locator("[data-shear-value]");

  await setRange(slider, "0");
  const first = await markup(mount);
  const firstShear = await readout.textContent();

  const max = await slider.getAttribute("max");
  await setRange(slider, max!);
  expect(await markup(mount)).not.toBe(first);
  expect(await readout.textContent()).not.toBe(firstShear);
});

test("the ensemble-spread lab redraws for each ensemble construction", async ({ page }) => {
  await page.goto("/docs/data/ensemble-values/", { waitUntil: "networkidle" });
  const figure = page.locator("#ensemble-spread-lab");
  const select = figure.locator("[data-ensemble-scenario]");
  const mount = figure.locator("[data-ensemble-mount]");

  const tight = await markup(mount);
  await select.selectOption("wide");
  const wide = await markup(mount);
  expect(wide).not.toBe(tight);
  await select.selectOption("censored");
  expect(await markup(mount)).not.toBe(wide);
});

test("the timing lab's hour lens walks the readouts across both profiles", async ({ page }) => {
  // Its two charts are deliberately static (whole profiles stay visible);
  // the control's contract is the readout pair, so that is what must move.
  await page.goto("/docs/models/choosing/", { waitUntil: "networkidle" });
  const figure = page.locator("#model-disagreement-lab");
  const slider = figure.locator("[data-timing-hour]");
  const earlier = figure.locator("[data-timing-earlier-thermal]");
  const later = figure.locator("[data-timing-later-thermal]");

  await setRange(slider, "0");
  const firstEarlier = await earlier.textContent();
  const firstLater = await later.textContent();

  const max = await slider.getAttribute("max");
  await setRange(slider, max!);
  expect(await earlier.textContent()).not.toBe(firstEarlier);
  expect(await later.textContent()).not.toBe(firstLater);
});

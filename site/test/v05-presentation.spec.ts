import { expect, test, type Locator } from "@playwright/test";
import { DEFAULT_OVERLAYS } from "windgram/scene";

const keySeriesClasses = [
  "wg-series-usable",
  "wg-series-cloud-base",
  "wg-series-boundary",
  "wg-series-pbl",
  "wg-isotherm-freezing",
] as const;

async function expectKeyMatchesChart(chart: Locator, key: Locator) {
  for (const className of keySeriesClasses) {
    const chartCount = await chart.locator(`.${className}`).count();
    const keyCount = await key.locator(`.${className}`).count();
    expect(keyCount, `${className} key parity`).toBe(chartCount > 0 ? 1 : 0);
  }

  const chartHasDenseCloud = (await chart.locator(".wg-cloud-dense").count()) > 0;
  const keyHasDenseCloud = (await key.locator('[id$="-cloud-hatch"]').count()) > 0;
  expect(keyHasDenseCloud, "condensation hatch key parity").toBe(chartHasDenseCloud);

  const chartHasStability = (await chart.locator('[class*="wg-stab-"]').count()) > 0;
  const keyHasStability = (await key.locator(".wg-key-title").count()) > 0;
  expect(keyHasStability, "stability key parity").toBe(chartHasStability);

  const ids = await chart.locator("[id]").evaluateAll((nodes) => nodes.map((node) => node.id));
  ids.push(...await key.locator("[id]").evaluateAll((nodes) => nodes.map((node) => node.id)));
  expect(new Set(ids).size, "chart/key ids stay unique").toBe(ids.length);
}

test("the site inherits the package's white wind barbs and slate outline", async ({ page }) => {
  await page.goto("/docs/learn/reading-a-windgram/", { waitUntil: "networkidle" });
  const chart = page.locator("#example-windgram [data-windgram-mount] svg");
  const barb = chart.locator(".wg-barb").first();
  const outline = chart.locator(".wg-barb-halo").first();

  await expect(barb).toBeVisible();
  await expect(outline).toBeVisible();
  await expect(barb).toHaveCSS("stroke", "rgb(255, 255, 255)");
  await expect(outline).toHaveCSS("stroke", "rgb(53, 89, 99)");

  const barbWidth = Number.parseFloat(await barb.evaluate((element) => getComputedStyle(element).strokeWidth));
  const outlineWidth = Number.parseFloat(await outline.evaluate((element) => getComputedStyle(element).strokeWidth));
  expect(outlineWidth).toBeGreaterThan(barbWidth);
});

test("the scene-derived key follows layer toggles and Reset", async ({ page }) => {
  await page.goto("/docs/learn/reading-a-windgram/", { waitUntil: "networkidle" });
  const figure = page.locator("#example-windgram");
  const chart = figure.locator("[data-windgram-mount] svg");
  const key = figure.locator("[data-windgram-key-mount] svg");
  const status = figure.locator("[data-windgram-key-status]");

  await expect(chart).toHaveCount(1);
  await expect(key).toHaveCount(1);
  await expect(key).toHaveAttribute("role", "img");
  await expect(key).toHaveAttribute("aria-label", /^Windgram key:/);
  await expect(key.locator('[role="img"]')).toHaveAttribute(
    "aria-label",
    /Lapse-rate stability ramp/,
  );
  await expectKeyMatchesChart(chart, key);
  const exposedOverlays = await figure.locator("[data-windgram-overlay]").evaluateAll((controls) =>
    controls.map((control) => (control as HTMLElement).dataset.windgramOverlay).sort(),
  );
  expect(exposedOverlays).toEqual(Object.keys(DEFAULT_OVERLAYS).sort());
  const surfaceTemperature = figure.getByLabel("Surface temperature", { exact: true });
  const surfaceTemperatureMarks = chart.locator(".wg-surface-temp");
  const initialSurfaceTemperatureCount = await surfaceTemperatureMarks.count();
  expect(initialSurfaceTemperatureCount).toBeGreaterThan(0);
  await expect(surfaceTemperature).toBeChecked();
  await expect(surfaceTemperatureMarks).toHaveCount(initialSurfaceTemperatureCount);
  await surfaceTemperature.uncheck();
  await expect(surfaceTemperatureMarks).toHaveCount(0);
  await surfaceTemperature.check();
  await expect(surfaceTemperatureMarks).toHaveCount(initialSurfaceTemperatureCount);

  await figure.getByLabel("Usable lift", { exact: true }).uncheck();
  await expect(chart.locator(".wg-series-usable")).toHaveCount(0);
  await expect(key.locator(".wg-series-usable")).toHaveCount(0);
  await expect(status).toHaveText("Key updated to match the visible windgram layers.");

  await figure.getByLabel("Stability", { exact: true }).uncheck();
  await expect(key.locator(".wg-key-title")).toHaveCount(0);
  await expectKeyMatchesChart(chart, key);

  await figure.getByRole("button", { name: "Reset layers" }).click();
  await expect(figure.getByLabel("Usable lift", { exact: true })).toBeChecked();
  await expect(figure.getByLabel("Stability", { exact: true })).toBeChecked();
  await expectKeyMatchesChart(chart, key);

  // A back/forward-cache restoration can retain a form state that differs
  // from the server frame. The chart/key initialization handshake must
  // publish that restored scene regardless of component script order.
  await figure.getByLabel("Usable lift", { exact: true }).uncheck();
  await page.goto("/docs/", { waitUntil: "networkidle" });
  await page.goBack({ waitUntil: "networkidle" });
  const restoredFigure = page.locator("#example-windgram");
  await expectKeyMatchesChart(
    restoredFigure.locator("[data-windgram-mount] svg"),
    restoredFigure.locator("[data-windgram-key-mount] svg"),
  );
});

test("the complete chart and key remain contained on mobile, print, and reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs/learn/reading-a-windgram/", { waitUntil: "networkidle" });

  const figure = page.locator("#example-windgram");
  await expect(figure).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(figure.locator("[data-windgram-key-mount]")).not.toHaveAttribute("aria-live", /.+/);

  await page.emulateMedia({ media: "print", reducedMotion: "reduce" });
  await expect(figure.locator("[data-windgram-key-mount] svg")).toHaveCSS("width", /.+px/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
